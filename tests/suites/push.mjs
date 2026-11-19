import { createHash } from "node:crypto";

import { client, createReporter, SETUP_TOKEN, sleep } from "../harness.mjs";
import { browserKeys, decryptPush, subscriptionJson, startPushService, verifyVapid } from "../push-fake.mjs";

/**
 * Notifications on people's devices, end to end, with a push service of our
 * own: an HTTP server in this process, which the panel is allowed to POST to
 * by `RUNPANEL_PUSH_SERVICES`, and which receives what a real one would — a
 * VAPID-signed, aes128gcm-encrypted message that this suite opens with the
 * browser keys it made, as the browser would.
 *
 * Every route is behind the session; a device is its account's alone, the
 * owner's included; nothing that identifies a subscription comes back out; a
 * push service answering 410 removes the device. And the rule the feature
 * stands on: a real notification — a deploy that fails — reaches the devices
 * of whoever may see that project, and nobody else's.
 */
export const meta = {
  name: "push",
  needsDocker: false,
  drivers: ["sqlite", "postgres"],
  env: { RUNPANEL_PUSH_SERVICES: "127.0.0.1" },
};

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export async function run({ base }) {
  const r = createReporter("push");
  const service = await startPushService();
  try {
    await suite(r, base, service);
  } finally {
    await service.close();
  }
  return r.result();
}

async function suite(r, base, service) {
  const anonymous = client(base);
  for (const [method, path] of [
    ["GET", "/api/account/push"],
    ["POST", "/api/account/push/devices"],
    ["PATCH", "/api/account/push/devices/x"],
    ["DELETE", "/api/account/push/devices/x"],
    ["POST", "/api/account/push/devices/x/test"],
    ["POST", "/api/account/push/sync"],
  ]) {
    const res = await anonymous.call(path, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
    r.check(`${method} ${path} needs a session`, res.status === 401, String(res.status));
  }

  const owner = client(base);
  await owner.call("/api/auth/login", json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "push-suite-pw" }));

  // --- the panel's key, made once --------------------------------------------------
  let res = await owner.call("/api/account/push");
  r.check("the list answers 200", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  const publicKey = res.body?.publicKey;
  r.check("with the panel's public key: an uncompressed P-256 point", typeof publicKey === "string" && Buffer.from(publicKey, "base64url").length === 65 && publicKey.startsWith("B"));
  r.check("no devices yet, and the limit", Array.isArray(res.body?.devices) && res.body.devices.length === 0 && res.body.max === 10, JSON.stringify(res.body));
  res = await owner.call("/api/account/push");
  r.check("the key is the same on the next request", res.body?.publicKey === publicKey);

  // --- what is refused before anything is stored --------------------------------------
  const ownerKeys = browserKeys();
  const ownerEndpoint = `${service.origin}/push/owner`;
  const valid = { subscription: subscriptionJson(ownerEndpoint, ownerKeys), name: "Chrome su Windows" };
  for (const [label, body] of [
    ["an unknown push service", { ...valid, subscription: subscriptionJson("https://push.example.com/abc", ownerKeys) }],
    ["a known one over plain http", { ...valid, subscription: subscriptionJson("http://fcm.googleapis.com/fcm/send/abc", ownerKeys) }],
    ["a browser key that is not one", { ...valid, subscription: { ...valid.subscription, keys: { ...valid.subscription.keys, p256dh: "AAAA" } } }],
    ["an event that does not exist", { ...valid, events: ["no.such.event"] }],
    ["an unknown field", { ...valid, userId: "someone-else" }],
  ]) {
    res = await owner.call("/api/account/push/devices", json("POST", body));
    r.check(`${label} is refused, in words`, res.status === 400 && typeof res.body?.error === "string" && res.body.error.length > 5, `${res.status} ${JSON.stringify(res.body)}`);
  }
  res = await owner.call("/api/account/push/devices", json("POST", { ...valid, applicationServerKey: "BAAA" }));
  r.check("a subscription made with another key of the panel is sent back", res.status === 409 && res.body?.code === "key_changed" && res.body?.publicKey === publicKey, JSON.stringify(res.body));

  // --- turning them on ------------------------------------------------------------------
  res = await owner.call("/api/account/push/devices", json("POST", { ...valid, applicationServerKey: publicKey }));
  r.check("a device is created", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  const ownerDevice = res.body?.device ?? {};
  const leaked = (value) => {
    const text = JSON.stringify(value);
    return text.includes("/push/owner") || text.includes(valid.subscription.keys.auth) || text.includes(valid.subscription.keys.p256dh);
  };
  r.check("nothing of the subscription comes back: no endpoint, no keys", !leaked(res.body), JSON.stringify(res.body));
  r.check("only the hash a browser can compute for itself", ownerDevice.endpointHash === sha256(ownerEndpoint));
  r.check("the recommended events, everything sent", ownerDevice.events?.includes("deploy.finished") && ownerDevice.filter === "all" && ownerDevice.enabled === true);

  res = await owner.call("/api/account/push/devices", json("POST", { ...valid, name: "Altro nome" }));
  r.check("the same browser again is the same device, refreshed", res.status === 200 && res.body?.device?.id === ownerDevice.id, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("keeping its name", res.body?.device?.name === "Chrome su Windows");

  res = await owner.call("/api/account/push");
  r.check("the list has it, still without secrets", res.body?.devices?.length === 1 && !leaked(res.body), JSON.stringify(res.body));

  // --- editing --------------------------------------------------------------------------
  res = await owner.call(`/api/account/push/devices/${ownerDevice.id}`, json("PATCH", { name: "PC dell'ufficio" }));
  r.check("it can be renamed", res.status === 200 && res.body?.device?.name === "PC dell'ufficio", JSON.stringify(res.body));
  res = await owner.call(`/api/account/push/devices/${ownerDevice.id}`, json("PATCH", { filter: "problems", events: ["deploy.finished", "backup.finished"] }));
  r.check("what it receives can be chosen", res.status === 200 && res.body?.device?.filter === "problems" && res.body.device.events.join() === "deploy.finished,backup.finished", JSON.stringify(res.body));
  res = await owner.call(`/api/account/push/devices/${ownerDevice.id}`, json("PATCH", {}));
  r.check("an edit with nothing in it is refused", res.status === 400, String(res.status));
  res = await owner.call(`/api/account/push/devices/${ownerDevice.id}`, json("PATCH", { name: "" }));
  r.check("an empty name is refused", res.status === 400, String(res.status));
  res = await owner.call("/api/account/push/devices/no-such-device", json("PATCH", { name: "x" }));
  r.check("an unknown device is a 404", res.status === 404, String(res.status));

  // --- a test, through the push service ---------------------------------------------------
  res = await owner.call(`/api/account/push/devices/${ownerDevice.id}/test`, { method: "POST" });
  r.check("the test answers ok", res.status === 200 && res.body?.ok === true, `${res.status} ${JSON.stringify(res.body)}`);
  const delivered = service.to("/push/owner");
  r.check("the push service received one POST", delivered.length === 1 && delivered[0].method === "POST", String(delivered.length));
  const push = delivered[0];
  const headers = push?.headers ?? {};
  r.check("encrypted as aes128gcm", headers["content-encoding"] === "aes128gcm" && headers["content-type"] === "application/octet-stream", JSON.stringify(headers));
  r.check("with a TTL, an urgency and a topic", Number(headers.ttl) > 0 && ["normal", "high"].includes(headers.urgency) && /^[A-Za-z0-9_-]{1,32}$/.test(headers.topic ?? ""), JSON.stringify(headers));
  const vapid = verifyVapid(headers.authorization);
  r.check("signed by the panel's key, as a push service checks", vapid.ok === true && vapid.publicKey === publicKey, vapid.reason ?? "");
  r.check("for this push service", vapid.claims?.aud === service.origin, JSON.stringify(vapid.claims));
  r.check("valid for less than a day", vapid.claims?.exp > Date.now() / 1000 && vapid.claims.exp <= Date.now() / 1000 + 24 * 3600);
  r.check("with a contact", /^(mailto:|https:\/\/)/.test(vapid.claims?.sub ?? ""), vapid.claims?.sub);
  let payload = null;
  try {
    payload = JSON.parse(decryptPush(push.body, ownerKeys).plaintext.toString("utf8"));
  } catch (err) {
    r.check("the browser can open it", false, err instanceof Error ? err.message : String(err));
  }
  r.check("the browser opens it: a test, in Italian", payload?.v === 1 && payload.title === "Prova da RunPanel" && payload.body.includes("PC dell'ufficio"), JSON.stringify(payload));
  r.check("it opens the push settings, inside the panel", payload?.url === "/account?open=push", payload?.url);
  r.check("it carries the unread count for the app's badge", typeof payload?.unread === "number");
  r.check("and the panel's icons", payload?.icon === "/icons/icon-192.png" && payload?.badge === "/icons/monochrome-192.png");
  res = await owner.call("/api/account/push");
  r.check("the list says the last push went out", Boolean(res.body?.devices?.[0]?.lastOkAt), JSON.stringify(res.body?.devices?.[0]));

  // --- another account ---------------------------------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "dev@runpanel.test", hours: 1 }));
  const devId = res.body?.user?.id;
  const inviteToken = res.body?.invitePath?.split("/").pop();
  const dev = client(base);
  res = await dev.call("/api/auth/invite", json("POST", { token: inviteToken, password: "dev-push-pw-1" }));
  r.check("a second account is set up", res.status === 200 && Boolean(devId), JSON.stringify(res.body));

  res = await dev.call("/api/account/push");
  r.check("it does not see the owner's devices", res.status === 200 && res.body?.devices?.length === 0, JSON.stringify(res.body));
  for (const [method, path, body] of [
    ["PATCH", `/api/account/push/devices/${ownerDevice.id}`, { name: "Mio" }],
    ["POST", `/api/account/push/devices/${ownerDevice.id}/test`, undefined],
    ["DELETE", `/api/account/push/devices/${ownerDevice.id}`, undefined],
  ]) {
    res = await dev.call(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    r.check(`${method} on someone else's device is a 404, as if it did not exist`, res.status === 404, String(res.status));
  }
  res = await owner.call("/api/account/push");
  r.check("and the owner's device is untouched", res.body?.devices?.[0]?.name === "PC dell'ufficio" && service.to("/push/owner").length === 1);

  const devKeys = browserKeys();
  const devEndpoint = `${service.origin}/push/dev`;
  res = await dev.call("/api/account/push/devices", json("POST", { subscription: subscriptionJson(devEndpoint, devKeys), name: "Telefono di Dev" }));
  r.check("the second account turns them on in its own browser", res.status === 201, JSON.stringify(res.body));
  res = await owner.call("/api/account/push");
  r.check("the owner does not see it either", res.body?.devices?.length === 1, JSON.stringify(res.body?.devices?.map((d) => d.name)));

  // --- a real notification: only to who may see it ----------------------------------------------
  // The owner's device back to everything, so a failed deploy is wanted by both.
  await owner.call(`/api/account/push/devices/${ownerDevice.id}`, json("PATCH", { filter: "all", events: ["deploy.finished"] }));
  res = await owner.call("/api/projects", json("POST", { name: "Push Suite" }));
  const projectId = res.body?.id;
  r.check("a project is created", res.status === 201 && Boolean(projectId), JSON.stringify(res.body));
  res = await owner.call(`/api/projects/${projectId}/deploy`, json("POST", {}));
  r.check("its deploy starts (and fails: it has no source)", res.status < 300, `${res.status} ${JSON.stringify(res.body)}`);

  const ownerGotIt = await service.until(() => service.to("/push/owner").length >= 2, 15_000);
  r.check("the owner's device receives the failed deploy", ownerGotIt, String(service.to("/push/owner").length));
  const deployPush = service.to("/push/owner")[1];
  let deployPayload = null;
  try {
    deployPayload = deployPush ? JSON.parse(decryptPush(deployPush.body, ownerKeys).plaintext.toString("utf8")) : null;
  } catch {
    deployPayload = null;
  }
  r.check("titled with what happened and to what", typeof deployPayload?.title === "string" && deployPayload.title.startsWith("Deploy fallito"), JSON.stringify(deployPayload));
  r.check("opening the project's page", deployPayload?.url === `/projects/${projectId}`, deployPayload?.url);
  r.check("tagged by the project, so the next one about it replaces it", deployPayload?.tag === `project:${projectId}`, deployPayload?.tag);
  r.check("urgent, being a failure", deployPush?.headers.urgency === "high", deployPush?.headers.urgency);
  r.check("naming the notification it stands for, to mark it read", Array.isArray(deployPayload?.ids) && deployPayload.ids.length === 1);
  r.check("and counting it for the badge", deployPayload?.unread >= 1, String(deployPayload?.unread));
  const history = (await owner.call(`/api/projects/${projectId}/logs`)).body;
  const reason = Array.isArray(history) ? history.map((d) => d.error_message).find(Boolean) : null;
  r.check(
    "the reason stays in the panel, out of the push",
    typeof reason === "string" && reason.length > 0 && !JSON.stringify(deployPayload).includes(reason),
    `${reason} / ${JSON.stringify(deployPayload)}`
  );

  await sleep(1_500);
  r.check("the second account, which cannot see the project, gets nothing", service.to("/push/dev").length === 0, String(service.to("/push/dev").length));

  // Read access, and the next failure reaches it too.
  res = await owner.call(`/api/users/${devId}`, json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } }));
  r.check("the second account is given the project to read", res.status === 200, JSON.stringify(res.body));
  await owner.call(`/api/projects/${projectId}/deploy`, json("POST", {}));
  const devGotIt = await service.until(() => service.to("/push/dev").length >= 1, 15_000);
  r.check("now its device receives the failure too", devGotIt, String(service.to("/push/dev").length));
  let devPayload = null;
  try {
    devPayload = JSON.parse(decryptPush(service.to("/push/dev")[0].body, devKeys).plaintext.toString("utf8"));
  } catch {
    devPayload = null;
  }
  r.check("sealed for its own browser, which opens it", devPayload?.url === `/projects/${projectId}`, JSON.stringify(devPayload));

  // --- one browser, one account ------------------------------------------------------------------
  // The owner signs in on the second account's browser: sync from there releases the old claim.
  res = await owner.call("/api/account/push/sync", json("POST", { endpoint: devEndpoint }));
  r.check("a browser asking whose it is, from another account, is released", res.status === 200 && res.body?.released === true && res.body?.device === null, JSON.stringify(res.body));
  res = await dev.call("/api/account/push");
  r.check("and the previous account no longer has it", res.body?.devices?.length === 0, JSON.stringify(res.body?.devices));
  res = await owner.call("/api/account/push/sync", json("POST", { endpoint: ownerEndpoint }));
  r.check("asking for its own, an account is told which device it is", res.body?.device?.id === ownerDevice.id && res.body?.released === false && res.body?.publicKey === publicKey, JSON.stringify(res.body));

  res = await dev.call("/api/account/push/devices", json("POST", { subscription: subscriptionJson(ownerEndpoint, ownerKeys), name: "Preso" }));
  r.check("turning them on in a browser another account had takes it over", res.status === 201, JSON.stringify(res.body));
  res = await owner.call("/api/account/push");
  r.check("so the owner's notifications stop landing there", res.body?.devices?.length === 0, JSON.stringify(res.body?.devices));
  res = await dev.call("/api/account/push/devices", json("POST", { subscription: subscriptionJson(devEndpoint, devKeys), name: "Telefono di Dev" }));
  const devAgain = res.body?.device ?? {};

  // --- a renewed subscription keeps its row ------------------------------------------------------
  const renewedKeys = browserKeys();
  const renewedEndpoint = `${service.origin}/push/dev-renewed`;
  await dev.call(`/api/account/push/devices/${devAgain.id}`, json("PATCH", { name: "Telefono rinominato" }));
  res = await dev.call(
    "/api/account/push/devices",
    json("POST", { subscription: subscriptionJson(renewedEndpoint, renewedKeys), name: "Dispositivo", previousEndpoint: devEndpoint })
  );
  r.check(
    "a subscription renewed by the push service is the same device, with its name",
    res.status === 200 && res.body?.device?.id === devAgain.id && res.body.device.name === "Telefono rinominato" && res.body.device.endpointHash === sha256(renewedEndpoint),
    JSON.stringify(res.body)
  );

  // --- a subscription the push service no longer has ---------------------------------------------
  service.statusFor.set("/push/dev-renewed", 410);
  res = await dev.call(`/api/account/push/devices/${devAgain.id}/test`, { method: "POST" });
  r.check("a 410 from the push service is reported", res.status === 200 && res.body?.ok === false && res.body?.removed === true, JSON.stringify(res.body));
  res = await dev.call("/api/account/push");
  r.check(
    "and the device is gone from the list",
    Array.isArray(res.body?.devices) && !res.body.devices.some((device) => device.id === devAgain.id),
    JSON.stringify(res.body?.devices?.map((device) => device.name))
  );

  // --- removing ----------------------------------------------------------------------------------
  res = await dev.call("/api/account/push");
  const leftover = res.body?.devices ?? [];
  for (const device of leftover) await dev.call(`/api/account/push/devices/${device.id}`, { method: "DELETE" });
  res = await dev.call("/api/account/push/devices", json("POST", { subscription: subscriptionJson(devEndpoint, devKeys), name: "Ultimo" }));
  const last = res.body?.device ?? {};
  res = await dev.call(`/api/account/push/devices/${last.id}`, { method: "DELETE" });
  r.check("a device can be removed", res.status === 200 && res.body?.ok === true, JSON.stringify(res.body));
  res = await dev.call(`/api/account/push/devices/${last.id}`, { method: "DELETE" });
  r.check("and removing it again is a 404", res.status === 404, String(res.status));

  // --- the activity log ----------------------------------------------------------------------------
  res = await owner.call("/api/audit?limit=200");
  const actions = new Set((res.body?.entries ?? []).map((entry) => entry.action));
  r.check(
    "turning on, editing, testing, taking over and removing are in the activity log",
    ["account.push.enable", "account.push.update", "account.push.test", "account.push.delete", "account.push.released", "account.push.taken"].every((action) => actions.has(action)),
    JSON.stringify([...actions].filter((action) => action.startsWith("account.push")))
  );
}
