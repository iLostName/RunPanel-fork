import { createReporter, client, startServer, SETUP_TOKEN } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A linked RunPanel server as a backup destination, between two real panels.
 *
 * Server A is the suite's own; server B is started here and joins A's cluster
 * from its first-run page, as in the cluster suite. Then: A checks and saves
 * B as a destination, a backup run of A's store lands in B's data directory —
 * in A's own folder, not among B's backups — and comes back for a download
 * and an integrity check. B's owner sees it, limits it, refuses it; a policy
 * with a local copy and one on B stays successful when B refuses, as it does
 * when B is down. A server answering 404 everywhere stands for an older
 * version.
 *
 * The protocol itself is driven with signed requests too, from a member the
 * suite joins on its own (it gets the cluster's secret): an archive of 20 MB
 * in pieces through the proxy, which buffers at most 10 MB, a piece with the
 * wrong token or a body that is not the signed one, a sha256 that does not
 * match, a ref that climbs out, and a member that cannot see another's copies.
 */
export const meta = { name: "backup-peer", needsDocker: false, drivers: ["sqlite"] };

const PASSWORD = "backup-peer-suite-pw";
const OWNER = "owner@peer.test";
const MB = 1024 * 1024;

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

async function waitForRun(api, runId, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/runs/${runId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`Il backup ${runId} non è finito in tempo`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

export async function run({ base, dataDir, repoRoot }) {
  const r = createReporter("backup-peer");
  const { signedHeaders, sha256Hex, EMPTY_BODY_SHA256 } = await import(pathToFileURL(join(repoRoot, "lib", "cluster-sign.ts")).href);

  const a = client(base);
  let res = await a.call("/api/auth/login", json("POST", { setup: true, email: OWNER, setupToken: SETUP_TOKEN, password: PASSWORD }));
  r.check("A is set up", res.status === 200, JSON.stringify(res.body));
  if (!fs.existsSync(join(dataDir, "runpanel.db"))) {
    r.note("store non SQLite: il backup di prova gira solo con SQLite");
    return r.result();
  }

  res = await a.call("/api/backups/destinations/check", json("POST", { type: "peer", config: { memberId: "nessuno" } }));
  r.check("alone, a server has no linked server to send copies to", res.body?.ok === false && /collegato ad altri RunPanel/.test(res.body?.message ?? ""), JSON.stringify(res.body));

  res = await a.call("/api/cluster/link-tokens", json("POST", { name: "pannello-a" }));
  const token = res.body?.token;
  const serverB = await startServer();
  let bRunning = true;
  const b = client(serverB.base);
  const fake = http.createServer((_req, response) => {
    // An older RunPanel: the route does not exist, and Next answers with its 404 page.
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<!doctype html><title>404: This page could not be found.</title>");
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));

  try {
    res = await b.call(
      "/api/auth/login",
      json("POST", { setup: true, setupToken: SETUP_TOKEN, link: { panelUrl: base, token, name: "nodo-b", url: serverB.base, role: "panel" } })
    );
    r.check("B joins A's cluster", res.status === 200 && res.body?.linked === true, `${res.status} ${JSON.stringify(res.body)}`);
    res = await b.call("/api/auth/login", json("POST", { email: OWNER, password: PASSWORD }));
    r.check("the owner signs in on B", res.status === 200, JSON.stringify(res.body));

    res = await a.call("/api/cluster");
    const selfA = res.body.members.find((m) => m.self);
    const memberB = res.body.members.find((m) => m.name === "nodo-b");
    r.check("A knows itself and B", Boolean(selfA && memberB), JSON.stringify(res.body.members));
    const areaOnB = join(serverB.dataDir, "peer-backups", selfA.id);

    // --- the destination -------------------------------------------------------------------
    for (const [label, config] of [
      ["this server itself", { memberId: selfA.id }],
      ["a server that is not linked", { memberId: "sconosciuto12" }],
      ["an id that climbs out", { memberId: "../x" }],
      ["no server", {}],
      ["an unknown field", { memberId: memberB.id, url: "http://altrove" }],
    ]) {
      res = await a.call("/api/backups/destinations", json("POST", { name: `peer-${crypto.randomBytes(3).toString("hex")}`, type: "peer", config }));
      r.check(`refused: ${label}`, res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }

    res = await a.call("/api/backups/destinations/check", json("POST", { type: "peer", config: { memberId: memberB.id } }));
    r.check("a check before saving writes, reads back and deletes on B", res.body?.ok === true && /nodo-b/.test(res.body?.message ?? ""), JSON.stringify(res.body));
    r.check("and leaves nothing in A's folder on B", filesUnder(areaOnB).every((file) => file.endsWith(".json")), filesUnder(areaOnB).join(", "));

    res = await a.call("/api/backups/destinations", json("POST", { name: "Copia su B", type: "peer", config: { memberId: memberB.id } }));
    r.check("B is saved as a destination of A", res.status === 201, JSON.stringify(res.body));
    const peerId = res.body?.id;
    res = await a.call("/api/backups/destinations");
    const row = res.body?.destinations?.find((entry) => entry.id === peerId);
    r.check("the list names B as it is called, still linked", row?.target?.memberId === memberB.id && row.target.memberName === "nodo-b" && row.target.linked === true, JSON.stringify(row));
    res = await a.call(`/api/backups/destinations/${peerId}`);
    r.check("the edit form gets the server", res.body?.config?.memberId === memberB.id, JSON.stringify(res.body));
    res = await a.call(`/api/backups/destinations/${peerId}`, { method: "POST" });
    r.check("Verifica on the saved destination", res.body?.ok === true && /Nessun limite/.test(res.body?.message ?? ""), JSON.stringify(res.body));
    res = await a.call(`/api/nodes/${memberB.id}/cluster/peer-backups`);
    r.check("an account cannot reach B's copies through the forwarder", res.status === 403, `${res.status} ${JSON.stringify(res.body)}`);

    // --- a real backup -------------------------------------------------------------------------
    res = await a.call("/api/backups/policies", json("POST", { name: "Su B", cron: "", destinationId: peerId, targets: [{ kind: "panel" }] }));
    r.check("a policy writes to B", res.status === 201, JSON.stringify(res.body));
    const policyB = res.body?.id;
    let started = await a.call(`/api/backups/policies/${policyB}/run`, { method: "POST" });
    let finished = await waitForRun(a, started.body?.runId);
    r.check("the run succeeds", finished.status === "success", `${finished.status} ${finished.errorMessage}`);
    r.check("the log says where the archive went", (finished.log ?? "").includes("Carico l'archivio su «Copia su B»"), finished.log?.slice(-400));
    const archives = filesUnder(areaOnB).filter((file) => /runpanel-.*\.zip(\.enc)?$/.test(file));
    r.check("B keeps it in A's own folder, year and month", archives.length === 1 && /peer-backups[\\/][^\\/]+[\\/]\d{4}[\\/]\d{2}[\\/]runpanel-/.test(archives[0]), archives.join(", "));
    r.check("not among B's own backups", filesUnder(join(serverB.dataDir, "backups", "archives")).length === 0);
    const onB = archives[0] ? fs.readFileSync(archives[0]) : Buffer.alloc(0);
    r.check("of the size and sha256 the run recorded", onB.length === finished.archiveBytes && sha(onB) === finished.checksum, `${onB.length} vs ${finished.archiveBytes}`);
    r.check("nothing provisional is left on B", !filesUnder(areaOnB).some((file) => file.endsWith(".part")));

    const download = await fetch(`${base}/api/backups/runs/${started.body?.runId}/download`, { headers: { cookie: a.cookie } });
    const downloaded = Buffer.from(await download.arrayBuffer());
    r.check("A's download is streamed back from B", download.status === 200 && downloaded.equals(onB), `${download.status} ${downloaded.length}`);
    res = await a.call(`/api/backups/runs/${started.body?.runId}/verify`, { method: "POST" });
    let verification = null;
    for (let i = 0; i < 60 && res.status === 202; i++) {
      verification = (await a.call(`/api/backups/runs/${started.body?.runId}/verify`)).body?.verification;
      if (verification && verification.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    r.check("an integrity check reads it back from B intact", verification?.status === "ok", JSON.stringify(verification));

    // --- what B's owner sees ------------------------------------------------------------------------
    res = await b.call("/api/backups/hosted");
    const fromA = res.body?.sources?.find((source) => source.sourceId === selfA.id);
    r.check("B lists what it keeps for A", fromA?.name === "pannello-a" && fromA.linked === true && fromA.archives === 1 && fromA.bytes === onB.length && fromA.quotaBytes === null, JSON.stringify(res.body));
    r.check("with its disk and the reserve it keeps", typeof res.body?.disk?.reserveBytes === "number" && res.body.folder === "data/peer-backups", JSON.stringify(res.body?.disk));
    res = await a.call("/api/cluster/backups");
    r.check("A's aggregated page shows it too, on B", res.body?.hosted?.some((source) => source.sourceId === selfA.id && source.memberId === memberB.id), JSON.stringify(res.body?.hosted));
    res = await b.call(`/api/backups/hosted/${selfA.id}/archives`);
    const listed = res.body?.archives?.[0];
    r.check("B's owner lists the archives", res.body?.archives?.length === 1 && listed?.bytes === onB.length, JSON.stringify(res.body));
    const rescue = await fetch(`${serverB.base}/api/backups/hosted/${selfA.id}/download?ref=${encodeURIComponent(listed?.ref ?? "")}`, { headers: { cookie: b.cookie } });
    r.check("and downloads one, to rebuild A elsewhere", rescue.status === 200 && Buffer.from(await rescue.arrayBuffer()).equals(onB), String(rescue.status));
    res = await b.call(`/api/backups/hosted/${selfA.id}/download?ref=${encodeURIComponent("../../backups/x.zip")}`);
    r.check("a download ref that climbs out is refused", res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);

    // --- B limits A, refuses it: A's runs stay complete -----------------------------------------------
    res = await b.call(`/api/backups/hosted/${selfA.id}`, json("PUT", { quotaBytes: onB.length }));
    r.check("B's owner sets a limit for A", res.status === 200 && res.body?.quotaBytes === onB.length, JSON.stringify(res.body));
    res = await a.call(`/api/backups/destinations/${peerId}`, { method: "POST" });
    r.check("A's Verifica says the space B gives is full", res.body?.ok === false && res.body?.code === "QUOTA" && /nodo-b/.test(res.body?.message ?? ""), JSON.stringify(res.body));

    const local = (await a.call("/api/backups/destinations")).body?.destinations?.find((entry) => entry.type === "local");
    res = await a.call(
      "/api/backups/policies",
      json("POST", { name: "Disco e B", cron: "", destinations: [{ destinationId: local?.id }, { destinationId: peerId }], targets: [{ kind: "panel" }] })
    );
    r.check("a policy keeps a copy here and one on B", res.status === 201, JSON.stringify(res.body));
    const policyBoth = res.body?.id;
    started = await a.call(`/api/backups/policies/${policyBoth}/run`, { method: "POST" });
    finished = await waitForRun(a, started.body?.runId);
    const peerCopy = finished.copies?.find((copy) => copy.destinationId === peerId);
    r.check(
      "B refusing the copy leaves the run successful, with the reason",
      finished.status === "success" && finished.copies?.find((copy) => copy.destinationId === local?.id)?.status === "done" && peerCopy?.status === "failed" && /Lo spazio che «nodo-b»/.test(peerCopy?.errorMessage ?? ""),
      JSON.stringify(finished.copies)
    );
    await a.call(`/api/backups/runs/${started.body?.runId}`, { method: "DELETE" });

    res = await b.call(`/api/backups/hosted/${selfA.id}`, json("PUT", { quotaBytes: 0 }));
    res = await a.call(`/api/backups/destinations/${peerId}`, { method: "POST" });
    r.check("refused outright, Verifica says so", res.body?.ok === false && res.body?.code === "REFUSED", JSON.stringify(res.body));
    res = await b.call(`/api/backups/hosted/${selfA.id}`, json("PUT", { quotaBytes: null }));
    r.check("and the limit can be lifted", res.status === 200 && res.body?.quotaBytes === null, JSON.stringify(res.body));
    res = await b.call(`/api/backups/hosted/${selfA.id}`, json("PUT", { quotaBytes: -1 }));
    r.check("a negative limit is refused", res.status === 400, String(res.status));

    // --- the protocol, signed by hand -------------------------------------------------------------------
    res = await a.call("/api/cluster/link-tokens", json("POST", {}));
    const spyJoin = await fetch(`${base}/api/cluster/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: res.body.token, name: "spia", url: "http://127.0.0.1:9", role: "node" }),
    });
    const spy = await spyJoin.json();
    r.check("a member of the suite's own joins", spyJoin.status === 200 && /^[0-9a-f]{64}$/.test(spy.secret ?? ""), String(spyJoin.status));
    await a.call("/api/cluster/sync", json("POST", {}));

    const signed = (target, method, path, { body = null, headers = {}, claimSha = null } = {}) => {
      const q = path.indexOf("?");
      const bytes = body === null ? null : typeof body === "string" ? Buffer.from(body) : body;
      const head = signedHeaders(spy.secret, {
        method,
        path: q < 0 ? path : path.slice(0, q),
        query: q < 0 ? "" : path.slice(q),
        memberId: spy.memberId,
        userId: null,
        bodySha256: claimSha ?? (bytes ? sha256Hex(bytes) : EMPTY_BODY_SHA256),
      });
      return fetch(`${target}${path}`, {
        method,
        headers: { ...headers, ...head, ...(bytes ? { "content-type": headers["content-type"] ?? "application/octet-stream" } : {}) },
        body: bytes,
      });
    };

    const big = crypto.randomBytes(20 * MB + 5);
    let response = await signed(base, "POST", "/api/cluster/peer-backups/uploads", {
      body: JSON.stringify({ fileName: "runpanel-spia-grande.zip", bytes: big.length, sha256: sha(big) }),
      headers: { "content-type": "application/json" },
    });
    const reservation = await response.json();
    r.check("a signed reservation answers with a one-time token", response.status === 201 && typeof reservation.token === "string" && reservation.chunkBytes === 8 * MB, JSON.stringify(reservation));
    const uploadPath = `/api/cluster/peer-backups/uploads/${reservation.uploadId}`;
    const piece = (n) => big.subarray(n * 8 * MB, Math.min(big.length, (n + 1) * 8 * MB));
    const withToken = (value = reservation.token) => ({ "x-runpanel-upload-token": value });

    response = await signed(base, "PUT", `${uploadPath}?offset=0`, { body: piece(0), headers: withToken("z".repeat(43)) });
    r.check("a piece with the wrong token is refused", response.status === 401 && (await response.json()).code === "TOKEN", String(response.status));
    response = await signed(base, "PUT", `${uploadPath}?offset=0`, { body: piece(0), headers: withToken(), claimSha: sha("altro") });
    r.check("a piece that is not the signed body is refused by the proxy", response.status === 401, String(response.status));
    response = await signed(base, "PUT", `${uploadPath}?offset=0`, { body: Buffer.alloc(9 * MB), headers: withToken() });
    r.check("a piece over 8 MB is refused", response.status === 413, String(response.status));
    response = await signed(base, "PUT", `${uploadPath}?offset=${8 * MB}`, { body: piece(1), headers: withToken() });
    const early = await response.json();
    r.check("a piece out of order says where to start", response.status === 409 && early.received === 0, JSON.stringify(early));
    for (let n = 0; n < 3; n++) {
      response = await signed(base, "PUT", `${uploadPath}?offset=${n * 8 * MB}`, { body: piece(n), headers: withToken() });
      if (response.status !== 200) break;
    }
    r.check("20 MB arrive in three signed pieces through the proxy", response.status === 200 && (await response.json()).received === big.length, String(response.status));
    response = await signed(base, "POST", uploadPath, { headers: withToken() });
    const stored = await response.json();
    r.check("complete checks and names it", response.status === 201 && stored.bytes === big.length && stored.sha256 === sha(big), JSON.stringify(stored));
    const spyArea = join(dataDir, "peer-backups", spy.memberId);
    const spyFiles = filesUnder(spyArea).filter((file) => file.endsWith(".zip"));
    r.check("the archive is in the member's own folder on A, whole", spyFiles.length === 1 && fs.readFileSync(spyFiles[0]).equals(big), spyFiles.join(", "));
    response = await signed(base, "GET", `/api/cluster/peer-backups/archive?ref=${encodeURIComponent(stored.ref)}`);
    r.check("and streams back whole", response.status === 200 && Buffer.from(await response.arrayBuffer()).equals(big), String(response.status));

    const small = Buffer.from("non è quello annunciato");
    response = await signed(base, "POST", "/api/cluster/peer-backups/uploads", {
      body: JSON.stringify({ fileName: "runpanel-spia-bugia.zip", bytes: small.length, sha256: sha("un altro contenuto") }),
      headers: { "content-type": "application/json" },
    });
    const lie = await response.json();
    await signed(base, "PUT", `/api/cluster/peer-backups/uploads/${lie.uploadId}?offset=0`, { body: small, headers: withToken(lie.token) });
    response = await signed(base, "POST", `/api/cluster/peer-backups/uploads/${lie.uploadId}`, { headers: withToken(lie.token) });
    r.check("an archive that is not the declared one is refused", response.status === 422 && (await response.json()).code === "HASH_MISMATCH", String(response.status));
    r.check("and nothing of it is kept", !filesUnder(spyArea).some((file) => file.includes("bugia")));

    response = await signed(base, "GET", `/api/cluster/peer-backups/archive/stat?ref=${encodeURIComponent("../../backups/archives/x.zip")}`);
    r.check("a ref that climbs out is refused", response.status === 400, String(response.status));
    const refOfA = `${listed.ref}`;
    response = await signed(serverB.base, "GET", `/api/cluster/peer-backups/archive/stat?ref=${encodeURIComponent(refOfA)}`);
    const peek = await response.json();
    r.check("another member asking B for A's copy finds nothing", response.status === 200 && peek.exists === false, JSON.stringify(peek));
    response = await signed(serverB.base, "DELETE", `/api/cluster/peer-backups/archive?ref=${encodeURIComponent(refOfA)}`);
    r.check("nor can it delete it", response.status === 200 && (await response.json()).removed === false && fs.existsSync(archives[0]));
    res = await a.call(`/api/cluster/members/${spy.memberId}`, { method: "DELETE" });

    // --- an older version, a server that is down --------------------------------------------------------------
    res = await a.call("/api/cluster/link-tokens", json("POST", {}));
    const oldJoin = await fetch(`${base}/api/cluster/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: res.body.token, name: "vecchio", url: `http://127.0.0.1:${fake.address().port}`, role: "panel" }),
    });
    const old = await oldJoin.json();
    res = await a.call("/api/backups/destinations/check", json("POST", { type: "peer", config: { memberId: old.memberId } }));
    r.check("a server on an older version: Verifica says to update it", res.body?.ok === false && res.body?.code === "OLD_VERSION" && /vecchio/.test(res.body?.message ?? ""), JSON.stringify(res.body));
    await a.call(`/api/cluster/members/${old.memberId}`, { method: "DELETE" });

    // A deleted run takes its copy on B with it.
    const firstRun = (await a.call(`/api/backups/runs?policyId=${policyB}`)).body?.runs?.[0];
    res = await a.call(`/api/backups/runs/${firstRun?.id}`, { method: "DELETE" });
    r.check("deleting the run deletes its copy on B", res.status === 200 && !fs.existsSync(archives[0]), JSON.stringify(res.body));

    // One more on B, which B's owner then deletes from there.
    started = await a.call(`/api/backups/policies/${policyB}/run`, { method: "POST" });
    finished = await waitForRun(a, started.body?.runId);
    res = await b.call(`/api/backups/hosted/${selfA.id}?confirm=sbagliato`, { method: "DELETE" });
    r.check("deleting A's copies on B takes A's name typed", res.status === 400, String(res.status));
    res = await b.call(`/api/backups/hosted/${selfA.id}?confirm=pannello-a`, { method: "DELETE" });
    r.check("B's owner deletes everything A keeps there", res.status === 200 && res.body?.archives === 1 && !fs.existsSync(areaOnB), JSON.stringify(res.body));
    const lost = await fetch(`${base}/api/backups/runs/${started.body?.runId}/download`, { headers: { cookie: a.cookie } });
    const lostBody = await lost.json().catch(() => ({}));
    r.check("A then says the copy is no longer there", lost.status === 404 && /non c'è più in «Copia su B»/.test(lostBody.error ?? ""), `${lost.status} ${JSON.stringify(lostBody)}`);

    await serverB.stop();
    bRunning = false;
    res = await a.call(`/api/backups/destinations/${peerId}`, { method: "POST" });
    r.check("B down: Verifica says it does not answer", res.body?.ok === false && res.body?.code === "UNREACHABLE" && /nodo-b/.test(res.body?.message ?? ""), JSON.stringify(res.body));
    started = await a.call(`/api/backups/policies/${policyBoth}/run`, { method: "POST" });
    finished = await waitForRun(a, started.body?.runId);
    const downCopy = finished.copies?.find((copy) => copy.destinationId === peerId);
    r.check(
      "B down: the run with a local copy stays successful, the copy on B says why",
      finished.status === "success" && downCopy?.status === "failed" && /non risponde/.test(downCopy?.errorMessage ?? ""),
      JSON.stringify(finished.copies)
    );
    r.check("and the log says one copy did not arrive", /non è arrivata/.test(finished.log ?? ""), finished.log?.slice(-300));
  } finally {
    await new Promise((resolve) => fake.close(resolve));
    if (bRunning) await serverB.stop();
  }

  return r.result();
}
