import crypto from "crypto";
import fs from "fs";
import { Readable } from "stream";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import {
  S3Failure,
  describeS3Exception,
  describeS3Response,
  s3ProblemText,
  type S3Context,
  type S3Operation,
  type S3Problem,
} from "@/lib/s3-errors";
import { archiveContentType } from "../paths";
import type { Destination } from "../types";

/**
 * Backups to S3-compatible object storage.
 *
 * The `Destination` interface was written as the seam for exactly this and then
 * only ever had `local` behind it — which meant every archive lived on the same
 * disk as the thing it was protecting. A backup that dies with the machine is
 * a copy, not a backup.
 *
 * One adapter covers S3, Cloudflare R2, Backblaze B2, MinIO and every other
 * implementation of the same API, because they differ in endpoint and in
 * addressing style, not in protocol.
 *
 * No SDK. The five operations this interface needs are plain HTTPS requests,
 * and SigV4 is a documented HMAC chain over `node:crypto` — about eighty lines,
 * against a dependency tree measured in megabytes that would also have to be
 * kept current. The panel already refuses to vendor what it can state.
 */

export interface S3Config {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, … */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, without leading or trailing slashes. */
  prefix?: string;
  /**
   * `https://s3.example.com/bucket/key` instead of `https://bucket.s3.example.com/key`.
   * MinIO and most self-hosted implementations need it; R2 accepts either.
   */
  forcePathStyle?: boolean;
}

const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

function sha256(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** Percent-encoding as S3 wants it: unreserved characters only, `/` kept in paths. */
function uriEncode(value: string, keepSlash: boolean): string {
  return value
    .split("")
    .map((ch) => {
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      if (ch === "/" && keepSlash) return ch;
      return Array.from(Buffer.from(ch, "utf8"))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign one request with AWS Signature Version 4.
 *
 * The payload hash is `UNSIGNED-PAYLOAD` rather than the real digest. That is
 * the documented option for streamed uploads over HTTPS, and here it is the
 * difference between reading a multi-gigabyte archive twice — once to hash it,
 * once to send it — and reading it once. TLS is what protects the body; the
 * signature still covers the method, path, query and headers.
 */
function sign(
  config: S3Config,
  method: string,
  key: string,
  extraHeaders: Record<string, string> = {}
): SignedRequest {
  const endpoint = new URL(config.endpoint);
  const encodedKey = uriEncode(key, true);

  const pathStyle = config.forcePathStyle ?? false;
  const host = pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = pathStyle ? `/${config.bucket}/${encodedKey}` : `/${encodedKey}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };

  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames
    .map((name) => {
      const value = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
      return `${name}:${String(value).trim()}\n`;
    })
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), SERVICE),
    "aws4_request"
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: `${endpoint.protocol}//${host}${path}`, headers };
}

/** The archive's key in the bucket, prefix included. */
function objectKey(config: S3Config, fileName: string): string {
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${fileName}` : fileName;
}

function isValid(config: Partial<S3Config>): config is S3Config {
  return Boolean(
    config.endpoint && config.region && config.bucket && config.accessKeyId && config.secretAccessKey
  );
}

/** Enough to see a check fail; a backup's own upload has no clock but the socket's. */
const CHECK_TIMEOUT_MS = 20_000;
/** An error document is a few hundred bytes; anything past this is not one. */
const MAX_ERROR_BODY = 16 * 1024;

async function errorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text;
  } catch {
    return "";
  }
}

function contextOf(cfg: S3Config, operation: S3Operation): S3Context {
  return {
    operation,
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
    pathStyle: cfg.forcePathStyle ?? false,
  };
}

/**
 * One signed request, with every way it can fail turned into an `S3Failure`
 * whose message is already the Italian cause and fix.
 */
async function request(
  cfg: S3Config,
  operation: S3Operation,
  method: string,
  key: string,
  init: { headers?: Record<string, string>; body?: BodyInit; stream?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const signed = sign(cfg, method, key, init.headers);
  try {
    return await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: init.body,
      ...(init.stream ? { duplex: "half" } : {}),
      ...(init.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
    } as RequestInit & { duplex?: "half" });
  } catch (err) {
    throw new S3Failure(describeS3Exception(err, contextOf(cfg, operation)));
  }
}

async function refusal(cfg: S3Config, operation: S3Operation, res: Response): Promise<S3Failure> {
  const body = res.status === 304 || operation === "stat" ? "" : await errorBody(res);
  return new S3Failure(describeS3Response({ status: res.status, body, headers: res.headers }, contextOf(cfg, operation)));
}

/**
 * Why a write is refused, asked with a few bytes instead of an archive.
 *
 * A service that refuses a large upload often answers before the body is sent
 * and closes the connection, and Node then reports a reset rather than the
 * service's reason. A tiny write gets the reason back as a document.
 */
async function diagnoseWrite(cfg: S3Config): Promise<S3Problem | null> {
  const key = objectKey(cfg, `.runpanel-write-test-${Date.now()}`);
  try {
    const body = Buffer.from("runpanel");
    const res = await request(cfg, "upload", "PUT", key, {
      headers: { "content-length": String(body.byteLength), "content-type": "text/plain" },
      body,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    if (!res.ok) return (await refusal(cfg, "upload", res)).problem;
    await request(cfg, "delete", "DELETE", key, { timeoutMs: CHECK_TIMEOUT_MS }).catch(() => null);
    return null;
  } catch (err) {
    return err instanceof S3Failure ? err.problem : null;
  }
}

export function s3Destination(
  row: BackupDestinationsTable,
  raw: Record<string, unknown>
): Destination {
  const config = raw as unknown as Partial<S3Config>;

  function requireConfig(): S3Config {
    if (!isValid(config)) {
      throw new Error(
        "Configurazione S3 incompleta: servono endpoint, regione, bucket e le due chiavi. Modifica la destinazione e completala."
      );
    }
    return config;
  }

  async function stat(ref: string): Promise<{ bytes: number; exists: boolean }> {
    const cfg = requireConfig();
    const res = await request(cfg, "stat", "HEAD", ref, { timeoutMs: CHECK_TIMEOUT_MS * 2 });
    if (res.status === 404) return { bytes: 0, exists: false };
    if (!res.ok) throw await refusal(cfg, "stat", res);
    return { bytes: Number(res.headers.get("content-length") ?? 0), exists: true };
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath, fileName) {
      const cfg = requireConfig();
      const { size } = await fs.promises.stat(localPath);
      const key = objectKey(cfg, fileName);

      let res: Response;
      try {
        res = await request(cfg, "upload", "PUT", key, {
          // An encrypted archive is not a zip anyone can open: no viewer should try.
          headers: { "content-length": String(size), "content-type": archiveContentType(fileName) },
          // Streamed, not buffered: an archive is routinely larger than the heap.
          body: Readable.toWeb(fs.createReadStream(localPath)) as ReadableStream,
          // Required by undici whenever the body is a stream.
          stream: true,
        });
      } catch (err) {
        const problem = err instanceof S3Failure ? err.problem : null;
        if (problem && (problem.code === "RESET" || problem.code === "STALLED")) {
          const reason = await diagnoseWrite(cfg);
          if (reason) throw new S3Failure(reason);
        }
        throw err;
      }
      if (!res.ok) throw await refusal(cfg, "upload", res);

      // A 200 says the service took the request; the size it reports is what
      // it actually kept. A key allowed to write but not to read cannot ask,
      // and that is a legitimate setup (a bucket nobody can read back from
      // here), so only a definite mismatch fails the run.
      const kept = await stat(key).catch(() => null);
      if (kept?.exists && kept.bytes !== size) {
        throw new Error(
          `Il bucket ha conservato ${kept.bytes} byte invece di ${size}: l'archivio caricato è incompleto. Riprova il backup.`
        );
      }

      return { ref: key, bytes: size };
    },

    async remove(ref) {
      const cfg = requireConfig();
      const res = await request(cfg, "delete", "DELETE", ref, { timeoutMs: CHECK_TIMEOUT_MS * 2 });
      // 404 means the object is already gone, which is the state we wanted.
      if (!res.ok && res.status !== 404) throw await refusal(cfg, "delete", res);
    },

    async open(ref): Promise<Readable> {
      const cfg = requireConfig();
      const res = await request(cfg, "download", "GET", ref);
      if (!res.ok || !res.body) throw await refusal(cfg, "download", res);
      return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    },

    stat,

    // Two destinations on the same bucket and prefix would put the same key
    // twice: one object, and deleting either copy would delete both.
    location() {
      let host = String(config.endpoint ?? "");
      try {
        host = new URL(host).host;
      } catch {
        /* an endpoint that is not a URL is compared as typed */
      }
      const prefix = String(config.prefix ?? "").replace(/^\/+|\/+$/g, "");
      return `s3:${host.toLowerCase()}/${config.bucket ?? ""}/${prefix}`;
    },

    /**
     * Writes, reads back and deletes a marker rather than only listing.
     *
     * A read-only key passes any check that just looks, and then fails on the
     * night of the first scheduled backup; a write-only one uploads fine and
     * cannot restore. The point of this button is to find either out now.
     */
    async test() {
      let cfg: S3Config;
      try {
        cfg = requireConfig();
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Configurazione non valida" };
      }

      const key = objectKey(cfg, `.runpanel-write-test-${Date.now()}`);
      const marker = `runpanel ${Date.now()}`;
      const failed = (step: string, err: unknown) => {
        const problem = err instanceof S3Failure ? err.problem : describeS3Exception(err, contextOf(cfg, "write-test"));
        return { ok: false, message: `${step}${s3ProblemText(problem)}`, code: problem.code, detail: problem.detail };
      };

      try {
        const body = Buffer.from(marker);
        const written = await request(cfg, "write-test", "PUT", key, {
          headers: { "content-length": String(body.byteLength), "content-type": "text/plain" },
          body,
          timeoutMs: CHECK_TIMEOUT_MS,
        });
        if (!written.ok) throw await refusal(cfg, "write-test", written);
      } catch (err) {
        return failed("", err);
      }

      try {
        const read = await request(cfg, "read-test", "GET", key, { timeoutMs: CHECK_TIMEOUT_MS });
        if (!read.ok) throw await refusal(cfg, "read-test", read);
        const text = await read.text();
        if (text !== marker) {
          return {
            ok: false,
            message:
              "La scrittura funziona, ma rileggendo il file il servizio ha restituito un contenuto diverso. " +
              "Controlla l'endpoint: tra il pannello e il servizio potrebbe esserci un proxy o una cache.",
          };
        }
      } catch (err) {
        // The marker stays behind: removing it would need the very access that
        // just failed to be checked, and it is a few bytes.
        return failed("La scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. ", err);
      }

      try {
        const removed = await request(cfg, "delete-test", "DELETE", key, { timeoutMs: CHECK_TIMEOUT_MS });
        if (!removed.ok && removed.status !== 404) throw await refusal(cfg, "delete-test", removed);
      } catch (err) {
        const problem = err instanceof S3Failure ? err.problem : describeS3Exception(err, contextOf(cfg, "delete-test"));
        // Not a failure: a bucket where nothing can be deleted is a deliberate
        // protection against ransomware. It does mean retention cannot work.
        return {
          ok: true,
          warning: true,
          message:
            `Bucket ${cfg.bucket} raggiungibile: scrittura e lettura riuscite. L'eliminazione è stata rifiutata, ` +
            "il che va bene se il bucket è protetto apposta, ma allora gli archivi vecchi non verranno cancellati " +
            "dalla retention: dovrai farlo dal sito del servizio.",
          code: problem.code,
          detail: problem.detail,
        };
      }

      return { ok: true, message: `Bucket ${cfg.bucket} raggiungibile: scrittura, lettura ed eliminazione riuscite.` };
    },
  };
}
