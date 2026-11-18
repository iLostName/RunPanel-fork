import { createReporter, client, SETUP_TOKEN } from "../harness.mjs";

/**
 * The Telegram destination's API on a real server, as far as it goes without
 * Telegram: every route behind the session and the backup permission, the
 * keys and the steps validated before anything is sent to Telegram, a login
 * that does not exist (or is someone else's) answered as expired, a
 * destination that cannot be created without a finished login, and the
 * session never in a list. Nothing here opens a connection to Telegram; the
 * destination's own logic is `backup-telegram-unit`.
 */
export const meta = { name: "backup-telegram", needsDocker: false, drivers: ["sqlite"] };

const PASSWORD = "telegram-suite-password";
const FAKE_LOGIN = "AAAAAAAAAAAAAAAAAAAAAAAA";

export async function run({ base }) {
  const r = createReporter("backup-telegram");
  const api = client(base);

  for (const [method, route] of [
    ["POST", "/api/backups/destinations/telegram/login"],
    ["GET", `/api/backups/destinations/telegram/login/${FAKE_LOGIN}`],
    ["POST", `/api/backups/destinations/telegram/login/${FAKE_LOGIN}`],
    ["DELETE", `/api/backups/destinations/telegram/login/${FAKE_LOGIN}`],
  ]) {
    const { status } = await api.call(route, { method, ...(method === "POST" ? { body: JSON.stringify({}) } : {}) });
    r.check(`${method} ${route.replace(FAKE_LOGIN, "{id}")} requires a session`, status === 401, String(status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: PASSWORD, confirmPassword: PASSWORD }),
  });

  const start = (body) => api.call("/api/backups/destinations/telegram/login", { method: "POST", body: JSON.stringify(body) });

  const shortHash = await start({ apiId: 12345, apiHash: "abc", method: "qr" });
  r.check("an api_hash that is not 32 hex characters is refused before Telegram is asked", shortHash.status === 400, String(shortHash.status));
  r.check("saying what it should look like", /32 caratteri/.test(shortHash.body?.error ?? ""), JSON.stringify(shortHash.body));

  const noPhone = await start({ apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef", method: "phone" });
  r.check("logging in by phone needs the number", noPhone.status === 400 && /numero/.test(noPhone.body?.error ?? ""), JSON.stringify(noPhone.body));

  const noKeys = await start({ method: "qr" });
  r.check("without a destination to re-link, api_id and api_hash are required", noKeys.status === 400, JSON.stringify(noKeys.body));

  const badId = await start({ apiId: "dodici", apiHash: "0123456789abcdef0123456789abcdef", method: "qr" });
  r.check("an api_id that is not a number is refused", badId.status === 400, JSON.stringify(badId.body));

  const extra = await start({ apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", method: "qr", session: "1BQ…" });
  r.check("a session cannot be sent in: the body is strict", extra.status === 400, String(extra.status));

  const relinkMissing = await start({ method: "qr", destinationId: "nonesiste" });
  r.check("re-linking a destination that does not exist is a 404", relinkMissing.status === 404, String(relinkMissing.status));

  const status = await api.call(`/api/backups/destinations/telegram/login/${FAKE_LOGIN}`);
  r.check("a login that does not exist reads as expired", status.status === 404 && /scaduto/.test(status.body?.error ?? ""), JSON.stringify(status.body));

  const step = await api.call(`/api/backups/destinations/telegram/login/${FAKE_LOGIN}`, { method: "POST", body: JSON.stringify({ code: "12345" }) });
  r.check("a code for a login that does not exist is a 404", step.status === 404, String(step.status));
  const both = await api.call(`/api/backups/destinations/telegram/login/${FAKE_LOGIN}`, {
    method: "POST",
    body: JSON.stringify({ code: "12345", password: "x" }),
  });
  r.check("a step is the code or the password, not both", both.status === 400, String(both.status));
  const letters = await api.call(`/api/backups/destinations/telegram/login/${FAKE_LOGIN}`, { method: "POST", body: JSON.stringify({ code: "abcde" }) });
  r.check("a code is digits", letters.status === 400, String(letters.status));

  const cancel = await api.call(`/api/backups/destinations/telegram/login/${FAKE_LOGIN}`, { method: "DELETE" });
  r.check("cancelling a login that does not exist is harmless", cancel.status === 200 && cancel.body?.cancelled === false, JSON.stringify(cancel.body));

  // --- creating needs a finished login ------------------------------------------
  const create = (config) =>
    api.call("/api/backups/destinations", { method: "POST", body: JSON.stringify({ name: "Telegram", type: "telegram", ...(config ? { config } : {}) }) });
  const bare = await create(null);
  r.check("a Telegram destination without a login is refused", bare.status === 400, String(bare.status));
  const invented = await create({ loginId: FAKE_LOGIN, chat: "channel", channelTitle: "Archivi" });
  r.check(
    "nor with a login id that is not a finished login",
    invented.status === 400 && /collega di nuovo/.test(invented.body?.error ?? ""),
    JSON.stringify(invented.body)
  );
  const withSession = await create({ loginId: FAKE_LOGIN, chat: "channel", session: "1BQ…", apiId: 1, apiHash: "x" });
  r.check("a session cannot be stored by sending it", withSession.status === 400, String(withSession.status));
  const badChat = await create({ loginId: FAKE_LOGIN, chat: "gruppo" });
  r.check("the chat is a channel or Saved Messages", badChat.status === 400, String(badChat.status));

  const list = await api.call("/api/backups/destinations");
  r.check("nothing was created", (list.body?.destinations ?? []).length === 1, JSON.stringify(list.body?.destinations?.map((d) => d.type)));
  const local = list.body?.destinations?.[0];
  r.check("the list says where a Telegram destination writes, and is null for the others", local && "telegram" in local && local.telegram === null, JSON.stringify(local));

  // --- checking and editing ---------------------------------------------------------
  const check = (body) => api.call("/api/backups/destinations/check", { method: "POST", body: JSON.stringify(body) });
  const nothing = await check({ type: "telegram" });
  r.check("checking Telegram before linking says to link first", nothing.status === 200 && nothing.body?.ok === false && /Collega/.test(nothing.body?.message ?? ""), JSON.stringify(nothing.body));
  const expired = await check({ type: "telegram", config: { loginId: FAKE_LOGIN, chat: "saved" } });
  r.check("checking with a login that does not exist says it expired", expired.body?.ok === false && /scaduto/.test(expired.body?.message ?? ""), JSON.stringify(expired.body));

  const relinkLocal = await api.call(`/api/backups/destinations/${local?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ config: { loginId: FAKE_LOGIN } }),
  });
  r.check("the local disk has no account to re-link", relinkLocal.status === 400, String(relinkLocal.status));

  const detail = await api.call(`/api/backups/destinations/${local?.id}`);
  r.check("the edit form's detail says null for Telegram on another type", detail.status === 200 && detail.body?.telegram === null, JSON.stringify(detail.body));

  return r.result();
}
