import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PEER_CHUNK_BYTES,
  PEER_DONE_TTL_MS,
  PEER_IDLE_MS,
  PEER_MAX_ACTIVE_UPLOADS,
  PEER_MAX_ARCHIVE_BYTES,
  PEER_PROTOCOL,
  PEER_RESERVATION_TTL_MS,
  isPeerMemberId,
  isPeerUploadId,
  isSha256,
  peerAlternativeName,
  peerFileNameProblem,
  peerRef,
  peerRefProblem,
  peerReserveBytes,
  peerRoom,
  peerRoomProblem,
} from "@/lib/backup-peer";

/**
 * The receiving side of a linked server's backups: the copies this server
 * keeps for the other members of its cluster.
 *
 * Each source has an area of its own, `<root>/<its member id>`, outside this
 * server's own backups and never mixed with them:
 *
 *   <root>/<member>/.source.json        who it is, as last seen
 *   <root>/<member>/<year>/<month>/…    its archives, under the names it sent
 *   <root>/<member>/.incoming/<id>.json a reservation: size, sha256, token hash
 *   <root>/<member>/.incoming/<id>.part the bytes received so far
 *
 * An upload is three steps, each a signed request of its own (see
 * app/api/cluster/peer-backups): a small one that reserves room for an
 * archive of a declared size and sha256 and gets back a one-time token; the
 * pieces, in order, each under the 10 MB the panel's proxy checks; and
 * "complete", which compares what arrived with what was declared and only
 * then gives the file its name. A file that does not match is deleted; one
 * left halfway is swept. Nothing a sender names leaves its area: the member
 * id comes from the signature, and names and refs are checked against
 * lib/backup-peer.ts before they become a path, and the path checked again.
 *
 * The sha256 is kept running in memory while pieces arrive, so "complete"
 * does not read back a file of many gigabytes. A restart loses it — and the
 * upload with it, which the sender learns at its next piece and retries:
 * an upload is never resumed across a restart, so a partial file is never
 * trusted.
 *
 * Only `node:` imports and the pure rules, so the unit suite drives it with a
 * temporary folder. The quota and the disk are asked through the options.
 */

export interface PeerSource {
  id: string;
  name: string;
  url: string | null;
}

export interface PeerHostOptions {
  root: string;
  /** The bytes the receiving owner gives a source: null for no limit of its own, 0 to refuse it. */
  quotaFor: (memberId: string) => Promise<number | null> | number | null;
  /** Free and total bytes of the disk holding `root`, or null when it cannot be told. */
  disk?: () => { free: number; total: number } | null;
  /** Free space that must stay while pieces arrive, whatever was reserved: the backup runner's own floor. */
  floorBytes?: number;
  now?: () => number;
}

export class PeerHostError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PeerHostError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type UploadStatus = "reserved" | "receiving" | "done";

interface UploadRecord {
  v: 1;
  id: string;
  memberId: string;
  fileName: string;
  bytes: number;
  sha256: string;
  tokenHash: string;
  status: UploadStatus;
  received: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  ref?: string;
}

export interface PeerArchive {
  ref: string;
  name: string;
  bytes: number;
  /** When it arrived (its file's time), ISO. */
  createdAt: string;
}

export interface PeerSourceSummary {
  id: string;
  /** The name it had when it last sent something; null when it never did. */
  name: string | null;
  url: string | null;
  archives: number;
  bytes: number;
  lastReceivedAt: string | null;
  incoming: { count: number; bytes: number };
}

export interface PeerInfo {
  protocol: number;
  chunkBytes: number;
  /** Null: no limit of its own. 0: refused. */
  quotaBytes: number | null;
  usedBytes: number;
  archives: number;
  freeBytes: number | null;
  reserveBytes: number;
  availableBytes: number | null;
  limitedBy: "REFUSED" | "QUOTA" | "DISK" | null;
}

/** One process's uploads in flight, and the reservations being decided: on `globalThis`, since each route is its own bundle. */
interface LiveUpload {
  hash: crypto.Hash;
  received: number;
  digest?: string;
}

const globalRef = globalThis as typeof globalThis & {
  __runpanelPeerLive?: Map<string, LiveUpload>;
  __runpanelPeerWriting?: Set<string>;
  __runpanelPeerReserving?: Map<string, Promise<unknown>>;
};
const live: Map<string, LiveUpload> = (globalRef.__runpanelPeerLive ??= new Map());
const writing: Set<string> = (globalRef.__runpanelPeerWriting ??= new Set());
const reserving: Map<string, Promise<unknown>> = (globalRef.__runpanelPeerReserving ??= new Map());

const INCOMING = ".incoming";
const LABEL = ".source.json";
/** A record or a piece file with nothing to go with it is left alone this long, in case its pair is being written. */
const ORPHAN_GRACE_MS = 60_000;

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export type PeerHost = ReturnType<typeof createPeerHost>;

export function createPeerHost(options: PeerHostOptions) {
  const root = path.resolve(options.root);
  const now = options.now ?? Date.now;
  const floor = options.floorBytes ?? 2 * 1024 ** 3;
  const disk = () => {
    try {
      return options.disk?.() ?? null;
    } catch {
      return null;
    }
  };
  const key = (uploadId: string) => `${root}\0${uploadId}`;

  // --- Paths, each checked before and after it is joined ------------------------------

  function area(memberId: string): string {
    if (!isPeerMemberId(memberId)) throw new PeerHostError(400, "INVALID", "Identificativo del server non valido");
    const dir = path.join(root, memberId);
    if (!within(root, dir)) throw new PeerHostError(400, "INVALID", "Identificativo del server non valido");
    return dir;
  }

  function incoming(memberId: string): string {
    return path.join(area(memberId), INCOMING);
  }

  function recordPath(memberId: string, uploadId: string): string {
    if (!isPeerUploadId(uploadId)) throw new PeerHostError(400, "INVALID", "Caricamento non valido");
    return path.join(incoming(memberId), `${uploadId}.json`);
  }

  function partPath(memberId: string, uploadId: string): string {
    if (!isPeerUploadId(uploadId)) throw new PeerHostError(400, "INVALID", "Caricamento non valido");
    return path.join(incoming(memberId), `${uploadId}.part`);
  }

  function archivePath(memberId: string, ref: string): string {
    if (peerRefProblem(ref)) throw new PeerHostError(400, "INVALID", "Riferimento dell'archivio non valido");
    const base = area(memberId);
    const file = path.resolve(base, ...ref.split("/"));
    if (!within(base, file)) throw new PeerHostError(400, "INVALID", "Riferimento dell'archivio non valido");
    return file;
  }

  // --- Reservations ------------------------------------------------------------------------

  function readRecord(memberId: string, uploadId: string): UploadRecord | null {
    const record = readJson<UploadRecord>(recordPath(memberId, uploadId));
    // A record is only ever read back from the area it names.
    return record && record.v === 1 && record.id === uploadId && record.memberId === memberId ? record : null;
  }

  function discard(memberId: string, uploadId: string): void {
    live.delete(key(uploadId));
    for (const file of [partPath(memberId, uploadId), recordPath(memberId, uploadId), `${recordPath(memberId, uploadId)}.tmp`]) {
      fs.rmSync(file, { force: true });
    }
  }

  function checkToken(record: UploadRecord, token: unknown): void {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) {
      throw new PeerHostError(401, "TOKEN", "Token del caricamento mancante o non valido");
    }
    const given = Buffer.from(sha256Hex(token), "hex");
    const expected = Buffer.from(record.tokenHash, "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new PeerHostError(401, "TOKEN", "Token del caricamento mancante o non valido");
    }
  }

  /** Why a record is no longer an upload, or null while it still is one. */
  function staleness(record: UploadRecord, at: number): "expired" | "idle" | "lost" | "spent" | null {
    if (record.status === "reserved") return at > record.expiresAt ? "expired" : null;
    if (record.status === "receiving") {
      if (!live.has(key(record.id))) return "lost";
      return at - record.updatedAt > PEER_IDLE_MS ? "idle" : null;
    }
    return at - record.updatedAt > PEER_DONE_TTL_MS ? "spent" : null;
  }

  /** The uploads of one source that are still under way, after the abandoned ones are gone. */
  function sweepArea(memberId: string): UploadRecord[] {
    const dir = incoming(memberId);
    const at = now();
    const kept: UploadRecord[] = [];
    const entries = listDir(dir);
    const records = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const uploadId = entry.name.slice(0, -".json".length);
      if (!isPeerUploadId(uploadId)) continue;
      records.add(uploadId);
      const record = readRecord(memberId, uploadId);
      if (!record) {
        const mtime = fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false })?.mtimeMs ?? 0;
        if (at - mtime > ORPHAN_GRACE_MS) discard(memberId, uploadId);
        continue;
      }
      // One being written right now is not judged in the middle of it.
      if (writing.has(key(uploadId))) {
        kept.push(record);
        continue;
      }
      const stale = staleness(record, at);
      if (stale === "spent") fs.rmSync(recordPath(memberId, uploadId), { force: true });
      else if (stale) discard(memberId, uploadId);
      else if (record.status !== "done") kept.push(record);
    }
    // Pieces whose record is gone, and temporary records a crash left behind.
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const orphan = entry.name.endsWith(".part")
        ? !records.has(entry.name.slice(0, -".part".length))
        : entry.name.endsWith(".json.tmp");
      if (!orphan) continue;
      const file = path.join(dir, entry.name);
      const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (at - mtime > ORPHAN_GRACE_MS) fs.rmSync(file, { force: true });
    }
    return kept;
  }

  function areas(): string[] {
    return listDir(root)
      .filter((entry) => entry.isDirectory() && isPeerMemberId(entry.name))
      .map((entry) => entry.name);
  }

  /** Bytes still to arrive for every upload under way, every source: the disk will need them. */
  function pendingBytes(): number {
    let total = 0;
    for (const memberId of areas()) {
      for (const record of sweepArea(memberId)) total += Math.max(0, record.bytes - record.received);
    }
    return total;
  }

  // --- What an area holds ----------------------------------------------------------------------

  function scan(memberId: string): { archives: PeerArchive[]; bytes: number } {
    const base = area(memberId);
    const archives: PeerArchive[] = [];
    let bytes = 0;
    for (const year of listDir(base)) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      for (const month of listDir(path.join(base, year.name))) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        for (const file of listDir(path.join(base, year.name, month.name))) {
          if (!file.isFile() || peerFileNameProblem(file.name)) continue;
          const stat = fs.statSync(path.join(base, year.name, month.name, file.name), { throwIfNoEntry: false });
          if (!stat) continue;
          bytes += stat.size;
          archives.push({
            ref: `${year.name}/${month.name}/${file.name}`,
            name: file.name,
            bytes: stat.size,
            createdAt: new Date(stat.mtimeMs).toISOString(),
          });
        }
      }
    }
    archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { archives, bytes };
  }

  function label(memberId: string): { name: string | null; url: string | null } {
    const stored = readJson<{ name?: unknown; url?: unknown }>(path.join(area(memberId), LABEL));
    return {
      name: typeof stored?.name === "string" ? stored.name : null,
      url: typeof stored?.url === "string" ? stored.url : null,
    };
  }

  async function room(memberId: string, kept: UploadRecord[]) {
    const quota = await options.quotaFor(memberId);
    const stored = scan(memberId);
    const used = stored.bytes + kept.reduce((sum, record) => sum + record.bytes, 0);
    const space = disk();
    const reserve = peerReserveBytes(space?.total ?? null);
    const free = space ? space.free - pendingBytes() : null;
    return { quota: quota === null || quota === undefined ? null : Math.max(0, Math.floor(quota)), used, free, reserve, archives: stored.archives.length };
  }

  /** Reservations decided one at a time, so two cannot both fit in the room that was there for one. */
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = reserving.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    reserving.set(root, next.catch(() => undefined));
    return next;
  }

  function writeLabel(source: PeerSource): void {
    try {
      writeJson(path.join(area(source.id), LABEL), { v: 1, memberId: source.id, name: source.name, url: source.url, updatedAt: new Date(now()).toISOString() });
    } catch {
      /* a name to show is not worth failing a backup over */
    }
  }

  // --- The protocol -------------------------------------------------------------------------------

  return {
    root,

    /** What a source may still send, for its "Verifica". */
    async info(memberId: string): Promise<PeerInfo> {
      const state = await room(memberId, sweepArea(memberId));
      const { available, limitedBy } = peerRoom(state);
      return {
        protocol: PEER_PROTOCOL,
        chunkBytes: PEER_CHUNK_BYTES,
        quotaBytes: state.quota,
        usedBytes: state.used,
        archives: state.archives,
        freeBytes: state.free,
        reserveBytes: state.reserve,
        availableBytes: available,
        limitedBy,
      };
    },

    /**
     * Room for one archive of a declared size and sha256. Answers with the
     * token the pieces must carry, shown this once and kept only as a hash.
     */
    async reserve(source: PeerSource, input: { fileName?: unknown; bytes?: unknown; sha256?: unknown }) {
      area(source.id);
      const nameProblem = peerFileNameProblem(input.fileName);
      if (nameProblem) throw new PeerHostError(400, "INVALID", nameProblem);
      const bytes = input.bytes;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > PEER_MAX_ARCHIVE_BYTES) {
        throw new PeerHostError(400, "INVALID", "Dimensione dell'archivio non valida");
      }
      if (!isSha256(input.sha256)) throw new PeerHostError(400, "INVALID", "sha256 dell'archivio non valido");
      const fileName = input.fileName as string;
      const sha256 = input.sha256;

      return serialized(async () => {
        fs.mkdirSync(incoming(source.id), { recursive: true, mode: 0o700 });
        const kept = sweepArea(source.id);
        if (kept.length >= PEER_MAX_ACTIVE_UPLOADS) {
          throw new PeerHostError(429, "BUSY", "Troppi caricamenti in corso da questo server");
        }
        const state = await room(source.id, kept);
        const problem = peerRoomProblem(state, bytes);
        if (problem === "REFUSED") throw new PeerHostError(403, "REFUSED", "Questo server non accetta copie da quel server");
        if (problem === "QUOTA") {
          throw new PeerHostError(507, "QUOTA", "Lo spazio concesso a quel server è pieno", { usedBytes: state.used, quotaBytes: state.quota, bytes });
        }
        if (problem === "DISK") {
          throw new PeerHostError(507, "DISK", "Spazio su disco insufficiente", { freeBytes: state.free, reserveBytes: state.reserve, bytes });
        }

        const at = now();
        const token = crypto.randomBytes(32).toString("base64url");
        const record: UploadRecord = {
          v: 1,
          id: crypto.randomBytes(12).toString("base64url"),
          memberId: source.id,
          fileName,
          bytes,
          sha256,
          tokenHash: sha256Hex(token),
          status: "reserved",
          received: 0,
          createdAt: at,
          updatedAt: at,
          expiresAt: at + PEER_RESERVATION_TTL_MS,
        };
        writeJson(recordPath(source.id, record.id), record);
        writeLabel(source);
        return { uploadId: record.id, token, chunkBytes: PEER_CHUNK_BYTES, expiresAt: new Date(record.expiresAt).toISOString() };
      });
    },

    /**
     * One piece, at the offset the receiver expects. A piece it already has —
     * sent again after a lost answer — is accepted and ignored.
     */
    async writeChunk(memberId: string, uploadId: string, token: unknown, offset: number, chunk: Buffer) {
      const record = readRecord(memberId, uploadId);
      if (!record) throw new PeerHostError(404, "NOT_FOUND", "Il caricamento non esiste più");
      checkToken(record, token);
      if (record.status === "done") throw new PeerHostError(409, "DONE", "Questo caricamento è già completo");
      if (!Number.isSafeInteger(offset) || offset < 0) throw new PeerHostError(400, "INVALID", "Posizione non valida");
      if (chunk.length === 0 || chunk.length > PEER_CHUNK_BYTES) throw new PeerHostError(413, "TOO_LARGE", "Pezzo di dimensione non valida");

      const id = key(uploadId);
      if (writing.has(id)) throw new PeerHostError(409, "BUSY_WRITE", "Un altro pezzo di questo caricamento è in scrittura");
      writing.add(id);
      try {
        const at = now();
        if (record.status === "reserved" && at > record.expiresAt) {
          discard(memberId, uploadId);
          throw new PeerHostError(410, "EXPIRED", "La prenotazione è scaduta prima del primo pezzo");
        }
        let state = live.get(id);
        if (record.status === "receiving" && !state) {
          discard(memberId, uploadId);
          throw new PeerHostError(410, "INTERRUPTED", "Il caricamento si è interrotto: questo server si è riavviato");
        }
        if (offset + chunk.length <= record.received) return { received: record.received };
        if (offset !== record.received) {
          throw new PeerHostError(409, "OUT_OF_ORDER", `Pezzo fuori ordine: qui ne serve uno a partire da ${record.received}`, { received: record.received });
        }
        if (offset + chunk.length > record.bytes) throw new PeerHostError(413, "TOO_LARGE", "L'archivio è più grande di quanto annunciato");
        const space = disk();
        if (space && space.free - chunk.length < floor) {
          throw new PeerHostError(507, "DISK", "Spazio su disco esaurito durante il caricamento", { freeBytes: space.free, reserveBytes: floor, bytes: record.bytes });
        }

        const file = partPath(memberId, uploadId);
        const handle = await fs.promises.open(file, state ? "r+" : "w", 0o600);
        try {
          // A piece written halfway by an earlier attempt is cut back first.
          await handle.truncate(offset);
          await handle.write(chunk, 0, chunk.length, offset);
        } finally {
          await handle.close();
        }
        if (!state) {
          state = { hash: crypto.createHash("sha256"), received: 0 };
          live.set(id, state);
        }
        state.hash.update(chunk);
        state.received = offset + chunk.length;
        record.received = state.received;
        record.status = "receiving";
        record.updatedAt = now();
        writeJson(recordPath(memberId, uploadId), record);
        return { received: record.received };
      } finally {
        writing.delete(id);
      }
    },

    /**
     * Every piece is in: the size and the sha256 compared with the declared
     * ones, the file flushed to the disk, and only then given its name — one
     * that never overwrites another file. Asked again after a lost answer, it
     * answers the same.
     */
    async complete(memberId: string, uploadId: string, token: unknown) {
      const record = readRecord(memberId, uploadId);
      if (!record) throw new PeerHostError(404, "NOT_FOUND", "Il caricamento non esiste più");
      checkToken(record, token);
      if (record.status === "done" && record.ref) return { ref: record.ref, bytes: record.bytes, sha256: record.sha256 };

      const id = key(uploadId);
      if (writing.has(id)) throw new PeerHostError(409, "BUSY_WRITE", "Un pezzo di questo caricamento è ancora in scrittura");
      if (record.status !== "receiving" || record.received !== record.bytes) {
        throw new PeerHostError(409, "INCOMPLETE", `Mancano ancora ${record.bytes - record.received} byte`, { received: record.received });
      }
      const state = live.get(id);
      if (!state) {
        discard(memberId, uploadId);
        throw new PeerHostError(410, "INTERRUPTED", "Il caricamento si è interrotto: questo server si è riavviato");
      }

      writing.add(id);
      try {
        state.digest ??= state.hash.digest("hex");
        const file = partPath(memberId, uploadId);
        const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? -1;
        if (size !== record.bytes) {
          discard(memberId, uploadId);
          throw new PeerHostError(422, "SIZE_MISMATCH", `Arrivati ${Math.max(0, size)} byte invece di ${record.bytes}`);
        }
        if (state.digest !== record.sha256) {
          discard(memberId, uploadId);
          throw new PeerHostError(422, "HASH_MISMATCH", "Lo sha256 di quello che è arrivato non è quello annunciato");
        }

        // On the disk before it has a name: a power cut must not leave a named file that is not whole.
        const handle = await fs.promises.open(file, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }

        const ref = await publish(memberId, file, record);
        record.status = "done";
        record.ref = ref;
        record.updatedAt = now();
        writeJson(recordPath(memberId, uploadId), record);
        fs.rmSync(file, { force: true });
        live.delete(id);
        return { ref, bytes: record.bytes, sha256: record.sha256 };
      } finally {
        writing.delete(id);
      }
    },

    /** The sender gave up: its pieces go now rather than at the next sweep. */
    async abort(memberId: string, uploadId: string, token: unknown) {
      const record = readRecord(memberId, uploadId);
      if (!record) return;
      checkToken(record, token);
      if (record.status === "done") return;
      if (writing.has(key(uploadId))) throw new PeerHostError(409, "BUSY_WRITE", "Un pezzo di questo caricamento è in scrittura");
      discard(memberId, uploadId);
    },

    stat(memberId: string, ref: string): { exists: boolean; bytes: number } {
      const stat = fs.statSync(archivePath(memberId, ref), { throwIfNoEntry: false });
      return stat?.isFile() ? { exists: true, bytes: stat.size } : { exists: false, bytes: 0 };
    },

    /** Where a stored copy is, for the route that streams it; null when it is gone. */
    locate(memberId: string, ref: string): { file: string; bytes: number } | null {
      const file = archivePath(memberId, ref);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat?.isFile() ? { file, bytes: stat.size } : null;
    },

    /** Delete one stored copy; false when it was already gone. Its month and year go with the last one. */
    remove(memberId: string, ref: string): boolean {
      const file = archivePath(memberId, ref);
      const existed = fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
      fs.rmSync(file, { force: true });
      for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
        try {
          fs.rmdirSync(dir);
        } catch {
          break;
        }
      }
      return existed;
    },

    /** Every source with an area here, for the receiving owner's page. */
    sources(): PeerSourceSummary[] {
      return areas().map((memberId) => {
        const kept = sweepArea(memberId);
        const stored = scan(memberId);
        const named = label(memberId);
        return {
          id: memberId,
          name: named.name,
          url: named.url,
          archives: stored.archives.length,
          bytes: stored.bytes,
          lastReceivedAt: stored.archives[0]?.createdAt ?? null,
          incoming: { count: kept.length, bytes: kept.reduce((sum, record) => sum + record.received, 0) },
        };
      });
    },

    archives(memberId: string): PeerArchive[] {
      return scan(memberId).archives;
    },

    /**
     * Every copy of one source, gone. Refused while one of its uploads is
     * under way, and decided in turn with the reservations, so none lands in
     * the folder while it is being removed.
     */
    removeSource(memberId: string): Promise<{ archives: number; bytes: number }> {
      const base = area(memberId);
      return serialized(async () => {
        if (!fs.existsSync(base)) return { archives: 0, bytes: 0 };
        if (sweepArea(memberId).length > 0) {
          throw new PeerHostError(409, "UPLOADING", "Quel server sta mandando una copia proprio ora: riprova quando ha finito");
        }
        const stored = scan(memberId);
        fs.rmSync(base, { recursive: true, force: true });
        return { archives: stored.archives.length, bytes: stored.bytes };
      });
    },

    /** Partial uploads nobody will finish, every source; how many went. */
    sweep(): number {
      const records = (dir: string) => listDir(dir).filter((entry) => entry.name.endsWith(".json")).length;
      let removed = 0;
      for (const memberId of areas()) {
        const dir = incoming(memberId);
        const before = records(dir);
        sweepArea(memberId);
        removed += Math.max(0, before - records(dir));
      }
      return removed;
    },
  };

  /**
   * Give a verified upload its name, never over another file: a hard link
   * refuses an existing name atomically. The same archive sent again — a
   * copy retried after its first answer was lost — finds itself already
   * there and is not stored twice; a different file under a taken name gets
   * a few characters more.
   */
  async function publish(memberId: string, file: string, record: UploadRecord): Promise<string> {
    const at = new Date(now());
    let name = record.fileName;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ref = peerRef(at, name);
      const target = archivePath(memberId, ref);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        fs.linkSync(file, target);
        return ref;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && !fs.existsSync(target)) {
          // No hard links on this filesystem (FAT, some network mounts): a
          // rename, which the check just above keeps from overwriting.
          fs.renameSync(file, target);
          return ref;
        }
        if (await sameArchive(target, record)) return ref;
        name = peerAlternativeName(record.fileName, crypto.randomBytes(2).toString("hex"));
      }
    }
    throw new PeerHostError(409, "NAME_TAKEN", "Non trovo un nome libero per l'archivio");
  }

  /** Read as a stream: an archive of many gigabytes must not hold the process while it is hashed. */
  async function sameArchive(target: string, record: UploadRecord): Promise<boolean> {
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== record.bytes) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk as Buffer);
    return hash.digest("hex") === record.sha256;
  }
}
