/**
 * A push service and a browser, for the suites, with node:crypto alone.
 *
 * The browser half makes what `pushManager.subscribe` makes — a P-256 key pair
 * and a 16-byte auth secret — and opens what the panel sends with them. It is
 * written apart from lib/web-push.ts on purpose, and differently: HKDF here is
 * node's own `hkdfSync`, where the panel spells out the HMACs as RFC 8291 does.
 * A mistake made the same way twice would pass a round trip; it does not pass
 * two independent derivations and the RFC's own example.
 *
 * The service half is an HTTP server that records every POST and answers 201,
 * or what a path was told to answer (410 for a subscription that is gone).
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
export const fromB64u = (text) => Buffer.from(text.replace(/\s+/g, ""), "base64url");

/** What a browser holds for one subscription. */
export function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth: randomBytes(16) };
}

/** The JSON a browser sends the panel: `PushSubscription.toJSON()`. */
export function subscriptionJson(endpoint, keys) {
  return { endpoint, expirationTime: null, keys: { p256dh: b64u(keys.publicKey), auth: b64u(keys.auth) } };
}

/** Open an `aes128gcm` push body (RFC 8188 header, RFC 8291 keys) the way a browser does. */
export function decryptPush(body, keys) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(keys.privateKey);
  const shared = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), keys.publicKey, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, keys.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("the last record does not end with the 0x02 delimiter");
  return { plaintext: padded.subarray(0, end), recordSize, salt, senderPublic };
}

/**
 * Check a `vapid t=…, k=…` header as a push service does: an ES256 JWT signed
 * by the key it names. Returns the claims and the key, or a reason.
 */
export function verifyVapid(header) {
  const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match) return { ok: false, reason: `not a vapid header: ${header}` };
  const [head, payload, signature] = match[1].split(".");
  const point = fromB64u(match[2]);
  if (point.length !== 65 || point[0] !== 4) return { ok: false, reason: "k is not an uncompressed P-256 point" };
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: "jwk" });
  const signatureBytes = fromB64u(signature);
  const valid = verify("sha256", Buffer.from(`${head}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, signatureBytes);
  let header_ = null;
  let claims = null;
  try {
    header_ = JSON.parse(fromB64u(head).toString("utf8"));
    claims = JSON.parse(fromB64u(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "the token is not JSON" };
  }
  return { ok: valid, reason: valid ? null : "bad signature", header: header_, claims, publicKey: match[2], signatureLength: signatureBytes.length };
}

/** An HTTP push service on a free port of 127.0.0.1. */
export async function startPushService() {
  const received = [];
  const statusFor = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = statusFor.get(req.url) ?? 201;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    received,
    statusFor,
    /** The pushes one endpoint path got so far. */
    to: (path) => received.filter((entry) => entry.path === path),
    /** Wait until `predicate()` is true, or the time is up; answers whether it became true. */
    async until(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return predicate();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
