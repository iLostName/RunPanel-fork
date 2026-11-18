import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The notification routes, without ever reaching a real service.
 *
 * Nothing here can deliver a message. A Telegram token is verified against
 * `api.telegram.org` before it is stored, so the suite only uses tokens that
 * are refused before any network call; webhooks and ntfy point at `.invalid`
 * hosts, which no resolver will ever answer, and are never tested; the mail
 * server is configured and cleared but never asked to send. What that leaves is
 * the part most likely to break: every route is behind the session, no secret
 * ever comes back out, validation refuses what it should in Italian, a blank
 * secret on edit keeps the stored one, and the notification centre answers for
 * the signed-in user.
 */
export const meta = { name: "notify", needsDocker: false, drivers: ["sqlite", "postgres"] };

const SECRET = "s3cr3t-signing-key-0123456789";
const HOOK = "https://hooks.example.invalid/runpanel/very-secret-path-0123456789";
const HEADER_VALUE = "Bearer header-secret-0123456789";

export async function run({ base }) {
  const r = createReporter("notify");
  const api = client(base);

  for (const [method, path] of [
    ["GET", "/api/notifications"],
    ["POST", "/api/notifications/read"],
    ["GET", "/api/notifications/channels"],
    ["POST", "/api/notifications/channels"],
    ["POST", "/api/notifications/telegram/chats"],
    ["GET", "/api/mail"],
    ["PUT", "/api/mail"],
  ]) {
    const res = await api.call(path, { method, ...(method === "GET" ? {} : { body: JSON.stringify({}) }) });
    r.check(`${method} ${path} needs a session`, res.status === 401, String(res.status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "notify-suite-pw" }),
  });

  // --- The notification centre ---------------------------------------------
  let res = await api.call("/api/notifications");
  r.check("the centre answers 200", res.status === 200, String(res.status));
  r.check("and starts empty", Array.isArray(res.body.items) && res.body.unread === 0, JSON.stringify(res.body));
  res = await api.call("/api/notifications?limit=500");
  r.check("a limit out of range is refused", res.status === 400, String(res.status));
  res = await api.call("/api/notifications?level=nope");
  r.check("an unknown level is refused", res.status === 400, String(res.status));
  res = await api.call("/api/notifications?unread=1&level=problems&group=deploy");
  r.check("the filters together answer 200", res.status === 200, String(res.status));

  res = await api.call("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });
  r.check("everything can be marked read", res.status === 200 && res.body.unread === 0, JSON.stringify(res.body));
  res = await api.call("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: ["no-such-id"] }) });
  r.check("an id that does not exist is ignored", res.status === 200, String(res.status));
  res = await api.call("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [] }) });
  r.check("an empty list is refused", res.status === 400, String(res.status));

  // --- Channels: the starting state ------------------------------------------
  res = await api.call("/api/notifications/channels");
  r.check("channels answer 200", res.status === 200, String(res.status));
  r.check("there are none yet", Array.isArray(res.body.channels) && res.body.channels.length === 0, JSON.stringify(res.body.channels));
  r.check("the event catalogue comes with them", Array.isArray(res.body.catalog) && res.body.catalog.length > 0);
  r.check("and no mail server is configured", res.body.mailReady === false);

  // --- Validation happens before anything is stored -------------------------
  const base_ = { name: "Prova", events: ["deploy.finished"] };
  const refused = [
    ["an unknown kind", { ...base_, kind: "pigeon" }],
    ["a malformed Telegram token", { ...base_, kind: "telegram", config: { chatId: "123" }, secrets: { botToken: "nope" } }],
    ["a malformed chat", { ...base_, kind: "telegram", config: { chatId: "not a chat" }, secrets: { botToken: "123:short" } }],
    [
      "a Discord look-alike",
      { ...base_, kind: "discord", secrets: { webhookUrl: "https://discord.com.example.invalid/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz" } },
    ],
    ["a Slack look-alike", { ...base_, kind: "slack", secrets: { webhookUrl: "https://hooks.example.invalid/services/T0/B0/XXXXXXXX" } }],
    ["a webhook over plain http to the internet", { ...base_, kind: "webhook", secrets: { url: "http://hooks.example.com/x", signingSecret: SECRET } }],
    ["a webhook to cloud metadata", { ...base_, kind: "webhook", secrets: { url: "http://169.254.169.254/latest", signingSecret: SECRET } }],
    ["a short signing secret", { ...base_, kind: "webhook", secrets: { url: HOOK, signingSecret: "short" } }],
    [
      "a header the panel sets itself",
      { ...base_, kind: "webhook", secrets: { url: HOOK, signingSecret: SECRET, headers: [{ name: "X-RunPanel-Signature", value: "v1=x" }] } },
    ],
    ["an email with no recipients", { ...base_, kind: "email", config: { to: [] } }],
    ["an email to a broken address", { ...base_, kind: "email", config: { to: ["not-an-address"] } }],
    ["an unknown event", { ...base_, events: ["no.such.event"], kind: "email", config: { to: ["ops@runpanel.test"] } }],
    ["an unknown field", { ...base_, kind: "email", config: { to: ["ops@runpanel.test"] }, extra: true }],
    ["an ntfy topic with a space", { ...base_, kind: "ntfy", config: { topic: "two words" } }],
  ];
  for (const [label, body] of refused) {
    res = await api.call("/api/notifications/channels", { method: "POST", body: JSON.stringify(body) });
    r.check(`${label} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
    r.check(`${label}: the reason is a sentence`, typeof res.body.error === "string" && res.body.error.length > 5, res.body.error);
  }

  // --- A webhook, and its secrets never coming back ---------------------------
  res = await api.call("/api/notifications/channels", {
    method: "POST",
    body: JSON.stringify({
      ...base_,
      name: "Automazioni",
      kind: "webhook",
      filter: "problems",
      secrets: { url: HOOK, signingSecret: SECRET, headers: [{ name: "Authorization", value: HEADER_VALUE }] },
    }),
  });
  r.check("a webhook channel is created", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  const hook = res.body.channel ?? {};
  const leaked = (value) => [SECRET, HEADER_VALUE, "very-secret-path"].some((secret) => JSON.stringify(value).includes(secret));
  r.check("the create response carries no secret", !leaked(res.body), JSON.stringify(res.body));
  r.check("it says which secrets are set", hook.secrets?.url === true && hook.secrets?.signingSecret === true && hook.secrets?.headers === true);
  r.check("the URL is shown only by its origin", hook.config?.hint === "https://hooks.example.invalid", JSON.stringify(hook.config));
  r.check("the header is listed by name", JSON.stringify(hook.config?.headerNames) === '["Authorization"]');
  r.check("the filter is kept", hook.filter === "problems");

  res = await api.call("/api/notifications/channels");
  r.check("the list carries no secret either", !leaked(res.body), JSON.stringify(res.body).slice(0, 300));

  // --- Edits: blank keeps, kind is fixed -------------------------------------
  res = await api.call(`/api/notifications/channels/${hook.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Automazioni del team", secrets: { url: "", signingSecret: "", headers: [{ name: "Authorization", value: "" }] } }),
  });
  r.check("an edit with blank secrets is accepted", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("the name changed", res.body.channel?.name === "Automazioni del team");
  r.check("and every secret is still set", res.body.channel?.secrets?.url === true && res.body.channel?.secrets?.signingSecret === true && res.body.channel?.secrets?.headers === true);

  res = await api.call(`/api/notifications/channels/${hook.id}`, {
    method: "PATCH",
    body: JSON.stringify({ secrets: { headers: [{ name: "X-New", value: "" }] } }),
  });
  r.check("a new header with no value is refused", res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);

  res = await api.call(`/api/notifications/channels/${hook.id}`, { method: "PATCH", body: JSON.stringify({ kind: "email" }) });
  r.check("the kind cannot change", res.status === 400, String(res.status));

  res = await api.call(`/api/notifications/channels/${hook.id}`, {
    method: "PATCH",
    body: JSON.stringify({ events: [], enabled: false }),
  });
  r.check("every event can be switched off", res.status === 200 && Array.isArray(res.body.channel?.events) && res.body.channel.events.length === 0);
  r.check("and the channel too", res.body.channel?.enabled === false);

  res = await api.call("/api/notifications/channels/no-such-channel", { method: "PATCH", body: JSON.stringify({ name: "x" }) });
  r.check("an unknown channel is a 404", res.status === 404, String(res.status));

  // --- Email, without a mail server --------------------------------------------
  res = await api.call("/api/notifications/channels", {
    method: "POST",
    body: JSON.stringify({ ...base_, name: "Email", kind: "email", config: { to: ["Ops@RunPanel.test", "dev@runpanel.test"] } }),
  });
  r.check("an email channel is created before there is a mail server", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  const email = res.body.channel ?? {};
  r.check("recipients are kept, lower-cased", JSON.stringify(email.config?.to) === '["ops@runpanel.test","dev@runpanel.test"]', JSON.stringify(email.config));

  res = await api.call(`/api/notifications/channels/${email.id}/test`, { method: "POST" });
  r.check("its test answers 200", res.status === 200, String(res.status));
  r.check("and says the mail server is missing", res.body.ok === false && /posta/.test(res.body.error ?? ""), JSON.stringify(res.body));

  // --- ntfy picks ntfy.sh unless told otherwise --------------------------------
  res = await api.call("/api/notifications/channels", {
    method: "POST",
    body: JSON.stringify({ ...base_, name: "Telefono", kind: "ntfy", config: { topic: "runpanel-suite-topic" } }),
  });
  r.check("an ntfy channel is created", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("on ntfy.sh by default", res.body.channel?.config?.server === "https://ntfy.sh", JSON.stringify(res.body.channel?.config));

  // --- Telegram chat discovery with nothing to ask with --------------------------
  res = await api.call("/api/notifications/telegram/chats", { method: "POST", body: JSON.stringify({}) });
  r.check("chat discovery with no token answers politely", res.status === 200 && res.body.ok === false, JSON.stringify(res.body));
  res = await api.call("/api/notifications/telegram/chats", { method: "POST", body: JSON.stringify({ token: "nope" }) });
  r.check("and refuses a malformed token before asking Telegram", res.status === 400, String(res.status));

  // --- Deleting ------------------------------------------------------------------
  res = await api.call(`/api/notifications/channels/${hook.id}`, { method: "DELETE" });
  r.check("a channel can be deleted", res.status === 200, String(res.status));
  res = await api.call(`/api/notifications/channels/${hook.id}`, { method: "DELETE" });
  r.check("and deleting it again is a 404", res.status === 404, String(res.status));

  // --- The mail server ------------------------------------------------------------
  res = await api.call("/api/mail");
  r.check("the mail server answers 200", res.status === 200, String(res.status));
  r.check("and is not configured", res.body.configured === false && res.body.passwordSet === false);

  const smtp = { host: "smtp.example.invalid", port: 587, security: "starttls", username: "avvisi@runpanel.test", from: "RunPanel <avvisi@runpanel.test>" };
  for (const [label, patch] of [
    ["a host with a scheme", { host: "smtp://smtp.example.invalid" }],
    ["a host with a port", { host: "smtp.example.invalid:587" }],
    ["a port out of range", { port: 0 }],
    ["an unknown security", { security: "ssl" }],
    ["a sender that is not an address", { from: "RunPanel" }],
  ]) {
    res = await api.call("/api/mail", { method: "PUT", body: JSON.stringify({ ...smtp, password: "x", ...patch }) });
    r.check(`${label} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }
  res = await api.call("/api/mail", { method: "PUT", body: JSON.stringify(smtp) });
  r.check("a user name without a password is refused", res.status === 400, String(res.status));

  const PASSWORD = "smtp-password-0123456789";
  res = await api.call("/api/mail", { method: "PUT", body: JSON.stringify({ ...smtp, password: PASSWORD }) });
  r.check("a complete server is saved", res.status === 200 && res.body.configured === true, JSON.stringify(res.body));
  r.check("the password never comes back", !JSON.stringify(res.body).includes(PASSWORD) && res.body.passwordSet === true);

  res = await api.call("/api/mail", { method: "PUT", body: JSON.stringify({ ...smtp, port: 465, security: "tls" }) });
  r.check("an edit without the password keeps it", res.status === 200 && res.body.passwordSet === true && res.body.port === 465, JSON.stringify(res.body));

  res = await api.call("/api/notifications/channels");
  r.check("email channels now have a server", res.body.mailReady === true);

  res = await api.call("/api/mail", { method: "POST", body: JSON.stringify({ action: "test", to: "not-an-address" }) });
  r.check("a test to a broken address is refused", res.status === 400, String(res.status));

  res = await api.call("/api/mail", { method: "POST", body: JSON.stringify({ action: "clear" }) });
  r.check("the server can be forgotten", res.status === 200 && res.body.configured === false && res.body.passwordSet === false, JSON.stringify(res.body));

  return r.result();
}
