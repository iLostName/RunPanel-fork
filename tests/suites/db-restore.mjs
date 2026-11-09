import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { client, createReporter, docker, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";

const { mongoShellCall } = await import(new URL("../../lib/service-exec.ts", import.meta.url).href);

/**
 * Backing up a real database and putting it back, on every engine that reads a
 * dump from stdin.
 *
 * Nothing used to run this path, which is how a restore could send no data at
 * all and report success: `docker exec` without `-i` gives the client an empty
 * script. The cases below are the ones that break for real: an app holding its
 * connection, table data that looks like a statement, and a dump landing on a
 * service whose credentials are not the ones in the archive.
 */
export const meta = { name: "db-restore", needsDocker: true, drivers: ["sqlite"] };

/** Outside every range Windows reserves for Hyper-V. */
const PORT = 47341;
const PASSWORD = "db-restore-pw";
const OTHER_PASSWORD = "db-restore-other-pw";

async function until(check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

async function finished(api, url, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api.call(url);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`${url} non è finito in tempo`);
    await sleep(500);
  }
}

const psql = (container, database, sql, password = PASSWORD) =>
  docker("exec", "-e", `PGPASSWORD=${password}`, container, "psql", "-U", "runpanel", "-d", database, "-Atc", sql);

/** Through the container's own address: the image trusts its socket and loopback, so those prove no password. */
const psqlTcp = (container, password) =>
  docker("exec", "-e", `PGPASSWORD=${password}`, container, "sh", "-c", `psql -h "$(hostname -i)" -U runpanel -d postgres -Atc "SELECT 'in'"`);

const mysql = (container, sql, password = PASSWORD) =>
  docker("exec", "-e", `MYSQL_PWD=${password}`, container, "mysql", "-u", "root", "-N", "-B", "-e", sql);

/** Over TCP: the temporary server of the first boot has no networking, and goes away. */
const mysqlReady = (container, password = PASSWORD) =>
  docker("exec", "-e", `MYSQL_PWD=${password}`, container, "mysql", "-h", "127.0.0.1", "--protocol=tcp", "-u", "root", "-N", "-B", "-e", "SELECT 1") === "1";

const mongo = (container, script) =>
  docker("exec", container, "mongosh", "-u", "runpanel", "-p", PASSWORD, "--authenticationDatabase", "admin", "--quiet", "appdb", "--eval", script);

export async function run({ base, dataDir }) {
  const r = createReporter("db-restore");
  const api = client(base);
  const cleanup = [];
  let port = PORT;

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "db-restore-suite-pw" }),
  });

  const destinations = await api.call("/api/backups/destinations");
  const destinationId = destinations.body?.destinations?.[0]?.id;

  const service = async (body) => {
    const created = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({ port: port++, ...body }),
    });
    r.check(`${body.name} provisioned`, created.status === 201, JSON.stringify(created.body).slice(0, 200));
    if (created.status === 201) {
      cleanup.push(() => api.call(`/api/services/${created.body.id}?deleteData=true`, { method: "DELETE" }));
    }
    return created.body;
  };

  const backup = async (name, target) => {
    const policy = await api.call("/api/backups/policies", {
      method: "POST",
      body: JSON.stringify({
        name,
        cron: "0 3 * * *",
        timezone: "Europe/Rome",
        destinationId,
        targets: [target],
        retentionCount: 5,
      }),
    });
    const started = await api.call(`/api/backups/policies/${policy.body.id}/run`, { method: "POST" });
    const run = await finished(api, `/api/backups/runs/${started.body.runId}`);
    r.check(`${name}: the backup succeeds`, run.status === "success", JSON.stringify(run.errorMessage));
    const artifact = run.artifacts?.find((entry) => entry.refId === target.id && entry.status === "ok");
    r.check(`${name}: the database was captured`, Boolean(artifact), JSON.stringify(run.artifacts));
    return { run, artifact };
  };

  const restore = async ({ run, artifact }, targetId) => {
    const started = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId: run.id,
        // What the archive calls it, wherever it is going.
        confirm: artifact.refName,
        targets: [{ artifactId: artifact.id, action: "restore", ...(targetId ? { targetId } : {}) }],
      }),
    });
    if (started.status !== 202) return { status: `refused ${started.status}`, errorMessage: JSON.stringify(started.body) };
    return finished(api, `/api/backups/restore/${started.body.restoreId}`);
  };

  try {
    // --- Postgres, a whole server --------------------------------------------------
    const pg = await service({
      name: "pgfull",
      type: "postgresql",
      version: "16",
      credentials: { user: "runpanel", password: PASSWORD, database: "primary_db" },
    });
    const pgc = pg.container_name;
    r.check(
      "postgres accepts connections",
      await until(() => docker("exec", pgc, "pg_isready").includes("accepting connections"))
    );
    await sleep(2000);

    await api.call(`/api/services/${pg.id}/databases`, { method: "POST", body: JSON.stringify({ name: "alpha" }) });
    psql(pgc, "primary_db", "CREATE TABLE notes (body text)");
    // Rows that read like the statements the role filter removes.
    psql(pgc, "primary_db", "INSERT INTO notes VALUES ('prima'), ('CREATE ROLE runpanel;'), ('ALTER ROLE runpanel WITH SUPERUSER;')");
    psql(pgc, "alpha", "CREATE TABLE a (x int); INSERT INTO a VALUES (1)");

    const full = await backup("pg completo", { kind: "service", id: pg.id });

    psql(pgc, "primary_db", "DELETE FROM notes; CREATE TABLE extra (x int)");
    psql(pgc, "alpha", "DELETE FROM a");
    r.check("the data is different now", psql(pgc, "primary_db", "SELECT count(*) FROM notes") === "0");

    // A session nobody can stop for us: the script would drop `alpha`, then stop on
    // `primary_db`. The restore has to refuse before the first statement.
    docker("exec", "-d", "-e", `PGPASSWORD=${PASSWORD}`, pgc, "psql", "-U", "runpanel", "-d", "primary_db", "-c", "SELECT pg_sleep(600)");
    r.check(
      "a session is holding a database",
      await until(() => psql(pgc, "postgres", "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep%'") === "1", 20_000)
    );

    const held = await restore(full);
    r.check("an open session stops the restore", held.status === "failed", JSON.stringify(held).slice(0, 240));
    r.check("and the reason says so", /connessioni aperte/.test(held.errorMessage ?? ""), held.errorMessage);
    r.check("no database was dropped", psql(pgc, "postgres", "SELECT count(*) FROM pg_database WHERE datname IN ('alpha','primary_db')") === "2");
    r.check("nothing was touched", psql(pgc, "primary_db", "SELECT count(*) FROM extra") === "0");

    psql(pgc, "postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep%' AND pid <> pg_backend_pid()");
    await sleep(1000);

    const back = await restore(full);
    r.check("with the session gone it succeeds", back.status === "success", JSON.stringify(back.errorMessage));
    r.check("the rows came back", psql(pgc, "primary_db", "SELECT count(*) FROM notes") === "3", psql(pgc, "primary_db", "SELECT count(*) FROM notes"));
    r.check("what came after the backup is gone", psql(pgc, "primary_db", "SELECT to_regclass('extra') IS NULL") === "t");
    r.check("every database came back", psql(pgc, "alpha", "SELECT x FROM a") === "1");
    r.check("the panel's own login still works", psqlTcp(pgc, PASSWORD) === "in");

    // --- Postgres, on another service with its own password ------------------------
    const other = await service({
      name: "pgother",
      type: "postgresql",
      version: "16",
      credentials: { user: "runpanel", password: OTHER_PASSWORD, database: "other_db" },
    });
    r.check(
      "the second postgres accepts connections",
      await until(() => docker("exec", other.container_name, "pg_isready").includes("accepting connections"))
    );
    await sleep(2000);

    const moved = await restore(full, other.id);
    r.check("a dump can land on another service", moved.status === "success", JSON.stringify(moved.errorMessage));
    r.check("the data is there", psql(other.container_name, "primary_db", "SELECT count(*) FROM notes", OTHER_PASSWORD) === "3");
    r.check("its password is still the one the panel holds", psqlTcp(other.container_name, OTHER_PASSWORD) === "in");
    r.check("not the archive's", psqlTcp(other.container_name, PASSWORD) === "");

    // --- Postgres, one database ------------------------------------------------------
    const single = await backup("pg singolo", { kind: "service", id: pg.id, databases: ["primary_db"] });
    psql(pgc, "primary_db", "DELETE FROM notes");

    const one = await restore(single);
    r.check("a single database comes back", one.status === "success", JSON.stringify(one.errorMessage));
    r.check(
      "and rows that read like statements are data",
      psql(pgc, "primary_db", "SELECT count(*) FROM notes WHERE body LIKE '%ROLE runpanel%'") === "2",
      psql(pgc, "primary_db", "SELECT body FROM notes")
    );

    // --- Postgres under a running app --------------------------------------------------
    const project = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Restore App" }) });
    const projectId = project.body.id;
    const slug = project.body.slug;
    cleanup.unshift(() => api.call(`/api/projects/${projectId}`, { method: "DELETE" }));

    const linked = await service({
      name: "pgapp",
      type: "postgresql",
      version: "16",
      projectId,
      credentials: { user: "runpanel", password: PASSWORD, database: "app_db" },
    });
    const linkedc = linked.container_name;
    r.check(
      "the linked postgres accepts connections",
      await until(() => docker("exec", linkedc, "pg_isready").includes("accepting connections"))
    );
    await sleep(2000);
    psql(linkedc, "app_db", "CREATE TABLE t (x int); INSERT INTO t VALUES (1), (2)");

    const repo = join(dataDir, "repos", slug);
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "Dockerfile"),
      // Idle, as an app's pool is: a backend inside pg_sleep outlives its client.
      `FROM postgres:16-alpine
CMD ["sh", "-c", "while true; do sleep 3600 | psql \\"$DATABASE_URL\\"; sleep 1; done"]
`
    );
    await api.call(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({
        runtimeType: "docker",
        sourceType: "upload",
        port: port++,
        builderConfig: { version: 1, healthcheck: { enabled: false } },
      }),
    });
    await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
    const deployed = await waitForDeploy(api, projectId);
    r.check("the app is deployed", deployed === "running", deployed);
    if (deployed !== "running") {
      const history = (await api.call(`/api/projects/${projectId}/logs`)).body ?? [];
      const last = Array.isArray(history) ? history[0] : null;
      if (last) {
        const full = await api.call(`/api/deployments/${last.id}?tail=25`);
        for (const line of String(full.body?.build_log ?? "").trim().split(/\r?\n/)) r.note(line);
      }
    }

    const appSessions = () => psql(linkedc, "postgres", "SELECT count(*) FROM pg_stat_activity WHERE datname = 'app_db'");
    r.check("the app holds a connection", await until(() => appSessions() === "1", 60_000), appSessions());

    const linkedBackup = await backup("pg con app", { kind: "service", id: linked.id });
    psql(linkedc, "app_db", "DELETE FROM t");

    const underApp = await restore(linkedBackup);
    r.check("the restore stops the app it needs out of the way", underApp.status === "success", JSON.stringify(underApp.errorMessage));
    r.check("the data came back", psql(linkedc, "app_db", "SELECT count(*) FROM t") === "2");
    r.check("the app came back up", (await api.call(`/api/projects/${projectId}`)).body?.status === "running");
    r.check("and connected again", await until(() => appSessions() === "1", 60_000), appSessions());

    // --- MySQL ---------------------------------------------------------------------------
    const my = await service({
      name: "myfull",
      type: "mysql",
      version: "8",
      credentials: { user: "runpanel", password: PASSWORD, database: "appdb" },
    });
    const myc = my.container_name;
    r.check("mysql accepts connections", await until(() => mysqlReady(myc), 180_000));

    mysql(myc, "USE appdb; CREATE TABLE t (x int); INSERT INTO t VALUES (1), (2)");
    const myBackup = await backup("mysql completo", { kind: "service", id: my.id });
    mysql(myc, "USE appdb; DELETE FROM t");

    const myBack = await restore(myBackup);
    r.check("a mysql dump comes back", myBack.status === "success", JSON.stringify(myBack.errorMessage));
    r.check("with its rows", mysql(myc, "SELECT count(*) FROM appdb.t") === "2", mysql(myc, "SELECT count(*) FROM appdb.t"));

    const myOther = await service({
      name: "myother",
      type: "mysql",
      version: "8",
      credentials: { user: "runpanel", password: OTHER_PASSWORD, database: "appdb" },
    });
    r.check(
      "the second mysql accepts connections",
      await until(() => mysqlReady(myOther.container_name, OTHER_PASSWORD), 180_000)
    );

    // A full dump carries the users of its server: said out loud, not called success.
    const myMoved = await restore(myBackup, myOther.id);
    r.check("users replaced on another service are reported", myMoved.status === "failed", JSON.stringify(myMoved).slice(0, 240));
    r.check("in words that explain it", /credenziali/.test(myMoved.errorMessage ?? ""), myMoved.errorMessage);

    // --- MongoDB ---------------------------------------------------------------------------
    const mg = await service({
      name: "mgfull",
      type: "mongodb",
      version: "8.0",
      credentials: { user: "runpanel", password: PASSWORD, database: "appdb" },
    });
    const mgc = mg.container_name;
    r.check("mongo accepts connections", await until(() => mongo(mgc, "db.runCommand({ping:1}).ok") === "1", 180_000));
    await sleep(3000);

    mongo(mgc, 'db.items.insertMany([{n:1},{n:2}]).acknowledged');
    const mgBackup = await backup("mongo completo", { kind: "service", id: mg.id });
    mongo(mgc, "db.items.deleteMany({}).deletedCount");
    r.check("the collection is empty now", mongo(mgc, "db.items.countDocuments()") === "0");

    const mgBack = await restore(mgBackup);
    r.check("a mongo dump comes back", mgBack.status === "success", JSON.stringify(mgBack.errorMessage));
    r.check("with its documents", mongo(mgc, "db.items.countDocuments()") === "2", mongo(mgc, "db.items.countDocuments()"));

    // --- the mongo shell, with the password on no command line ------------------------
    const target = { containerName: mgc, credentials: { user: "runpanel", password: PASSWORD, database: "appdb" } };
    const listed = await api.call(`/api/services/${mg.id}/databases`);
    r.check("the panel lists mongo's databases", listed.body?.databases?.some((d) => d.name === "appdb"), JSON.stringify(listed.body));

    const once = mongoShellCall(target, "mongosh", { database: "appdb", script: "db.items.countDocuments()" });
    const evaluated = spawnSync("docker", ["exec", ...Object.keys(once.env).flatMap((k) => ["-e", k]), mgc, ...once.argv], {
      encoding: "utf8",
      env: { ...process.env, ...once.env },
    });
    r.check("a script runs authenticated", evaluated.stdout.trim() === "2", evaluated.stdout + evaluated.stderr);

    const console = mongoShellCall(target, "mongosh", { database: "appdb", shell: true });
    const session = spawn("docker", ["exec", "-i", ...Object.keys(console.env).flatMap((k) => ["-e", k]), mgc, ...console.argv], {
      env: { ...process.env, ...console.env },
    });
    let output = "";
    session.stdout.on("data", (chunk) => (output += chunk));
    session.stderr.on("data", (chunk) => (output += chunk));
    session.stdin.write("db.items.countDocuments()\n");
    await until(() => /\b2\b/.test(output), 20_000);
    const processes = docker("exec", mgc, "sh", "-c", "cat /proc/[0-9]*/cmdline | tr '\\0' ' '");
    session.stdin.end("exit\n");
    await new Promise((resolve) => session.on("close", resolve));
    r.check("a console session answers", /\b2\b/.test(output), output.slice(0, 300));
    r.check("it opens on a prompt, not on noise", !output.includes("ok: 1"), output.slice(0, 300));
    r.check("no process in the container carries the password", processes.length > 0 && !processes.includes(PASSWORD), processes.slice(0, 300));
    r.check("a wrong password is refused", (() => {
      const bad = mongoShellCall({ ...target, credentials: { ...target.credentials, password: "wrong" } }, "mongosh", { script: "1" });
      const res = spawnSync("docker", ["exec", ...Object.keys(bad.env).flatMap((k) => ["-e", k]), mgc, ...bad.argv], {
        encoding: "utf8",
        env: { ...process.env, ...bad.env },
      });
      return res.status !== 0;
    })());
  } finally {
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
  }

  return r.result();
}
