import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Web Push, the two halves the panel has to do itself: telling the push
 * service who is sending (VAPID, RFC 8292) and sealing the message so that
 * only the browser it is for can open it (RFC 8291, the `aes128gcm` content
 * coding of RFC 8188).
 *
 * Both are a few dozen lines on top of node:crypto, which is why there is no
 * dependency for them: the `web-push` package does the same with more options
 * the panel has no use for (the old `aesgcm` coding, GCM keys, proxies), and
 * one more package that handles keys is one more to audit.
 *
 * The push service — Google's, Apple's, Mozilla's — sees who sent a message
 * and to which subscription, never what it says: that is between the panel
 * and the browser, keyed by the secrets the browser handed over when it
 * subscribed.
 *
 * Server only, and no `@/` import: the unit suite loads this file on its own
 * and checks it against the RFC's own example.
 */

/** The panel's VAPID identity: base64url, an uncompressed P-256 point (65 bytes) and its scalar (32). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** What a browser hands over when it subscribes, as `PushSubscription.toJSON()` writes it. */
export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url, uncompressed (65 bytes). */
  p256dh: string;
  /** The shared authentication secret, base64url (16 bytes). */
  auth: string;
}

/**
 * The record size written in the header. One record is all a push message can
 * be (RFC 8291 §4), so this is also the largest message: 4096 is what every
 * push service accepts, and the header and the tag come out of it.
 */
export const PUSH_RECORD_SIZE = 4096;

const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;

/** The most plaintext one record carries: the header, the tag and the delimiter octet come out of 4096. */
export const MAX_PUSH_PLAINTEXT = PUSH_RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** A fresh VAPID key pair. Made once per panel and kept sealed with the panel's key (services/notify/push-keys.ts). */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("La chiave generata non ha le coordinate attese");
  const point = Buffer.concat([Buffer.from([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y)]);
  return { publicKey: toBase64Url(point), privateKey: jwk.d };
}

/** Whether a stored pair is the shape the rest of this file assumes, and its halves belong together. */
export function isVapidKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== "object") return false;
  const { publicKey, privateKey } = value as Record<string, unknown>;
  if (typeof publicKey !== "string" || typeof privateKey !== "string") return false;
  const point = fromBase64Url(publicKey);
  if (point.length !== 65 || point[0] !== 4 || fromBase64Url(privateKey).length !== 32) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromBase64Url(privateKey));
    return ecdh.getPublicKey().equals(point);
  } catch {
    return false;
  }
}

/**
 * The private half as a key node:crypto signs with. JWK, because that is the
 * one import format that takes the raw scalar and the point as they are.
 */
function signingKey(keys: VapidKeys): KeyObject {
  const point = fromBase64Url(keys.publicKey);
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/**
 * The signed claim a push service checks before it accepts a message: who it
 * is for (`aud`, the push service's own origin), until when (`exp`), and whom
 * to contact about it (`sub`).
 *
 * ES256 as JWS wants it: the signature is r and s side by side, 64 bytes, not
 * the DER sequence node:crypto writes by default.
 */
export function vapidJwt(claims: { aud: string; exp: number; sub: string }, keys: VapidKeys): string {
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = toBase64Url(Buffer.from(JSON.stringify({ aud: claims.aud, exp: claims.exp, sub: claims.sub })));
  const input = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), { key: signingKey(keys), dsaEncoding: "ieee-p1363" });
  return `${input}.${toBase64Url(signature)}`;
}

/**
 * How long a signature is good for. RFC 8292 caps it at a day; half of that
 * leaves room for a clock that runs fast without the token being refused.
 */
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

/** The `Authorization` header for one message to one endpoint. */
export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now / 1000) + VAPID_TTL_SECONDS;
  return `vapid t=${vapidJwt({ aud, exp, sub: subject }, keys)}, k=${keys.publicKey}`;
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** `label`, a zero octet, then what follows — the shape of every info string in RFC 8291 and 8188. */
function info(label: string, ...rest: Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(label, "latin1"), Buffer.from([0]), ...rest]);
}

const ONE = Buffer.from([1]);

/**
 * Seal one message for one subscription: the body of the POST, header and all.
 *
 * Every message gets its own key pair and salt, so two messages with the same
 * text do not look alike to anyone in between. `salt` and `senderPrivateKey`
 * exist for the RFC's test vector, which fixes both; nothing else passes them.
 */
export function encryptPush(
  plaintext: Uint8Array | string,
  target: Pick<PushTarget, "p256dh" | "auth">,
  options: { salt?: Uint8Array; senderPrivateKey?: Uint8Array } = {}
): Buffer {
  const message = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  if (message.length > MAX_PUSH_PLAINTEXT) {
    throw new Error(`Messaggio troppo lungo per una notifica push: ${message.length} byte, al massimo ${MAX_PUSH_PLAINTEXT}`);
  }
  const uaPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("La chiave del browser (p256dh) non è valida");
  if (authSecret.length !== 16) throw new Error("Il segreto del browser (auth) non è valido");

  const sender = createECDH("prime256v1");
  if (options.senderPrivateKey) sender.setPrivateKey(Buffer.from(options.senderPrivateKey));
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt = options.salt ? Buffer.from(options.salt) : randomBytes(16);
  if (salt.length !== 16) throw new Error("Il sale deve essere di 16 byte");

  // RFC 8291 §3.3-3.4: the ECDH secret and the browser's auth secret make the
  // input key; RFC 8188 then derives the content key and the nonce from it.
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([info("WebPush: info", uaPublic, asPublic), ONE]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([info("Content-Encoding: aes128gcm"), ONE])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info("Content-Encoding: nonce"), ONE])).subarray(0, 12);

  // One record, the last one: its padding starts with the delimiter 0x02.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([message, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(PUSH_RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * The `Topic` header for a tag: a push service keeps only the newest message
 * per topic for a device that is offline, so a phone that comes back after a
 * night gets one message per project, not the whole night. At most 32
 * characters of the URL-safe alphabet (RFC 8030 §5.4), hence a hash.
 */
export function pushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** How the panel recognises an endpoint without keeping it in the clear: lookups, uniqueness, the browser's own match. */
export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}
