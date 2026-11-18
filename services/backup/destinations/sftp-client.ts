import fs from "node:fs";
import { Readable, type Writable } from "node:stream";

/**
 * An SFTP client, version 3 of the protocol, over any pair of streams.
 *
 * The pair is the stdin and stdout of `ssh -s … sftp`: OpenSSH does the
 * connection, the authentication and the host key, and this file speaks the
 * file protocol on top. That split is the reason the panel needs neither a
 * library nor the `sftp` program — which cannot stream a download into a pipe,
 * because it seeks in the file it writes — and it is also what makes accounts
 * without a shell work: storage boxes and most NAS give SFTP only, which is
 * exactly the subsystem this talks to.
 *
 * Version 3 (draft-ietf-secsh-filexfer-02) because it is what every server
 * speaks, OpenSSH included. Of it, only what a backup needs: open, read, write,
 * close, stat, mkdir, remove, rename; and three OpenSSH extensions used when
 * the server offers them — `posix-rename` (an atomic rename that also works on
 * filesystems without hard links), `fsync` (the data is on the disk before the
 * file gets its final name) and `statvfs` (free space, to explain a refused
 * write) — plus `limits`, to send larger pieces to a server that accepts them.
 *
 * Requests are pipelined: an upload keeps a window of writes in flight and a
 * download a window of reads, so a link with 50 ms of latency is not reduced
 * to one 32 KB piece per round trip. Memory stays bounded by that window.
 *
 * Only `node:` imports; the unit suite runs it against OpenSSH's own
 * `sftp-server` when one is installed.
 */

export const FX = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
  /** Later drafts; some version-3 servers send them all the same. */
  NO_SPACE_ON_FILESYSTEM: 14,
  QUOTA_EXCEEDED: 15,
} as const;

const T = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  FSTAT: 8,
  REMOVE: 13,
  MKDIR: 14,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
  EXTENDED_REPLY: 201,
} as const;

export const OPEN_FLAGS = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 } as const;

const ATTR = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8, EXTENDED: 0x80000000 } as const;

/** Every server accepts this much data in one request; the spec says so. */
const SAFE_CHUNK = 32 * 1024;
/** Larger pieces, when the server says it takes them, stay under OpenSSH's own 256 KB packets. */
const MAX_CHUNK = 255 * 1024;
/** Bytes in flight in either direction, whatever the piece size. */
const WINDOW_BYTES = 8 * 1024 * 1024;
/** A packet this long is not one: text printed by a login script, most often. */
const MAX_PACKET = 4 * 1024 * 1024;

export type SftpOperation =
  | "init"
  | "open"
  | "close"
  | "read"
  | "write"
  | "fstat"
  | "stat"
  | "remove"
  | "mkdir"
  | "rename"
  | "realpath"
  | "statvfs"
  | "fsync"
  | "limits";

/** The server answered, and the answer was no. */
export class SftpStatusError extends Error {
  readonly status: number;
  readonly serverMessage: string;
  readonly operation: SftpOperation;
  readonly path: string;
  constructor(status: number, serverMessage: string, operation: SftpOperation, path: string) {
    super(`SFTP ${operation} ${path}: ${serverMessage || `status ${status}`}`);
    this.name = "SftpStatusError";
    this.status = status;
    this.serverMessage = serverMessage;
    this.operation = operation;
    this.path = path;
  }
}

export type SftpProtocolCode = "CLOSED" | "BANNER" | "PROTOCOL" | "STALLED" | "ABORTED";

/** The conversation itself broke: the connection closed, or what came back is not SFTP. */
export class SftpProtocolError extends Error {
  readonly code: SftpProtocolCode;
  /** For BANNER: the start of what the server printed instead of answering. */
  readonly sample: string | null;
  constructor(code: SftpProtocolCode, message: string, sample: string | null = null) {
    super(message);
    this.name = "SftpProtocolError";
    this.code = code;
    this.sample = sample;
  }
}

export interface SftpAttrs {
  size: number | null;
  permissions: number | null;
  mtime: number | null;
  /** Null when the server did not send permissions. */
  isDirectory: boolean | null;
}

export interface SftpSpace {
  /** Bytes an unprivileged user may still write. */
  available: number;
  total: number;
}

export interface SftpChannel {
  /** What the server sends: the stdout of `ssh`. */
  input: Readable;
  /** What the server reads: the stdin of `ssh`. */
  output: Writable;
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
  operation: SftpOperation;
  path: string;
}

interface Reply {
  type: number;
  body: Buffer;
}

// --- Wire encoding -------------------------------------------------------------

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
}

function str(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(bytes.length), bytes]);
}

function attrs(permissions: number | null): Buffer {
  return permissions === null ? u32(0) : Buffer.concat([u32(ATTR.PERMISSIONS), u32(permissions)]);
}

// Plain fields rather than parameter properties: the unit suites load this
// file with Node's type stripping, which does not rewrite constructors.
class Cursor {
  private at = 0;
  private readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  get remaining(): number {
    return this.data.length - this.at;
  }
  u32(): number {
    if (this.remaining < 4) throw new SftpProtocolError("PROTOCOL", "Risposta SFTP troncata");
    const value = this.data.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }
  u64(): number {
    if (this.remaining < 8) throw new SftpProtocolError("PROTOCOL", "Risposta SFTP troncata");
    const value = this.data.readBigUInt64BE(this.at);
    this.at += 8;
    return Number(value);
  }
  bytes(): Buffer {
    const length = this.u32();
    if (this.remaining < length) throw new SftpProtocolError("PROTOCOL", "Risposta SFTP troncata");
    const out = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
  string(): string {
    return this.bytes().toString("utf8");
  }
  attrs(): SftpAttrs {
    const flags = this.u32();
    let size: number | null = null;
    let permissions: number | null = null;
    let mtime: number | null = null;
    if (flags & ATTR.SIZE) size = this.u64();
    if (flags & ATTR.UIDGID) {
      this.u32();
      this.u32();
    }
    if (flags & ATTR.PERMISSIONS) permissions = this.u32();
    if (flags & ATTR.ACMODTIME) {
      this.u32();
      mtime = this.u32();
    }
    if (flags & ATTR.EXTENDED) {
      const count = this.u32();
      for (let i = 0; i < count; i++) {
        this.bytes();
        this.bytes();
      }
    }
    return {
      size,
      permissions,
      mtime,
      isDirectory: permissions === null ? null : (permissions & 0o170000) === 0o040000,
    };
  }
}

/** Printable start of what arrived instead of a packet, for the error message. */
function sampleOf(data: Buffer): string {
  return data
    .subarray(0, 120)
    .toString("utf8")
    .replace(/[^\x20-\x7e -￿]+/g, " ")
    .trim();
}

export function isStatus(err: unknown, ...statuses: number[]): err is SftpStatusError {
  return err instanceof SftpStatusError && (statuses.length === 0 || statuses.includes(err.status));
}

// --- The client ----------------------------------------------------------------

export class SftpClient {
  version = 0;
  readonly extensions = new Map<string, string>();
  /** Piece sizes, raised by `limits@openssh.com` when the server offers it. */
  readChunk = SAFE_CHUNK;
  writeChunk = SAFE_CHUNK;

  private readonly channel: SftpChannel;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private gotVersion = false;
  private onVersion: ((body: Buffer) => void) | null = null;
  private failure: Error | null = null;
  private readonly stallMs: number;
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly closeListeners: ((err: Error) => void)[] = [];
  private readonly drainWaiters = new Set<() => void>();

  constructor(channel: SftpChannel, opts: { stallMs?: number } = {}) {
    this.channel = channel;
    this.stallMs = opts.stallMs ?? 5 * 60_000;
    channel.input.on("data", (chunk: Buffer) => this.receive(chunk));
    channel.input.on("end", () => this.fail(new SftpProtocolError("CLOSED", "Il server ha chiuso la connessione SFTP")));
    channel.input.on("error", (err: Error) => this.fail(new SftpProtocolError("CLOSED", `Connessione SFTP interrotta: ${err.message}`)));
    // A write after the other side went away: the read side reports why.
    channel.output.on("error", () => {});
  }

  /** The error that ended the conversation, once it has ended. */
  get closedWith(): Error | null {
    return this.failure;
  }

  onClose(listener: (err: Error) => void): void {
    this.closeListeners.push(listener);
  }

  /** Ends the conversation: every request still waiting fails with `err`. */
  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.clearStall();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(err);
    this.onVersion = null;
    for (const waiter of [...this.drainWaiters]) waiter();
    for (const listener of [...this.closeListeners]) listener(err);
  }

  /** Done: the server sees the end of its input and exits. */
  end(): void {
    if (!this.failure) this.fail(new SftpProtocolError("CLOSED", "Connessione SFTP chiusa"));
    this.channel.output.end();
  }

  async init(): Promise<void> {
    const body = await new Promise<Buffer>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.onVersion = resolve;
      this.closeListeners.push(reject);
      this.send(Buffer.concat([Buffer.from([T.INIT]), u32(3)]));
    });
    const cursor = new Cursor(body);
    this.version = cursor.u32();
    while (cursor.remaining > 0) {
      const name = cursor.string();
      const data = cursor.string();
      this.extensions.set(name, data);
    }
    if (this.extensions.has("limits@openssh.com")) {
      const limits = await this.extended("limits@openssh.com", [], "limits", "").catch(() => null);
      if (limits?.type === T.EXTENDED_REPLY) {
        const cursor2 = new Cursor(limits.body);
        cursor2.u64(); // max packet length
        const maxRead = cursor2.u64();
        const maxWrite = cursor2.u64();
        if (maxRead > 0) this.readChunk = Math.max(SAFE_CHUNK, Math.min(maxRead, MAX_CHUNK));
        if (maxWrite > 0) this.writeChunk = Math.max(SAFE_CHUNK, Math.min(maxWrite, MAX_CHUNK));
      }
    }
  }

  // --- requests ------------------------------------------------------------------

  async stat(path: string): Promise<SftpAttrs> {
    return this.attrsOf(await this.request(T.STAT, [str(path)], "stat", path), "stat", path);
  }

  async fstat(handle: Buffer, path: string): Promise<SftpAttrs> {
    return this.attrsOf(await this.request(T.FSTAT, [str(handle)], "fstat", path), "fstat", path);
  }

  async open(path: string, flags: number, permissions: number | null = null): Promise<Buffer> {
    const reply = await this.request(T.OPEN, [str(path), u32(flags), attrs(permissions)], "open", path);
    if (reply.type === T.HANDLE) return new Cursor(reply.body).bytes();
    throw this.unexpected(reply, "open", path);
  }

  async close(handle: Buffer, path: string): Promise<void> {
    this.expectOk(await this.request(T.CLOSE, [str(handle)], "close", path), "close", path);
  }

  /** The bytes at `offset`, possibly fewer than asked; null at the end of the file. */
  async read(handle: Buffer, offset: number, length: number, path: string): Promise<Buffer | null> {
    const reply = await this.request(T.READ, [str(handle), u64(offset), u32(length)], "read", path);
    if (reply.type === T.DATA) return new Cursor(reply.body).bytes();
    if (reply.type === T.STATUS) {
      const cursor = new Cursor(reply.body);
      const status = cursor.u32();
      if (status === FX.EOF) return null;
      throw new SftpStatusError(status, cursor.remaining > 0 ? cursor.string() : "", "read", path);
    }
    throw this.unexpected(reply, "read", path);
  }

  async write(handle: Buffer, offset: number, data: Buffer, path: string): Promise<void> {
    this.expectOk(await this.request(T.WRITE, [str(handle), u64(offset), str(data)], "write", path), "write", path);
  }

  async remove(path: string): Promise<void> {
    this.expectOk(await this.request(T.REMOVE, [str(path)], "remove", path), "remove", path);
  }

  async mkdir(path: string, permissions: number | null = null): Promise<void> {
    this.expectOk(await this.request(T.MKDIR, [str(path), attrs(permissions)], "mkdir", path), "mkdir", path);
  }

  async realpath(path: string): Promise<string> {
    const reply = await this.request(T.REALPATH, [str(path)], "realpath", path);
    if (reply.type === T.NAME) {
      const cursor = new Cursor(reply.body);
      if (cursor.u32() < 1) throw new SftpProtocolError("PROTOCOL", "Risposta SFTP vuota");
      return cursor.string();
    }
    throw this.unexpected(reply, "realpath", path);
  }

  /**
   * `from` takes the name `to`.
   *
   * The OpenSSH extension when offered: rename(2) itself, atomic, and fine on a
   * filesystem without hard links, where the version-3 RENAME of OpenSSH (a
   * link and an unlink) has to fall back to something weaker.
   */
  async rename(from: string, to: string): Promise<void> {
    if (this.extensions.has("posix-rename@openssh.com")) {
      this.expectOk(await this.extended("posix-rename@openssh.com", [str(from), str(to)], "rename", from), "rename", from);
      return;
    }
    this.expectOk(await this.request(T.RENAME, [str(from), str(to)], "rename", from), "rename", from);
  }

  /** Flushed to the server's disk. False when the server cannot be asked. */
  async fsync(handle: Buffer, path: string): Promise<boolean> {
    if (!this.extensions.has("fsync@openssh.com")) return false;
    this.expectOk(await this.extended("fsync@openssh.com", [str(handle)], "fsync", path), "fsync", path);
    return true;
  }

  /** Free and total space where `path` lives, or null when the server does not say. */
  async space(path: string): Promise<SftpSpace | null> {
    if (!this.extensions.has("statvfs@openssh.com")) return null;
    const reply = await this.extended("statvfs@openssh.com", [str(path)], "statvfs", path).catch(() => null);
    if (!reply || reply.type !== T.EXTENDED_REPLY) return null;
    const cursor = new Cursor(reply.body);
    const bsize = cursor.u64();
    const frsize = cursor.u64();
    const blocks = cursor.u64();
    cursor.u64(); // bfree
    const bavail = cursor.u64();
    const unit = frsize || bsize;
    // Some servers answer with zeros for a filesystem they cannot measure:
    // "0 bytes free" would be a lie, and a dangerous one.
    if (!unit || !blocks) return null;
    return { available: bavail * unit, total: blocks * unit };
  }

  // --- what a backup does with them --------------------------------------------

  /**
   * The folder, and every folder above it, created where missing.
   *
   * Each level is looked at before it is created, so an existing folder is
   * never "created" again, and a level the account may not look into — the
   * root of a chrooted NAS — is stepped over rather than refused: whether the
   * account may write in the level it needs is what the next step finds out.
   */
  async ensureDir(folder: string): Promise<void> {
    if (!folder || folder === "/" || folder === ".") return;
    const whole = await this.stat(folder).catch((err: unknown) => {
      if (isStatus(err, FX.NO_SUCH_FILE, FX.PERMISSION_DENIED)) return null;
      throw err;
    });
    if (whole) {
      if (whole.isDirectory === false) throw new SftpStatusError(FX.FAILURE, "not a directory", "mkdir", folder);
      return;
    }

    const absolute = folder.startsWith("/");
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : absolute ? `/${part}` : part;
      const found = await this.stat(current).catch((err: unknown) => {
        if (isStatus(err, FX.NO_SUCH_FILE)) return null;
        if (isStatus(err, FX.PERMISSION_DENIED)) return "unknown" as const;
        throw err;
      });
      if (found === "unknown") continue;
      if (found) {
        if (found.isDirectory === false) throw new SftpStatusError(FX.FAILURE, "not a directory", "mkdir", current);
        continue;
      }
      try {
        await this.mkdir(current, 0o700);
      } catch (err) {
        // Created in the meantime, or a server that reports "exists" as a failure.
        const again = await this.stat(current).catch(() => null);
        if (!again || again.isDirectory === false) throw err;
      }
    }
  }

  /**
   * A local file written to `remotePath`, with a window of writes in flight.
   *
   * The file is created 0600 (archives carry the panel's secrets), flushed to
   * the server's disk when the server can be asked, and closed — and a refused
   * close fails the upload, because on several servers that is where a full
   * disk is finally reported.
   */
  async upload(
    localPath: string,
    remotePath: string,
    opts: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {}
  ): Promise<number> {
    let handle: Buffer;
    try {
      handle = await this.open(remotePath, OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.TRUNC, 0o600);
    } catch (err) {
      // A server that will not take a mode on open (some Windows-backed ones):
      // the archive is still worth writing with the server's default.
      if (!isStatus(err, FX.OP_UNSUPPORTED, FX.BAD_MESSAGE)) throw err;
      handle = await this.open(remotePath, OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.TRUNC);
    }

    const chunk = this.writeChunk;
    const window = Math.max(4, Math.min(64, Math.floor(WINDOW_BYTES / chunk)));
    const inFlight = new Set<Promise<void>>();
    let firstError: unknown = null;
    let offset = 0;
    const source = fs.createReadStream(localPath, { highWaterMark: chunk });

    try {
      for await (const piece of source as AsyncIterable<Buffer>) {
        if (opts.signal?.aborted) throw new SftpProtocolError("ABORTED", "Caricamento annullato");
        if (firstError) break;
        const at = offset;
        offset += piece.length;
        const write: Promise<void> = this.write(handle, at, piece, remotePath).then(
          () => {
            inFlight.delete(write);
          },
          (err: unknown) => {
            inFlight.delete(write);
            firstError ??= err;
          }
        );
        inFlight.add(write);
        opts.onProgress?.(offset);
        while (inFlight.size >= window) await Promise.race(inFlight);
        if (this.channel.output.writableNeedDrain) await this.waitDrain();
      }
      await Promise.all(inFlight);
      if (firstError) throw firstError;
      await this.fsync(handle, remotePath).catch((err: unknown) => {
        // Unsupported for this file (some mounts): the close below still has to succeed.
        if (!isStatus(err, FX.OP_UNSUPPORTED)) throw err;
      });
    } catch (err) {
      source.destroy();
      await this.close(handle, remotePath).catch(() => {});
      throw err;
    }
    await this.close(handle, remotePath);
    return offset;
  }

  /**
   * A remote file as a stream, with a window of reads in flight.
   *
   * Opened before this resolves, so a missing archive is an error here and not
   * a stream that fails on its first read. Pieces are delivered in order
   * whatever order the replies come in; a short read — legal, and some servers
   * do it — asks for the rest before anything after it.
   */
  async download(remotePath: string, opts: { onEnd?: () => void } = {}): Promise<Readable> {
    const handle = await this.open(remotePath, OPEN_FLAGS.READ);
    let size: number | null = null;
    try {
      size = (await this.fstat(handle, remotePath)).size;
    } catch {
      size = null;
    }
    return new SftpReadStream(this, handle, remotePath, size, this.readChunk, opts.onEnd);
  }

  // --- plumbing --------------------------------------------------------------------

  private extended(name: string, payload: Buffer[], operation: SftpOperation, path: string): Promise<Reply> {
    return this.request(T.EXTENDED, [str(name), ...payload], operation, path);
  }

  private request(type: number, payload: Buffer[], operation: SftpOperation, path: string): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, operation, path });
      this.armStall();
      this.send(Buffer.concat([Buffer.from([type]), u32(id), ...payload]));
    });
  }

  private send(body: Buffer): void {
    try {
      this.channel.output.write(Buffer.concat([u32(body.length), body]));
    } catch (err) {
      this.fail(new SftpProtocolError("CLOSED", `Connessione SFTP interrotta: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.failure) return resolve();
      const done = () => {
        this.channel.output.off("drain", done);
        this.drainWaiters.delete(done);
        resolve();
      };
      this.channel.output.on("drain", done);
      this.drainWaiters.add(done);
    });
  }

  /**
   * Incoming bytes, cut into packets. The pieces are joined only once a whole
   * packet is there, so a 255 KB reply arriving in pipe-sized chunks is copied
   * once, not once per chunk.
   */
  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 4) {
      const first = this.chunks[0];
      const length = first.length >= 4 ? first.readUInt32BE(0) : Buffer.concat(this.chunks, 4).readUInt32BE(0);
      if (length > MAX_PACKET || length === 0) {
        // Before the first answer, this is a login script talking on the
        // channel (`echo` in a .bashrc): the classic "message too long".
        const err = this.gotVersion
          ? new SftpProtocolError("PROTOCOL", `Pacchetto SFTP non valido (${length} byte)`)
          : new SftpProtocolError("BANNER", "Il server ha scritto del testo invece di rispondere in SFTP", sampleOf(Buffer.concat(this.chunks)));
        this.fail(err);
        return;
      }
      if (this.buffered < 4 + length) return;
      this.dispatch(this.take(4 + length).subarray(4));
      if (this.failure) return;
    }
  }

  /** Exactly `count` bytes off the front of what has arrived. */
  private take(count: number): Buffer {
    this.buffered -= count;
    const first = this.chunks[0];
    if (first.length >= count) {
      if (first.length === count) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    while (copied < count) {
      const head = this.chunks[0];
      const need = count - copied;
      if (head.length <= need) {
        head.copy(out, copied);
        copied += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, copied, 0, need);
        this.chunks[0] = head.subarray(need);
        copied += need;
      }
    }
    return out;
  }

  private dispatch(packet: Buffer): void {
    const type = packet[0];
    if (type === T.VERSION) {
      if (this.gotVersion) return;
      this.gotVersion = true;
      const resolve = this.onVersion;
      this.onVersion = null;
      resolve?.(Buffer.from(packet.subarray(1)));
      return;
    }
    if (packet.length < 5) {
      this.fail(new SftpProtocolError("PROTOCOL", "Risposta SFTP troncata"));
      return;
    }
    const id = packet.readUInt32BE(1);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (this.pending.size === 0) this.clearStall();
    else this.armStall();
    entry.resolve({ type, body: packet.subarray(5) });
  }

  private armStall(): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      if (this.pending.size > 0) {
        this.fail(new SftpProtocolError("STALLED", "Il server ha smesso di rispondere a metà operazione"));
      }
    }, this.stallMs);
    this.stallTimer.unref?.();
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private expectOk(reply: Reply, operation: SftpOperation, path: string): void {
    if (reply.type !== T.STATUS) throw this.unexpected(reply, operation, path);
    const cursor = new Cursor(reply.body);
    const status = cursor.u32();
    if (status !== FX.OK) throw new SftpStatusError(status, cursor.remaining > 0 ? cursor.string() : "", operation, path);
  }

  private attrsOf(reply: Reply, operation: SftpOperation, path: string): SftpAttrs {
    if (reply.type === T.ATTRS) return new Cursor(reply.body).attrs();
    throw this.unexpected(reply, operation, path);
  }

  private unexpected(reply: Reply, operation: SftpOperation, path: string): Error {
    if (reply.type === T.STATUS) {
      const cursor = new Cursor(reply.body);
      const status = cursor.u32();
      return new SftpStatusError(status, cursor.remaining > 0 ? cursor.string() : "", operation, path);
    }
    return new SftpProtocolError("PROTOCOL", `Risposta SFTP inattesa (${reply.type}) a ${operation}`);
  }
}

interface ReadEntry {
  offset: number;
  length: number;
  state: "pending" | "done" | "failed";
  data: Buffer | null;
  error: unknown;
}

/** See `SftpClient.download`. */
class SftpReadStream extends Readable {
  private readonly queue: ReadEntry[] = [];
  private nextOffset = 0;
  private delivered = 0;
  private sawEof = false;
  private finished = false;
  private readonly window: number;
  private readonly client: SftpClient;
  private readonly handle: Buffer;
  private readonly path: string;
  private readonly size: number | null;
  private readonly chunk: number;
  private readonly onEnd?: () => void;

  constructor(client: SftpClient, handle: Buffer, path: string, size: number | null, chunk: number, onEnd?: () => void) {
    super();
    this.client = client;
    this.handle = handle;
    this.path = path;
    this.size = size;
    this.chunk = chunk;
    this.onEnd = onEnd;
    this.window = Math.max(4, Math.min(64, Math.floor(WINDOW_BYTES / chunk)));
    client.onClose((err) => {
      if (!this.finished && !this.destroyed) this.destroy(err);
    });
  }

  override _read(): void {
    this.drain();
  }

  private fill(): void {
    while (!this.sawEof && this.queue.length < this.window && (this.size === null || this.nextOffset < this.size)) {
      const length = this.size === null ? this.chunk : Math.min(this.chunk, this.size - this.nextOffset);
      this.enqueue(this.nextOffset, length, false);
      this.nextOffset += length;
    }
  }

  private enqueue(offset: number, length: number, first: boolean): void {
    const entry: ReadEntry = { offset, length, state: "pending", data: null, error: null };
    if (first) this.queue.unshift(entry);
    else this.queue.push(entry);
    this.client.read(this.handle, offset, length, this.path).then(
      (data) => {
        entry.state = "done";
        entry.data = data;
        this.drain();
      },
      (err: unknown) => {
        entry.state = "failed";
        entry.error = err;
        this.drain();
      }
    );
  }

  private drain(): void {
    if (this.finished || this.destroyed) return;
    while (this.queue.length > 0 && this.queue[0].state !== "pending") {
      const head = this.queue.shift() as ReadEntry;
      if (head.state === "failed") {
        this.destroy(head.error instanceof Error ? head.error : new Error(String(head.error)));
        return;
      }
      const data = head.data;
      if (!data || data.length === 0) {
        this.sawEof = true;
        if (this.size !== null && head.offset < this.size) {
          this.destroy(
            new SftpStatusError(FX.FAILURE, `file shorter than expected (${head.offset} of ${this.size} bytes)`, "read", this.path)
          );
          return;
        }
        // Later requests can only be at the end too; nothing more to deliver.
        this.queue.length = 0;
        break;
      }
      if (data.length < head.length) this.enqueue(head.offset + data.length, head.length - data.length, true);
      this.delivered += data.length;
      if (!this.push(data)) return;
    }
    const complete = this.size !== null ? this.delivered >= this.size && this.queue.length === 0 : this.sawEof && this.queue.length === 0;
    if (complete) {
      void this.finish();
      return;
    }
    this.fill();
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.client.close(this.handle, this.path).catch(() => {});
    this.onEnd?.();
    this.push(null);
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.finished) {
      this.finished = true;
      this.client.close(this.handle, this.path).catch(() => {});
      this.onEnd?.();
    }
    callback(err);
  }
}
