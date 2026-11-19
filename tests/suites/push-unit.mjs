import { createHash } from "node:crypto";

import { createReporter } from "../harness.mjs";
import { loadTs } from "../ts-modules.mjs";
import { b64u, browserKeys, decryptPush, fromB64u, verifyVapid } from "../push-fake.mjs";

/**
 * Notifications on a person's devices, without a browser or a server: the
 * cryptography, the rules for what is accepted, and what a notification says.
 *
 * The encryption is checked against the example of RFC 8291 itself, byte for
 * byte, and opened again by an independent implementation (tests/push-fake.mjs);
 * the VAPID token is verified with node:crypto as a push service would. The
 * words are checked for what must never be in them: a push is read on a lock
 * screen, and it quotes no error, log line or commit.
 */
export const meta = { name: "push-unit", needsDocker: false, drivers: [], standalone: true };

/** RFC 8291 §5 and Appendix A. */
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
};

export async function run({ repoRoot }) {
  const r = createReporter("push-unit");
  const wp = await loadTs(repoRoot, "lib", "web-push.ts");
  const rules = await loadTs(repoRoot, "lib", "push-rules.ts");
  const { describePush, describePushDigest } = await loadTs(repoRoot, "services", "notify", "push-text.ts");
  const { describe } = await loadTs(repoRoot, "services", "notify", "messages.ts");
  const { NOTIFY_EVENTS } = await loadTs(repoRoot, "lib", "notify-events.ts");
  const { pushDeviceName, describeDevice } = await loadTs(repoRoot, "lib", "device-name.ts");
  const { pushSubscribeSchema, pushDeviceUpdateSchema, pushSyncSchema } = await loadTs(repoRoot, "lib", "validation.ts");

  // --- aes128gcm: the RFC's own example ------------------------------------------------
  const rfcKeys = { privateKey: fromB64u(RFC.uaPrivate), publicKey: fromB64u(RFC.uaPublic), auth: fromB64u(RFC.auth) };
  const sealed = wp.encryptPush(fromB64u(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: fromB64u(RFC.salt),
    senderPrivateKey: fromB64u(RFC.asPrivate),
  });
  r.check("the RFC 8291 example encrypts to exactly the RFC's message", b64u(sealed) === RFC.body, b64u(sealed));
  r.check("with the RFC's 86-byte header: salt, 4096, 65, the sender's key", b64u(sealed.subarray(0, 86)) === RFC.header);
  r.check("the sender's key in the header is the RFC's", b64u(sealed.subarray(21, 86)) === RFC.asPublic);
  const opened = decryptPush(sealed, rfcKeys);
  r.check(
    "an independent decryption with the RFC's browser key reads the plaintext",
    opened.plaintext.toString("utf8") === "When I grow up, I want to be a watermelon",
    opened.plaintext.toString("utf8")
  );

  // --- aes128gcm: as the sender really uses it -------------------------------------------
  const browser = browserKeys();
  const target = { p256dh: b64u(browser.publicKey), auth: b64u(browser.auth) };
  const message = JSON.stringify({ title: "Deploy fallito — api", body: "Il motivo è nella pagina del progetto." });
  const first = wp.encryptPush(message, target);
  const second = wp.encryptPush(message, target);
  r.check("a fresh message opens with the browser's keys", decryptPush(first, browser).plaintext.toString("utf8") === message);
  r.check("the same text never looks the same twice (new salt and key each time)", !first.equals(second) && !first.subarray(0, 16).equals(second.subarray(0, 16)));
  r.check("the record size is 4096", first.readUInt32BE(16) === wp.PUSH_RECORD_SIZE && wp.PUSH_RECORD_SIZE === 4096);
  r.check("the largest message fits one 4096-byte body", wp.encryptPush("x".repeat(wp.MAX_PUSH_PLAINTEXT), target).length === 4096);
  r.check("one byte more is refused instead of sent", throws(() => wp.encryptPush("x".repeat(wp.MAX_PUSH_PLAINTEXT + 1), target)));
  r.check("a browser key that is not a P-256 point is refused", throws(() => wp.encryptPush("x", { p256dh: b64u(Buffer.alloc(65, 1)), auth: target.auth })));
  r.check("an auth secret of the wrong size is refused", throws(() => wp.encryptPush("x", { p256dh: target.p256dh, auth: b64u(Buffer.alloc(8)) })));
  const other = browserKeys();
  r.check("another browser cannot open it", throws(() => decryptPush(first, other)));

  // --- VAPID -----------------------------------------------------------------------------
  const keys = wp.generateVapidKeys();
  r.check("a generated pair is valid: a 65-byte point and its 32-byte scalar", wp.isVapidKeys(keys) && fromB64u(keys.publicKey).length === 65 && fromB64u(keys.privateKey).length === 32);
  r.check("a public key from another pair is caught", !wp.isVapidKeys({ publicKey: wp.generateVapidKeys().publicKey, privateKey: keys.privateKey }));
  r.check("two panels never share a pair", wp.generateVapidKeys().publicKey !== keys.publicKey);

  const now = Date.UTC(2026, 10, 19, 12, 0, 0);
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc:def";
  const authorization = wp.vapidAuthorization(endpoint, "https://panel.esempio.it", keys, now);
  const checked = verifyVapid(authorization);
  r.check("the Authorization header is `vapid t=…, k=<public key>`", checked.ok !== undefined && checked.publicKey === keys.publicKey, authorization.slice(0, 40));
  r.check("its ES256 signature verifies with node:crypto against the public key", checked.ok === true, checked.reason ?? "");
  r.check("the signature is r||s, 64 bytes, as JWS wants", checked.signatureLength === 64);
  r.check("the header says JWT and ES256", checked.header?.typ === "JWT" && checked.header?.alg === "ES256", JSON.stringify(checked.header));
  r.check("aud is the push service's origin", checked.claims?.aud === "https://fcm.googleapis.com", JSON.stringify(checked.claims));
  r.check("sub is the contact given", checked.claims?.sub === "https://panel.esempio.it");
  const expires = checked.claims?.exp;
  r.check("exp is in the future and within the 24 hours RFC 8292 allows", expires > now / 1000 && expires <= now / 1000 + 24 * 3600, String(expires));

  const [head, payload, signature] = authorization.slice("vapid t=".length).split(",")[0].split(".");
  const forged = b64u(Buffer.from(JSON.stringify({ aud: "https://fcm.googleapis.com", exp: expires, sub: "mailto:someone@else.example" })));
  r.check("a changed claim no longer verifies", verifyVapid(`vapid t=${head}.${forged}.${signature}, k=${keys.publicKey}`).ok === false);
  r.check("nor with another panel's key", verifyVapid(`vapid t=${head}.${payload}.${signature}, k=${wp.generateVapidKeys().publicKey}`).ok === false);
  const direct = wp.vapidJwt({ aud: "https://web.push.apple.com", exp: 1_900_000_000, sub: "mailto:ops@esempio.it" }, keys);
  r.check("a token for Apple carries Apple's origin", verifyVapid(`vapid t=${direct}, k=${keys.publicKey}`).claims?.aud === "https://web.push.apple.com");

  r.check("Topic: at most 32 characters of the URL-safe alphabet", /^[A-Za-z0-9_-]{1,32}$/.test(wp.pushTopic("project:abc")));
  r.check("Topic: the same tag, the same topic; another tag, another", wp.pushTopic("a") === wp.pushTopic("a") && wp.pushTopic("a") !== wp.pushTopic("b"));
  r.check("the endpoint hash is SHA-256 hex, as the browser computes it", wp.endpointHash(endpoint) === createHash("sha256").update(endpoint).digest("hex"));

  // --- which endpoints the panel will POST to -------------------------------------------------
  for (const good of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    r.check(`accepted: ${new URL(good).host}`, rules.pushEndpointProblem(good) === null, rules.pushEndpointProblem(good));
  }
  for (const [label, bad] of [
    ["plain http to a known service", "http://fcm.googleapis.com/fcm/send/abc"],
    ["an unknown host", "https://push.example.com/abc"],
    ["a look-alike host", "https://fcm.googleapis.com.evil.example/abc"],
    ["a host that only ends like one", "https://evilfcm.googleapis.com/abc"],
    ["the bare suffix", "https://notify.windows.com/w/abc"],
    ["the machine itself", "https://127.0.0.1/push"],
    ["cloud metadata", "http://169.254.169.254/latest"],
    ["credentials in the address", "https://user:pw@fcm.googleapis.com/fcm/send/abc"],
    ["another port", "https://fcm.googleapis.com:8443/fcm/send/abc"],
    ["not a URL", "fcm.googleapis.com/abc"],
    ["a scheme that is not http", "javascript://fcm.googleapis.com/%0aalert(1)"],
  ]) {
    const problem = rules.pushEndpointProblem(bad);
    r.check(`refused: ${label}`, typeof problem === "string" && problem.length > 10, String(problem));
  }
  const extra = rules.parsePushServices(" http://127.0.0.1:4500/x , push.mia-azienda.it, , [::1]:80, bad host ");
  r.check("RUNPANEL_PUSH_SERVICES is read as hosts, scheme, port and path dropped", JSON.stringify(extra) === JSON.stringify(["127.0.0.1", "push.mia-azienda.it", "[::1]"]), JSON.stringify(extra));
  r.check("an added host may use http and any port", rules.pushEndpointProblem("http://127.0.0.1:4567/push/a", extra) === null);
  r.check("but not a different host", rules.pushEndpointProblem("http://127.0.0.2:4567/push/a", extra) !== null);
  r.check("the push service is named for the list", rules.pushServiceLabel("fcm.googleapis.com") === "Google" && rules.pushServiceLabel("web.push.apple.com") === "Apple");

  r.check("a browser key is 65 bytes starting with 0x04", rules.isPushPublicKey(target.p256dh) && !rules.isPushPublicKey(b64u(Buffer.alloc(64, 4))));
  r.check("an auth secret is 16 bytes", rules.isPushAuthSecret(target.auth) && !rules.isPushAuthSecret(b64u(Buffer.alloc(15))) && !rules.isPushAuthSecret("not base64url!"));

  for (const [raw, expected] of [
    ["/projects/abc", "/projects/abc"],
    ["//evil.example/x", "/notifications"],
    ["https://evil.example", "/notifications"],
    ["/\\evil.example", "/notifications"],
    [42, "/notifications"],
  ]) {
    r.check(`a notification opens ${JSON.stringify(raw)} as ${expected}`, rules.panelPath(raw) === expected, rules.panelPath(raw));
  }
  r.check("clip: short text stays", rules.clip("  Deploy  fallito ", 50) === "Deploy fallito");
  const clipped = rules.clip("Un nome molto lungo per un progetto che non sta in una riga 🚀🚀", 60);
  r.check("clip: long text ends with an ellipsis within the limit", clipped.length <= 60 && clipped.endsWith("…"), clipped);
  r.check("clip: never half an emoji", !/[\uD800-\uDBFF]…$/.test(rules.clip("a".repeat(58) + "🚀🚀", 60)));

  // --- what a notification says ------------------------------------------------------------------
  const SECRET = "SEGRETO-XYZ";
  const samples = {
    "project.crashed": { key: "project.crashed", slug: "api", runtime: `pm2 ${SECRET}` },
    "service.crashed": { key: "service.crashed", name: "db", container: `rp-${SECRET}` },
    "restart.scheduled": { key: "restart.scheduled", kind: "project", name: "api", outcome: `errore: ${SECRET}`, ok: false, id: "p1" },
    "docker.down": { key: "docker.down", up: false, detail: `dial unix ${SECRET}` },
    "disk.low": { key: "disk.low", up: false, freeBytes: 1e9, totalBytes: 1e11, path: `/srv/${SECRET}`, level: "critical", scope: "data" },
    "deploy.finished": { key: "deploy.finished", slug: "api", ok: false, trigger: "webhook", commitSha: "4d480c7aa", commitMessage: `fix ${SECRET}`, durationMs: 72_000, error: `npm ERR! ${SECRET}` },
    "backup.finished": { key: "backup.finished", policy: "Notte", status: "failed", ok: 0, failed: 2, skipped: 0, bytes: 0, durationMs: 1000, error: `s3: ${SECRET}` },
    "panel.update": { key: "panel.update", behind: 3, from: "aaaaaaa", to: "bbbbbbb", branch: "main" },
    "panel.restarted": { key: "panel.restarted", version: "1.2.3", sha: "ccccccc", afterUpdate: true },
    "uptime.down": { key: "uptime.down", up: false, name: "Shop", cause: "Nessuno risponde sulla porta: l'app è ferma o si sta riavviando", target: `GET /${SECRET}`, durationMs: null, projectId: "p1" },
    "metrics.high": { key: "metrics.high", up: false, scope: "project", name: "api", metric: "memory", percent: 93, peak: 97, durationMs: null, projectId: "p1" },
    "task.failed": { key: "task.failed", up: false, project: "Shop", task: "Pulizia", outcome: `spawn ${SECRET}`, exitCode: 1, detail: `Error: ${SECRET}`, failures: 3, durationMs: 1200, projectId: "p1", taskId: "t1" },
  };
  r.check("every event of the catalogue has a sample here", NOTIFY_EVENTS.every((key) => key in samples), NOTIFY_EVENTS.filter((key) => !(key in samples)).join(", "));
  for (const event of Object.values(samples)) {
    const text = describePush(event, describe(event));
    r.check(
      `${event.key}: a title and a body, within what a phone shows`,
      text.title.length > 0 && text.body.length > 0 && text.title.length <= rules.PUSH_TITLE_MAX && text.body.length <= rules.PUSH_BODY_MAX,
      JSON.stringify(text)
    );
    r.check(`${event.key}: quotes nothing from an error, a log, a path or a commit`, !JSON.stringify(text).includes(SECRET), JSON.stringify(text));
    r.check(`${event.key}: plain text, no markup`, !/<\/?(b|code|a)\b/.test(text.title + text.body), JSON.stringify(text));
  }
  const crash = describePush(samples["project.crashed"], describe(samples["project.crashed"]));
  r.check("a crash names the project in the title", crash.title.includes("api"), crash.title);
  const recovered = describePush({ ...samples["uptime.down"], up: true }, describe({ ...samples["uptime.down"], up: true }));
  r.check("an all-clear reads as one", /di nuovo/i.test(recovered.title + recovered.body), JSON.stringify(recovered));
  const digest = describePushDigest(["Progetto fermo — a", "Progetto fermo — b", "Servizio fermo — c", "Servizio fermo — d"], 2);
  r.check("a digest counts what it stands for", digest.title === "6 avvisi da RunPanel", digest.title);
  r.check("and lists the latest titles", digest.body.includes("Servizio fermo — d") && digest.body.includes("altri 3"), digest.body);

  // --- a device's default name -----------------------------------------------------------------
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  r.check("the app on an iPhone", pushDeviceName(iphone, true) === "App RunPanel su iPhone", pushDeviceName(iphone, true));
  r.check("the app on an iPad that says it is a Mac", pushDeviceName(ipad, true, true) === "App RunPanel su iPad", pushDeviceName(ipad, true, true));
  r.check("a browser tab is the browser", pushDeviceName(chrome, false) === "Chrome su Windows" && describeDevice(chrome) === "Chrome su Windows");

  // --- the request bodies --------------------------------------------------------------------------
  const body = { subscription: { endpoint, expirationTime: null, keys: target }, name: "Chrome su Windows" };
  r.check("a browser's subscription is accepted", pushSubscribeSchema.safeParse(body).success);
  r.check("with events, filter and the previous endpoint", pushSubscribeSchema.safeParse({ ...body, events: ["deploy.finished"], filter: "problems", previousEndpoint: endpoint, applicationServerKey: keys.publicKey }).success);
  for (const [label, wrong] of [
    ["no name", { ...body, name: " " }],
    ["a name too long", { ...body, name: "x".repeat(61) }],
    ["a key that is not a point", { ...body, subscription: { ...body.subscription, keys: { ...target, p256dh: b64u(Buffer.alloc(32)) } } }],
    ["a short auth secret", { ...body, subscription: { ...body.subscription, keys: { ...target, auth: "AAAA" } } }],
    ["an event that does not exist", { ...body, events: ["no.such.event"] }],
    ["an unknown field", { ...body, owner: true }],
  ]) {
    const parsed = pushSubscribeSchema.safeParse(wrong);
    r.check(`refused: ${label}, with a sentence`, !parsed.success && /\s/.test(parsed.error.issues[0]?.message ?? ""), parsed.success ? "accepted" : parsed.error.issues[0]?.message);
  }
  r.check("an edit needs something to change", !pushDeviceUpdateSchema.safeParse({}).success);
  r.check("a rename is an edit", pushDeviceUpdateSchema.safeParse({ name: "iPhone di Marco" }).success);
  r.check("switching every event off is an edit", pushDeviceUpdateSchema.safeParse({ events: [] }).success);
  r.check("a sync needs only the endpoint", pushSyncSchema.safeParse({ endpoint }).success && !pushSyncSchema.safeParse({ endpoint, userId: "x" }).success);

  return r.result();
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
