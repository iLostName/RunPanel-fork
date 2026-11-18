import crypto from "node:crypto";
import fs from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import yauzl from "yauzl";

/**
 * Backup archives encrypted with a password.
 *
 * An archive copied off this server — a bucket, a disk that walks away — must
 * not hand over the dumps, the volumes and the code it holds. yazl has no
 * encryption, and zip's own (ZipCrypto, WinZip AES) leaves member names, sizes
 * and the directory in clear anyway, so the whole zip goes inside an envelope:
 *
 *   "RPBKENC" | version (1 byte) | header length (uint32 BE) | header (JSON)
 *   chunk 0 | chunk 1 | … | chunk n-1
 *
 * Every chunk is `chunkSize` bytes of the zip (the last one 0 to chunkSize)
 * sealed with AES-256-GCM, followed by its 16-byte tag. The nonce is the
 * chunk's index, and the additional data binds three things to every chunk:
 * the sha256 of the header bytes, the index, and whether it is the last one.
 * So a flipped bit fails its chunk, two swapped or repeated chunks fail on their
 * index, a file cut at a chunk boundary fails because its new last chunk was
 * not sealed as the last, and a header edited by hand fails every chunk.
 *
 * The key comes from the password through scrypt, with a salt of its own for
 * every archive: no two archives share a key, which is what makes the index a
 * safe nonce. The header also carries a short value derived from the same
 * secret, so a wrong password is told apart from a damaged file before any
 * chunk is opened — it lets a guess be checked no faster than chunk 0 would.
 *
 * Nothing in clear ever touches the disk. Writing, yazl's output stream goes
 * through `SealStream` on its way to the file. Reading, `SealedFileReader` is a
 * yauzl RandomAccessReader that opens only the chunks a read needs, so listing,
 * verifying and extracting work on an encrypted archive exactly as on a zip.
 *
 * Only `node:` imports and yauzl, so a standalone suite can load it, and so
 * `scripts/decrypt-backup.mjs` — the same format in plain Node, for a machine
 * with no panel — has nothing to keep in step with but this comment.
 */

export const SEALED_MAGIC = Buffer.from("RPBKENC", "latin1");
export const SEALED_VERSION = 1;
/** An encrypted archive is named after the zip it holds, plus this. */
export const SEALED_SUFFIX = ".enc";

const PREFIX_BYTES = SEALED_MAGIC.length + 1 + 4;
/** A header is a few hundred bytes; a length past this is not a header. */
const MAX_HEADER_BYTES = 8 * 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const SALT_BYTES = 32;
const CHECK_BYTES = 16;

/** 64 KiB: the tags cost 0.02%, and a random read decrypts little it does not need. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** scrypt as OWASP recommends it: 128 MiB of memory and a fraction of a second per guess. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

/**
 * What a reader accepts. The parameters come from the file, and an archive is
 * something somebody can hand the panel: N = 2^30 would ask for a terabyte of
 * memory before the password is even tried. The lower bounds only keep out
 * nonsense; a cheap KDF weakens nobody's file but its author's.
 */
const KDF_LIMITS = { minLogN: 10, maxLogN: 20, maxR: 32, maxP: 4, maxNr: 2 ** 21 } as const;
const CHUNK_LIMITS = { min: 1024, max: 4 * 1024 * 1024 } as const;
/** Node refuses scrypt above `maxmem`; the limits above keep real use under half of it. */
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

const INFO_KEY = "runpanel-backup/v1/aes-256-gcm";
const INFO_CHECK = "runpanel-backup/v1/password-check";

/** Plain text at the top of the file, for whoever finds it without the panel. */
const ABOUT =
  "RunPanel backup, encrypted with the backup password. Decrypt it with scripts/decrypt-backup.mjs (docs: backups, encryption).";

// --- The header -----------------------------------------------------------------

export interface SealHeader {
  about: string;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  /** base64, 32 bytes, new for every archive. */
  salt: string;
  cipher: "aes-256-gcm";
  /** Bytes of the zip in every chunk but the last. */
  chunkSize: number;
  /** base64, 16 bytes: tells a wrong password from a damaged file. */
  check: string;
  /** Which of the panel's passwords sealed it. Not secret. */
  keyId: string;
  /** When that password was set, so a person knows which one to type. */
  keyCreatedAt: string | null;
}

/** The header as read from a file: parsed, and the exact bytes the chunks are bound to. */
export interface SealedHead {
  header: SealHeader;
  bytes: Buffer;
  hash: Buffer;
}

/** The file is encrypted, damaged, or in a format this panel does not read. */
export class SealedArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedArchiveError";
  }
}

/** The archive is fine; the password to open it is missing or wrong. */
export class ArchiveLockedError extends Error {
  readonly wrongPassword: boolean;
  readonly keyId: string;
  readonly keyCreatedAt: string | null;

  constructor(header: SealHeader, wrongPassword: boolean) {
    super(
      wrongPassword
        ? "La password non è quella di questo archivio."
        : "L'archivio è cifrato con una password che questo pannello non conosce: serve la password dei backup con cui è stato creato."
    );
    this.name = "ArchiveLockedError";
    this.wrongPassword = wrongPassword;
    this.keyId = header.keyId;
    this.keyCreatedAt = header.keyCreatedAt;
  }
}

function damaged(detail: string): SealedArchiveError {
  return new SealedArchiveError(`L'archivio cifrato è danneggiato o è stato modificato: ${detail}.`);
}

const isPowerOfTwo = (value: number) => Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;

function decoded(value: unknown, bytes: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").length === bytes;
}

/**
 * Every field, with its type and its range. A header that is not exactly the
 * shape this version writes is refused here, rather than half-understood.
 */
function validHeader(value: unknown): value is SealHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const h = value as Record<string, unknown>;
  if (typeof h.about !== "string" || h.about.length > 512) return false;
  if (h.kdf !== "scrypt" || h.cipher !== "aes-256-gcm") return false;
  for (const key of ["N", "r", "p", "chunkSize"]) {
    if (typeof h[key] !== "number" || !Number.isSafeInteger(h[key])) return false;
  }
  const N = h.N as number;
  const r = h.r as number;
  const p = h.p as number;
  const chunkSize = h.chunkSize as number;
  if (!isPowerOfTwo(N) || N < 2 ** KDF_LIMITS.minLogN || N > 2 ** KDF_LIMITS.maxLogN) return false;
  if (r < 1 || r > KDF_LIMITS.maxR || p < 1 || p > KDF_LIMITS.maxP || N * r > KDF_LIMITS.maxNr) return false;
  if (!isPowerOfTwo(chunkSize) || chunkSize < CHUNK_LIMITS.min || chunkSize > CHUNK_LIMITS.max) return false;
  if (!decoded(h.salt, SALT_BYTES) || !decoded(h.check, CHECK_BYTES)) return false;
  if (typeof h.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(h.keyId)) return false;
  if (h.keyCreatedAt !== null && (typeof h.keyCreatedAt !== "string" || h.keyCreatedAt.length > 40 || !Number.isFinite(Date.parse(h.keyCreatedAt)))) {
    return false;
  }
  return true;
}

function encodeHeader(header: SealHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  SEALED_MAGIC.copy(prefix, 0);
  prefix[SEALED_MAGIC.length] = SEALED_VERSION;
  prefix.writeUInt32BE(json.length, SEALED_MAGIC.length + 1);
  return Buffer.concat([prefix, json]);
}

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest();

async function readAt(fd: number, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = await new Promise<number>((resolve, reject) =>
      fs.read(fd, buffer, filled, length - filled, position + filled, (err, bytes) => (err ? reject(err) : resolve(bytes)))
    );
    if (read === 0) break;
    filled += read;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

const openFd = (file: string) =>
  new Promise<number>((resolve, reject) => fs.open(file, "r", (err, fd) => (err ? reject(err) : resolve(fd))));
const closeFd = (fd: number) => new Promise<void>((resolve) => fs.close(fd, () => resolve()));
const fileSize = (fd: number) =>
  new Promise<number>((resolve, reject) => fs.fstat(fd, (err, stat) => (err ? reject(err) : resolve(stat.size))));

async function headAt(fd: number): Promise<SealedHead | null> {
  const prefix = await readAt(fd, PREFIX_BYTES, 0);
  if (prefix.length < SEALED_MAGIC.length || !prefix.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) return null;
  if (prefix.length < PREFIX_BYTES) throw damaged("il file finisce dentro l'intestazione");
  const version = prefix[SEALED_MAGIC.length];
  if (version !== SEALED_VERSION) {
    throw new SealedArchiveError(
      `L'archivio è cifrato in un formato più recente (versione ${version}): aggiorna il pannello per aprirlo.`
    );
  }
  const length = prefix.readUInt32BE(SEALED_MAGIC.length + 1);
  if (length === 0 || length > MAX_HEADER_BYTES) throw damaged("l'intestazione ha una lunghezza impossibile");
  const json = await readAt(fd, length, PREFIX_BYTES);
  if (json.length < length) throw damaged("il file finisce dentro l'intestazione");

  let header: unknown;
  try {
    header = JSON.parse(json.toString("utf8"));
  } catch {
    throw damaged("l'intestazione non si legge");
  }
  if (!validHeader(header)) throw damaged("l'intestazione non è valida");
  const bytes = Buffer.concat([prefix, json]);
  return { header, bytes, hash: sha256(bytes) };
}

/** The header of an encrypted archive; null for a file that is not one (a zip, say). */
export async function readSealedHead(file: string): Promise<SealedHead | null> {
  const fd = await openFd(file);
  try {
    return await headAt(fd);
  } finally {
    await closeFd(fd);
  }
}

// --- Keys -------------------------------------------------------------------------

interface SealKeys {
  key: Buffer;
  check: Buffer;
}

/**
 * The password as bytes. NFC first: "è" typed on one keyboard and on another
 * can be one code point or two, and a password that only works on the
 * computer it was set from is a backup that does not restore anywhere else.
 */
function passwordBytes(password: string): Buffer {
  return Buffer.from(password.normalize("NFC"), "utf8");
}

async function deriveKeys(password: string, header: Pick<SealHeader, "N" | "r" | "p" | "salt">): Promise<SealKeys> {
  const master = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(
      passwordBytes(password),
      Buffer.from(header.salt, "base64"),
      32,
      { N: header.N, r: header.r, p: header.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  );
  // Two keys from one secret, neither of which says anything about the other.
  const key = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), INFO_KEY, 32));
  const check = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), INFO_CHECK, CHECK_BYTES));
  master.fill(0);
  return { key, check };
}

function fits(keys: SealKeys, header: SealHeader): boolean {
  return crypto.timingSafeEqual(keys.check, Buffer.from(header.check, "base64"));
}

/**
 * The key of an archive, from the first of `passwords` that opens it.
 * Throws `ArchiveLockedError` when none does — or when there was none to try.
 */
export async function unlockSealedHead(head: SealedHead, passwords: readonly string[]): Promise<Buffer> {
  const tried = new Set<string>();
  for (const password of passwords) {
    if (!password || tried.has(password)) continue;
    tried.add(password);
    const keys = await deriveKeys(password, head.header);
    if (fits(keys, head.header)) return keys.key;
  }
  throw new ArchiveLockedError(head.header, tried.size > 0);
}

/** Whether `password` opens this archive. Throws for a file that is not an encrypted archive. */
export async function checkArchivePassword(file: string, password: string): Promise<boolean> {
  const head = await readSealedHead(file);
  if (!head) throw new SealedArchiveError("Questo archivio non è cifrato.");
  if (!password) return false;
  return fits(await deriveKeys(password, head.header), head.header);
}

// --- Chunks -----------------------------------------------------------------------

function nonceFor(index: number): Buffer {
  // 4 zero bytes, then the index as a 64-bit big-endian integer. Unique under
  // a key that is itself unique to the archive.
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(Math.floor(index / 0x1_0000_0000), 4);
  nonce.writeUInt32BE(index >>> 0, 8);
  return nonce;
}

function aadFor(hash: Buffer, index: number, final: boolean): Buffer {
  const aad = Buffer.alloc(hash.length + 9);
  hash.copy(aad, 0);
  aad.writeUInt32BE(Math.floor(index / 0x1_0000_0000), hash.length);
  aad.writeUInt32BE(index >>> 0, hash.length + 4);
  aad[hash.length + 8] = final ? 1 : 0;
  return aad;
}

function sealChunk(key: Buffer, hash: Buffer, index: number, final: boolean, plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonceFor(index), { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(hash, index, final));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(key: Buffer, hash: Buffer, index: number, final: boolean, stored: Buffer): Buffer {
  if (stored.length < TAG_BYTES) throw damaged(`il blocco ${index + 1} è troncato`);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonceFor(index), { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(hash, index, final));
    decipher.setAuthTag(stored.subarray(stored.length - TAG_BYTES));
    return Buffer.concat([decipher.update(stored.subarray(0, stored.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw damaged(`il blocco ${index + 1} non supera il controllo`);
  }
}

// --- Writing ----------------------------------------------------------------------

/**
 * The header first, then the zip in chunks.
 *
 * A full chunk is held back until either more bytes arrive or the stream ends:
 * only then is it known whether it is the last one, which is sealed as such.
 * The last chunk is empty only when the whole input is, so the file size alone
 * says where every chunk is and which one is last.
 */
class SealStream extends Transform {
  readonly #key: Buffer;
  readonly #head: SealedHead;
  readonly #chunk: Buffer;
  #filled = 0;
  #index = 0;
  #started = false;

  constructor(key: Buffer, head: SealedHead) {
    super();
    this.#key = key;
    this.#head = head;
    this.#chunk = Buffer.alloc(head.header.chunkSize);
  }

  #start() {
    if (this.#started) return;
    this.#started = true;
    this.push(this.#head.bytes);
  }

  #emit(final: boolean) {
    this.push(sealChunk(this.#key, this.#head.hash, this.#index, final, this.#chunk.subarray(0, this.#filled)));
    this.#index += 1;
    this.#filled = 0;
  }

  _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#start();
      const size = this.#chunk.length;
      let offset = 0;
      while (offset < data.length) {
        // Full, and more is coming: so it is not the last.
        if (this.#filled === size) this.#emit(false);
        const take = Math.min(size - this.#filled, data.length - offset);
        data.copy(this.#chunk, this.#filled, offset, offset + take);
        this.#filled += take;
        offset += take;
      }
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  _flush(done: TransformCallback): void {
    try {
      this.#start();
      this.#emit(true);
      this.#key.fill(0);
      done();
    } catch (err) {
      done(err as Error);
    }
  }
}

/** A key for one archive, ready to encrypt it. */
export interface ArchiveSeal {
  readonly keyId: string;
  readonly keyCreatedAt: string | null;
  /**
   * The encrypting stream. Once per seal: a second stream would repeat the
   * first one's nonces under the same key, which is the one mistake GCM does
   * not survive — so it throws instead.
   */
  createStream(): Transform;
}

export async function prepareSeal(opts: {
  password: string;
  keyId: string;
  keyCreatedAt?: string | null;
  /** Lower only in tests: every guess at the password costs what this costs. */
  kdf?: { N: number; r: number; p: number };
  chunkSize?: number;
}): Promise<ArchiveSeal> {
  if (!opts.password) throw new Error("Serve una password per cifrare l'archivio");
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const draft = {
    about: ABOUT,
    kdf: "scrypt" as const,
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: crypto.randomBytes(SALT_BYTES).toString("base64"),
    cipher: "aes-256-gcm" as const,
    chunkSize: opts.chunkSize ?? DEFAULT_CHUNK_BYTES,
    check: "",
    keyId: opts.keyId,
    keyCreatedAt: opts.keyCreatedAt ?? null,
  };
  const keys = await deriveKeys(opts.password, draft);
  const header: SealHeader = { ...draft, check: keys.check.toString("base64") };
  // The same rules as reading: the panel never writes what it could not read back.
  if (!validHeader(header)) throw new Error("Parametri di cifratura non validi");
  const bytes = encodeHeader(header);
  const head: SealedHead = { header, bytes, hash: sha256(bytes) };

  let used = false;
  return {
    keyId: header.keyId,
    keyCreatedAt: header.keyCreatedAt,
    createStream() {
      if (used) throw new Error("Questa chiave ha già cifrato un archivio: ne serve una nuova");
      used = true;
      return new SealStream(keys.key, head);
    },
  };
}

// --- Reading ----------------------------------------------------------------------

interface Layout {
  chunkSize: number;
  chunkCount: number;
  /** Bytes the last chunk takes in the file, its tag included. */
  lastStored: number;
  plainSize: number;
}

/**
 * Where every chunk is, from the file's size alone. A size no writer could
 * have produced — a tail shorter than a tag, an empty last chunk after full
 * ones — is a file that was cut or added to.
 */
function layoutOf(size: number, head: SealedHead): Layout {
  const chunkSize = head.header.chunkSize;
  const body = size - head.bytes.length;
  if (body < TAG_BYTES) throw damaged("il file è troncato");
  const stride = chunkSize + TAG_BYTES;
  const chunkCount = Math.ceil(body / stride);
  const lastStored = body - (chunkCount - 1) * stride;
  if (lastStored < TAG_BYTES || (lastStored === TAG_BYTES && chunkCount > 1)) throw damaged("il file è troncato");
  return { chunkSize, chunkCount, lastStored, plainSize: (chunkCount - 1) * chunkSize + lastStored - TAG_BYTES };
}

/** Decrypted chunks kept at hand: yauzl reads a directory in many small pieces. */
const CACHED_CHUNKS = 16;

/**
 * The zip inside an encrypted archive, for yauzl, without a copy in clear.
 *
 * Every read decrypts — and so authenticates — the chunks it touches. The last
 * chunk is always among them: yauzl starts from the end of the zip, where its
 * directory is, so a file cut short fails at the first open.
 */
export class SealedFileReader extends yauzl.RandomAccessReader {
  readonly plainSize: number;
  readonly #fd: number;
  readonly #key: Buffer;
  readonly #head: SealedHead;
  readonly #layout: Layout;
  readonly #cache = new Map<number, Buffer>();
  readonly #pending = new Map<number, Promise<Buffer>>();
  #closed = false;

  constructor(fd: number, head: SealedHead, key: Buffer, layout: Layout) {
    super();
    this.#fd = fd;
    this.#head = head;
    this.#key = key;
    this.#layout = layout;
    this.plainSize = layout.plainSize;
  }

  /** One chunk in clear. Shared with the cache: copy before handing it on. */
  chunk(index: number): Promise<Buffer> {
    // After close the descriptor number may already belong to another file.
    if (this.#closed) return Promise.reject(new Error("L'archivio è già stato chiuso"));
    const cached = this.#cache.get(index);
    if (cached) {
      this.#cache.delete(index);
      this.#cache.set(index, cached);
      return Promise.resolve(cached);
    }
    const pending = this.#pending.get(index);
    if (pending) return pending;

    const { chunkSize, chunkCount, lastStored } = this.#layout;
    if (index < 0 || index >= chunkCount) return Promise.reject(damaged("lettura oltre la fine dell'archivio"));
    const final = index === chunkCount - 1;
    const length = final ? lastStored : chunkSize + TAG_BYTES;
    const position = this.#head.bytes.length + index * (chunkSize + TAG_BYTES);

    const work = readAt(this.#fd, length, position)
      .then((stored) => {
        if (stored.length < length) throw damaged("il file è troncato");
        const plain = openChunk(this.#key, this.#head.hash, index, final, stored);
        this.#cache.set(index, plain);
        if (this.#cache.size > CACHED_CHUNKS) this.#cache.delete(this.#cache.keys().next().value as number);
        return plain;
      })
      .finally(() => this.#pending.delete(index));
    this.#pending.set(index, work);
    return work;
  }

  /** `length` bytes of the zip from `position`, in a buffer of their own. */
  async readRange(position: number, length: number): Promise<Buffer> {
    if (position < 0 || length < 0 || position + length > this.plainSize) {
      throw damaged("lettura oltre la fine dell'archivio");
    }
    const out = Buffer.alloc(length);
    const size = this.#layout.chunkSize;
    let done = 0;
    while (done < length) {
      const at = position + done;
      const index = Math.floor(at / size);
      const plain = await this.chunk(index);
      const from = at - index * size;
      const copied = plain.copy(out, done, from, Math.min(plain.length, from + (length - done)));
      if (copied === 0) throw damaged("lettura oltre la fine dell'archivio");
      done += copied;
    }
    return out;
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void
  ): void {
    this.readRange(position, length).then(
      (data) => {
        data.copy(buffer, offset);
        callback(null, length);
      },
      (err: Error) => callback(err)
    );
  }

  _readStreamForRange(start: number, end: number): Readable {
    let position = start;
    const size = this.#layout.chunkSize;
    const stream: Readable = new Readable({
      // One chunk per pull: a large member streams with one chunk in memory.
      read: () => {
        if (position >= end) {
          stream.push(null);
          return;
        }
        const index = Math.floor(position / size);
        this.chunk(index).then(
          (plain) => {
            const from = position - index * size;
            const to = Math.min(plain.length, end - index * size);
            if (to <= from) {
              stream.destroy(damaged("lettura oltre la fine dell'archivio"));
              return;
            }
            position += to - from;
            // A copy: whatever reads the stream may write into what it is given.
            stream.push(Buffer.from(plain.subarray(from, to)));
          },
          (err: Error) => stream.destroy(err)
        );
      },
    });
    return stream;
  }

  close(callback: (err: Error | null) => void): void {
    if (this.#closed) {
      setImmediate(() => callback(null));
      return;
    }
    this.#closed = true;
    this.#cache.clear();
    fs.close(this.#fd, (err) => callback(err ?? null));
  }
}

/**
 * A reader over the zip inside an encrypted archive. Close it, or hand it to
 * yauzl, which does. Used on its own, `ref()` it before `createReadStream`:
 * yauzl's reference counting closes the reader when the last stream it
 * counted ends.
 */
export async function openSealedReader(file: string, head: SealedHead, key: Buffer): Promise<SealedFileReader> {
  const fd = await openFd(file);
  try {
    // Read again from the descriptor that will be used, not trusted from the
    // earlier look: the file could have been replaced in between.
    const own = await headAt(fd);
    if (!own || !own.hash.equals(head.hash)) throw damaged("l'intestazione è cambiata durante la lettura");
    return new SealedFileReader(fd, head, key, layoutOf(await fileSize(fd), head));
  } catch (err) {
    await closeFd(fd);
    throw err;
  }
}

export type ZipOpener = (file: string) => Promise<yauzl.ZipFile>;

const ZIP_OPTIONS = { lazyEntries: true, autoClose: false } as const;

/** A plain zip, as every reader in the panel opens one. */
export function openPlainZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, ZIP_OPTIONS, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("Archivio illeggibile"));
      else resolve(zip);
    });
  });
}

export async function openSealedZip(file: string, head: SealedHead, key: Buffer): Promise<yauzl.ZipFile> {
  const reader = await openSealedReader(file, head, key);
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(reader, reader.plainSize, ZIP_OPTIONS, (err, zip) => {
      if (err || !zip) {
        // yauzl took a reference it gives back only through a ZipFile it never made.
        reader.close(() => {});
        reject(err ?? new Error("Archivio illeggibile"));
      } else {
        resolve(zip);
      }
    });
  });
}

/** The passwords worth trying on an archive, given its header. */
export type PasswordCandidates = (header: SealHeader) => readonly string[] | Promise<readonly string[]>;

/**
 * Opens plain and encrypted archives alike: the one function every reader of
 * an archive is handed.
 *
 * A key, once found, is kept for the life of the opener — one restore, one
 * check — because a restore opens the archive once per repository file, and
 * scrypt on every open would make that minutes. It is dropped with the opener.
 */
export function createArchiveOpener(candidates?: PasswordCandidates): ZipOpener {
  const unlocked = new Map<string, Buffer>();
  return async (file) => {
    const head = await readSealedHead(file);
    if (!head) return openPlainZip(file);
    const id = head.hash.toString("hex");
    let key = unlocked.get(id);
    if (!key) {
      key = await unlockSealedHead(head, candidates ? await candidates(head.header) : []);
      unlocked.set(id, key);
    }
    return openSealedZip(file, head, key);
  };
}
