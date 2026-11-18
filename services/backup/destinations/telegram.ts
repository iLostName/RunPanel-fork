import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { formatBytes } from "@/lib/format";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import type { Destination, DestinationCheck, DestinationStat, PutOptions } from "../types";

/**
 * Backups kept on Telegram, through the user's own account.
 *
 * An account and not a bot: a bot uploads 50 MB at most, which is one database
 * dump, not a night's archive. An account uploads files of up to 2000 MiB, and
 * 4000 MiB with Telegram Premium — and Premium can lapse, so it is read from
 * the account at every run rather than remembered.
 *
 * An archive larger than one file is split into parts, each its own document
 * with a caption that names the archive, the part (2 of 3) and its sha256. The
 * stored reference lists the messages in order, so `open` streams them back as
 * the one archive the restore expects, and `remove` deletes every one of them.
 *
 * This file holds everything that decides what goes where — the split, the
 * captions, the reference, the reassembly, the retry policy, the Italian
 * explanations — behind `TelegramTransport`, a handful of calls. The calls
 * themselves, MTProto through GramJS, live in `telegram-client.ts` and are
 * loaded only when a Telegram destination is used: the library costs 15 MB of
 * heap and half a second to load, which a panel without Telegram should not
 * pay. It also means `tests/suites/backup-telegram-unit.mjs` runs all of this
 * against a fake account, with no network.
 */

// --- What Telegram allows ----------------------------------------------------

/**
 * The upload piece: the largest Telegram accepts. A piece must be a multiple of
 * 1 KiB that divides 512 KiB evenly (upload.saveBigFilePart), and the bigger the
 * piece, the larger the file the part count allows.
 */
export const TELEGRAM_CHUNK_BYTES = 512 * 1024;

/**
 * How many pieces one file may have: `upload_max_fileparts_default` and
 * `upload_max_fileparts_premium` in the app config Telegram publishes, 4000 and
 * 8000 when this was written. Times 512 KiB, that is the familiar 2000 MiB and
 * 4000 MiB. The transport asks Telegram at every run and only ever goes lower
 * than these: a limit raised one day is a limit that can be lowered back.
 */
export const TELEGRAM_MAX_FILE_PARTS = { regular: 4000, premium: 8000 } as const;

/**
 * Pieces kept free below the ceiling: 20 MiB. A part exactly at the limit
 * works on paper and is the first thing to fail on the day the limit is
 * counted differently.
 */
export const TELEGRAM_MARGIN_CHUNKS = 40;

/** Bytes in one part of an archive, for a ceiling of `maxParts` pieces. */
export function partBytesFor(
  maxParts: number,
  chunkBytes: number = TELEGRAM_CHUNK_BYTES,
  marginChunks: number = TELEGRAM_MARGIN_CHUNKS
): number {
  return Math.max(1, Math.floor(maxParts) - marginChunks) * chunkBytes;
}

export interface PlannedPart {
  index: number;
  offset: number;
  length: number;
}

/** Where each part starts and how long it is. Every part is full but the last. */
export function planParts(total: number, partBytes: number): PlannedPart[] {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("L'archivio è vuoto");
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) throw new Error("Dimensione delle parti non valida");
  const parts: PlannedPart[] = [];
  for (let offset = 0, index = 0; offset < total; offset += partBytes, index++) {
    parts.push({ index, offset, length: Math.min(partBytes, total - offset) });
  }
  return parts;
}

/**
 * A part's file name on Telegram: the archive's own name when it fits in one,
 * `….zip.enc.001`, `.002`… when it does not. Zero-padded, so a shell's
 * alphabetical `cat name.*` puts them back in order without the panel.
 */
export function partFileName(fileName: string, index: number, count: number): string {
  if (count <= 1) return fileName;
  return `${fileName}.${String(index + 1).padStart(Math.max(3, String(count).length), "0")}`;
}

// --- Captions ------------------------------------------------------------------

export interface PartCaption {
  fileName: string;
  index: number;
  count: number;
  bytes: number;
  sha256: string;
}

/**
 * The caption under each part: what someone scrolling the channel needs to
 * know without the panel, and what `open` checks before trusting a message to
 * be the part the reference says it is.
 */
export function partCaption(part: PartCaption): string {
  const lines = [
    "RunPanel · archivio di backup",
    part.fileName,
    `Parte ${part.index + 1} di ${part.count} · ${formatBytes(part.bytes)} (${part.bytes} byte)`,
    `sha256 ${part.sha256}`,
  ];
  if (part.count > 1) lines.push(`Per ricomporlo: cat ${part.fileName}.* > ${part.fileName}`);
  return lines.join("\n");
}

export interface ParsedCaption {
  fileName: string | null;
  index: number;
  count: number;
  bytes: number | null;
  sha256: string | null;
}

/** Null for a caption that is not one of ours, or was edited past recognition. */
export function parseCaption(text: string | null | undefined): ParsedCaption | null {
  if (!text) return null;
  const part = /^Parte (\d+) di (\d+)\b/m.exec(text);
  if (!part) return null;
  const lines = text.split("\n");
  const sha = /^sha256 ([0-9a-f]{64})$/m.exec(text);
  const bytes = /\((\d+) byte\)/.exec(text);
  return {
    fileName: lines[0]?.startsWith("RunPanel") ? lines[1]?.trim() || null : null,
    index: Number(part[1]) - 1,
    count: Number(part[2]),
    bytes: bytes ? Number(bytes[1]) : null,
    sha256: sha?.[1] ?? null,
  };
}

// --- The reference stored with the run ------------------------------------------

/**
 * Everything needed to find an archive again and put it back together:
 *
 *   tg1:<chat>:<part bytes>:<total bytes>:<message id>,<message id>…/<file name>
 *
 * `chat` is `me` (Saved Messages) or `c<channel id>`. The ids are in part
 * order, which is the order the archive is rebuilt in — message ids are not
 * guaranteed to be consecutive, or even ascending, when something else is
 * posted in between. The part size and the total give every part's expected
 * length, so a missing or truncated one is found before a byte is downloaded.
 * The file name comes last so that `path.basename(ref)`, which the download
 * route uses for the browser's file name, is the archive's name.
 */
export interface TelegramRef {
  chat: string;
  partBytes: number;
  total: number;
  ids: number[];
  fileName: string;
}

const MAX_MESSAGE_ID = 2 ** 31 - 1;

export function encodeTelegramRef(ref: TelegramRef): string {
  return `tg1:${ref.chat}:${ref.partBytes}:${ref.total}:${ref.ids.join(",")}/${ref.fileName}`;
}

export function parseTelegramRef(text: string): TelegramRef | null {
  const m = /^tg1:(me|c\d{1,20}):(\d{1,16}):(\d{1,16}):(\d{1,10}(?:,\d{1,10})*)\/([^/\\]+)$/.exec(text);
  if (!m) return null;
  const partBytes = Number(m[2]);
  const total = Number(m[3]);
  const ids = m[4].split(",").map(Number);
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) return null;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  if (ids.some((id) => id <= 0 || id > MAX_MESSAGE_ID)) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (ids.length !== Math.ceil(total / partBytes)) return null;
  return { chat: m[1], partBytes, total, ids, fileName: m[5] };
}

/** The length each part of a stored archive must have. */
export function partSizes(ref: TelegramRef): number[] {
  return planParts(ref.total, ref.partBytes).map((part) => part.length);
}

// --- Configuration ---------------------------------------------------------------

/** Where the archives go: a channel the panel created, or the account's Saved Messages. */
export type TelegramChat =
  | { kind: "saved" }
  | { kind: "channel"; id: string; accessHash: string; title: string };

export interface TelegramAccount {
  id: string;
  name: string;
  username: string | null;
  premium: boolean;
}

/**
 * What the destination row holds, encrypted with the panel key like every
 * destination config. `session` is the account's authorization: it is written
 * here by the login and read back only by the server, never sent to a browser.
 */
export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  session: string;
  chat: TelegramChat;
  /** Who was linked, for the edit form and to notice a different account on a re-link. */
  account?: { id: string; name: string; username: string | null };
}

export function readTelegramChat(raw: unknown): TelegramChat | null {
  if (!raw || typeof raw !== "object") return null;
  const chat = raw as Record<string, unknown>;
  if (chat.kind === "saved") return { kind: "saved" };
  if (
    chat.kind === "channel" &&
    typeof chat.id === "string" &&
    /^\d{1,20}$/.test(chat.id) &&
    typeof chat.accessHash === "string" &&
    /^-?\d{1,20}$/.test(chat.accessHash)
  ) {
    return { kind: "channel", id: chat.id, accessHash: chat.accessHash, title: typeof chat.title === "string" ? chat.title : "" };
  }
  return null;
}

/** Null when something the transport needs is missing: the config was never completed, or not readable. */
export function readTelegramConfig(raw: Record<string, unknown>): TelegramConfig | null {
  const chat = readTelegramChat(raw.chat);
  const apiId = typeof raw.apiId === "number" ? raw.apiId : Number(raw.apiId);
  if (!chat || !Number.isInteger(apiId) || apiId <= 0) return null;
  if (typeof raw.apiHash !== "string" || !raw.apiHash || typeof raw.session !== "string" || !raw.session) return null;
  const account = raw.account && typeof raw.account === "object" ? (raw.account as Record<string, unknown>) : null;
  return {
    apiId,
    apiHash: raw.apiHash,
    session: raw.session,
    chat,
    ...(account && typeof account.id === "string"
      ? {
          account: {
            id: account.id,
            name: typeof account.name === "string" ? account.name : "",
            username: typeof account.username === "string" ? account.username : null,
          },
        }
      : {}),
  };
}

export function chatKey(chat: TelegramChat): string {
  return chat.kind === "saved" ? "me" : `c${chat.id}`;
}

/** «canale «Backup di srv1»» or «Messaggi salvati», for sentences. */
export function chatLabel(chat: TelegramChat): string {
  return chat.kind === "saved" ? "i Messaggi salvati" : `il canale «${chat.title || chat.id}»`;
}

export function accountLabel(account: { name: string; username: string | null }): string {
  const name = account.name.trim();
  if (account.username) return name ? `${name} (@${account.username})` : `@${account.username}`;
  return name || "account senza nome";
}

// --- The transport -------------------------------------------------------------

/** One message of the archive, as far as the reassembly cares. */
export interface TelegramDocument {
  messageId: number;
  bytes: number;
  caption: string;
  fileName: string | null;
}

export interface UploadInput {
  /** The bytes, in pieces of `chunkBytes` (the last one shorter), in order. */
  chunks: AsyncIterable<Buffer>;
  bytes: number;
  chunkBytes: number;
  fileName: string;
  signal?: AbortSignal;
  /** Bytes Telegram has confirmed so far. */
  onProgress?: (sent: number) => void;
  /** Telegram asked to slow down for this long; the transport waits and carries on. */
  onWait?: (seconds: number) => void;
}

/**
 * The calls the destination makes, and nothing about how. Implemented with
 * GramJS in `telegram-client.ts` and by an in-memory fake in the unit suite.
 */
export interface TelegramTransport {
  account(): Promise<TelegramAccount>;
  /** Upload pieces per file Telegram allows this account, never above `TELEGRAM_MAX_FILE_PARTS`. */
  maxFileParts(premium: boolean): Promise<number>;
  /** Upload a file without posting it yet; the handle goes to `post`. */
  upload(input: UploadInput): Promise<unknown>;
  /** Post an uploaded file as a document with a caption; returns the message id. */
  post(chat: TelegramChat, file: unknown, input: { fileName: string; caption: string; bytes: number; signal?: AbortSignal }): Promise<number>;
  /** The messages, aligned with `ids`; null where one is gone or is not a document. */
  documents(chat: TelegramChat, ids: number[]): Promise<(TelegramDocument | null)[]>;
  /** A document's bytes, from the start, in order. */
  download(chat: TelegramChat, messageId: number, options?: { signal?: AbortSignal }): AsyncIterable<Buffer>;
  remove(chat: TelegramChat, ids: number[]): Promise<void>;
  close(): Promise<void>;
}

export type TelegramConnect = (config: TelegramConfig) => Promise<TelegramTransport>;

// --- Errors ----------------------------------------------------------------------

/**
 * A failure whose message is already the Italian sentence to show. `code` is
 * Telegram's (`FLOOD_WAIT_120`), `detail` the library's own words: both for
 * the run log and expert mode, neither ever holding a secret.
 */
export class TelegramFailure extends Error {
  code: string | null;
  detail: string | null;
  constructor(message: string, code: string | null = null, detail: string | null = null) {
    super(message);
    this.name = "TelegramFailure";
    this.code = code;
    this.detail = detail;
  }
}

export class TelegramTimeoutError extends Error {
  code: string;
  constructor(what: string, ms: number) {
    super(`Nessuna risposta da Telegram in ${Math.round(ms / 1000)} secondi (${what})`);
    this.name = "TelegramTimeoutError";
    this.code = "TIMEOUT";
  }
}

export type TelegramProblemKind =
  | "revoked"
  | "deactivated"
  | "flood"
  | "migrate"
  | "file-reference"
  | "chat"
  | "rights"
  | "app"
  | "file"
  | "transient"
  | "network"
  | "timeout"
  | "aborted"
  | "other";

export interface TelegramProblem {
  kind: TelegramProblemKind;
  /** Telegram's error, `FLOOD_WAIT_120` and the like, or a socket code. */
  code: string | null;
  seconds?: number;
  newDc?: number;
}

const REVOKED = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_PERM_EMPTY",
  // The same session used from two places at once: Telegram ends it.
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
]);
const DEACTIVATED = new Set(["USER_DEACTIVATED", "USER_DEACTIVATED_BAN"]);
const CHAT_GONE = new Set([
  "CHANNEL_INVALID",
  "CHANNEL_PRIVATE",
  "CHAT_ID_INVALID",
  "CHAT_INVALID",
  "PEER_ID_INVALID",
  "CHANNEL_PUBLIC_GROUP_NA",
]);
const NO_RIGHTS = new Set([
  "CHAT_WRITE_FORBIDDEN",
  "CHAT_ADMIN_REQUIRED",
  "CHAT_SEND_MEDIA_FORBIDDEN",
  "CHAT_SEND_DOCS_FORBIDDEN",
  "MESSAGE_DELETE_FORBIDDEN",
  "USER_BANNED_IN_CHANNEL",
  "CHAT_RESTRICTED",
]);
const BAD_APP = new Set(["API_ID_INVALID", "API_ID_PUBLISHED_FLOOD"]);
const TRANSIENT = /^(TIMEOUT|RPC_CALL_FAIL|RPC_MCGET_FAIL|INTERDC_\d+_CALL(_RICH)?_ERROR|MSG_WAIT_FAILED|MEMBER_OCCUPY_PRIMARY_LOC_FAILED|WORKER_BUSY_TOO_LONG_RETRY|NEED_MEMBER_INVALID|INTERNAL|-503)/;
const SOCKET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED"]);

function errorField(err: unknown, key: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
}

/**
 * What kind of failure an error is, read from its shape rather than its class:
 * GramJS's errors carry `errorMessage` (`FLOOD_WAIT_120`), `seconds` and
 * `newDc`, and this file must not import GramJS to recognise them.
 */
export function classifyTelegramError(err: unknown): TelegramProblem {
  // Already explained: the code it kept still says what kind of failure it was.
  if (err instanceof TelegramFailure) return err.code ? classifyTelegramError({ errorMessage: err.code }) : { kind: "other", code: null };
  const name = errorField(err, "name");
  if (name === "AbortError") return { kind: "aborted", code: null };
  if (name === "TelegramTimeoutError") return { kind: "timeout", code: "TIMEOUT" };

  const message = errorField(err, "errorMessage");
  const code = typeof message === "string" ? message : null;
  if (code) {
    const seconds = Number(errorField(err, "seconds"));
    if (/^(FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)$/.test(code)) {
      const fromCode = Number(/_(\d+)$/.exec(code)?.[1]);
      return { kind: "flood", code, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : fromCode };
    }
    if (/_MIGRATE_(\d+)$/.test(code)) {
      const newDc = Number(errorField(err, "newDc"));
      return { kind: "migrate", code, newDc: Number.isFinite(newDc) && newDc > 0 ? newDc : Number(/_(\d+)$/.exec(code)?.[1]) };
    }
    if (REVOKED.has(code)) return { kind: "revoked", code };
    if (DEACTIVATED.has(code)) return { kind: "deactivated", code };
    if (code === "FILE_REFERENCE_EXPIRED" || code === "FILE_REFERENCE_INVALID") return { kind: "file-reference", code };
    if (CHAT_GONE.has(code)) return { kind: "chat", code };
    if (NO_RIGHTS.has(code)) return { kind: "rights", code };
    if (BAD_APP.has(code)) return { kind: "app", code };
    if (/^FILE_PART|^FILE_PARTS_INVALID|^FILE_ID_INVALID|^MD5_CHECKSUM_INVALID/.test(code)) return { kind: "file", code };
    if (TRANSIENT.test(code)) return { kind: "transient", code };
    // Unauthorized without a name we know: the session is not usable.
    if (errorField(err, "code") === 401) return { kind: "revoked", code };
    return { kind: "other", code };
  }

  const socket = errorField(err, "code");
  if (typeof socket === "string" && SOCKET.has(socket)) return { kind: "network", code: socket };
  const text = err instanceof Error ? err.message : String(err ?? "");
  // GramJS's own words when the connection is gone, between two reconnects.
  if (/disconnected|not connected|connection closed|reconnect|socket|Request was unsuccessful/i.test(text)) {
    return { kind: "network", code: null };
  }
  return { kind: "other", code: null };
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} secondi`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minuti`;
  return `${Math.round(seconds / 3600)} ore`;
}

/** The sentence a person acts on, for any error a Telegram call can end in. */
export function telegramProblemText(err: unknown): string {
  if (err instanceof TelegramFailure) return err.message;
  const problem = classifyTelegramError(err);
  switch (problem.kind) {
    case "revoked":
      return "Sessione chiusa dall'app di Telegram, o scaduta: ricollega l'account dalla destinazione (Modifica › Ricollega l'account).";
    case "deactivated":
      return "L'account Telegram è stato disattivato o bloccato: collega un altro account dalla destinazione (Modifica › Ricollega l'account).";
    case "flood":
      return `Telegram chiede di aspettare ${waitText(problem.seconds ?? 0)} prima di continuare: troppe richieste in poco tempo. Riprova più tardi.`;
    case "chat":
      return "Il canale degli archivi non esiste più, o questo account non ne fa più parte.";
    case "rights":
      return "L'account non ha più il permesso di scrivere o cancellare in quella chat: controlla che sia ancora amministratore del canale.";
    case "app":
      return "api_id e api_hash non sono validi: ricontrollali su my.telegram.org, in API development tools.";
    case "file":
      return "Telegram ha rifiutato il file caricato. Riprova: se succede di nuovo, il file sul disco è cambiato durante il caricamento.";
    case "file-reference":
      return "Telegram ha rifiutato il riferimento al file, scaduto durante il trasferimento. Riprova.";
    case "timeout":
      return "Telegram non ha risposto in tempo. Riprova più tardi.";
    case "network":
      return "Non riesco a raggiungere Telegram: controlla che questo server possa collegarsi a internet.";
    case "aborted":
      return "Operazione annullata.";
    default: {
      const text = err instanceof Error ? err.message : String(err ?? "errore sconosciuto");
      return problem.code ? `Telegram ha risposto ${problem.code}.` : text;
    }
  }
}

/** Any error as a `TelegramFailure`, the sentence ready and Telegram's code kept for expert mode. */
export function asTelegramFailure(err: unknown): TelegramFailure {
  if (err instanceof TelegramFailure) return err;
  const message = telegramProblemText(err);
  const raw = err instanceof Error ? err.message : null;
  return new TelegramFailure(message, classifyTelegramError(err).code, raw && raw !== message ? raw.slice(0, 500) : null);
}

// --- Waiting, retrying -------------------------------------------------------------

function abortError(): Error {
  const err = new Error("Operazione annullata");
  err.name = "AbortError";
  return err;
}

/** A sleep that a cancelled run cuts short. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A call with a clock. GramJS has none of its own for requests, and a request
 * on a connection that died quietly would otherwise wait forever. The call
 * left behind is not cancelled — there is no way to — but its outcome is
 * caught, so a late rejection cannot surface as an unhandled one.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TelegramTimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

export interface RetryOptions {
  /** Attempts for a failure that may pass by itself: a dropped connection, a timeout, a Telegram hiccup. */
  attempts?: number;
  /** The longest FLOOD_WAIT worth sitting out; a longer one fails the operation with its own sentence. */
  maxWaitSeconds?: number;
  signal?: AbortSignal;
  onWait?: (seconds: number) => void;
  /** Before trying again after a connection problem: where the transport reconnects. */
  beforeRetry?: (problem: TelegramProblem) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The retry policy, in one place.
 *
 * FLOOD_WAIT is Telegram saying "not now, in N seconds": it is waited out, up
 * to a quarter of an hour, and never counted as a failure — it is the normal
 * way a large upload is paced, and FLOOD_PREMIUM_WAIT is how an account
 * without Premium is slowed down. A dropped connection or a timeout is retried
 * a few times with a growing pause. A revoked session, a missing channel or a
 * refused permission is final, and fails at once with its own sentence.
 */
export async function withTelegramRetry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const maxWait = options.maxWaitSeconds ?? 15 * 60;
  const sleep = options.sleep ?? sleepFor;
  let failures = 0;
  let waits = 0;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await op();
    } catch (err) {
      if (options.signal?.aborted) throw abortError();
      const problem = classifyTelegramError(err);
      if (problem.kind === "flood" && problem.seconds !== undefined) {
        // Thirty waits in one operation is not pacing any more.
        if (problem.seconds > maxWait || ++waits > 30) throw err;
        options.onWait?.(problem.seconds);
        await sleep(problem.seconds * 1000 + 500, options.signal);
        continue;
      }
      if (problem.kind === "transient" || problem.kind === "network" || problem.kind === "timeout") {
        failures++;
        if (failures >= attempts) throw err;
        await sleep(Math.min(30_000, 1000 * 2 ** failures), options.signal);
        await options.beforeRetry?.(problem);
        continue;
      }
      throw err;
    }
  }
}

// --- Reading the archive in slices --------------------------------------------------

/**
 * One part of the archive, in upload pieces, read from the file at its offset
 * and hashed on the way. Nothing is copied to a temporary file and nothing
 * larger than a piece is held: the transport keeps a few in flight, that is all.
 */
export async function* readSlice(
  file: fs.promises.FileHandle,
  offset: number,
  length: number,
  chunkBytes: number,
  hash: crypto.Hash,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  let done = 0;
  while (done < length) {
    if (signal?.aborted) throw abortError();
    const size = Math.min(chunkBytes, length - done);
    const buffer = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await file.read(buffer, filled, size - filled, offset + done + filled);
      if (bytesRead === 0) throw new Error("L'archivio si è accorciato mentre lo caricavo su Telegram");
      filled += bytesRead;
    }
    hash.update(buffer);
    done += size;
    yield buffer;
  }
}

/**
 * Progress worth a line in the run log: every tenth, or every minute on a slow
 * line, and nothing at all for an archive that uploads in seconds.
 */
export function progressLog(
  log: (line: string) => void,
  total: number,
  now: () => number = Date.now
): (done: number) => void {
  const startedAt = now();
  let lastAt = startedAt;
  let lastTenth = 0;
  return (done) => {
    if (total < 32 * 1024 * 1024 || done >= total) return;
    const tenth = Math.floor((done * 10) / total);
    const at = now();
    if (tenth <= lastTenth && at - lastAt < 60_000) return;
    lastTenth = Math.max(lastTenth, tenth);
    lastAt = at;
    const rate = done / Math.max(1, (at - startedAt) / 1000);
    log(`  caricati ${formatBytes(done)} di ${formatBytes(total)} (${Math.floor((done * 100) / total)}%) · ${formatBytes(rate)}/s`);
  };
}

// --- Checking what is stored ---------------------------------------------------------

function listParts(numbers: number[]): string {
  if (numbers.length === 1) return `la parte ${numbers[0]}`;
  return `le parti ${numbers.slice(0, -1).join(", ")} e ${numbers[numbers.length - 1]}`;
}

/**
 * What is wrong with the messages of an archive, in a sentence; null when every
 * part is there, at the size it was uploaded, and says it is the part the
 * reference expects. The last check is what makes a hand-edited reference, or
 * two ids swapped, fail with a reason instead of rebuilding a corrupt archive.
 */
export function partsProblem(ref: TelegramRef, docs: (TelegramDocument | null)[]): string | null {
  const sizes = partSizes(ref);
  const count = ref.ids.length;
  const missing: number[] = [];
  const resized: number[] = [];
  const misplaced: number[] = [];
  ref.ids.forEach((_, i) => {
    const doc = docs[i];
    if (!doc) {
      missing.push(i + 1);
      return;
    }
    if (doc.bytes !== sizes[i]) resized.push(i + 1);
    const caption = parseCaption(doc.caption);
    if (
      caption &&
      (caption.index !== i || caption.count !== count || (caption.fileName !== null && caption.fileName !== ref.fileName))
    ) {
      misplaced.push(i + 1);
    }
  });
  const of = count > 1 ? ` di ${count}` : "";
  if (missing.length) {
    return count > 1
      ? `Su Telegram manca ${listParts(missing)}${of} dell'archivio: ${missing.length === 1 ? "il suo messaggio è stato eliminato" : "i loro messaggi sono stati eliminati"} fuori dal pannello.`
      : "Su Telegram il messaggio dell'archivio non c'è più: è stato eliminato fuori dal pannello.";
  }
  if (resized.length) {
    return `Su Telegram ${listParts(resized)}${of} non ha la dimensione con cui è stata caricata: l'archivio non è più intero.`;
  }
  if (misplaced.length) {
    return `I messaggi su Telegram non corrispondono all'archivio registrato (${listParts(misplaced)}${of}): non lo ricompongo, per non ripristinare un archivio sbagliato.`;
  }
  return null;
}

// --- The destination -------------------------------------------------------------------

export interface TelegramDestinationOptions {
  connect?: TelegramConnect;
  /** Telegram's largest upload piece; smaller only in tests, to split small files. */
  chunkBytes?: number;
  marginChunks?: number;
}

const defaultConnect: TelegramConnect = async (config) => {
  const { connectTelegram } = await import("./telegram-client");
  return connectTelegram(config);
};

export function telegramDestination(
  row: Pick<BackupDestinationsTable, "id" | "name" | "type">,
  raw: Record<string, unknown>,
  options: TelegramDestinationOptions = {}
): Destination {
  const connect = options.connect ?? defaultConnect;
  const chunkBytes = options.chunkBytes ?? TELEGRAM_CHUNK_BYTES;
  const marginChunks = options.marginChunks ?? TELEGRAM_MARGIN_CHUNKS;
  const config = readTelegramConfig(raw);

  function requireConfig(): TelegramConfig {
    if (!config) {
      throw new TelegramFailure(
        "Account Telegram non collegato, o configurazione incompleta: modifica la destinazione e collega l'account."
      );
    }
    return config;
  }

  /** The account, open for the length of `run`, closed whatever happens. */
  async function session<T>(run: (transport: TelegramTransport, cfg: TelegramConfig) => Promise<T>): Promise<T> {
    const cfg = requireConfig();
    let transport: TelegramTransport;
    try {
      transport = await connect(cfg);
    } catch (err) {
      throw asTelegramFailure(err);
    }
    try {
      return await run(transport, cfg);
    } catch (err) {
      throw asTelegramFailure(err);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  function requireRef(ref: string): TelegramRef {
    const parsed = parseTelegramRef(ref);
    if (!parsed) throw new TelegramFailure(`Riferimento all'archivio su Telegram non valido: ${ref}`);
    return parsed;
  }

  /**
   * The chat a stored archive lives in. Always the destination's own: the chat
   * is chosen when the destination is created and never changes, so a
   * reference naming another one was not written by this destination.
   */
  function chatOf(ref: TelegramRef, cfg: TelegramConfig): TelegramChat {
    if (ref.chat !== chatKey(cfg.chat)) {
      throw new TelegramFailure(
        `Questo archivio sta in un'altra chat di Telegram (${ref.chat}), non in ${chatLabel(cfg.chat)} di questa destinazione.`
      );
    }
    return cfg.chat;
  }

  async function* reassemble(
    transport: TelegramTransport,
    chat: TelegramChat,
    ref: TelegramRef,
    docs: TelegramDocument[]
  ): AsyncGenerator<Buffer> {
    const sizes = partSizes(ref);
    const count = ref.ids.length;
    try {
      for (let i = 0; i < count; i++) {
        const expected = parseCaption(docs[i].caption);
        const hash = crypto.createHash("sha256");
        let received = 0;
        for await (const chunk of transport.download(chat, ref.ids[i])) {
          received += chunk.length;
          if (received > sizes[i]) {
            throw new TelegramFailure(`La parte ${i + 1} di ${count} scaricata da Telegram è più lunga di quella caricata.`);
          }
          hash.update(chunk);
          yield chunk;
        }
        if (received !== sizes[i]) {
          throw new TelegramFailure(
            `La parte ${i + 1} di ${count} si è interrotta a ${formatBytes(received)} su ${formatBytes(sizes[i])}. Riprova.`
          );
        }
        // Belt and braces: the restore checks the archive's sha256 anyway,
        // but this one says which part is wrong.
        if (expected?.sha256 && hash.digest("hex") !== expected.sha256) {
          throw new TelegramFailure(
            `La parte ${i + 1} di ${count} scaricata da Telegram è diversa da quella caricata (sha256 diverso).`
          );
        }
      }
    } catch (err) {
      throw asTelegramFailure(err);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath: string, fileName: string, putOptions: PutOptions = {}) {
      const log = putOptions.log ?? (() => {});
      const signal = putOptions.signal;
      if (/[/\\]/.test(fileName)) throw new TelegramFailure(`Nome di archivio non valido: ${fileName}`);
      const { size } = await fs.promises.stat(localPath);

      return session(async (transport, cfg) => {
        // Every run: Premium can lapse, and an archive split for 4000 MiB
        // parts would be refused by an account that no longer has it.
        const account = await transport.account();
        const maxParts = await transport.maxFileParts(account.premium);
        const partBytes = partBytesFor(maxParts, chunkBytes, marginChunks);
        const plan = planParts(size, partBytes);
        log(
          `  Telegram: ${accountLabel(account)}, ${account.premium ? "con Premium" : "senza Premium"} — parti fino a ${formatBytes(partBytes)}` +
            (plan.length > 1 ? `: l'archivio va in ${plan.length} parti` : "")
        );

        const chat = cfg.chat;
        const posted: number[] = [];
        const onWait = (seconds: number) => {
          // Short waits are how Telegram paces an upload: not worth a line each.
          if (seconds >= 10) log(`  Telegram chiede di aspettare ${waitText(seconds)}: riprendo da solo.`);
        };
        const handle = await fs.promises.open(localPath, "r");
        try {
          const progress = progressLog(log, size);
          for (const part of plan) {
            const name = partFileName(fileName, part.index, plan.length);
            const hash = crypto.createHash("sha256");
            const uploaded = await transport.upload({
              chunks: readSlice(handle, part.offset, part.length, chunkBytes, hash, signal),
              bytes: part.length,
              chunkBytes,
              fileName: name,
              signal,
              onProgress: (sent) => progress(part.offset + sent),
              onWait,
            });
            const caption = partCaption({
              fileName,
              index: part.index,
              count: plan.length,
              bytes: part.length,
              sha256: hash.digest("hex"),
            });
            posted.push(await transport.post(chat, uploaded, { fileName: name, caption, bytes: part.length, signal }));
            if (plan.length > 1) log(`  parte ${part.index + 1} di ${plan.length} caricata (${formatBytes(part.length)})`);
          }

          // What Telegram says it kept, not what it accepted: a part shorter
          // than the one sent is an archive that will not restore.
          const kept = await transport.documents(chat, posted);
          const problem = partsProblem({ chat: chatKey(chat), partBytes, total: size, ids: posted, fileName }, kept);
          if (problem) throw new TelegramFailure(`Caricamento incompleto. ${problem}`);
        } catch (err) {
          // No half archive left behind: parts already posted are deleted, so
          // the channel holds only archives the panel knows how to rebuild.
          if (posted.length > 0) {
            await transport.remove(chat, posted).catch(() => {
              log(`  non sono riuscito a togliere le ${posted.length} parti già caricate: eliminale a mano da ${chatLabel(chat)}`);
            });
          }
          const failure = asTelegramFailure(err);
          if (failure.detail ?? failure.code) log(`  dettaglio: ${failure.detail ?? failure.code}`);
          throw failure;
        } finally {
          await handle.close();
        }

        return {
          ref: encodeTelegramRef({ chat: chatKey(chat), partBytes, total: size, ids: posted, fileName }),
          bytes: size,
        };
      });
    },

    async remove(ref) {
      const parsed = requireRef(ref);
      await session(async (transport, cfg) => {
        try {
          await transport.remove(chatOf(parsed, cfg), parsed.ids);
        } catch (err) {
          // A channel deleted, or one this account was removed from: nothing
          // the panel can still delete, and refusing would leave a run nobody
          // can ever remove from the list.
          if (classifyTelegramError(err).kind === "chat") return;
          throw err;
        }
      });
    },

    async open(ref): Promise<Readable> {
      const parsed = requireRef(ref);
      const cfg = requireConfig();
      const chat = chatOf(parsed, cfg);
      let transport: TelegramTransport;
      try {
        transport = await connect(cfg);
      } catch (err) {
        throw asTelegramFailure(err);
      }
      let docs: (TelegramDocument | null)[];
      try {
        docs = await transport.documents(chat, parsed.ids);
        const problem = partsProblem(parsed, docs);
        if (problem) throw new TelegramFailure(problem);
      } catch (err) {
        await transport.close().catch(() => {});
        throw asTelegramFailure(err);
      }
      // Pulled one download chunk at a time: the consumer's pace is the
      // download's pace, and closing the stream closes the connection.
      return Readable.from(reassemble(transport, chat, parsed, docs as TelegramDocument[]), {
        objectMode: false,
        highWaterMark: 1024 * 1024,
      });
    },

    async stat(ref): Promise<DestinationStat> {
      const parsed = requireRef(ref);
      return session(async (transport, cfg) => {
        const docs = await transport.documents(chatOf(parsed, cfg), parsed.ids);
        const bytes = docs.reduce((sum, doc) => sum + (doc?.bytes ?? 0), 0);
        const problem = partsProblem(parsed, docs);
        return problem ? { exists: false, bytes, detail: problem } : { exists: true, bytes };
      });
    },

    /**
     * Connects, says who is linked, with or without Premium and how large a
     * part can be, then writes, reads back and deletes a small file in the
     * chat — the same three steps a backup, a restore and the retention take.
     */
    async test(): Promise<DestinationCheck> {
      if (!config) {
        return { ok: false, message: "Account Telegram non collegato: modifica la destinazione e collega l'account." };
      }
      const failed = (prefix: string, err: unknown): DestinationCheck => {
        const failure = asTelegramFailure(err);
        return { ok: false, message: `${prefix}${failure.message}`, code: failure.code ?? undefined, detail: failure.detail };
      };

      let transport: TelegramTransport;
      try {
        transport = await connect(config);
      } catch (err) {
        return failed("", err);
      }
      try {
        let who: string;
        try {
          const account = await transport.account();
          const maxParts = await transport.maxFileParts(account.premium);
          who =
            `Account ${accountLabel(account)}, ${account.premium ? "con Telegram Premium" : "senza Premium"}: ` +
            `parti fino a ${formatBytes(partBytesFor(maxParts, chunkBytes, marginChunks))}.`;
        } catch (err) {
          return failed("", err);
        }

        const where = chatLabel(config.chat);
        const Where = where.charAt(0).toUpperCase() + where.slice(1);
        const marker = Buffer.from(`runpanel ${Date.now()}`);
        const name = "runpanel-prova-di-scrittura.txt";
        let messageId: number;
        try {
          const file = await transport.upload({
            chunks: (async function* () {
              for (let at = 0; at < marker.length; at += chunkBytes) yield marker.subarray(at, at + chunkBytes);
            })(),
            bytes: marker.length,
            chunkBytes,
            fileName: name,
          });
          messageId = await transport.post(config.chat, file, {
            fileName: name,
            caption: "RunPanel · prova di scrittura: il pannello la cancella subito.",
            bytes: marker.length,
          });
        } catch (err) {
          return failed(`${who} ${Where}: la scrittura non riesce. `, err);
        }

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of transport.download(config.chat, messageId)) chunks.push(chunk);
          if (!Buffer.concat(chunks).equals(marker)) {
            return { ok: false, message: `${who} ${Where}: il file scritto si rilegge diverso. Riprova la verifica.` };
          }
        } catch (err) {
          // The marker stays behind: removing it needs the access that just failed.
          return failed(`${who} ${Where}: la scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. `, err);
        }

        try {
          await transport.remove(config.chat, [messageId]);
        } catch (err) {
          const failure = asTelegramFailure(err);
          return {
            ok: true,
            warning: true,
            message:
              `${who} ${Where}: scrittura e lettura riuscite, ma l'eliminazione è stata rifiutata, quindi la retention ` +
              "non potrà togliere gli archivi vecchi. Controlla che l'account sia amministratore del canale.",
            code: failure.code ?? undefined,
            detail: failure.detail ?? failure.message,
          };
        }

        return { ok: true, message: `${who} ${Where}: scrittura, lettura ed eliminazione riuscite.` };
      } finally {
        await transport.close().catch(() => {});
      }
    },
  };
}
