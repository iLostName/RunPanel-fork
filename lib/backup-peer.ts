/**
 * The rules of a linked RunPanel server keeping another one's backups: what a
 * sender may name, how much room a receiver gives, and the constants of the
 * protocol both sides speak.
 *
 * The sender is the destination "Server RunPanel collegato"
 * (services/backup/destinations/peer.ts); the receiver keeps the copies in an
 * area of its data directory of their own, one per source server
 * (services/backup/peer-host.ts). Everything a sender names — its member id,
 * a file name, a ref — becomes a path on the receiver, so it is checked here,
 * once, by both sides: the sender to fail early with a clear sentence, the
 * receiver because a request is never trusted.
 *
 * Zero imports: validation.ts runs in the browser too, and the unit suites
 * load this file directly.
 */

/** Bumped when a receiver changes in a way an older sender must notice. */
export const PEER_PROTOCOL = 1;

/**
 * One piece of an upload. Under the 10 MB that `proxy.ts` buffers to check a
 * signed body — a larger one would be truncated without an error — and small
 * enough that a slow line still sends it well inside the five minutes Node
 * gives a request body by default.
 */
export const PEER_CHUNK_BYTES = 8 * 1024 * 1024;

/** A terabyte: past that a typo, not a backup. */
export const PEER_MAX_ARCHIVE_BYTES = 1024 ** 4;

/** A petabyte: the largest limit worth typing for one source. */
export const PEER_MAX_QUOTA_BYTES = 1024 ** 5;

/** How long a reservation waits for its first piece. */
export const PEER_RESERVATION_TTL_MS = 15 * 60_000;

/** An upload with no piece for this long was abandoned: its partial file goes. */
export const PEER_IDLE_MS = 30 * 60_000;

/** How long a finished upload still answers a repeated "complete", whose first answer was lost. */
export const PEER_DONE_TTL_MS = 60 * 60_000;

/** Uploads one source may have open at once: a backup and a check, with room to spare. */
export const PEER_MAX_ACTIVE_UPLOADS = 4;

/** The header carrying an upload's token: never in the query, which ends up in access logs. */
export const PEER_TOKEN_HEADER = "x-runpanel-upload-token";

/** The folder under the data directory, as the pages and the docs name it. */
export const PEER_FOLDER = "data/peer-backups";

const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/**
 * A file name: letters, digits and `. _ -`, starting with a letter or a digit.
 * Wide enough for every archive name the panel writes
 * (`runpanel-20261118-030000-notte-abc123.zip.enc`), narrow enough that no
 * filesystem reads it as anything but a name.
 */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Names Windows keeps for devices, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** `<year>/<month>/<name>`: the only shape a stored copy has. */
const REF = /^(\d{4})\/(\d{2})\/([^/]+)$/;

export function isPeerMemberId(value: unknown): value is string {
  return typeof value === "string" && MEMBER_ID.test(value);
}

export function isPeerUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/** Why a file name cannot be stored as is, or null. */
export function peerFileNameProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "Manca il nome del file";
  if (value.length > 200) return "Il nome del file è troppo lungo";
  if (!FILE_NAME.test(value)) return "Il nome del file può contenere solo lettere, numeri e . _ -, e deve iniziare con una lettera o un numero";
  if (value.includes("..")) return "Il nome del file non può contenere ..";
  if (value.endsWith(".")) return "Il nome del file non può finire con un punto";
  if (DEVICE_NAME.test(value)) return "Il nome del file è riservato dal sistema";
  return null;
}

/** Why a ref names nothing a source can have stored, or null. */
export function peerRefProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 220) return "Riferimento dell'archivio non valido";
  const match = REF.exec(value);
  if (!match) return "Riferimento dell'archivio non valido";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "Riferimento dell'archivio non valido";
  return peerFileNameProblem(match[3]) ? "Riferimento dell'archivio non valido" : null;
}

export function peerRef(at: Date, fileName: string): string {
  return `${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${fileName}`;
}

/**
 * The same name with a few characters added before its extensions, for a
 * copy that arrives under a name already taken by a different file:
 * `runpanel-…-abc.zip.enc` becomes `runpanel-…-abc-1f2e.zip.enc`.
 */
export function peerAlternativeName(fileName: string, nonce: string): string {
  const dot = fileName.indexOf(".");
  return dot > 0 ? `${fileName.slice(0, dot)}-${nonce}${fileName.slice(dot)}` : `${fileName}-${nonce}`;
}

const GB = 1024 ** 3;

/**
 * What a receiver always keeps free on its disk, whatever its sources are
 * given: a tenth of the disk, no less than 5 GB and no more than 50 GB. Its
 * own projects, databases and nightly backup need the room more than a
 * neighbour's copies do — the backup runner alone stops under 2 GB.
 */
export function peerReserveBytes(totalBytes: number | null): number {
  if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) return 5 * GB;
  return Math.min(50 * GB, Math.max(5 * GB, Math.floor(totalBytes / 10)));
}

export type PeerRoomProblem = "REFUSED" | "QUOTA" | "DISK";

export interface PeerRoomInput {
  /** Bytes the receiving owner gives this source; null is no limit of its own, 0 refuses it. */
  quota: number | null;
  /** What the source holds there already, the uploads under way included. */
  used: number;
  /** Free bytes on the receiver's disk, after the uploads under way have finished; null when unknown. */
  free: number | null;
  /** What the receiver keeps free for itself. */
  reserve: number;
}

/**
 * How many more bytes a source may send now, and what stops it first. With
 * neither a limit nor a known disk, nothing can be said: `available` is null.
 */
export function peerRoom(input: PeerRoomInput): { available: number | null; limitedBy: PeerRoomProblem | null } {
  if (input.quota === 0) return { available: 0, limitedBy: "REFUSED" };
  const byQuota = input.quota === null ? null : Math.max(0, input.quota - input.used);
  const byDisk = input.free === null ? null : Math.max(0, input.free - input.reserve);
  if (byQuota === null && byDisk === null) return { available: null, limitedBy: null };
  if (byDisk === null || (byQuota !== null && byQuota <= byDisk)) return { available: byQuota, limitedBy: "QUOTA" };
  return { available: byDisk, limitedBy: "DISK" };
}

/** Why an archive of `bytes` cannot be accepted now, or null. */
export function peerRoomProblem(input: PeerRoomInput, bytes: number): PeerRoomProblem | null {
  if (input.quota === 0) return "REFUSED";
  if (input.quota !== null && input.used + bytes > input.quota) return "QUOTA";
  if (input.free !== null && input.free - bytes < input.reserve) return "DISK";
  return null;
}
