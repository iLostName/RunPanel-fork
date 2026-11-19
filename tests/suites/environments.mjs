import { client, createReporter, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Staging environments over HTTP: created from production in one step,
 * inheriting its variables but never its databases, following its
 * permissions, promoted — and production never modified except by the
 * promote.
 *
 * Deploys are real and fail fast, as in `deploy-commit`: the repository does
 * not exist, so a deploy records the commit it was asked for and stops at the
 * clone. Staging's "working version" is a deployment row written straight
 * into the store, the way `shared-vars` gives a project a deploy to restart.
 *
 * Not exercised without Docker and nginx: a container actually running,
 * staging's address being served, the deploy on production building the
 * promoted commit, and the switch without downtime.
 */
export const meta = { name: "environments", needsDocker: false, drivers: ["sqlite", "postgres"] };

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const REPO = "https://github.com/runpanel-test/does-not-exist";
const LIVE = "b".repeat(40);

/** The panel's own sealing, for a row written straight into the store. */
function seal(secretHex, text) {
  const key = Buffer.from(secretHex, "hex").subarray(0, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** A statement on the server's store, whichever driver it runs: `?` placeholders. */
async function storeHandle(dataDir) {
  const require = createRequire(import.meta.url);
  const file = join(dataDir, "runpanel.db");
  if (existsSync(file)) {
    const db = new (require("better-sqlite3"))(file);
    return { run: async (sql, params = []) => db.prepare(sql).run(...params), close: async () => db.close() };
  }
  const url = process.env.RUNPANEL_TEST_PG_URL;
  if (!url) return null;
  const { Client } = require("pg");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  return {
    run: async (sql, params = []) => {
      let n = 0;
      return pg.query(sql.replace(/\?/g, () => `$${++n}`), params);
    },
    close: async () => pg.end(),
  };
}

async function invite(owner, base, email, password) {
  const res = await owner.call("/api/users", json("POST", { email, hours: 1 }));
  const id = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const account = client(base);
  await account.call("/api/auth/invite", json("POST", { token, password }));
  await account.call("/api/auth/login", json("POST", { email, password }));
  return { id, account };
}

/** What a promote, and only a promote, may change on production. */
function productionFacts(row) {
  return JSON.stringify({
    name: row.name,
    branch: row.source_branch,
    url: row.source_url,
    runtime: row.runtime_type,
    port: row.port,
    pinned: row.pinned_sha,
    auto: row.auto_deploy,
    config: row.builder_config,
    deploys: row.deploy_count,
  });
}

export async function run({ base, dataDir }) {
  const r = createReporter("environments");
  const owner = client(base);
  await owner.call("/api/auth/login", json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "environments-suite-pw" }));
  const store = await storeHandle(dataDir);
  if (!store) r.note("no handle on the store: the checks that write into it are skipped");

  // --- production ---------------------------------------------------------------------
  let res = await owner.call("/api/projects", json("POST", { name: "Shop" }));
  const prod = res.body;
  res = await owner.call(
    `/api/projects/${prod.id}`,
    json("PATCH", { sourceType: "github", sourceUrl: REPO, sourceBranch: "main", runtimeType: "docker", port: 3000 })
  );
  r.check("production is set up from GitHub", res.status === 200, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);

  // A database linked to production, which staging must not inherit.
  let hasDatabase = false;
  if (store) {
    const secret = readFileSync(join(dataDir, ".secret"), "utf8").trim();
    const now = new Date().toISOString();
    try {
      await store.run(
        "INSERT INTO services (id, name, type, version, status, port, credentials, config, project_id, inject_env, created_at, updated_at, container_name) VALUES (?, 'main', 'postgresql', '16', 'running', 55432, ?, '{}', ?, 1, ?, ?, 'runpanel-svc-main-envsuite')",
        ["svc-main-envsuite", seal(secret, JSON.stringify({ user: "shop", password: "prod-secret", database: "shop" })), prod.id, now, now]
      );
      hasDatabase = true;
    } catch (err) {
      r.check("a database row can be written for production", false, String(err));
    }
  }
  const prodVars = [
    { key: "API_URL", value: "https://api.prod" },
    { key: "SHARED", value: "prod" },
    ...(hasDatabase ? [{ key: "DB_FROM_REF", value: "${{ db.shop.main.url }}" }] : []),
  ];
  res = await owner.call(`/api/projects/${prod.id}/env`, json("PUT", { vars: prodVars }));
  r.check("production has its variables", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  const prodBefore = (await owner.call(`/api/projects/${prod.id}`)).body;
  const prodEnvBefore = JSON.stringify((await owner.call(`/api/projects/${prod.id}/env`)).body);

  res = await owner.call(`/api/projects/${prod.id}/environments`);
  r.check("a project without environments has no family", res.status === 200 && res.body.kind === "production" && res.body.family === null, JSON.stringify(res.body));

  // --- creating staging ---------------------------------------------------------------
  res = await owner.call(`/api/projects/${prod.id}/environments?offer=staging`);
  const offer = res.body?.offer;
  r.check("the offer proposes staging, not production's branch", offer?.branch === "staging" && offer?.blocker === null, JSON.stringify(offer));
  if (hasDatabase) {
    r.check("and lists production's database, for an explicit choice", offer?.databases?.some((db) => db.name === "main" && db.envKey === "DATABASE_URL"), JSON.stringify(offer?.databases));
  }
  r.check("with no address to propose here, it says why", offer?.address === null && typeof offer?.addressNote === "string", JSON.stringify(offer));

  res = await owner.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "main" }));
  r.check("staging on production's branch is refused", res.status === 400 && /Produzione segue già main/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "-x" }));
  r.check("a branch git would read as an option is refused", res.status === 400, String(res.status));

  res = await owner.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "develop" }));
  const staging = res.body;
  r.check("staging is created in one step", res.status === 201 && staging?.id, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  r.check("as an environment of production", staging?.environment_of === prod.id && staging?.environment === "staging", JSON.stringify(staging));
  r.check("on its own branch, from the same source", staging?.source_branch === "develop" && staging?.source_url === REPO && staging?.runtime_type === "docker");
  r.check("with its own slug and port", staging?.slug === "shop-staging" && staging?.port !== 3000 && staging?.port > 0, `${staging?.slug} :${staging?.port}`);
  r.check("and its own webhook secret", staging?.webhook_secret && staging.webhook_secret !== prodBefore.webhook_secret);

  res = await owner.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "qa" }));
  r.check("a second staging is refused", res.status === 409 && res.body?.code === "staging_exists", `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${staging.id}/environments`, json("POST", { kind: "staging", branch: "qa" }));
  r.check("an environment cannot have environments", res.status === 409 && res.body?.code === "not_eligible", `${res.status} ${JSON.stringify(res.body)}`);

  for (const id of [prod.id, staging.id]) {
    res = await owner.call(`/api/projects/${id}/environments`);
    r.check(
      `the family is the same seen from ${id === prod.id ? "production" : "staging"}`,
      res.body?.family?.production?.id === prod.id && res.body?.family?.staging?.id === staging.id,
      JSON.stringify(res.body)
    );
  }

  res = await owner.call(`/api/projects/${staging.id}`, json("PATCH", { sourceBranch: "main" }));
  r.check("staging cannot be moved onto production's branch later either", res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);

  // --- variables: inherited, overridden, never production's database ----------------------
  res = await owner.call(`/api/projects/${staging.id}/env`, json("PUT", { vars: [{ key: "API_URL", value: "https://api.staging" }, { key: "ONLY_STAGING", value: "1" }] }));
  r.check("staging has variables of its own", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${staging.id}/env/effective?reveal=true`);
  const eff = (key) => res.body?.vars?.find((v) => v.key === key);
  r.check("staging's own value wins over production's", eff("API_URL")?.source?.kind === "own" && eff("API_URL")?.value === "https://api.staging", JSON.stringify(eff("API_URL")));
  r.check("what it does not set comes from production", eff("SHARED")?.source?.kind === "inherited" && eff("SHARED")?.value === "prod", JSON.stringify(eff("SHARED")));
  r.check("the inheritance is named", res.body?.inherits?.[0]?.id === prod.id, JSON.stringify(res.body?.inherits));
  if (hasDatabase) {
    r.check("a variable reading production's database is not handed down", !eff("DB_FROM_REF") && res.body?.withheld?.some((v) => v.key === "DB_FROM_REF"), JSON.stringify(res.body?.withheld));
    r.check("nor is production's database link", !eff("DATABASE_URL"), JSON.stringify(eff("DATABASE_URL")));
  }
  r.check("nothing stops staging's deploy", res.body?.problems === 0, JSON.stringify(res.body?.problems));

  // --- staging's actions never reach production ----------------------------------------------
  res = await owner.call(`/api/projects/${staging.id}/deploy`, json("POST", {}));
  r.check("staging deploys", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  await waitForDeploy(owner, staging.id, 120_000);
  res = await owner.call(`/api/projects/${staging.id}/control`, json("POST", { action: "stop" }));
  const prodAfterStaging = (await owner.call(`/api/projects/${prod.id}`)).body;
  r.check("production is exactly as it was", productionFacts(prodAfterStaging) === productionFacts(prodBefore), `${productionFacts(prodBefore)} -> ${productionFacts(prodAfterStaging)}`);
  r.check("with the same variables", JSON.stringify((await owner.call(`/api/projects/${prod.id}/env`)).body) === prodEnvBefore);

  // --- promote ------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${staging.id}/promote`);
  r.check("nothing to promote before a deploy worked on staging", res.status === 200 && /versione funzionante/.test(res.body?.blocker ?? ""), JSON.stringify(res.body));
  res = await owner.call(`/api/projects/${staging.id}/promote`, json("POST", { commitSha: LIVE }));
  r.check("and the promote is refused", res.status === 409 && res.body?.code === "not_promotable", `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/promote`);
  r.check("production is not promoted onto itself", /solo un ambiente di staging/.test(res.body?.blocker ?? ""), JSON.stringify(res.body));

  if (store) {
    await store.run(
      "INSERT INTO deployments (id, project_id, trigger_type, commit_sha, commit_message, status, started_at, finished_at) VALUES (?, ?, 'manual', ?, 'Checkout in one page', 'running', ?, ?)",
      ["fake-live-staging", staging.id, LIVE, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString()]
    );
    res = await owner.call(`/api/projects/${staging.id}/promote`);
    const preview = res.body;
    r.check("the confirmation names the commit staging runs", preview?.commit?.sha === LIVE && preview?.commit?.message === "Checkout in one page" && preview?.blocker === null, JSON.stringify(preview));
    r.check("and production as it will take it", preview?.production?.id === prod.id && preview?.production?.branch === "main" && preview?.production?.pinnedSha === null, JSON.stringify(preview?.production));
    const change = (key) => preview?.variables?.find((v) => v.key === key)?.change;
    r.check("a variable production lacks is said first", preview?.variables?.[0]?.key === "ONLY_STAGING" && change("ONLY_STAGING") === "added", JSON.stringify(preview?.variables));
    r.check("one with another value is said", change("API_URL") === "changed");
    r.check("a shared value is not mentioned", change("SHARED") === undefined);
    r.check("no value travels in the confirmation", !JSON.stringify(preview).includes("api.staging") && !JSON.stringify(preview).includes("prod-secret"));

    res = await owner.call(`/api/projects/${staging.id}/promote`, json("POST", { commitSha: "c".repeat(40) }));
    r.check("a commit staging no longer runs is refused", res.status === 409 && res.body?.code === "staging_moved", `${res.status} ${JSON.stringify(res.body)}`);
    r.check("and production is still untouched", productionFacts((await owner.call(`/api/projects/${prod.id}`)).body) === productionFacts(prodBefore));

    res = await owner.call(`/api/projects/${staging.id}/promote`, json("POST", { commitSha: LIVE }));
    r.check("the confirmed commit is promoted", res.status === 202 && res.body?.productionId === prod.id && res.body?.commitSha === LIVE, `${res.status} ${JSON.stringify(res.body)}`);
    await sleep(1_500);
    const promoted = (await owner.call(`/api/projects/${prod.id}`)).body;
    r.check("production is held at exactly that commit", promoted.pinned_sha === LIVE, String(promoted.pinned_sha));
    await waitForDeploy(owner, prod.id, 120_000);
    const history = (await owner.call(`/api/projects/${prod.id}/logs`)).body;
    r.check("and a deploy of it ran on production", Array.isArray(history) && history.length === 1 && history[0].commit_sha === LIVE, JSON.stringify(history));
    r.check("on its own branch and settings", promoted.source_branch === "main" && promoted.builder_config === prodBefore.builder_config);
    const log = (await owner.call(`/api/audit?action=project.promote&scope=project&scopeId=${prod.id}`)).body;
    r.check("the promote is in the activity log, on production", log?.entries?.length === 1 && /bbbbbbb/.test(log.entries[0].detail ?? ""), JSON.stringify(log));
    await owner.call(`/api/projects/${prod.id}/pin`, json("POST", { action: "release" }));
  }

  // --- permissions follow production's --------------------------------------------------------
  const dev = await invite(owner, base, "dev@runpanel.test", "dev-password-1");
  await owner.call(`/api/users/${dev.id}`, json("PATCH", { access: { permissions: ["projects.create"], grants: [{ scope: "project", scopeId: prod.id, level: "read", terminal: false }] } }));
  res = await dev.account.call(`/api/projects/${staging.id}`);
  r.check("a grant on production shows its staging", res.status === 200 && res.body?.permission?.level === "read", `${res.status} ${JSON.stringify(res.body?.permission)}`);
  res = await dev.account.call(`/api/projects/${staging.id}/promote`, json("POST", { commitSha: LIVE }));
  r.check("reading production does not promote", res.status === 403, String(res.status));
  res = await dev.account.call(`/api/projects/${staging.id}/deploy`, json("POST", {}));
  r.check("nor deploy staging", res.status === 403, String(res.status));
  res = await dev.account.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "qa" }));
  r.check("nor create an environment", res.status === 403, String(res.status));

  await owner.call(`/api/users/${dev.id}`, json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: staging.id, level: "manage", terminal: false }] } }));
  res = await dev.account.call(`/api/projects/${staging.id}`);
  r.check("a grant left on staging itself shows nothing", res.status === 404, String(res.status));
  res = await dev.account.call("/api/projects");
  r.check("and lists nothing", Array.isArray(res.body) && res.body.length === 0, JSON.stringify(res.body?.map?.((p) => p.name)));

  // --- deleting ---------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${prod.id}`, { method: "DELETE" });
  r.check("production does not go without its environments", res.status === 409 && res.body?.code === "has_environments" && res.body?.environments?.[0]?.id === staging.id, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("and is still there", (await owner.call(`/api/projects/${prod.id}`)).status === 200);
  res = await owner.call(`/api/projects/${prod.id}?environments=keep`, { method: "DELETE" });
  r.check("there is no other way of asking", res.status === 400, String(res.status));

  const prodBeforeDelete = (await owner.call(`/api/projects/${prod.id}`)).body;
  res = await owner.call(`/api/projects/${staging.id}`, { method: "DELETE" });
  r.check("staging is deleted", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("and production is exactly as it was", productionFacts((await owner.call(`/api/projects/${prod.id}`)).body) === productionFacts(prodBeforeDelete));
  r.check("with its variables", JSON.stringify((await owner.call(`/api/projects/${prod.id}/env`)).body) === prodEnvBefore);
  if (hasDatabase) {
    const services = (await owner.call("/api/services")).body;
    r.check("and its database", Array.isArray(services) && services.some((s) => s.id === "svc-main-envsuite" && s.project_id === prod.id), JSON.stringify(services?.map?.((s) => [s.id, s.project_id])));
  }
  res = await owner.call(`/api/projects/${prod.id}/environments`);
  r.check("production has no family again", res.body?.family === null, JSON.stringify(res.body));

  res = await owner.call(`/api/projects/${prod.id}/environments`, json("POST", { kind: "staging", branch: "develop", databaseIds: hasDatabase ? ["svc-main-envsuite"] : [] }));
  const second = res.body;
  r.check("a staging can be made again", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  if (hasDatabase) {
    res = await owner.call(`/api/projects/${second.id}/env/effective?reveal=true`);
    const picked = res.body?.vars?.find((v) => v.key === "DATABASE_URL");
    r.check(
      "production's database, chosen explicitly, is a reference in staging's own variables",
      picked?.source?.kind === "own" && picked?.refs?.[0] === "${{ db.shop.main.url }}",
      JSON.stringify(picked)
    );
  }
  res = await owner.call(`/api/projects/${prod.id}?environments=delete`, { method: "DELETE" });
  r.check("production goes with its environments when that is confirmed", res.status === 200 && res.body?.environmentsDeleted === 1, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("both are gone", (await owner.call(`/api/projects/${prod.id}`)).status === 404 && (await owner.call(`/api/projects/${second.id}`)).status === 404);

  const created = (await owner.call("/api/audit?action=project.environment.create")).body;
  r.check("every staging created is in the activity log", created?.entries?.length === 2, JSON.stringify(created?.entries?.map?.((e) => e.detail)));
  const deleted = (await owner.call("/api/audit?action=project.delete")).body;
  r.check("and every one deleted", deleted?.entries?.filter((e) => e.scopeId === staging.id || e.scopeId === second.id).length === 2, JSON.stringify(deleted?.entries?.map?.((e) => [e.scopeId, e.detail])));

  await store?.close();
  return r.result();
}
