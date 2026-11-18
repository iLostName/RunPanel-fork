/**
 * A small SFTP version 3 server over any pair of streams, backed by a folder.
 *
 * For the parts of the SFTP driver that OpenSSH's own `sftp-server` will not
 * do on request: replies out of order, short reads, a login script printing
 * text on the channel, a server that goes silent, a connection that drops in
 * the middle of an upload. Where `sftp-server` is installed the suite runs the
 * same checks against it as well, so this file and the driver cannot simply
 * agree with each other on a misreading of the protocol.
 *
 * Run as a program (by tests/ssh-fake.mjs) it serves stdin/stdout from
 * FAKE_SFTP_ROOT, with the knobs read from FAKE_SFTP_* variables.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, REMOVE: 13, MKDIR: 14,
  REALPATH: 16, STAT: 17, RENAME: 18, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
  EXTENDED: 200, EXTENDED_REPLY: 201,
};
const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, OP_UNSUPPORTED: 8 };

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
};
const str = (v) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
  return Buffer.concat([u32(b.length), b]);
};

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
  }
  u32() {
    const v = this.buf.readUInt32BE(this.at);
    this.at += 4;
    return v;
  }
  u64() {
    const v = Number(this.buf.readBigUInt64BE(this.at));
    this.at += 8;
    return v;
  }
  bytes() {
    const n = this.u32();
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  string() {
    return this.bytes().toString("utf8");
  }
}

function errnoStatus(err) {
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return FX.NO_SUCH_FILE;
  if (err?.code === "EACCES" || err?.code === "EPERM") return FX.PERMISSION_DENIED;
  return FX.FAILURE;
}

function attrsOf(stat) {
  const mode = stat.isDirectory() ? 0o040755 : 0o100600;
  return Buffer.concat([u32(0x1 | 0x4), u64(stat.size), u32(mode)]);
}

/**
 * knobs:
 *   banner          text written before anything else (a chatty .bashrc)
 *   shortReads      answer every read with at most half of what was asked
 *   reorder         answer each batch of requests in reverse order
 *   silent          answer INIT, then nothing
 *   dropAfterBytes  close the connection once this many bytes were written
 *   readOnly        refuse writes, mkdir, rename and remove with PERMISSION_DENIED
 *   noRename        refuse renames with FAILURE
 *   noRemove        refuse removes with PERMISSION_DENIED
 *   failWrites      refuse writes with this status code
 */
export function serveSftp({ input, output, root, knobs = {}, onDrop }) {
  const handles = new Map();
  let nextHandle = 1;
  let written = 0;
  let chunks = [];
  let buffered = 0;
  let batch = [];
  let dropped = false;

  const resolvePath = (p) => {
    const target = path.resolve(root, String(p).replace(/^\/+/, "") || ".");
    if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
      const err = new Error("outside");
      err.code = "EACCES";
      throw err;
    }
    return target;
  };

  const send = (type, id, ...parts) => {
    const body = Buffer.concat([Buffer.from([type]), ...(id === null ? [] : [u32(id)]), ...parts]);
    batch.push(Buffer.concat([u32(body.length), body]));
  };
  const status = (id, code, message = "") => send(T.STATUS, id, u32(code), str(message), str(""));
  const flush = () => {
    if (dropped) return;
    const out = knobs.reorder ? batch.reverse() : batch;
    batch = [];
    for (const packet of out) output.write(packet);
  };

  const drop = () => {
    dropped = true;
    batch = [];
    onDrop?.();
    output.end();
    input.destroy?.();
  };

  const handle = (type, r) => {
    if (type === T.INIT) {
      send(T.VERSION, null, u32(3), str("posix-rename@openssh.com"), str("1"), str("fsync@openssh.com"), str("1"));
      return;
    }
    const id = r.u32();
    if (knobs.silent) return;
    try {
      switch (type) {
        case T.OPEN: {
          const file = resolvePath(r.string());
          const flags = r.u32();
          const writing = (flags & 0x2) !== 0;
          if (writing && knobs.readOnly) return status(id, FX.PERMISSION_DENIED, "Permission denied");
          const mode = writing ? ((flags & 0x10) !== 0 ? "w" : "r+") : "r";
          const fd = fs.openSync(file, (flags & 0x20) !== 0 ? "wx" : mode, 0o600);
          const h = String(nextHandle++);
          handles.set(h, { fd, file });
          return send(T.HANDLE, id, str(h));
        }
        case T.CLOSE: {
          const key = r.string();
          const h = handles.get(key);
          if (!h) return status(id, FX.FAILURE, "bad handle");
          fs.closeSync(h.fd);
          handles.delete(key);
          return status(id, FX.OK);
        }
        case T.READ: {
          const h = handles.get(r.string());
          const offset = r.u64();
          let length = r.u32();
          if (knobs.shortReads) length = Math.max(1, Math.ceil(length / 2));
          const buf = Buffer.alloc(length);
          const n = fs.readSync(h.fd, buf, 0, length, offset);
          if (n === 0) return status(id, FX.EOF, "EOF");
          return send(T.DATA, id, str(buf.subarray(0, n)));
        }
        case T.WRITE: {
          const h = handles.get(r.string());
          const offset = r.u64();
          const data = r.bytes();
          if (knobs.failWrites) return status(id, knobs.failWrites, "Failure");
          fs.writeSync(h.fd, data, 0, data.length, offset);
          written += data.length;
          if (knobs.dropAfterBytes && written >= knobs.dropAfterBytes) {
            drop();
            return;
          }
          return status(id, FX.OK);
        }
        case T.FSTAT: {
          const h = handles.get(r.string());
          return send(T.ATTRS, id, attrsOf(fs.fstatSync(h.fd)));
        }
        case T.LSTAT:
        case T.STAT:
          return send(T.ATTRS, id, attrsOf(fs.statSync(resolvePath(r.string()))));
        case T.REMOVE:
          if (knobs.readOnly || knobs.noRemove) return status(id, FX.PERMISSION_DENIED, "Permission denied");
          fs.unlinkSync(resolvePath(r.string()));
          return status(id, FX.OK);
        case T.MKDIR:
          if (knobs.readOnly) return status(id, FX.PERMISSION_DENIED, "Permission denied");
          fs.mkdirSync(resolvePath(r.string()));
          return status(id, FX.OK);
        case T.REALPATH: {
          const p = resolvePath(r.string());
          const rel = "/" + path.relative(root, p).split(path.sep).join("/");
          return send(T.NAME, id, u32(1), str(rel), str(rel), u32(0));
        }
        case T.RENAME: {
          if (knobs.readOnly || knobs.noRename) return status(id, FX.FAILURE, "Failure");
          const from = resolvePath(r.string());
          const to = resolvePath(r.string());
          if (fs.existsSync(to)) return status(id, FX.FAILURE, "Failure");
          fs.renameSync(from, to);
          return status(id, FX.OK);
        }
        case T.EXTENDED: {
          const name = r.string();
          if (name === "posix-rename@openssh.com") {
            if (knobs.readOnly || knobs.noRename) return status(id, FX.FAILURE, "Failure");
            fs.renameSync(resolvePath(r.string()), resolvePath(r.string()));
            return status(id, FX.OK);
          }
          if (name === "fsync@openssh.com") return status(id, FX.OK);
          return status(id, FX.OP_UNSUPPORTED, "Operation unsupported");
        }
        default:
          return status(id, FX.OP_UNSUPPORTED, "Operation unsupported");
      }
    } catch (err) {
      return status(id, errnoStatus(err), err?.message ?? "Failure");
    }
  };

  if (knobs.banner) output.write(knobs.banner);

  input.on("data", (chunk) => {
    if (dropped) return;
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (buffered < 4) break;
      const all = Buffer.concat(chunks);
      const length = all.readUInt32BE(0);
      if (buffered < 4 + length) {
        chunks = [all];
        break;
      }
      const packet = all.subarray(4, 4 + length);
      const rest = all.subarray(4 + length);
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
      handle(packet[0], new Reader(packet.subarray(1)));
      if (dropped) return;
    }
    flush();
  });
  input.on("end", () => {
    for (const h of handles.values()) fs.closeSync(h.fd);
    output.end();
  });
}

/** The knobs as a program reads them from its environment. */
export function knobsFromEnv(env = process.env) {
  return {
    banner: env.FAKE_SFTP_BANNER || undefined,
    shortReads: env.FAKE_SFTP_SHORT_READS === "1",
    reorder: env.FAKE_SFTP_REORDER === "1",
    silent: env.FAKE_SFTP_SILENT === "1",
    dropAfterBytes: env.FAKE_SFTP_DROP_AFTER ? Number(env.FAKE_SFTP_DROP_AFTER) : undefined,
    readOnly: env.FAKE_SFTP_READ_ONLY === "1",
    noRename: env.FAKE_SFTP_NO_RENAME === "1",
    noRemove: env.FAKE_SFTP_NO_REMOVE === "1",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveSftp({
    input: process.stdin,
    output: process.stdout,
    root: process.env.FAKE_SFTP_ROOT ?? process.cwd(),
    knobs: knobsFromEnv(),
    onDrop: () => setTimeout(() => process.exit(255), 10),
  });
}
