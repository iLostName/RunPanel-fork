import crypto from "node:crypto";

/**
 * The key pair the panel generates for an SFTP destination, and the server's
 * host key it learns on first use.
 *
 * One Ed25519 pair per destination, made here with `node:crypto` rather than by
 * running `ssh-keygen`: the private key then never touches the disk until a
 * connection needs it, and the panel needs no binary to create a destination.
 * The private half is written in OpenSSH's own format (`openssh-key-v1`),
 * which every OpenSSH since 6.5 reads, so `ssh -i` takes it as it is. Ed25519
 * because every NAS, storage box and Linux server of the last ten years accepts
 * it, and because its keys are short enough to paste.
 *
 * Only `node:` imports, so the unit suite loads it directly and checks the
 * output against the real `ssh-keygen` when one is installed.
 */

export interface SshKeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----…`, unencrypted: the destination's config is encrypted whole. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment`: the line that goes into `authorized_keys`. */
  publicKey: string;
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

/** Host key types OpenSSH writes into known_hosts. */
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

/** An SSH wire `string`: a length, then the bytes. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** Reads SSH wire strings in sequence; null once the input is malformed. */
function readStrings(blob: Buffer, count: number): Buffer[] | null {
  const out: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 4 > blob.length) return null;
    const length = blob.readUInt32BE(at);
    at += 4;
    if (at + length > blob.length) return null;
    out.push(blob.subarray(at, at + length));
    at += length;
  }
  return out;
}

function base64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** `SHA256:` and the unpadded base64 digest of the key blob, exactly as OpenSSH shows it. */
export function fingerprintOfBlob(blob: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** A comment safe for an `authorized_keys` line: no spaces, nothing a shell or a parser trips on. */
export function keyComment(hostname: string): string {
  const host = hostname.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 60) || "server";
  return `runpanel-backup@${host}`;
}

/** A new Ed25519 pair for one destination. */
export function generateSshKeyPair(comment: string): SshKeyPair {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) throw new Error("Generazione della chiave non riuscita");
  const seed = base64url(jwk.d);
  const pub = base64url(jwk.x);
  if (seed.length !== 32 || pub.length !== 32) throw new Error("Generazione della chiave non riuscita");

  const safeComment = comment.replace(/[\r\n]/g, " ").trim();
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);

  // The private section, as sshkey_private_to_blob2 lays it out: two equal
  // check integers (how OpenSSH tells a wrong passphrase from a corrupt file),
  // the key type, the public key, the 64-byte secret (seed then public key),
  // the comment, and padding 1, 2, 3… up to the cipher's block size — 8 for
  // "none".
  const check = crypto.randomBytes(4);
  let section = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(safeComment),
  ]);
  const padding: number[] = [];
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i++) padding.push(i);
  section = Buffer.concat([section, Buffer.from(padding)]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    u32(1),
    sshString(blob),
    sshString(section),
  ]);
  const wrapped = body.toString("base64").match(/.{1,70}/g)?.join("\n") ?? "";

  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString("base64")}${safeComment ? ` ${safeComment}` : ""}`,
    fingerprint: fingerprintOfBlob(blob),
  };
}

export interface ParsedPublicKey {
  type: string;
  blob: Buffer;
  /** `type base64`, without the comment: the form known_hosts and the pin are kept in. */
  key: string;
}

/**
 * `ssh-ed25519 AAAA… comment` read back, or null when it is not a key.
 *
 * The type written in front has to be the type inside the blob: a mismatch is
 * a pasted mix of two keys, or a forgery, and either way not something to pin.
 */
export function parsePublicKey(line: string): ParsedPublicKey | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, data] = parts;
  if (!KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,3}$/.test(data)) return null;
  const blob = Buffer.from(data, "base64");
  const [inner] = readStrings(blob, 1) ?? [];
  if (!inner || inner.toString("utf8") !== type) return null;
  return { type, blob, key: `${type} ${blob.toString("base64")}` };
}

export function fingerprintOf(line: string): string | null {
  const parsed = parsePublicKey(line);
  return parsed ? fingerprintOfBlob(parsed.blob) : null;
}

/** The name ssh files the destination's host key under, whatever the host is called. */
export const HOST_KEY_ALIAS = "runpanel-destination";

/** The known_hosts file for a pinned key: one line, under the alias. */
export function knownHostsFor(key: string): string {
  const parsed = parsePublicKey(key);
  if (!parsed) throw new Error("Chiave del server non valida");
  return `${HOST_KEY_ALIAS} ${parsed.key}\n`;
}

/**
 * The host key `ssh` accepted on first use, read from the known_hosts file it
 * wrote with `StrictHostKeyChecking=accept-new`.
 *
 * That key is the one the server proved it holds during the key exchange,
 * which is what makes it worth pinning: the panel never trusts a key it was
 * merely told about.
 */
export function learnedHostKey(knownHosts: string): string | null {
  for (const raw of knownHosts.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    const [names, ...rest] = line.split(/\s+/);
    if (!names.split(",").includes(HOST_KEY_ALIAS)) continue;
    const parsed = parsePublicKey(rest.join(" "));
    if (parsed) return parsed.key;
  }
  return null;
}
