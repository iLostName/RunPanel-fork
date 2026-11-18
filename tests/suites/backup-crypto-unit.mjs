import { createReporter } from "../harness.mjs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Archives encrypted with a password: the format, then the archive.
 *
 * The format is checked where it breaks: inputs on either side of a chunk
 * boundary (empty, one byte, exact multiples), a wrong password, a file cut
 * at a boundary and in the middle of a chunk, a flipped byte in a chunk and
 * in a tag, two chunks swapped or one repeated, bytes appended, a header
 * edited, and reads at random positions across chunks. Then a real archive
 * from `writeArchive`, read back through the opener by every reader the
 * panel has, and turned back into a zip by `scripts/decrypt-backup.mjs` —
 * which shares no code with the panel, so the two readings of the format are
 * checked against each other.
 *
 * Standalone: archive-crypto.ts imports only `node:` modules and yauzl. The
 * KDF is turned down to N = 1024 except in one round trip, so the suite does
 * not spend minutes in scrypt.
 */
export const meta = { name: "backup-crypto-unit", needsDocker: false, drivers: [], standalone: true };

const FAST = { N: 1024, r: 8, p: 1 };
const CHUNK = 1024;
const TAG = 16;
const PASSWORD = "una password lunga dei backup";

/** Deterministic bytes, so a failure reproduces. */
function bytes(size, seed = 1) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function pieces(buffer, size) {
  const out = [];
  for (let at = 0; at < buffer.length; at += size) out.push(buffer.subarray(at, at + size));
  return out;
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-crypto-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const sealed = await load("services", "backup", "archive-crypto.ts");
  const { writeArchive } = await load("services", "backup", "archive.ts");
  const read = await load("services", "backup", "archive-read.ts");
  const integrity = await load("services", "backup", "integrity.ts");

  const root = fs.mkdtempSync(join(os.tmpdir(), "runpanel-crypto-"));
  let counter = 0;
  const path = (name) => join(root, `${counter++}-${name}`);

  const seal = async (plain, opts = {}) => {
    const s = await sealed.prepareSeal({
      password: opts.password ?? PASSWORD,
      keyId: opts.keyId ?? "k1",
      keyCreatedAt: opts.keyCreatedAt ?? "2026-11-18T10:00:00.000Z",
      kdf: opts.kdf ?? FAST,
      chunkSize: opts.chunkSize ?? CHUNK,
    });
    const file = path("archive.enc");
    const input = opts.pieceSize ? pieces(plain, opts.pieceSize) : plain.length ? [plain] : [];
    await pipeline(Readable.from(input), s.createStream(), fs.createWriteStream(file));
    return file;
  };

  /** The reader over a file, or the error opening it raised. */
  const openReader = async (file, password = PASSWORD) => {
    const head = await sealed.readSealedHead(file);
    const key = await sealed.unlockSealedHead(head, [password]);
    return sealed.openSealedReader(file, head, key);
  };
  const close = (reader) => new Promise((resolve) => reader.close(resolve));

  /** Everything in clear, or the error that stopped it. */
  const decryptAll = async (file, password = PASSWORD) => {
    let reader;
    try {
      reader = await openReader(file, password);
      return { plain: reader.plainSize ? await reader.readRange(0, reader.plainSize) : Buffer.alloc(0) };
    } catch (err) {
      return { error: err };
    } finally {
      if (reader) await close(reader);
    }
  };

  const headerLength = async (file) => (await sealed.readSealedHead(file)).bytes.length;

  try {
    // --- round trips at the chunk boundaries -------------------------------------
    {
      const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 2 * CHUNK + 1, 3 * CHUNK + 5, 10_000];
      const failures = [];
      const shapes = [];
      for (const size of sizes) {
        const plain = bytes(size, size + 7);
        for (const pieceSize of [undefined, 7, CHUNK]) {
          const file = await seal(plain, { pieceSize });
          const back = await decryptAll(file);
          if (!back.plain?.equals(plain)) failures.push(`${size}/${pieceSize ?? "whole"}: ${back.error?.message ?? "different bytes"}`);
          const expectedChunks = Math.max(1, Math.ceil(size / CHUNK));
          const expectedSize = (await headerLength(file)) + size + expectedChunks * TAG;
          if (fs.statSync(file).size !== expectedSize) shapes.push(`${size}: ${fs.statSync(file).size} != ${expectedSize}`);
        }
      }
      r.check("every size round-trips, fed whole, in small pieces and in chunk-sized ones", failures.length === 0, failures.join("; "));
      r.check(
        "one chunk per started chunk, no empty one after an exact multiple, one empty chunk for nothing",
        shapes.length === 0,
        shapes.join("; ")
      );
    }

    // --- the password -------------------------------------------------------------
    const plain = bytes(5 * CHUNK + 300, 42);
    const good = await seal(plain);
    {
      const head = await sealed.readSealedHead(good);
      r.check("the header says which password and when", head.header.keyId === "k1" && head.header.keyCreatedAt === "2026-11-18T10:00:00.000Z");
      r.check("the file starts with the magic, not with a zip", fs.readFileSync(good).subarray(0, 7).toString("latin1") === "RPBKENC");

      let wrong = null;
      try {
        await sealed.unlockSealedHead(head, ["sbagliata", "anche questa"]);
      } catch (err) {
        wrong = err;
      }
      r.check("a wrong password is refused", wrong instanceof sealed.ArchiveLockedError && wrong.wrongPassword === true, String(wrong));

      let none = null;
      try {
        await sealed.unlockSealedHead(head, []);
      } catch (err) {
        none = err;
      }
      r.check("no password at all says so, rather than 'wrong'", none instanceof sealed.ArchiveLockedError && none.wrongPassword === false);

      const key = await sealed.unlockSealedHead(head, ["sbagliata", PASSWORD]);
      r.check("the right one among several is found", key.length === 32);
      r.check("checkArchivePassword agrees", (await sealed.checkArchivePassword(good, PASSWORD)) && !(await sealed.checkArchivePassword(good, "no")));
    }
    {
      // "è" as one code point and as "e" plus a combining accent.
      const composed = "perché è così";
      const decomposed = composed.normalize("NFD");
      r.check("the two spellings really differ", composed !== decomposed);
      const file = await seal(plain, { password: composed });
      const back = await decryptAll(file, decomposed);
      r.check("a password is the same whatever the keyboard composed", back.plain?.equals(plain), String(back.error));
    }
    {
      const s = await sealed.prepareSeal({ password: PASSWORD, keyId: "k1", kdf: FAST, chunkSize: CHUNK });
      s.createStream();
      let again = null;
      try {
        s.createStream();
      } catch (err) {
        again = err;
      }
      r.check("a seal encrypts one archive only: a second stream would reuse its nonces", again !== null);
    }

    // --- damage ---------------------------------------------------------------------
    const original = fs.readFileSync(good);
    const head = await headerLength(good);
    const stride = CHUNK + TAG;
    const chunkAt = (index) => head + index * stride;
    const variant = (mutate) => {
      const copy = Buffer.from(original);
      const out = mutate(copy) ?? copy;
      const file = path("damaged.enc");
      fs.writeFileSync(file, out);
      return file;
    };
    const refused = async (label, file, pattern = /danneggiato|modificato|troncato/) => {
      const back = await decryptAll(file);
      r.check(label, !back.plain && pattern.test(back.error?.message ?? ""), back.error ? back.error.message : "it decrypted");
    };

    await refused("cut at a chunk boundary: the new last chunk was not sealed as last", variant((b) => b.subarray(0, chunkAt(5))));
    await refused("cut in the middle of a chunk", variant((b) => b.subarray(0, chunkAt(2) + 100)));
    await refused("cut inside the last tag", variant((b) => b.subarray(0, b.length - 3)));
    await refused("cut right after the header", variant((b) => b.subarray(0, head)));
    await refused("cut inside the header", variant((b) => b.subarray(0, head - 10)));
    await refused("a byte flipped inside a chunk", variant((b) => void (b[chunkAt(1) + 17] ^= 0x01)));
    await refused("a byte flipped in a tag", variant((b) => void (b[chunkAt(1) + stride - 1] ^= 0x80)));
    await refused("a byte flipped in the last chunk", variant((b) => void (b[b.length - TAG - 1] ^= 0x01)));
    await refused(
      "two chunks swapped",
      variant((b) => {
        const first = Buffer.from(b.subarray(chunkAt(0), chunkAt(1)));
        b.copy(b, chunkAt(0), chunkAt(1), chunkAt(2));
        first.copy(b, chunkAt(1));
      })
    );
    await refused("a chunk repeated in place of the next", variant((b) => void b.copy(b, chunkAt(2), chunkAt(1), chunkAt(2))));
    await refused("bytes appended", variant((b) => Buffer.concat([b, Buffer.alloc(40)])));
    await refused("a whole chunk appended", variant((b) => Buffer.concat([b, b.subarray(chunkAt(0), chunkAt(1))])));
    await refused(
      "the last chunk dropped and an earlier full one put at the end",
      variant((b) => Buffer.concat([b.subarray(0, chunkAt(5)), b.subarray(chunkAt(0), chunkAt(1))]))
    );

    {
      // Damage is local: a reader that never touches the bad chunk still works,
      // the one that does is stopped.
      const file = variant((b) => void (b[chunkAt(3) + 5] ^= 0x01));
      const reader = await openReader(file);
      const before = await reader.readRange(0, 3 * CHUNK).catch((err) => err);
      const across = await reader.readRange(3 * CHUNK - 10, 20).catch((err) => err);
      await close(reader);
      r.check("chunks before the damaged one still read", Buffer.isBuffer(before) && before.equals(plain.subarray(0, 3 * CHUNK)));
      r.check("a read that reaches it fails", across instanceof sealed.SealedArchiveError, String(across));
    }

    // --- the header -------------------------------------------------------------------
    {
      const jsonStart = 12;
      const json = () => JSON.parse(original.subarray(jsonStart, head).toString("utf8"));
      // Same length, so the chunks stay where they were: only the binding is tested.
      const edit = (from, to) =>
        variant((b) => {
          const text = b.subarray(jsonStart, head).toString("utf8");
          if (!text.includes(from) || from.length !== to.length) throw new Error(`cannot edit ${from}`);
          Buffer.from(text.replace(from, to), "utf8").copy(b, jsonStart);
        });

      await refused("a header edited by hand fails every chunk (key id changed)", edit('"keyId":"k1"', '"keyId":"k2"'));
      await refused("…and the date of the password", edit("2026-11-18T10", "2025-11-18T10"));
      await refused("a chunk size edited", edit('"chunkSize":1024', '"chunkSize":2048'));
      {
        const back = await decryptAll(edit('"N":1024', '"N":2048'));
        r.check(
          "KDF parameters edited read as a wrong password",
          back.error instanceof sealed.ArchiveLockedError && back.error.wrongPassword,
          String(back.error)
        );
      }
      {
        const file = variant((b) => void (b[7] = 2));
        const back = await decryptAll(file);
        r.check("a newer version is refused with a sentence that says so", /più recente/.test(back.error?.message ?? ""), String(back.error));
      }
      {
        const file = variant((b) => void b.writeUInt32BE(1 << 30, 8));
        await refused("an impossible header length", file);
      }
      {
        const file = variant((b) => void (b[0] = 0x51));
        r.check("without the magic it is not an encrypted archive at all", (await sealed.readSealedHead(file)) === null);
      }
      {
        // A header someone wrote to make the panel allocate a terabyte.
        const hostile = { ...json(), N: 2 ** 30 };
        const body = Buffer.from(JSON.stringify(hostile), "utf8");
        const prefix = Buffer.alloc(12);
        Buffer.from("RPBKENC", "latin1").copy(prefix);
        prefix[7] = 1;
        prefix.writeUInt32BE(body.length, 8);
        const file = path("hostile.enc");
        fs.writeFileSync(file, Buffer.concat([prefix, body, original.subarray(head)]));
        const started = Date.now();
        let error = null;
        try {
          await sealed.readSealedHead(file);
        } catch (err) {
          error = err;
        }
        r.check("KDF parameters past the limits are refused before scrypt runs", /non è valida/.test(error?.message ?? "") && Date.now() - started < 2000, String(error));
      }
    }

    // --- random access ------------------------------------------------------------------
    {
      const reader = await openReader(good);
      // Held, as a ZipFile holds it: yauzl closes a reader when its count drops to zero.
      reader.ref();
      r.check("the reader knows the size in clear", reader.plainSize === plain.length, `${reader.plainSize}`);
      const random = bytes(400, 9);
      const mismatches = [];
      for (let i = 0; i < 100; i++) {
        const position = (random.readUInt16BE(i * 4) * 3) % plain.length;
        const length = Math.min(plain.length - position, 1 + (random.readUInt16BE(i * 4 + 2) % (3 * CHUNK)));
        const got = await reader.readRange(position, length);
        if (!got.equals(plain.subarray(position, position + length))) mismatches.push(`${position}+${length}`);
      }
      r.check("random reads across chunks return the right bytes", mismatches.length === 0, mismatches.slice(0, 5).join(", "));

      const ranges = [
        [0, 1],
        [CHUNK - 1, CHUNK + 1],
        [CHUNK, 2 * CHUNK],
        [10, plain.length],
        [plain.length - 1, plain.length],
        [2 * CHUNK + 3, 4 * CHUNK + 900],
      ];
      const streamed = [];
      for (const [start, end] of ranges) {
        const parts = [];
        try {
          for await (const part of reader.createReadStream({ start, end })) parts.push(part);
          if (!Buffer.concat(parts).equals(plain.subarray(start, end))) streamed.push(`${start}-${end}`);
        } catch (err) {
          streamed.push(`${start}-${end}: ${err.message}`);
        }
      }
      r.check("streamed ranges across chunks return the right bytes", streamed.length === 0, streamed.join(", "));

      const beyond = await reader.readRange(plain.length - 2, 5).catch((err) => err);
      r.check("a read past the end is refused", beyond instanceof Error);
      await new Promise((resolve) => {
        reader.once("close", resolve);
        reader.unref();
      });
      const afterClose = await reader.readRange(0, 10).catch((err) => err);
      r.check("a closed reader refuses to read rather than use a descriptor that may be another file's", afterClose instanceof Error);
    }

    // --- with the KDF as the panel uses it ----------------------------------------------
    {
      const file = await seal(bytes(3000, 3), { kdf: sealed.DEFAULT_KDF, chunkSize: sealed.DEFAULT_CHUNK_BYTES });
      const back = await decryptAll(file);
      const head = await sealed.readSealedHead(file);
      r.check(
        "the default parameters fit Node's scrypt memory limit and round-trip",
        back.plain?.equals(bytes(3000, 3)) && head.header.N === 2 ** 17 && head.header.chunkSize === 65536,
        String(back.error)
      );
    }

    // --- a real archive ---------------------------------------------------------------------
    const stage = (entryPath, data, { precompressed = false, hashed = true } = {}) => {
      const absolutePath = join(root, "staging", entryPath);
      fs.mkdirSync(join(absolutePath, ".."), { recursive: true });
      fs.writeFileSync(absolutePath, data);
      return {
        absolutePath,
        entryPath,
        bytes: data.length,
        sha256: hashed ? crypto.createHash("sha256").update(data).digest("hex") : null,
        precompressed,
      };
    };
    const dump = gzipSync(Buffer.from("INSERT INTO t VALUES (1);\n".repeat(20_000)));
    const files = [
      stage("databases/pg/all.sql.gz", dump, { precompressed: true }),
      stage("projects/shop/config.enc.json", Buffer.from('{"v":"ciphertext"}')),
      stage("projects/shop/repo/index.js", Buffer.from("console.log('hi')\n"), { hashed: false }),
      stage("projects/shop/volumes/data.tar.gz", gzipSync(bytes(200_000, 5)), { precompressed: true }),
    ];
    const manifest = {
      schemaVersion: 1,
      runId: "sealedrun",
      policyId: null,
      policyName: null,
      trigger: "manual",
      createdAt: new Date().toISOString(),
      panel: { version: "test", storeDriver: "sqlite" },
      artifacts: [],
    };
    const archivePath = join(root, "archivio.zip.enc");
    const archiveSeal = await sealed.prepareSeal({ password: PASSWORD, keyId: "k1", kdf: FAST });
    const archive = await writeArchive(archivePath, files, manifest, { seal: archiveSeal });
    const raw = fs.readFileSync(archivePath);

    r.check("writeArchive encrypts on the way to the disk", raw.subarray(0, 7).toString("latin1") === "RPBKENC");
    r.check("its sha256 is the encrypted file's", crypto.createHash("sha256").update(raw).digest("hex") === archive.sha256);
    r.check("no member name is readable in the file", !raw.includes(Buffer.from("databases/pg")) && !raw.includes(Buffer.from("manifest.json")));
    r.check("no .part is left behind", !fs.existsSync(`${archivePath}.part`));

    let candidateCalls = 0;
    const open = sealed.createArchiveOpener(() => {
      candidateCalls++;
      return [PASSWORD];
    });
    const handle = { file: archivePath, open };
    {
      const entries = await read.listArchiveEntries(handle);
      const names = entries.map((entry) => entry.entryPath).sort();
      r.check(
        "its members list through the opener",
        names.join(",") ===
          "LEGGIMI.txt,checksums.txt,databases/pg/all.sql.gz,manifest.json,projects/shop/config.enc.json,projects/shop/repo/index.js,projects/shop/volumes/data.tar.gz",
        names.join(",")
      );
      const back = await read.readArchiveManifest(handle);
      r.check("the manifest reads back", back?.runId === "sealedrun");
      const out = join(root, "extracted", "all.sql.gz");
      await read.extractArchiveEntry(handle, "databases/pg/all.sql.gz", out);
      r.check("a member extracts byte for byte", fs.readFileSync(out).equals(dump));
      r.check("and the password was worked out once for all of it", candidateCalls === 1, String(candidateCalls));
    }
    {
      const report = await integrity.verifyArchiveFile(archivePath, { expectedSha256: archive.sha256, open });
      r.check("the whole check passes on an encrypted archive", report.ok, report.message);
      r.check("every member is opened", report.members?.checked === 7 && report.members?.withSha256 === 3, JSON.stringify(report.members));
      const only = await integrity.verifyMembers(archivePath, { only: ["databases/pg/all.sql.gz"], open });
      r.check("a restore's narrowed check works too", only.checked === 1 && only.failures.length === 0, JSON.stringify(only));
    }
    {
      const plainZip = await integrity.verifyArchiveFile(archivePath);
      r.check("read as a plain zip it is not one", !plainZip.ok, plainZip.message);
      const locked = await integrity.verifyArchiveFile(archivePath, {
        expectedSha256: archive.sha256,
        open: sealed.createArchiveOpener(() => ["sbagliata"]),
      });
      r.check(
        "with the wrong password the check says the bytes match but the content cannot be read",
        !locked.ok && locked.archiveMatches === true && /password/.test(locked.message),
        locked.message
      );
      let thrown = null;
      try {
        await read.readArchiveManifest({ file: archivePath, open: sealed.createArchiveOpener() });
      } catch (err) {
        thrown = err;
      }
      r.check("a manifest behind an unknown password is an error to act on, not 'no manifest'", thrown?.name === "ArchiveLockedError", String(thrown));
    }
    {
      const flipped = join(root, "flipped.zip.enc");
      const copy = Buffer.from(raw);
      copy[Math.floor(copy.length / 2)] ^= 0x04;
      fs.writeFileSync(flipped, copy);
      const withHash = await integrity.verifyArchiveFile(flipped, { expectedSha256: archive.sha256, open });
      r.check("a flipped byte fails the sha256", !withHash.ok && withHash.archiveMatches === false);
      const withoutHash = await integrity.verifyArchiveFile(flipped, { open });
      r.check("and without one, the decryption itself refuses it", !withoutHash.ok, withoutHash.message);
    }
    {
      // A plain zip still opens through the same opener, untouched.
      const zipPath = join(root, "plain.zip");
      const plainArchive = await writeArchive(zipPath, files, { ...manifest, runId: "plainrun" });
      const report = await integrity.verifyArchiveFile(zipPath, { expectedSha256: plainArchive.sha256, open });
      r.check("an archive without encryption reads through the opener exactly as before", report.ok && fs.readFileSync(zipPath).subarray(0, 2).toString() === "PK", report.message);
    }

    // --- scripts/decrypt-backup.mjs ---------------------------------------------------------
    const script = join(repoRoot, "scripts", "decrypt-backup.mjs");
    const decrypt = (args, input, env = {}) =>
      spawnSync(process.execPath, [script, ...args], {
        input,
        env: { ...process.env, RUNPANEL_BACKUP_PASSWORD: "", ...env },
        encoding: "utf8",
        timeout: 120_000,
      });
    {
      const out = join(root, "decrypted.zip");
      const result = decrypt([archivePath, out], `${PASSWORD}\n`);
      r.check("the offline script decrypts the archive", result.status === 0, `${result.status} ${result.stderr}`);
      const reader = await openReader(archivePath);
      const inside = await reader.readRange(0, reader.plainSize);
      await close(reader);
      r.check("into exactly the zip inside it", fs.existsSync(out) && fs.readFileSync(out).equals(inside));
      const entries = fs.existsSync(out) ? await read.listArchiveEntries(out) : [];
      r.check("which opens as a plain zip, LEGGIMI.txt included", entries.some((entry) => entry.entryPath === "LEGGIMI.txt"));
      const report = fs.existsSync(out) ? await integrity.verifyArchiveFile(out) : { ok: false, message: "missing" };
      r.check("and passes the panel's own check", report.ok, report.message);

      const again = decrypt([archivePath, out], `${PASSWORD}\n`);
      r.check("it does not overwrite an existing file without --force", again.status === 1 && /esiste già/.test(again.stderr), again.stderr);
    }
    {
      const out = join(root, "wrong.zip");
      const result = decrypt([archivePath, out], "sbagliata\n");
      r.check("a wrong password exits 2 and writes nothing", result.status === 2 && !fs.existsSync(out) && !fs.existsSync(`${out}.part`), `${result.status} ${result.stderr}`);
      const check = decrypt(["--check", archivePath], "", { RUNPANEL_BACKUP_PASSWORD: PASSWORD });
      r.check("--check takes the password from the environment and writes nothing", check.status === 0 && /integro/.test(check.stdout), `${check.status} ${check.stderr}`);
      const passwordFile = join(root, "password.txt");
      fs.writeFileSync(passwordFile, `${PASSWORD}\r\n`);
      const fromFile = decrypt(["--check", "--password-file", passwordFile, archivePath], "");
      r.check("or from the first line of a file", fromFile.status === 0, `${fromFile.status} ${fromFile.stderr}`);
    }
    {
      const damagedFile = join(root, "damaged.zip.enc");
      const copy = Buffer.from(raw);
      copy[copy.length - 100] ^= 0x01;
      fs.writeFileSync(damagedFile, copy);
      const out = join(root, "damaged.zip");
      const result = decrypt([damagedFile, out], `${PASSWORD}\n`);
      r.check("a damaged archive exits 1 and leaves no partial zip", result.status === 1 && !fs.existsSync(out) && !fs.existsSync(`${out}.part`), `${result.status} ${result.stderr}`);
      const cut = join(root, "cut.zip.enc");
      fs.writeFileSync(cut, raw.subarray(0, raw.length - 500));
      const truncated = decrypt(["--check", cut], `${PASSWORD}\n`);
      r.check("so does a truncated one", truncated.status === 1, `${truncated.status} ${truncated.stderr}`);
    }
    {
      // The script and the panel agree on the format itself, not only on zips.
      const payload = bytes(3 * CHUNK, 77);
      const file = await seal(payload);
      const out = join(root, "payload.bin");
      const result = decrypt([file, out], `${PASSWORD}\n`);
      r.check("the script reads chunk sizes other than the default", result.status === 0 && fs.readFileSync(out).equals(payload), result.stderr);
      const empty = await seal(Buffer.alloc(0));
      const emptyOut = join(root, "empty.bin");
      const emptyResult = decrypt([empty, emptyOut], `${PASSWORD}\n`);
      r.check("and an empty payload", emptyResult.status === 0 && fs.readFileSync(emptyOut).length === 0, emptyResult.stderr);
      const notSealed = decrypt(["--check", join(root, "plain.zip")], `${PASSWORD}\n`);
      r.check("a plain zip is recognised as one", notSealed.status === 1 && /già uno zip/.test(notSealed.stderr), notSealed.stderr);
    }
  } finally {
    // On Windows a file still open cannot be deleted: this also checks that
    // every reader above let go of its descriptor.
    let leftOpen = null;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
      leftOpen = err;
    }
    r.check("every file handle was closed", leftOpen === null, String(leftOpen));
  }

  return r.result();
}
