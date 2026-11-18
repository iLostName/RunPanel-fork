import { createReporter } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { loadTs } from "../ts-modules.mjs";

/**
 * A linked RunPanel server keeping another one's backups, without a cluster.
 *
 * The rules first: which names, refs and ids may become a path on the
 * receiver, and how much room it gives. Then the receiver's engine on a
 * temporary folder — the reservation and its one-time token, pieces in order,
 * the size and sha256 compared before a file gets its name, what a restart, an
 * expiry or an abandoned upload leaves (nothing), the limit, the disk's
 * reserve, and one source never reaching another's copies. Last, the sender
 * against that engine through an in-process stand-in for the signed calls:
 * an archive in several pieces, a piece retried after a lost answer, and what
 * each refusal says.
 */
export const meta = { name: "backup-peer-unit", needsDocker: false, drivers: [], standalone: true };

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-peer-unit");
  const rules = await loadTs(repoRoot, "lib", "backup-peer.ts");
  const { createPeerHost, PeerHostError } = await loadTs(repoRoot, "services", "backup", "peer-host.ts");
  const peer = await loadTs(repoRoot, "services", "backup", "destinations", "peer.ts");
  const { DestinationFailure } = await loadTs(repoRoot, "services", "backup", "destinations", "problem.ts");
  const live = () => globalThis.__runpanelPeerLive;

  // --- What may become a path ------------------------------------------------------------
  const archive = "runpanel-20261118-030000-backup-notturno-a1B2c3D4e5F6.zip.enc";
  r.check("an archive name of the panel is a name", rules.peerFileNameProblem(archive) === null);
  for (const [label, name] of [
    ["empty", ""],
    ["hidden", ".runpanel.zip"],
    ["climbing", "../x.zip"],
    ["with a folder", "a/b.zip"],
    ["with a backslash", "a\\b.zip"],
    ["with two dots", "a..b.zip"],
    ["ending in a dot", "x.zip."],
    ["a Windows device", "con.zip"],
    ["another Windows device", "LPT1"],
    ["with a space", "back up.zip"],
    ["with an accent", "città.zip"],
    ["too long", `${"a".repeat(201)}`],
    ["not a string", 42],
  ]) {
    r.check(`a file name ${label} is refused`, rules.peerFileNameProblem(name) !== null, String(name));
  }
  r.check("a ref is year/month/name", rules.peerRefProblem(`2026/11/${archive}`) === null);
  for (const ref of ["2026/13/x.zip", "../2026/11/x.zip", "2026/11/../x.zip", "2026/11/.x", "/2026/11/x.zip", "2026\\11\\x.zip", "2026/11/x/y.zip", "26/11/x.zip", "", null]) {
    r.check(`a ref like ${JSON.stringify(ref)} is refused`, rules.peerRefProblem(ref) !== null);
  }
  r.check("a member id of the cluster is one", rules.isPeerMemberId("aB3_x-9KqLmN0"));
  for (const id of ["../x", "a/b", "", "x".repeat(65), "a b", "a.b"]) {
    r.check(`a member id like ${JSON.stringify(id)} is refused`, !rules.isPeerMemberId(id));
  }
  r.check("a taken name gets characters before its extensions", rules.peerAlternativeName("a.zip.enc", "1f2e") === "a-1f2e.zip.enc" && rules.peerAlternativeName("a", "1f2e") === "a-1f2e");
  r.check(
    "the receiver keeps a tenth of its disk, 5 to 50 GB",
    rules.peerReserveBytes(20 * GB) === 5 * GB && rules.peerReserveBytes(200 * GB) === 20 * GB && rules.peerReserveBytes(2048 * GB) === 50 * GB && rules.peerReserveBytes(null) === 5 * GB
  );
  r.check("a limit of 0 refuses", rules.peerRoomProblem({ quota: 0, used: 0, free: 100 * GB, reserve: 5 * GB }, 1) === "REFUSED");
  r.check("past the limit is the limit", rules.peerRoomProblem({ quota: 10, used: 8, free: 100 * GB, reserve: 5 * GB }, 3) === "QUOTA");
  r.check("into the reserve is the disk", rules.peerRoomProblem({ quota: null, used: 0, free: 6 * GB, reserve: 5 * GB }, 2 * GB) === "DISK");
  r.check("otherwise it fits", rules.peerRoomProblem({ quota: null, used: 0, free: 6 * GB, reserve: 5 * GB }, GB) === null);
  {
    const room = rules.peerRoom({ quota: 10 * GB, used: 4 * GB, free: 8 * GB, reserve: 5 * GB });
    r.check("the room left is the smaller of the two, and says which", room.available === 3 * GB && room.limitedBy === "DISK", JSON.stringify(room));
  }

  // --- The receiver ---------------------------------------------------------------------------
  const root = fs.mkdtempSync(join(os.tmpdir(), "rp-peer-unit-"));
  let clock = Date.now();
  const quotas = {};
  const disk = { free: 100 * GB, total: 1000 * GB };
  const host = createPeerHost({ root, quotaFor: (id) => quotas[id] ?? null, disk: () => ({ ...disk }), now: () => clock, floorBytes: 1024 });
  const A = { id: "srcA_1", name: "server-a", url: "http://a.test" };
  const B = { id: "srcB_2", name: "server-b", url: "http://b.test" };
  const hostError = (err, status, code) => err instanceof PeerHostError && err.status === status && err.code === code;

  try {
    for (const [label, input, source] of [
      ["a name that climbs out", { fileName: "../x.zip", bytes: 1, sha256: sha("x") }, A],
      ["no size", { fileName: "x.zip", bytes: 0, sha256: sha("x") }, A],
      ["a size that is not a number", { fileName: "x.zip", bytes: "12", sha256: sha("x") }, A],
      ["a size past a terabyte", { fileName: "x.zip", bytes: 1024 ** 4 + 1, sha256: sha("x") }, A],
      ["no sha256", { fileName: "x.zip", bytes: 1, sha256: "abc" }, A],
      ["a member id that climbs out", { fileName: "x.zip", bytes: 1, sha256: sha("x") }, { ...A, id: "../srcB_2" }],
    ]) {
      const err = await rejects(host.reserve(source, input));
      r.check(`a reservation with ${label} is refused`, hostError(err, 400, "INVALID"), String(err?.message));
    }

    // Three pieces: 8 + 8 + 4 MB, the last one short.
    const data = crypto.randomBytes(20 * MB);
    const name = "runpanel-20261119-030000-notte-abcdefABCDEF.zip";
    const reserved = await host.reserve(A, { fileName: name, bytes: data.length, sha256: sha(data) });
    r.check("a reservation answers with an id, a token and the piece size", rules.isPeerUploadId(reserved.uploadId) && reserved.token.length >= 40 && reserved.chunkBytes === 8 * MB, JSON.stringify(reserved));
    const record = fs.readFileSync(join(root, A.id, ".incoming", `${reserved.uploadId}.json`), "utf8");
    r.check("the token is kept only as a hash", !record.includes(reserved.token) && record.includes(sha(reserved.token)));
    const label = JSON.parse(fs.readFileSync(join(root, A.id, ".source.json"), "utf8"));
    r.check("the source's name is kept with its copies", label.name === "server-a" && label.memberId === A.id);

    const piece = (n) => data.subarray(n * 8 * MB, Math.min(data.length, (n + 1) * 8 * MB));
    r.check("a piece with the wrong token is refused", hostError(await rejects(host.writeChunk(A.id, reserved.uploadId, "x".repeat(43), 0, piece(0))), 401, "TOKEN"));
    r.check("a piece with no token is refused", hostError(await rejects(host.writeChunk(A.id, reserved.uploadId, null, 0, piece(0))), 401, "TOKEN"));
    const ahead = await rejects(host.writeChunk(A.id, reserved.uploadId, reserved.token, 8 * MB, piece(1)));
    r.check("a piece out of order is refused, saying where to start", hostError(ahead, 409, "OUT_OF_ORDER") && ahead.details.received === 0);
    r.check("another source cannot write into it", hostError(await rejects(host.writeChunk(B.id, reserved.uploadId, reserved.token, 0, piece(0))), 404, "NOT_FOUND"));

    let written = await host.writeChunk(A.id, reserved.uploadId, reserved.token, 0, piece(0));
    r.check("the first piece is taken", written.received === 8 * MB);
    written = await host.writeChunk(A.id, reserved.uploadId, reserved.token, 0, piece(0));
    r.check("the same piece again, after a lost answer, is accepted and ignored", written.received === 8 * MB);
    r.check("an unfinished upload cannot complete", hostError(await rejects(host.complete(A.id, reserved.uploadId, reserved.token)), 409, "INCOMPLETE"));
    await host.writeChunk(A.id, reserved.uploadId, reserved.token, 8 * MB, piece(1));
    const overflow = await rejects(host.writeChunk(A.id, reserved.uploadId, reserved.token, 16 * MB, Buffer.concat([piece(2), Buffer.from("extra")])));
    r.check("more than was declared is refused", hostError(overflow, 413, "TOO_LARGE"));
    await host.writeChunk(A.id, reserved.uploadId, reserved.token, 16 * MB, piece(2));
    const month = new Date(clock);
    const finalPath = join(root, A.id, String(month.getUTCFullYear()), String(month.getUTCMonth() + 1).padStart(2, "0"), name);
    r.check("nothing has the archive's name before it is complete", !fs.existsSync(finalPath));

    const done = await host.complete(A.id, reserved.uploadId, reserved.token);
    r.check("complete names it year/month/name", done.ref === rules.peerRef(month, name) && done.bytes === data.length && done.sha256 === sha(data), JSON.stringify(done));
    r.check("and the file is the archive, byte for byte", fs.existsSync(finalPath) && fs.readFileSync(finalPath).equals(data));
    r.check("no piece file is left", !fs.readdirSync(join(root, A.id, ".incoming")).some((entry) => entry.endsWith(".part")));
    const again = await host.complete(A.id, reserved.uploadId, reserved.token);
    r.check("complete asked again answers the same", again.ref === done.ref);
    r.check("a finished upload takes no more pieces", hostError(await rejects(host.writeChunk(A.id, reserved.uploadId, reserved.token, 0, piece(0))), 409, "DONE"));

    // --- one source never reaches another's copies ------------------------------------------
    r.check("the owner sees it", host.stat(A.id, done.ref).exists === true && host.stat(A.id, done.ref).bytes === data.length);
    r.check("another source does not", host.stat(B.id, done.ref).exists === false && host.locate(B.id, done.ref) === null);
    r.check("nor can it delete it", host.remove(B.id, done.ref) === false && fs.existsSync(finalPath));
    for (const ref of [`../${A.id}/${done.ref}`, `${done.ref}/../../../../x`, finalPath, `2026/11/../../${A.id}`]) {
      const err = await rejects(Promise.resolve().then(() => host.stat(B.id, ref)));
      r.check(`a ref that climbs out is refused: ${ref.slice(0, 40)}`, hostError(err, 400, "INVALID"), String(err?.message));
    }
    r.check("a member id that climbs out is refused", hostError(await rejects(Promise.resolve().then(() => host.locate("..", done.ref))), 400, "INVALID"));

    // --- a different archive than declared --------------------------------------------------
    {
      const other = crypto.randomBytes(1000);
      const lie = await host.reserve(A, { fileName: "bugia.zip", bytes: other.length, sha256: sha(Buffer.alloc(1000)) });
      await host.writeChunk(A.id, lie.uploadId, lie.token, 0, other);
      const err = await rejects(host.complete(A.id, lie.uploadId, lie.token));
      r.check("an archive whose sha256 is not the declared one is refused", hostError(err, 422, "HASH_MISMATCH"));
      r.check("and nothing of it stays", !host.archives(A.id).some((a) => a.name === "bugia.zip") && !fs.readdirSync(join(root, A.id, ".incoming")).some((e) => e.startsWith(lie.uploadId)));

      const cut = await host.reserve(A, { fileName: "tagliato.zip", bytes: other.length, sha256: sha(other) });
      await host.writeChunk(A.id, cut.uploadId, cut.token, 0, other);
      fs.truncateSync(join(root, A.id, ".incoming", `${cut.uploadId}.part`), 10);
      const short = await rejects(host.complete(A.id, cut.uploadId, cut.token));
      r.check("a file cut short on the disk is refused", hostError(short, 422, "SIZE_MISMATCH"));
      r.check("and removed", !host.archives(A.id).some((a) => a.name === "tagliato.zip"));
    }

    // --- the same name twice ----------------------------------------------------------------
    {
      const same = await host.reserve(A, { fileName: name, bytes: data.length, sha256: sha(data) });
      for (let n = 0; n < 3; n++) await host.writeChunk(A.id, same.uploadId, same.token, n * 8 * MB, piece(n));
      const kept = await host.complete(A.id, same.uploadId, same.token);
      r.check("the same archive sent again is not stored twice", kept.ref === done.ref && host.archives(A.id).filter((a) => a.name.startsWith("runpanel-20261119")).length === 1);
      const different = Buffer.from("un altro archivio con lo stesso nome");
      const clash = await host.reserve(A, { fileName: name, bytes: different.length, sha256: sha(different) });
      await host.writeChunk(A.id, clash.uploadId, clash.token, 0, different);
      const renamed = await host.complete(A.id, clash.uploadId, clash.token);
      r.check("a different one under a taken name gets a name of its own", renamed.ref !== done.ref && /-[0-9a-f]{4}\.zip$/.test(renamed.ref) && fs.readFileSync(finalPath).equals(data), renamed.ref);
      r.check("deleting a copy says it was there", host.remove(A.id, renamed.ref) === true && host.remove(A.id, renamed.ref) === false);
    }

    // --- the limit ------------------------------------------------------------------------------
    quotas[A.id] = data.length;
    const full = await rejects(host.reserve(A, { fileName: "uno-in-piu.zip", bytes: 1, sha256: sha("x") }));
    r.check("past its limit a source is refused, with the numbers", hostError(full, 507, "QUOTA") && full.details.usedBytes === data.length && full.details.quotaBytes === data.length && full.details.bytes === 1, JSON.stringify(full?.details));
    quotas[A.id] = 0;
    r.check("a limit of 0 refuses outright", hostError(await rejects(host.reserve(A, { fileName: "x.zip", bytes: 1, sha256: sha("x") })), 403, "REFUSED"));
    r.check("and says so to its check", (await host.info(A.id)).limitedBy === "REFUSED");
    delete quotas[A.id];
    {
      const info = await host.info(A.id);
      r.check("its check gets what it holds and the room left", info.protocol === 1 && info.usedBytes === data.length && info.quotaBytes === null && info.reserveBytes === 50 * GB && info.availableBytes === 50 * GB, JSON.stringify(info));
    }

    // --- the disk's reserve -------------------------------------------------------------------------
    disk.free = 50 * GB + 1.5 * GB;
    const first = await host.reserve(B, { fileName: "grande-1.zip", bytes: GB, sha256: sha("1") });
    const second = await rejects(host.reserve(B, { fileName: "grande-2.zip", bytes: GB, sha256: sha("2") }));
    r.check("the disk keeps its reserve, counting uploads under way", hostError(second, 507, "DISK") && second.details.reserveBytes === 50 * GB, JSON.stringify(second?.details));
    await host.abort(B.id, first.uploadId, first.token);
    const fits = await host.reserve(B, { fileName: "grande-2.zip", bytes: GB, sha256: sha("2") });
    r.check("an upload given up frees its room", rules.isPeerUploadId(fits.uploadId));
    r.check("a give-up with the wrong token is refused", hostError(await rejects(host.abort(B.id, fits.uploadId, "y".repeat(43))), 401, "TOKEN"));
    disk.free = 500;
    r.check("a piece that would fill the disk is refused", hostError(await rejects(host.writeChunk(B.id, fits.uploadId, fits.token, 0, Buffer.alloc(2048))), 507, "DISK"));
    disk.free = 100 * GB;
    await host.abort(B.id, fits.uploadId, fits.token);

    // --- uploads that will never finish ---------------------------------------------------------------
    {
      const open = [];
      for (let n = 0; n < rules.PEER_MAX_ACTIVE_UPLOADS; n++) open.push(await host.reserve(B, { fileName: `b-${n}.zip`, bytes: 10, sha256: sha(String(n)) }));
      r.check("a source has a few uploads open at most", hostError(await rejects(host.reserve(B, { fileName: "b-x.zip", bytes: 10, sha256: sha("x") })), 429, "BUSY"));
      for (const entry of open) await host.abort(B.id, entry.uploadId, entry.token);
    }
    {
      const late = await host.reserve(B, { fileName: "tardi.zip", bytes: 10, sha256: sha("t") });
      clock += rules.PEER_RESERVATION_TTL_MS + 1000;
      r.check("a reservation not started in time has expired", hostError(await rejects(host.writeChunk(B.id, late.uploadId, late.token, 0, Buffer.alloc(10))), 410, "EXPIRED"));
      r.check("and left nothing", fs.readdirSync(join(root, B.id, ".incoming")).length === 0);
    }
    {
      const payload = Buffer.alloc(100, 7);
      const restart = await host.reserve(B, { fileName: "riavvio.zip", bytes: 200, sha256: sha(Buffer.alloc(200, 7)) });
      await host.writeChunk(B.id, restart.uploadId, restart.token, 0, payload);
      live().clear();
      r.check("after a restart an upload under way cannot go on", hostError(await rejects(host.writeChunk(B.id, restart.uploadId, restart.token, 100, payload)), 410, "INTERRUPTED"));
      r.check("and its piece file is gone", !fs.readdirSync(join(root, B.id, ".incoming")).some((e) => e.startsWith(restart.uploadId)));

      const swept = await host.reserve(B, { fileName: "spazzato.zip", bytes: 200, sha256: sha(Buffer.alloc(200, 7)) });
      await host.writeChunk(B.id, swept.uploadId, swept.token, 0, payload);
      live().clear();
      r.check("the boot sweep removes what a stopped process was receiving", host.sweep() === 1 && fs.readdirSync(join(root, B.id, ".incoming")).length === 0);

      const idle = await host.reserve(B, { fileName: "fermo.zip", bytes: 200, sha256: sha(Buffer.alloc(200, 7)) });
      await host.writeChunk(B.id, idle.uploadId, idle.token, 0, payload);
      clock += rules.PEER_IDLE_MS + 1000;
      r.check("an upload with no piece for half an hour is swept", host.sweep() === 1 && fs.readdirSync(join(root, B.id, ".incoming")).length === 0);

      const orphan = join(root, B.id, ".incoming", "orfanoorfano12.part");
      fs.writeFileSync(orphan, "x");
      fs.utimesSync(orphan, new Date(clock - 3_600_000), new Date(clock - 3_600_000));
      host.sweep();
      r.check("a piece file with no reservation is swept", !fs.existsSync(orphan));
    }

    // --- what the receiving owner sees, and deletes --------------------------------------------------------
    {
      const list = host.sources();
      const a = list.find((s) => s.id === A.id);
      r.check("each source is listed with what it holds", a?.archives === 1 && a.bytes === data.length && a.name === "server-a" && a.incoming.count === 0, JSON.stringify(a));
      const busy = await host.reserve(A, { fileName: "in-corso.zip", bytes: 10, sha256: sha("c") });
      r.check("a source's copies are not deleted while it sends one", hostError(await rejects(host.removeSource(A.id)), 409, "UPLOADING"));
      await host.abort(A.id, busy.uploadId, busy.token);
      const removed = await host.removeSource(A.id);
      r.check("otherwise they all go", removed.archives === 1 && removed.bytes === data.length && !fs.existsSync(join(root, A.id)) && !host.sources().some((s) => s.id === A.id));
    }
  } finally {
    live().clear();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- The sender, against that engine -----------------------------------------------------------------
  const peerRoot = fs.mkdtempSync(join(os.tmpdir(), "rp-peer-send-"));
  const staging = fs.mkdtempSync(join(os.tmpdir(), "rp-peer-staged-"));
  const receiverQuotas = {};
  const receiver = createPeerHost({ root: peerRoot, quotaFor: (id) => receiverQuotas[id] ?? null, disk: () => ({ free: 100 * GB, total: 1000 * GB }), floorBytes: 1024 });
  const S = { id: "sender_S9", name: "server-s", url: "http://s.test" };
  const R = { id: "receiver_R7", name: "nas-casa", url: "http://r.test" };

  /** The receiving routes, without HTTP: what each one does with the engine. */
  async function route(path, init) {
    const url = new URL(path, "http://peer.test");
    const token = init.headers?.["x-runpanel-upload-token"] ?? null;
    const upload = /^\/api\/cluster\/peer-backups\/uploads\/([^/]+)$/.exec(url.pathname);
    try {
      if (url.pathname === "/api/cluster/peer-backups" && init.method === "GET") return json(await receiver.info(S.id));
      if (url.pathname === "/api/cluster/peer-backups/uploads" && init.method === "POST") return json(await receiver.reserve(S, JSON.parse(init.body)), 201);
      if (upload && init.method === "PUT") return json(await receiver.writeChunk(S.id, upload[1], token, Number(url.searchParams.get("offset")), Buffer.from(init.body)));
      if (upload && init.method === "POST") return json(await receiver.complete(S.id, upload[1], token), 201);
      if (upload && init.method === "DELETE") {
        await receiver.abort(S.id, upload[1], token);
        return json({ ok: true });
      }
      const ref = url.searchParams.get("ref") ?? "";
      if (url.pathname === "/api/cluster/peer-backups/archive/stat") return json(receiver.stat(S.id, ref));
      if (url.pathname === "/api/cluster/peer-backups/archive" && init.method === "GET") {
        const found = receiver.locate(S.id, ref);
        return found ? new Response(fs.readFileSync(found.file)) : json({ error: "L'archivio non c'è più", code: "NOT_FOUND" }, 404);
      }
      if (url.pathname === "/api/cluster/peer-backups/archive" && init.method === "DELETE") return json({ ok: true, removed: receiver.remove(S.id, ref) });
      return new Response("<html>404</html>", { status: 404 });
    } catch (err) {
      if (err instanceof PeerHostError) return json({ error: err.message, code: err.code, ...err.details }, err.status);
      throw err;
    }
  }

  const calls = [];
  const transport = (overrides = {}) => ({
    resolve: overrides.resolve ?? (async (id) => (id === R.id ? { member: R } : { problem: "gone" })),
    send:
      overrides.send ??
      (async (member, path, init) => {
        calls.push(`${init.method} ${path.split("?")[0]}`);
        return route(path, init);
      }),
  });
  const fast = { retryDelaysMs: [1, 1, 1], sleep: async () => {} };
  const row = { id: "dest1", name: "Copia su nas-casa", type: "peer" };
  const destination = (t = transport(), config = { memberId: R.id, memberName: "nas-casa" }) => peer.peerDestination(row, config, t, fast);

  try {
    const big = crypto.randomBytes(20 * MB + 123);
    const staged = join(staging, "runpanel-20261119-030000-notte-xyz.zip");
    fs.writeFileSync(staged, big);
    const lines = [];
    const dest = destination();
    r.check("two destinations to one server are one place", dest.location() === `peer:${R.id}`);

    const stored = await dest.put(staged, "runpanel-20261119-030000-notte-xyz.zip", { log: (line) => lines.push(line), sha256: sha(big) });
    r.check("an archive goes over in pieces and comes back with its ref", rules.peerRefProblem(stored.ref) === null && stored.bytes === big.length, JSON.stringify(stored));
    r.check("three pieces, reserved first and completed last", calls.filter((c) => c.startsWith("PUT")).length === 3 && calls[0] === "POST /api/cluster/peer-backups/uploads" && calls.at(-1).startsWith("POST /api/cluster/peer-backups/uploads/"), calls.join(", "));
    r.check("the staged archive is left in place for the next destination", fs.existsSync(staged));
    r.check("stat finds it", JSON.stringify(await dest.stat(stored.ref)) === JSON.stringify({ exists: true, bytes: big.length }));
    r.check("open reads it back whole", (await collect(await dest.open(stored.ref))).equals(big));
    await dest.remove(stored.ref);
    r.check("remove deletes it", (await dest.stat(stored.ref)).exists === false);
    const gone = await rejects(dest.open(stored.ref));
    r.check("a copy deleted on the other server says so", gone instanceof DestinationFailure && gone.problem.code === "NOT_FOUND" && /nas-casa/.test(gone.message), gone?.message);

    const unknown = await dest.put(staged, "senza-hash.zip", {});
    r.check("without a sha256 given, the sender computes it", unknown.bytes === big.length);
    await dest.remove(unknown.ref);

    const wrong = await rejects(dest.put(staged, "hash-sbagliato.zip", { sha256: sha("non è questo") }));
    r.check("a sha256 that is not the file's is caught by the receiver", wrong instanceof DestinationFailure && wrong.problem.code === "MISMATCH", wrong?.message);
    r.check("and nothing stays there", receiver.archives(S.id).length === 0 && fs.readdirSync(join(peerRoot, S.id, ".incoming")).every((e) => !e.endsWith(".part")));

    const verdict = await dest.test();
    r.check("Verifica writes, reads back and deletes", verdict.ok === true && !verdict.warning && /raggiungibile/.test(verdict.message) && /Nessun limite/.test(verdict.message), JSON.stringify(verdict));
    r.check("and leaves nothing behind", receiver.archives(S.id).length === 0);

    // A piece whose answer is lost: the receiver has it, the sender sends it again.
    {
      let lost = 0;
      const flaky = destination(
        transport({
          send: async (member, path, init) => {
            const res = await route(path, init);
            if (init.method === "PUT" && path.includes("offset=8388608") && lost++ === 0) throw new Error("socket hang up");
            return res;
          },
        })
      );
      const log = [];
      const kept = await flaky.put(staged, "risposta-persa.zip", { sha256: sha(big), log: (line) => log.push(line) });
      r.check("a piece whose answer was lost is sent again, and the upload goes on", kept.bytes === big.length && lost === 2 && log.some((line) => /Riprovo il pezzo/.test(line)), log.join(" | "));
      r.check("the archive arrived whole", fs.readFileSync(receiver.locate(S.id, kept.ref).file).equals(big));
      receiver.remove(S.id, kept.ref);
    }

    // --- what each refusal says ----------------------------------------------------------------
    receiverQuotas[S.id] = 10;
    const quota = await rejects(dest.put(staged, "troppo.zip", { sha256: sha(big) }));
    r.check("a full limit says how full, and where to raise it", quota?.problem?.code === "QUOTA" && /nas-casa/.test(quota.message) && /usati/.test(quota.message) && /Copie per altri server/.test(quota.message), quota?.message);
    receiverQuotas[S.id] = 0;
    const refused = await dest.test();
    r.check("Verifica says when the other server refuses this one", refused.ok === false && refused.code === "REFUSED", JSON.stringify(refused));
    delete receiverQuotas[S.id];

    const down = destination(transport({ send: async () => Promise.reject(new Error("ECONNREFUSED")) }));
    const unreachable = await down.test();
    r.check("a server that is down says so at Verifica", unreachable.ok === false && unreachable.code === "UNREACHABLE" && /nas-casa/.test(unreachable.message), JSON.stringify(unreachable));
    const failedPut = await rejects(down.put(staged, "giu.zip", { sha256: sha(big) }));
    r.check("and during a run, after retrying", failedPut?.problem?.code === "UNREACHABLE", failedPut?.message);

    const old = destination(transport({ send: async () => new Response("<!doctype html><title>404</title>", { status: 404 }) }));
    const oldCheck = await old.test();
    r.check("an older version says to update it", oldCheck.ok === false && oldCheck.code === "OLD_VERSION" && /Aggiornalo/.test(oldCheck.message), JSON.stringify(oldCheck));
    r.check("and so does a run", (await rejects(old.put(staged, "vecchio.zip", { sha256: sha(big) })))?.problem?.code === "OLD_VERSION");

    const strange = destination(transport({ send: async () => json({ error: "Firma non valida" }, 401) }));
    r.check("a refused signature points at the diagnosis", (await strange.test()).code === "SIGNATURE");

    const revoked = destination(transport(), { memberId: "membro_andato", memberName: "vecchio-nas" });
    const revokedCheck = await revoked.test();
    r.check("a server no longer linked is named as it was", revokedCheck.ok === false && revokedCheck.code === "NOT_LINKED" && /vecchio-nas/.test(revokedCheck.message), JSON.stringify(revokedCheck));
    const solo = destination(transport({ resolve: async () => ({ problem: "solo" }) }));
    r.check("and a server out of the cluster says that", (await solo.test()).code === "SOLO");

    const controller = new AbortController();
    controller.abort();
    const aborted = await rejects(dest.put(staged, "annullato.zip", { sha256: sha(big), signal: controller.signal }));
    r.check("a cancelled backup stops the upload", aborted?.problem?.code === "ABORTED", aborted?.message);
    r.check("and its reservation is given back", fs.readdirSync(join(peerRoot, S.id, ".incoming")).filter((e) => e.endsWith(".json")).every((e) => JSON.parse(fs.readFileSync(join(peerRoot, S.id, ".incoming", e), "utf8")).status === "done"));

    const disk = peer.describePeerStatus({ status: 507, body: { code: "DISK", freeBytes: 6 * GB, reserveBytes: 5 * GB, bytes: 2 * GB } }, { name: "nas-casa", step: "reserve" });
    r.check("a full disk says what is free and what it keeps", disk.code === "DISK" && /6\.0 GB/.test(disk.cause) && /5\.0 GB/.test(disk.cause) && /2\.0 GB/.test(disk.cause), disk.cause);
  } finally {
    live().clear();
    fs.rmSync(peerRoot, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return r.result();
}
