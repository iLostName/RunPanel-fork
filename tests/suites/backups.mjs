import { createReporter, client, SETUP_TOKEN } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/**
 * The backup API end to end, without Docker.
 *
 * The panel's own SQLite store is a target that needs no container, which makes
 * it possible to exercise the whole path — schedule, run, archive, download,
 * retention, delete — against a real server on any machine. The Docker-only
 * engines are covered separately.
 */
export const meta = { name: "backups", needsDocker: false, drivers: ["sqlite", "postgres"] };

const PASSWORD = "backup-suite-password";

async function waitForRun(api, runId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/runs/${runId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`Il backup ${runId} non è finito in tempo`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function run({ base, dataDir, repoRoot }) {
  const r = createReporter("backups");
  const api = client(base);

  // Only the SQLite store can be dumped without a container, so the parts of
  // this suite that actually produce an archive run there.
  const canDumpStore = fs.existsSync(path.join(dataDir, "runpanel.db"));

  // --- everything is behind the session -----------------------------------
  for (const [method, route] of [
    ["GET", "/api/backups/policies"],
    ["GET", "/api/backups/runs"],
    ["GET", "/api/backups/destinations"],
    ["GET", "/api/backups/targets"],
    ["POST", "/api/backups/cron-preview"],
  ]) {
    const { status } = await api.call(route, {
      method,
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
    });
    r.check(`${method} ${route} requires a session`, status === 401, String(status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: PASSWORD, confirmPassword: PASSWORD }),
  });

  // --- the local destination exists on its own -----------------------------
  const destinations = await api.call("/api/backups/destinations");
  r.check("a destination is created at boot", destinations.body?.destinations?.length === 1);
  const destination = destinations.body?.destinations?.[0];
  r.check("it is the local one", destination?.type === "local", JSON.stringify(destination));
  r.check("its encrypted config is never returned", destination?.config === undefined);

  const probe = await api.call(`/api/backups/destinations/${destination.id}`, { method: "POST" });
  r.check("it verifies as writable", probe.body?.ok === true, JSON.stringify(probe.body));

  // --- an S3 destination is validated before it is stored -------------------
  //
  // The archives carry every environment variable the panel holds, so the
  // transport rule matters: TLS towards anything public, plain HTTP tolerated
  // only towards an address that cannot leave the operator's own network. Half
  // a configuration is refused outright — accepted, encrypted and then failing
  // at 03:00 is the worst of the three outcomes.
  const s3 = (config, name = `s3-${Math.random().toString(36).slice(2, 8)}`) =>
    api.call("/api/backups/destinations", {
      method: "POST",
      body: JSON.stringify({ name, type: "s3", config }),
    });

  const complete = {
    region: "auto",
    bucket: "archivi",
    accessKeyId: "chiave",
    secretAccessKey: "segreto",
  };

  for (const [label, endpoint] of [
    ["a public host over plain http", "http://s3.amazonaws.com"],
    ["a hostname that is not a URL", "non-un-url"],
    ["another scheme entirely", "ftp://storage.example.com"],
  ]) {
    const refused = await s3({ ...complete, endpoint });
    r.check(`S3 endpoint refused: ${label}`, refused.status === 400, `${endpoint} → ${refused.status}`);
  }

  const missingKey = await s3({ endpoint: "https://s3.example.com", region: "auto", bucket: "archivi" });
  r.check("an S3 destination without credentials is refused", missingKey.status === 400, String(missingKey.status));

  const publicTls = await s3({ ...complete, endpoint: "https://s3.example.com" }, "s3-pubblico");
  r.check("https towards a public host is accepted", publicTls.status === 201, String(publicTls.status));

  const lan = await s3({ ...complete, endpoint: "http://192.168.1.50:9000" }, "s3-in-lan");
  r.check(
    "and plain http towards a private address too",
    lan.status === 201,
    `${lan.status} ${JSON.stringify(lan.body).slice(0, 120)}`
  );

  // The secret must never come back out, however the row is read.
  const listed = await api.call("/api/backups/destinations");
  r.check(
    "no destination ever returns its config",
    (listed.body?.destinations ?? []).every((row) => row.config === undefined)
  );

  // --- editing a destination -------------------------------------------------
  {
    const id = publicTls.body?.id;
    const renamed = await api.call(`/api/backups/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "s3-rinominata" }),
    });
    r.check("a destination can be renamed", renamed.status === 200, JSON.stringify(renamed.body));
    const clash = await api.call(`/api/backups/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "s3-in-lan" }),
    });
    r.check("not onto another one's name", clash.status === 409, String(clash.status));

    const keys = await api.call(`/api/backups/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ config: { region: "eu-west-1", secretAccessKey: "" } }),
    });
    r.check("an edit with an empty secret is accepted", keys.status === 200, JSON.stringify(keys.body));
    const detail = await api.call(`/api/backups/destinations/${id}`);
    r.check("the edit kept the stored secret", detail.body?.config?.hasSecret === true, JSON.stringify(detail.body));
    r.check("and never returns it", !JSON.stringify(detail.body).includes("segreto"));
    r.check("the region changed", detail.body?.config?.region === "eu-west-1", String(detail.body?.config?.region));

    const typeChange = await api.call(`/api/backups/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ type: "local" }),
    });
    r.check("the type of a destination does not change", typeChange.status === 400, String(typeChange.status));

    const list = await api.call("/api/backups/destinations");
    const row = (list.body?.destinations ?? []).find((entry) => entry.id === id);
    r.check("the list says where it writes", row?.target?.bucket === "archivi", JSON.stringify(row));
    r.check("but not with which keys", !JSON.stringify(list.body).includes("chiave") && !JSON.stringify(list.body).includes("segreto"));

    const check = await api.call("/api/backups/destinations/check", {
      method: "POST",
      body: JSON.stringify({ type: "local" }),
    });
    r.check("the local disk checks before saving", check.body?.ok === true, JSON.stringify(check.body));
    const badCheck = await api.call("/api/backups/destinations/check", {
      method: "POST",
      body: JSON.stringify({ type: "s3", config: { ...complete, endpoint: "http://s3.amazonaws.com" } }),
    });
    r.check("a check refuses an invalid S3 configuration without storing it", badCheck.body?.ok === false, JSON.stringify(badCheck.body));

    const madeDefault = await api.call(`/api/backups/destinations/${id}/default`, { method: "POST" });
    r.check("the owner can make it the default", madeDefault.status === 200, JSON.stringify(madeDefault.body));
    const afterDefault = await api.call("/api/backups/destinations");
    r.check(
      "and only one is the default",
      (afterDefault.body?.destinations ?? []).filter((entry) => entry.isDefault).map((entry) => entry.id).join() === id,
      JSON.stringify(afterDefault.body?.destinations?.map((entry) => [entry.name, entry.isDefault]))
    );
    await api.call(`/api/backups/destinations/${destination.id}/default`, { method: "POST" });
  }

  for (const id of [publicTls.body?.id, lan.body?.id].filter(Boolean)) {
    await api.call(`/api/backups/destinations/${id}`, { method: "DELETE" });
  }

  // --- schedules are validated by the real parser --------------------------
  const badCron = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Sbagliata",
      cron: "0 25 * * *",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
    }),
  });
  r.check("an impossible hour is rejected", badCron.status === 400, String(badCron.status));

  const reboot = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Al riavvio",
      cron: "@reboot",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
    }),
  });
  r.check("@reboot is refused here too", reboot.status === 400, String(reboot.status));

  const noTargets = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({ name: "Vuota", cron: "", destinationId: destination.id, targets: [] }),
  });
  r.check("a policy with nothing to back up is rejected", noTargets.status === 400);

  // --- create --------------------------------------------------------------
  const created = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Notturno",
      cron: "0 3 * * *",
      timezone: "Europe/Rome",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
      retentionCount: 2,
    }),
  });
  r.check("a valid policy is created", created.status === 201, JSON.stringify(created.body));

  const policyId = created.body?.id;
  r.check("the schedule is described in words", created.body?.schedule === "ogni giorno alle 03:00", created.body?.schedule);

  const unknownDestination = await api.call(`/api/backups/policies/${policyId}`, {
    method: "PUT",
    body: JSON.stringify({ destinationId: "doesnotexist" }),
  });
  r.check("moving a policy to an unknown destination is a 404", unknownDestination.status === 404, String(unknownDestination.status));

  r.check("the next run is computed immediately", Boolean(created.body?.nextRunAt), created.body?.nextRunAt);
  r.check(
    "creating it does not also run it",
    created.body?.lastRunAt === null,
    String(created.body?.lastRunAt)
  );

  const preview = await api.call("/api/backups/cron-preview", {
    method: "POST",
    body: JSON.stringify({ cron: "0 3 * * *", timezone: "Europe/Rome", count: 3 }),
  });
  r.check("the preview returns three occurrences", preview.body?.occurrences?.length === 3);
  r.check(
    "the preview and the policy agree on the wording",
    preview.body?.description === created.body?.schedule
  );

  // --- several copies of every backup: destinations and policies ---------------
  //
  // Two local destinations in folders of their own stand in for a second disk
  // and a bucket: the same path every copy takes, without a network. Outside
  // the data directory, as the panel requires.
  const copyRoot = fs.mkdtempSync(path.join(path.dirname(dataDir), "runpanel-copies-"));
  const dirA = path.join(copyRoot, "disco-a");
  const dirB = path.join(copyRoot, "disco-b");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const localIn = (name, folder) =>
    api.call("/api/backups/destinations", {
      method: "POST",
      body: JSON.stringify({ name, type: "local", config: { path: folder } }),
    });

  const insideData = await localIn("Dentro i dati", path.join(dataDir, "copie"));
  r.check("a folder inside the panel's data is refused", insideData.status === 400, `${insideData.status} ${JSON.stringify(insideData.body)}`);
  const relativeFolder = await localIn("Relativa", "copie/a");
  r.check("so is a relative path", relativeFolder.status === 400, String(relativeFolder.status));
  const diskA = await localIn("Disco A", dirA);
  const diskB = await localIn("Disco B", dirB);
  r.check("a local destination can have a folder of its own", diskA.status === 201 && diskB.status === 201, JSON.stringify([diskA.body, diskB.body]));
  const probeA = await api.call(`/api/backups/destinations/${diskA.body?.id}`, { method: "POST" });
  r.check("and is checked by writing there", probeA.body?.ok === true && (probeA.body?.message ?? "").includes("disco-a"), JSON.stringify(probeA.body));
  const folders = await api.call("/api/backups/destinations");
  r.check(
    "the list says which folder",
    folders.body?.destinations?.find((row) => row.id === diskA.body?.id)?.directory === path.resolve(dirA),
    JSON.stringify(folders.body?.destinations?.map((row) => [row.name, row.directory]))
  );

  const policyWith = (destinations, extra = {}) =>
    api.call("/api/backups/policies", {
      method: "POST",
      body: JSON.stringify({ name: "Copie da rifiutare", cron: "", targets: [{ kind: "panel" }], destinations, ...extra }),
    });
  const sameTwice = await policyWith([{ destinationId: destination.id }, { destinationId: destination.id }]);
  r.check("the same destination twice in a policy is refused", sameTwice.status === 400, `${sameTwice.status} ${JSON.stringify(sameTwice.body)}`);
  const twinA = await localIn("Disco A bis", dirA);
  const samePlace = await policyWith([{ destinationId: diskA.body?.id }, { destinationId: twinA.body?.id }]);
  r.check(
    "so are two destinations writing to the same folder",
    samePlace.status === 400 && /stesso posto/.test(samePlace.body?.error ?? ""),
    `${samePlace.status} ${JSON.stringify(samePlace.body)}`
  );
  await api.call(`/api/backups/destinations/${twinA.body?.id}`, { method: "DELETE" });
  const notFirst = await policyWith([{ destinationId: diskA.body?.id }], { destinationId: destination.id });
  r.check("destinationId, when sent with the list, has to be its first", notFirst.status === 400, String(notFirst.status));
  const unknownCopy = await policyWith([{ destinationId: destination.id }, { destinationId: "doesnotexist" }]);
  r.check("an unknown destination in the list is a 404", unknownCopy.status === 404, String(unknownCopy.status));

  const threeWays = [
    { destinationId: destination.id },
    { destinationId: diskA.body?.id, retention: { count: 1 } },
    { destinationId: diskB.body?.id },
  ];
  const copiesPolicy = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({ name: "Tre copie", cron: "", targets: [{ kind: "panel" }], retentionCount: 3, destinations: threeWays }),
  });
  r.check("a policy with three destinations is created", copiesPolicy.status === 201, JSON.stringify(copiesPolicy.body));
  const listedOrder = (body) => (body?.destinations ?? []).map((entry) => entry.destinationId).join();
  r.check(
    "listed in order, the first one also as destinationId",
    listedOrder(copiesPolicy.body) === threeWays.map((entry) => entry.destinationId).join() && copiesPolicy.body?.destinationId === destination.id,
    JSON.stringify(copiesPolicy.body?.destinations)
  );
  r.check(
    "each copy with its own rule or the policy's",
    copiesPolicy.body?.destinations?.[0]?.retention === null &&
      copiesPolicy.body?.destinations?.[1]?.retention?.count === 1 &&
      copiesPolicy.body?.destinations?.[2]?.retention === null,
    JSON.stringify(copiesPolicy.body?.destinations)
  );
  const newPrimary = await api.call(`/api/backups/policies/${copiesPolicy.body?.id}`, {
    method: "PUT",
    body: JSON.stringify({ destinationId: diskB.body?.id }),
  });
  r.check(
    "a client that only knows destinationId moves the primary and keeps the other copies",
    listedOrder(newPrimary.body) === [diskB.body?.id, destination.id, diskA.body?.id].join() &&
      newPrimary.body?.destinations?.[2]?.retention?.count === 1,
    JSON.stringify(newPrimary.body?.destinations)
  );
  await api.call(`/api/backups/policies/${copiesPolicy.body?.id}`, { method: "PUT", body: JSON.stringify({ destinations: threeWays }) });
  const copyInUse = await api.call(`/api/backups/destinations/${diskB.body?.id}`, { method: "DELETE" });
  r.check("a destination a policy keeps a copy on is not deleted", copyInUse.status === 409, `${copyInUse.status} ${JSON.stringify(copyInUse.body)}`);
  const manualTwice = await api.call("/api/backups/runs", {
    method: "POST",
    body: JSON.stringify({ targets: [{ kind: "panel" }], destinationIds: [diskA.body?.id, diskA.body?.id] }),
  });
  r.check("a manual backup refuses the same destination twice too", manualTwice.status === 400, String(manualTwice.status));

  // --- run it --------------------------------------------------------------
  if (canDumpStore) {
    const started = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    r.check("a manual run is accepted immediately", started.status === 202, String(started.status));

    const runId = started.body?.runId;
    r.check("it answers with an id the client can follow", Boolean(runId));

    // The row has to exist by the time the id is handed out, or the page that
    // opens a stream on it gets a 404.
    const immediately = await api.call(`/api/backups/runs/${runId}`);
    r.check("the run is queryable straight away", immediately.status === 200, String(immediately.status));

    const finished = await waitForRun(api, runId);
    r.check("the run succeeds", finished.status === "success", JSON.stringify(finished.errorMessage));
    r.check("it produced an archive", finished.hasArchive === true);
    r.check("the archive has a size", finished.archiveBytes > 0, String(finished.archiveBytes));
    r.check("the archive has a checksum", /^[0-9a-f]{64}$/.test(finished.checksum ?? ""), finished.checksum);

    const artifact = finished.artifacts?.find((entry) => entry.kind === "panel-store");
    r.check("the panel store was captured", artifact?.status === "ok", JSON.stringify(artifact));
    r.check(
      "integrity_check ran on the dump rather than being assumed",
      artifact?.meta?.integrityCheck === "ok",
      JSON.stringify(artifact?.meta)
    );
    r.check(
      "the row count is recorded, so an empty dump would be visible",
      typeof artifact?.meta?.projectCount === "number",
      JSON.stringify(artifact?.meta?.projectCount)
    );
    r.check("the log was kept", (finished.log ?? "").includes("store del pannello"), finished.log?.slice(0, 120));

    // --- download ----------------------------------------------------------
    const download = await fetch(`${base}/api/backups/runs/${runId}/download`, {
      headers: { cookie: api.cookie },
    });
    r.check("the archive downloads", download.status === 200, String(download.status));
    r.check(
      "it is served as a zip",
      download.headers.get("content-type") === "application/zip",
      download.headers.get("content-type")
    );
    r.check(
      "the digest travels with it",
      download.headers.get("x-checksum-sha256") === finished.checksum
    );

    const bytes = Buffer.from(await download.arrayBuffer());
    r.check("the body really is a zip", bytes.subarray(0, 2).toString() === "PK", bytes.subarray(0, 4).toString("hex"));
    r.check("the body is the whole archive", bytes.length === finished.archiveBytes, `${bytes.length}`);

    // --- integrity ------------------------------------------------------------
    // Read back in the background; on the local disk every member is opened.
    const verifyStarted = await api.call(`/api/backups/runs/${runId}/verify`, { method: "POST" });
    r.check("an integrity check starts", verifyStarted.status === 202, JSON.stringify(verifyStarted.body));
    let verification = null;
    const verifyDeadline = Date.now() + 60_000;
    while (Date.now() < verifyDeadline) {
      const { body } = await api.call(`/api/backups/runs/${runId}/verify`);
      if (body?.verification && body.verification.status !== "running") {
        verification = body.verification;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    r.check("a fresh archive is intact", verification?.status === "ok", JSON.stringify(verification));
    r.check("on the local disk the check is complete", verification?.depth === "full", String(verification?.depth));
    const runAfterCheck = await api.call(`/api/backups/runs/${runId}`);
    r.check("the run remembers it", runAfterCheck.body?.verification?.status === "ok", JSON.stringify(runAfterCheck.body?.verification));

    // --- restoring from an uploaded archive -------------------------------------
    // The download above, sent back in pieces as the browser does.
    const sendPieces = async (payload, { tamper = false } = {}) => {
      const created = await api.call("/api/backups/uploads", {
        method: "POST",
        body: JSON.stringify({ fileName: "archivio.zip", bytes: payload.length }),
      });
      const id = created.body?.upload?.id;
      const size = created.body?.chunkBytes ?? 8 * 1024 * 1024;
      const data = Buffer.from(payload);
      if (tamper) data[Math.floor(data.length / 2)] ^= 0xff;
      const put = (offset, piece) =>
        fetch(`${base}/api/backups/uploads/${id}/chunk?offset=${offset}&length=${piece.length}`, {
          method: "PUT",
          headers: { cookie: api.cookie, "content-type": "application/octet-stream" },
          body: piece,
        });
      for (let offset = 0; offset < data.length; offset += size) {
        const res = await put(offset, data.subarray(offset, offset + size));
        if (!res.ok) return { id, created, failed: res.status };
      }
      return { id, created, put };
    };

    const sent = await sendPieces(bytes);
    r.check("an upload is announced", sent.created.status === 201, JSON.stringify(sent.created.body).slice(0, 160));
    r.check("every piece is accepted", !sent.failed, String(sent.failed));
    if (sent.put) {
      const again = await sent.put(0, bytes.subarray(0, Math.min(bytes.length, sent.created.body.chunkBytes)));
      r.check("a piece sent twice is accepted and ignored", again.status === 200, String(again.status));
      const beyond = await sent.put(bytes.length + 10, Buffer.from("x"));
      r.check("a piece out of order is refused", beyond.status === 409 || beyond.status === 400, String(beyond.status));
    }
    const finishedUpload = await api.call(`/api/backups/uploads/${sent.id}`, { method: "POST" });
    r.check("finishing starts the check", finishedUpload.status === 202, JSON.stringify(finishedUpload.body).slice(0, 160));

    const waitForUpload = async (id) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const { body } = await api.call(`/api/backups/uploads/${id}`);
        if (body?.upload && body.upload.status !== "checking") return body.upload;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    };
    const ready = await waitForUpload(sent.id);
    r.check("a whole archive passes the check", ready?.status === "ready", JSON.stringify(ready).slice(0, 240));
    const storeItem = ready?.artifacts?.find((entry) => entry.kind === "panel-store");
    r.check("its items are read from its own manifest", Boolean(storeItem), JSON.stringify(ready?.artifacts).slice(0, 200));

    if (storeItem) {
      const wrong = await api.call("/api/backups/restore", {
        method: "POST",
        body: JSON.stringify({
          uploadId: sent.id,
          confirm: "qualcos'altro",
          targets: [{ artifactId: storeItem.id, action: "restore" }],
        }),
      });
      r.check("an upload's restore wants the item's name typed too", wrong.status === 400, JSON.stringify(wrong.body));
    }

    const damaged = await sendPieces(bytes, { tamper: true });
    await api.call(`/api/backups/uploads/${damaged.id}`, { method: "POST" });
    const refused = await waitForUpload(damaged.id);
    r.check("a damaged archive is refused by the check", refused?.status === "invalid", JSON.stringify(refused).slice(0, 240));
    if (storeItem && refused) {
      const fromDamaged = await api.call("/api/backups/restore", {
        method: "POST",
        body: JSON.stringify({
          uploadId: damaged.id,
          confirm: storeItem.refName,
          targets: [{ artifactId: storeItem.id, action: "restore" }],
        }),
      });
      r.check("and cannot be restored from", fromDamaged.status === 409, String(fromDamaged.status));
    }

    for (const id of [sent.id, damaged.id]) {
      const gone = await api.call(`/api/backups/uploads/${id}`, { method: "DELETE" });
      r.check("an upload can be deleted", gone.status === 200, String(gone.status));
    }
    const afterUploads = await api.call(`/api/backups/uploads/${sent.id}`);
    r.check("and is gone", afterUploads.status === 404, String(afterUploads.status));

    // --- an id that is not an id -------------------------------------------
    for (const hostile of ["..", "../../etc/passwd", "%2e%2e%2fsecret", "notarealid"]) {
      const { status } = await api.call(`/api/backups/runs/${encodeURIComponent(hostile)}/download`);
      r.check(`a hostile id gives 404, not 500: ${hostile}`, status === 404, String(status));
    }

    // --- restore -------------------------------------------------------------
    // Restoring the panel's own SQLite store does not swap it live — it stages
    // the file and a marker for the next boot — which makes it the one target
    // that can be exercised end to end inside a running test.
    const wrongConfirm = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId,
        confirm: "qualcos'altro",
        targets: [{ artifactId: artifact.id, action: "restore" }],
      }),
    });
    r.check(
      "a wrong confirmation is refused by the server, not just the browser",
      wrongConfirm.status === 400,
      JSON.stringify(wrongConfirm.body)
    );

    const startedRestore = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId,
        confirm: artifact.refName,
        targets: [{ artifactId: artifact.id, action: "restore" }],
      }),
    });
    r.check("a confirmed restore is accepted", startedRestore.status === 202, JSON.stringify(startedRestore.body));

    const restoreId = startedRestore.body?.restoreId;
    let restore = null;
    const restoreDeadline = Date.now() + 120_000;
    for (;;) {
      const { body } = await api.call(`/api/backups/restore/${restoreId}`);
      if (body?.status && body.status !== "running") {
        restore = body;
        break;
      }
      if (Date.now() > restoreDeadline) throw new Error("Il ripristino non è finito in tempo");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    r.check("the restore succeeds", restore.status === "success", JSON.stringify(restore.errorMessage));
    r.check("a safety backup was taken first", Boolean(restore.safetyRunId), String(restore.safetyRunId));

    const safety = await api.call(`/api/backups/runs/${restore.safetyRunId}`);
    r.check("the safety backup succeeded", safety.body?.status === "success");
    r.check(
      "and is exempt from retention, so it cannot be collected later",
      safety.body?.pinned === true
    );

    r.check(
      "the store is staged for the next boot rather than swapped underneath us",
      fs.existsSync(path.join(dataDir, "runpanel.restored.db")) &&
        fs.existsSync(path.join(dataDir, ".restore-pending"))
    );
    r.check(
      "the log says what will happen",
      (restore.log ?? "").includes("prossimo riavvio"),
      (restore.log ?? "").slice(-160)
    );

    // Leave the data directory as we found it: a marker left behind would make
    // the next boot swap a store this suite is done with.
    fs.rmSync(path.join(dataDir, ".restore-pending"), { force: true });
    fs.rmSync(path.join(dataDir, "runpanel.restored.db"), { force: true });

    // --- retention ----------------------------------------------------------
    // retentionCount is 2, so a third run should collect the first.
    const second = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    await waitForRun(api, second.body.runId);
    const third = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    await waitForRun(api, third.body.runId);

    const listed = await api.call(`/api/backups/runs?policyId=${policyId}`);
    const kept = listed.body?.runs ?? [];
    r.check("retention keeps exactly what was asked for", kept.length === 2, `${kept.length}`);
    r.check("it is the oldest that goes", !kept.some((entry) => entry.id === runId));

    const archives = path.join(dataDir, "backups", "archives");
    const listArchives = () => {
      const found = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".zip")) found.push(entry.name);
        }
      };
      if (fs.existsSync(archives)) walk(archives);
      return found;
    };
    // The safety copy taken before the restore is pinned, so retention must
    // leave it alone even though it belongs to no policy.
    const isPolicyArchive = (name) => !name.includes("sicurezza-pre-ripristino");

    const onDisk = listArchives();
    r.check(
      "the collected archive is gone from disk too",
      onDisk.filter(isPolicyArchive).length === 2,
      onDisk.join(", ")
    );
    r.check(
      "the pinned safety copy is not collected",
      onDisk.some((name) => !isPolicyArchive(name)),
      onDisk.join(", ")
    );
    r.check("no .part file survives a finished run", !onDisk.some((name) => name.endsWith(".part")));

    // --- deleting a run ------------------------------------------------------
    const doomed = kept[0].id;
    const removed = await api.call(`/api/backups/runs/${doomed}`, { method: "DELETE" });
    r.check("a run can be deleted", removed.status === 200, String(removed.status));

    const afterDelete = listArchives();
    r.check(
      "deleting the run deletes its archive",
      afterDelete.filter(isPolicyArchive).length === 1,
      afterDelete.join(", ")
    );

    // --- encryption with the backup password -----------------------------------
    //
    // The whole cycle on a real server: the password is set, the next archive
    // leaves encrypted and still verifies and restores here, a replaced
    // password keeps its archives readable, an archive from "another server"
    // asks for its password on upload, and a run whose password the panel lost
    // asks for it in the restore.
    const sealed = await import(pathToFileURL(path.join(repoRoot, "services", "backup", "archive-crypto.ts")).href);
    const FIRST = "la prima password dei backup";
    const SECOND = "la seconda password dei backup";
    const putPassword = (password) =>
      api.call("/api/backups/encryption", { method: "PUT", body: JSON.stringify({ password }) });
    const waitFor = async (route, done) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const { body } = await api.call(route);
        if (done(body)) return body;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    };
    const verify = async (id) => {
      await api.call(`/api/backups/runs/${id}/verify`, { method: "POST" });
      return (await waitFor(`/api/backups/runs/${id}/verify`, (body) => body?.verification && body.verification.status !== "running"))
        ?.verification;
    };
    const restoreAndWait = async (payload) => {
      const started = await api.call("/api/backups/restore", { method: "POST", body: JSON.stringify(payload) });
      if (started.status !== 202) return { started };
      const done = await waitFor(`/api/backups/restore/${started.body.restoreId}`, (body) => body?.status && body.status !== "running");
      fs.rmSync(path.join(dataDir, ".restore-pending"), { force: true });
      fs.rmSync(path.join(dataDir, "runpanel.restored.db"), { force: true });
      return { started, done };
    };
    const listEncrypted = () => {
      const found = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".zip.enc") || entry.name.endsWith(".part")) found.push(full);
        }
      };
      if (fs.existsSync(archives)) walk(archives);
      return found;
    };

    {
      const initial = await api.call("/api/backups/encryption");
      r.check("encryption starts off, so nothing changes until the owner asks", initial.body?.enabled === false, JSON.stringify(initial.body));
      const short = await putPassword("corta");
      r.check("a short backup password is refused", short.status === 400, JSON.stringify(short.body));
      const spaced = await putPassword(" una password che finisce con uno spazio ");
      r.check("so is one with a space at either end", spaced.status === 400, JSON.stringify(spaced.body));
      const noCheck = await api.call("/api/backups/encryption/check", { method: "POST", body: JSON.stringify({ password: FIRST }) });
      r.check("there is nothing to check while it is off", noCheck.status === 409, String(noCheck.status));

      const set = await putPassword(FIRST);
      r.check("the owner sets the backup password", set.status === 200 && set.body?.enabled === true, JSON.stringify(set.body));
      r.check("and it never comes back out", !JSON.stringify(set.body).includes(FIRST));
      const wrong = await api.call("/api/backups/encryption/check", { method: "POST", body: JSON.stringify({ password: "un'altra" }) });
      const right = await api.call("/api/backups/encryption/check", { method: "POST", body: JSON.stringify({ password: FIRST }) });
      r.check("checking it says no to another and yes to it", wrong.body?.matches === false && right.body?.matches === true);
    }

    const sealedPolicy = await api.call("/api/backups/policies", {
      method: "POST",
      body: JSON.stringify({ name: "Cifrato", cron: "", destinationId: destination.id, targets: [{ kind: "panel" }] }),
    });
    const firstSealed = await api.call(`/api/backups/policies/${sealedPolicy.body?.id}/run`, { method: "POST" });
    const sealedRun = await waitForRun(api, firstSealed.body?.runId);
    r.check("a run with the password set succeeds", sealedRun.status === "success", JSON.stringify(sealedRun.errorMessage));
    r.check("and says its archive is encrypted, with a password this panel has", sealedRun.encryption?.usable === true, JSON.stringify(sealedRun.encryption));
    r.check("the log says so too", /cifrato/.test(sealedRun.log ?? ""), (sealedRun.log ?? "").slice(0, 200));
    {
      const files = listEncrypted();
      r.check("the archive on disk is a .zip.enc, and no .part is left", files.length === 1 && files[0].endsWith(".zip.enc"), files.join(", "));
      const head = files[0] ? fs.readFileSync(files[0]).subarray(0, 7).toString("latin1") : "";
      r.check("and starts with the encryption header, not a zip", head === "RPBKENC", head);

      const download = await fetch(`${base}/api/backups/runs/${sealedRun.id}/download`, { headers: { cookie: api.cookie } });
      const body = Buffer.from(await download.arrayBuffer());
      r.check("it downloads as it is stored, encrypted", body.subarray(0, 7).toString("latin1") === "RPBKENC" && body.length === sealedRun.archiveBytes);
      r.check(
        "named .zip.enc and not served as a zip",
        /\.zip\.enc"/.test(download.headers.get("content-disposition") ?? "") && download.headers.get("content-type") === "application/octet-stream",
        `${download.headers.get("content-disposition")} ${download.headers.get("content-type")}`
      );

      const check = await verify(sealedRun.id);
      r.check("an encrypted archive passes the full integrity check here", check?.status === "ok" && check?.depth === "full", JSON.stringify(check));

      const listed = await api.call("/api/backups/runs?limit=50");
      // The second retention run: the third was deleted above.
      const plain = (listed.body?.runs ?? []).find((run) => run.id === second.body.runId);
      r.check("archives taken before stay marked as not encrypted", plain && plain.encryption === null, JSON.stringify(plain?.encryption));

      // --- a new password keeps the old archives readable here --------------------
      const changed = await putPassword(SECOND);
      r.check("the password can be replaced", changed.body?.enabled === true && changed.body?.previous === 1, JSON.stringify(changed.body));
      const again = await verify(sealedRun.id);
      r.check("an archive sealed with the old one still opens here", again?.status === "ok" && again?.depth === "full", JSON.stringify(again));

      // --- back as an upload: this panel's own archive opens by itself -------------
      const own = await sendPieces(body);
      await api.call(`/api/backups/uploads/${own.id}`, { method: "POST" });
      const ownReady = await waitForUpload(own.id);
      r.check(
        "an encrypted archive of this panel, uploaded back, needs no password",
        ownReady?.status === "ready" && ownReady?.encryption?.unlocked === true,
        JSON.stringify(ownReady).slice(0, 240)
      );
      await api.call(`/api/backups/uploads/${own.id}`, { method: "DELETE" });

      // --- an archive from another server ---------------------------------------
      // The plain archive downloaded earlier, sealed the way another panel would.
      const foreignPassword = "la password di un altro server";
      const seal = await sealed.prepareSeal({ password: foreignPassword, keyId: "altroserver01", keyCreatedAt: "2026-01-02T03:04:05.000Z" });
      const foreignFile = path.join(dataDir, "foreign.zip.enc");
      await pipeline(Readable.from([bytes]), seal.createStream(), fs.createWriteStream(foreignFile));
      const foreign = await sendPieces(fs.readFileSync(foreignFile));
      fs.rmSync(foreignFile, { force: true });
      await api.call(`/api/backups/uploads/${foreign.id}`, { method: "POST" });
      const locked = await waitForUpload(foreign.id);
      r.check(
        "an archive encrypted elsewhere waits for its password",
        locked?.status === "locked" && locked?.encryption?.unlocked === false && /password/.test(locked?.message ?? ""),
        JSON.stringify(locked).slice(0, 240)
      );
      const early = await api.call("/api/backups/restore", {
        method: "POST",
        body: JSON.stringify({ uploadId: foreign.id, confirm: "x", targets: [{ artifactId: "0", action: "restore" }] }),
      });
      r.check("and cannot be restored before it is unlocked", early.status === 409, String(early.status));
      const badUnlock = await api.call(`/api/backups/uploads/${foreign.id}/unlock`, { method: "POST", body: JSON.stringify({ password: FIRST }) });
      r.check("a wrong password is refused at once", badUnlock.status === 400, JSON.stringify(badUnlock.body));
      const goodUnlock = await api.call(`/api/backups/uploads/${foreign.id}/unlock`, {
        method: "POST",
        body: JSON.stringify({ password: foreignPassword }),
      });
      r.check("the right one starts the check", goodUnlock.status === 202 && goodUnlock.body?.upload?.status === "checking", JSON.stringify(goodUnlock.body).slice(0, 200));
      r.check("and is never echoed back", !JSON.stringify(goodUnlock.body).includes(foreignPassword) && !JSON.stringify(goodUnlock.body).includes("secret"));
      const unlocked = await waitForUpload(foreign.id);
      r.check("then the archive is checked like any other", unlocked?.status === "ready", JSON.stringify(unlocked).slice(0, 240));
      const foreignStore = unlocked?.artifacts?.find((entry) => entry.kind === "panel-store");
      if (foreignStore) {
        const { started, done } = await restoreAndWait({
          uploadId: foreign.id,
          confirm: foreignStore.refName,
          targets: [{ artifactId: foreignStore.id, action: "restore" }],
        });
        r.check("and restored from, with the password it was unlocked with", started.status === 202 && done?.status === "success", JSON.stringify(done?.errorMessage ?? started.body));
        r.check("the restore log says it was encrypted", /cifrato/.test(done?.log ?? ""), (done?.log ?? "").slice(0, 200));
      }
      await api.call(`/api/backups/uploads/${foreign.id}`, { method: "DELETE" });

      // --- a run whose password the panel no longer has ----------------------------
      // As after restoring another panel's store: the key row is there, but does
      // not decrypt with this panel's key.
      const Database = (await import("better-sqlite3")).default;
      const store = new Database(path.join(dataDir, "runpanel.db"));
      const keyRow = store.prepare("SELECT id, secret FROM backup_keys WHERE retired_at IS NOT NULL").get();
      store.prepare("UPDATE backup_keys SET secret = ? WHERE id = ?").run("bm9uIHNpIGRlY2lmcmE=", keyRow.id);
      try {
        const detail = await api.call(`/api/backups/runs/${sealedRun.id}`);
        r.check("a run whose password the panel lost says so", detail.body?.encryption?.usable === false, JSON.stringify(detail.body?.encryption));
        const storeArtifact = detail.body?.artifacts?.find((entry) => entry.kind === "panel-store");
        const payload = {
          runId: sealedRun.id,
          confirm: storeArtifact?.refName,
          targets: [{ artifactId: storeArtifact?.id, action: "restore" }],
        };
        const missing = await restoreAndWait(payload);
        r.check(
          "its restore asks for the password before starting",
          missing.started.status === 400 && missing.started.body?.passwordRequired === true,
          JSON.stringify(missing.started.body)
        );
        const wrongPassword = await restoreAndWait({ ...payload, password: SECOND });
        r.check("a wrong one is refused before starting too", wrongPassword.started.status === 400, JSON.stringify(wrongPassword.started.body));
        const withPassword = await restoreAndWait({ ...payload, password: FIRST });
        r.check(
          "the right one restores it",
          withPassword.started.status === 202 && withPassword.done?.status === "success",
          JSON.stringify(withPassword.done?.errorMessage ?? withPassword.started.body)
        );
        const lostCheck = await verify(sealedRun.id);
        r.check(
          "and its integrity check vouches for the bytes without calling it damaged",
          lostCheck?.status === "ok" && lostCheck?.depth === "archive",
          JSON.stringify(lostCheck)
        );
      } finally {
        store.prepare("UPDATE backup_keys SET secret = ? WHERE id = ?").run(keyRow.secret, keyRow.id);
        store.close();
      }

      // --- turned off --------------------------------------------------------------
      const off = await api.call("/api/backups/encryption", { method: "DELETE" });
      r.check("encryption can be turned off", off.body?.enabled === false && off.body?.changed === true && off.body?.previous === 2, JSON.stringify(off.body));
      const plainAgain = await api.call(`/api/backups/policies/${sealedPolicy.body?.id}/run`, { method: "POST" });
      const plainRun = await waitForRun(api, plainAgain.body?.runId);
      r.check("after which archives are in clear again", plainRun.status === "success" && plainRun.encryption === null, JSON.stringify(plainRun.encryption));
      const stillOpens = await verify(sealedRun.id);
      r.check("and the encrypted ones still open here", stillOpens?.status === "ok" && stillOpens?.depth === "full", JSON.stringify(stillOpens));
    }
    await api.call(`/api/backups/policies/${sealedPolicy.body?.id}`, { method: "DELETE" });

    // --- several copies of every backup: the runs ---------------------------------
    //
    // The archive is written once and copied to every destination; each copy is
    // pruned by its own rule; a copy that fails warns without failing the backup
    // and can be sent again; and every read falls back to the next copy when
    // one is gone.
    {
      const archivesIn = (dir) => {
        const found = [];
        const walk = (at) => {
          if (!fs.existsSync(at) || !fs.statSync(at).isDirectory()) return;
          for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.zip(\.enc)?$/.test(entry.name)) found.push(full);
          }
        };
        walk(dir);
        return found;
      };
      const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const runCopies = async () => {
        const started = await api.call(`/api/backups/policies/${copiesPolicy.body?.id}/run`, { method: "POST" });
        return waitForRun(api, started.body?.runId);
      };
      const idle = () => waitFor("/api/backups/runs?limit=1", (body) => body && body.activeRunId === null);

      const firstCopies = await runCopies();
      r.check("a run of a policy with three destinations succeeds", firstCopies.status === "success", JSON.stringify(firstCopies.errorMessage));
      r.check(
        "with three copies, all saved, in the policy's order",
        firstCopies.copies?.length === 3 &&
          firstCopies.copies.every((copy) => copy.status === "done") &&
          firstCopies.copies.map((copy) => copy.destinationId).join() === threeWays.map((entry) => entry.destinationId).join(),
        JSON.stringify(firstCopies.copies)
      );
      r.check(
        "the run's own destination fields still describe the primary",
        firstCopies.destinationName === destination.name && firstCopies.hasArchive === true,
        `${firstCopies.destinationName} ${firstCopies.hasArchive}`
      );
      const onA = archivesIn(dirA);
      const onB = archivesIn(dirB);
      r.check("a copy lands in each folder", onA.length === 1 && onB.length === 1, JSON.stringify([onA, onB]));
      r.check(
        "each one the archive the run wrote, byte for byte",
        onA[0] && onB[0] && sha256Of(onA[0]) === firstCopies.checksum && sha256Of(onB[0]) === firstCopies.checksum
      );
      r.check("the log names every copy", (firstCopies.log ?? "").includes("3 copie"), (firstCopies.log ?? "").slice(0, 300));
      const copiesListed = await api.call(`/api/backups/runs?policyId=${copiesPolicy.body?.id}`);
      r.check("the run list carries the copies too", copiesListed.body?.runs?.[0]?.copies?.length === 3, JSON.stringify(copiesListed.body?.runs?.[0]?.copies));

      // --- each copy by its own rule: Disco A keeps one, the others three ---------
      await runCopies();
      r.check("Disco A keeps only its newest copy, the others keep both", archivesIn(dirA).length === 1 && archivesIn(dirB).length === 2);
      const older = await api.call(`/api/backups/runs/${firstCopies.id}`);
      r.check(
        "the older run stays, with the copies its other destinations keep",
        older.status === 200 && older.body?.copies?.length === 2 && !older.body.copies.some((copy) => copy.destinationId === diskA.body?.id),
        JSON.stringify(older.body?.copies)
      );

      // --- a copy that fails ---------------------------------------------------------
      // Disco B's folder is set aside and a file put in its place: nothing can be
      // written under it, as with a disk gone read-only or unmounted.
      fs.renameSync(dirB, `${dirB}-via`);
      fs.writeFileSync(dirB, "non è una cartella");
      const third = await runCopies();
      const lost = third.copies?.find((copy) => copy.destinationId === diskB.body?.id);
      r.check("a run where a copy failed is not a failed backup", third.status === "success", JSON.stringify(third.errorMessage));
      r.check("the copy says it failed, and why", lost?.status === "failed" && /cartella/.test(lost.errorMessage ?? ""), JSON.stringify(lost));
      r.check("the other copies arrived", third.copies?.filter((copy) => copy.status === "done").length === 2, JSON.stringify(third.copies));
      r.check("the log says the archive is safe anyway", /al sicuro/.test(third.log ?? ""), (third.log ?? "").slice(-300));
      const warned = await waitFor("/api/notifications", (body) =>
        (body?.items ?? []).some((item) => item.event === "backup.finished" && item.level === "warn" && /copia/.test(item.title ?? ""))
      );
      r.check("and a warning notification says a copy was not saved", Boolean(warned), JSON.stringify((warned?.items ?? []).slice(0, 2)));

      // --- Riprova la copia ---------------------------------------------------------------
      const saved = third.copies?.find((copy) => copy.status === "done");
      const notAgain = await api.call(`/api/backups/runs/${third.id}/copies/${saved?.id}/retry`, { method: "POST" });
      r.check("a copy that arrived is not sent again", notAgain.status === 409, `${notAgain.status} ${JSON.stringify(notAgain.body)}`);
      fs.rmSync(dirB, { force: true });
      fs.renameSync(`${dirB}-via`, dirB);
      const retry = await api.call(`/api/backups/runs/${third.id}/copies/${lost?.id}/retry`, { method: "POST" });
      r.check("a failed copy can be sent again", retry.status === 202 && retry.body?.copy?.status === "uploading", `${retry.status} ${JSON.stringify(retry.body)}`);
      const retried = await waitFor(`/api/backups/runs/${third.id}`, (body) => {
        const status = body?.copies?.find((copy) => copy.id === lost?.id)?.status;
        return status === "done" || status === "failed";
      });
      await idle();
      const back = retried?.copies?.find((copy) => copy.id === lost?.id);
      r.check("and arrives, from another copy", back?.status === "done", JSON.stringify(back));
      const resent = archivesIn(dirB).find((file) => sha256Of(file) === third.checksum);
      r.check("identical to the archive the backup created", Boolean(resent) && archivesIn(dirB).length === 3, JSON.stringify(archivesIn(dirB)));
      r.check("the run's log says so", /Riprovo la copia/.test(retried?.log ?? ""), (retried?.log ?? "").slice(-300));

      // --- every read falls back to the next copy ------------------------------------------
      // The primary's file disappears, as with the disk it was on.
      const primaryCopy = third.copies?.find((copy) => copy.position === 0);
      fs.rmSync(path.join(dataDir, "backups", primaryCopy?.ref ?? "missing"), { force: true });
      const fallbackDownload = await fetch(`${base}/api/backups/runs/${third.id}/download`, { headers: { cookie: api.cookie } });
      const downloaded = Buffer.from(await fallbackDownload.arrayBuffer());
      r.check(
        "the download falls back to the next copy",
        fallbackDownload.status === 200 && crypto.createHash("sha256").update(downloaded).digest("hex") === third.checksum,
        String(fallbackDownload.status)
      );
      const fallbackCheck = await verify(third.id);
      r.check(
        "so does the integrity check, and it says which copy it read",
        fallbackCheck?.status === "ok" && fallbackCheck?.source?.destinationName === "Disco A",
        JSON.stringify(fallbackCheck)
      );
      const thirdStore = third.artifacts?.find((entry) => entry.kind === "panel-store");
      const fallbackRestore = await restoreAndWait({
        runId: third.id,
        confirm: thirdStore?.refName,
        targets: [{ artifactId: thirdStore?.id, action: "restore" }],
      });
      r.check(
        "and so does a restore",
        fallbackRestore.started.status === 202 && fallbackRestore.done?.status === "success",
        JSON.stringify(fallbackRestore.done?.errorMessage ?? fallbackRestore.started.body)
      );
      r.check(
        "whose log says which copy it passed over and which it used",
        /successiva/.test(fallbackRestore.done?.log ?? "") && /Disco A/.test(fallbackRestore.done?.log ?? ""),
        (fallbackRestore.done?.log ?? "").slice(0, 500)
      );

      // --- deleting a run deletes every copy -----------------------------------------------------
      const removedCopies = await api.call(`/api/backups/runs/${third.id}`, { method: "DELETE" });
      r.check(
        "deleting the run deletes every copy it has",
        removedCopies.status === 200 && archivesIn(dirA).length === 0 && !archivesIn(dirB).some((file) => file === resent),
        `${removedCopies.status} ${JSON.stringify([archivesIn(dirA), archivesIn(dirB)])}`
      );
    }
  } else {
    r.note("store Postgres: il dump richiede Docker, verifico solo la parte di configurazione");
  }

  // The copies' policy and folders go, so what follows finds the store as it
  // expects it: one policy, one destination.
  await api.call(`/api/backups/policies/${copiesPolicy.body?.id}`, { method: "DELETE" });
  for (const disk of [diskA, diskB]) {
    const removed = await api.call(`/api/backups/destinations/${disk.body?.id}?confirm=${encodeURIComponent(disk.body?.name ?? "")}`, {
      method: "DELETE",
    });
    r.check(`a destination holding copies can be removed once no policy lists it: ${disk.body?.name}`, removed.status === 200, `${removed.status} ${JSON.stringify(removed.body)}`);
  }
  fs.rmSync(copyRoot, { recursive: true, force: true });

  // --- editing --------------------------------------------------------------
  const disabled = await api.call(`/api/backups/policies/${policyId}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  r.check("a policy can be switched off", disabled.body?.enabled === false);
  r.check(
    "switching it off clears the next run instead of leaving a stale one",
    disabled.body?.nextRunAt === null,
    String(disabled.body?.nextRunAt)
  );

  const manualOnly = await api.call(`/api/backups/policies/${policyId}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, cron: "" }),
  });
  r.check("an empty schedule means manual only", manualOnly.body?.schedule === "solo su richiesta");
  r.check("and has no next run", manualOnly.body?.nextRunAt === null);

  // --- the destination cannot be pulled out from under a policy -------------
  const inUse = await api.call(`/api/backups/destinations/${destination.id}`, { method: "DELETE" });
  r.check("a destination in use is not deleted", inUse.status === 409, String(inUse.status));

  const gone = await api.call(`/api/backups/policies/${policyId}`, { method: "DELETE" });
  r.check("a policy can be deleted", gone.status === 200);

  const afterPolicyDelete = await api.call("/api/backups/policies");
  r.check("and it is gone", afterPolicyDelete.body?.policies?.length === 0);

  // Every restore's safety copy needs somewhere to go.
  const lastOne = await api.call(`/api/backups/destinations/${destination.id}`, { method: "DELETE" });
  r.check("the last destination is not deleted", lastOne.status === 409, String(lastOne.status));

  if (canDumpStore) {
    // The runs outlive the policy on purpose: their archives are files, and a
    // cascade would leave them on disk with nothing that knows about them.
    const orphaned = await api.call("/api/backups/runs");
    // Looked up by name: the encryption runs above are newer than these.
    const survivor = orphaned.body?.runs?.find((entry) => entry.policyName === "Notturno");
    r.check("its runs survive, with the name kept for the history", Boolean(survivor), JSON.stringify(orphaned.body?.runs?.[0]));
    r.check("but no longer point at a policy", survivor?.policyId === null);
  }

  // --- a project's volume settings ---------------------------------------------
  //
  // Saved from the project's settings and read by every policy that includes
  // the project. The paths reach `tar --exclude` and a restore's `find`, so
  // what cannot be a plain relative path is a 400 here, not a surprise at 03:00.
  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Backup Settings Suite" }),
  });
  const projectId = project.body?.id;
  const settingsUrl = `/api/projects/${projectId}/backup`;

  const initial = await api.call(settingsUrl);
  r.check("a project's backup settings can be read", initial.status === 200, String(initial.status));
  r.check(
    "and default to pausing the writers, with nothing excluded",
    initial.body?.settings?.consistency === "pause" &&
      initial.body?.settings?.preBackup === null &&
      JSON.stringify(initial.body?.settings?.excludes) === "{}",
    JSON.stringify(initial.body?.settings)
  );
  r.check("with no policy covering them yet", Array.isArray(initial.body?.coverage) && initial.body.coverage.length === 0);

  for (const [label, excludes] of [
    ["a path climbing out of the volume", { "runpanel-x_data": ["../etc"] }],
    ["an absolute path", { "runpanel-x_data": ["/etc/passwd"] }],
    ["a wildcard", { "runpanel-x_data": ["*.parquet"] }],
    ["a quote", { "runpanel-x_data": ["it's"] }],
    ["a volume name Docker would refuse", { "../x": ["trades"] }],
  ]) {
    const refused = await api.call(settingsUrl, {
      method: "PUT",
      body: JSON.stringify({ consistency: "pause", preBackup: null, excludes }),
    });
    r.check(`an exclusion is refused: ${label}`, refused.status === 400, `${refused.status} ${JSON.stringify(refused.body).slice(0, 120)}`);
  }

  const badHook = await api.call(settingsUrl, {
    method: "PUT",
    body: JSON.stringify({ consistency: "live", preBackup: { service: "db", command: "   ", timeoutSec: 60 } }),
  });
  r.check("a pre-backup command with nothing to run is refused", badHook.status === 400, String(badHook.status));

  const saved = await api.call(settingsUrl, {
    method: "PUT",
    body: JSON.stringify({
      consistency: "live",
      preBackup: { service: "db", command: "pg_dump -f /backup/db.sql", timeoutSec: 120 },
      excludes: { "runpanel-x_data": ["./trades/", "cache/tmp", "trades"] },
    }),
  });
  r.check("valid settings are saved", saved.status === 200, `${saved.status} ${JSON.stringify(saved.body).slice(0, 160)}`);
  r.check(
    "and come back normalised",
    JSON.stringify(saved.body?.settings?.excludes) === JSON.stringify({ "runpanel-x_data": ["trades", "cache/tmp"] }),
    JSON.stringify(saved.body?.settings?.excludes)
  );

  const row = await api.call(`/api/projects/${projectId}`);
  const stored = JSON.parse(row.body?.backup_settings ?? "null");
  r.check(
    "the project row carries them",
    stored?.consistency === "live" && stored?.preBackup?.service === "db",
    String(row.body?.backup_settings)
  );

  await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Volumi di tutti",
      cron: "",
      destinationId: destination.id,
      targets: [{ kind: "all-projects", include: ["config", "volumes"] }],
    }),
  });
  const covered = await api.call(settingsUrl);
  r.check(
    "a policy over every project's volumes is listed as covering this one",
    covered.body?.coverage?.some((policy) => policy.name === "Volumi di tutti"),
    JSON.stringify(covered.body?.coverage)
  );

  const missing = await api.call("/api/projects/nonexistent/backup", {
    method: "PUT",
    body: JSON.stringify({ consistency: "pause", preBackup: null }),
  });
  r.check("settings for a project that does not exist are a 404", missing.status === 404, String(missing.status));

  const anonymous = await client(base).call(settingsUrl);
  r.check("and they are behind the session", anonymous.status === 401, String(anonymous.status));

  return r.result();
}
