import { createReporter } from "../harness.mjs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTs } from "../ts-modules.mjs";

/**
 * Environments, without a server: the rules a staging copy follows.
 *
 * What is pinned here: who is a member of which family, what a sibling is
 * called, which branch staging is offered, why a project cannot have one or
 * cannot be promoted, which variables a promote should mention, which
 * inherited variable is held back for reading production's database, when
 * production may be deleted — and migration 053, twice over the same store.
 *
 * The server side (create, promote, delete, permissions over HTTP) is the
 * `environments` suite.
 */
export const meta = { name: "environments-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("environments-unit");
  const env = await loadTs(repoRoot, "lib", "environments.ts");

  // --- membership -----------------------------------------------------------------
  r.check("an ordinary project is no environment", env.environmentKindOf({ environment_of: null, environment: null }) === null);
  r.check("a staging row is staging", env.environmentKindOf({ environment_of: "p1", environment: "staging" }) === "staging");
  r.check("a preview row is a preview", env.environmentKindOf({ environment_of: "p1", environment: "preview" }) === "preview");
  r.check(
    "a kind this panel does not know reads as staging, never removed by itself",
    env.environmentKindOf({ environment_of: "p1", environment: "qa" }) === "staging"
  );
  r.check("a kind with no parent is an ordinary project", env.environmentKindOf({ environment_of: null, environment: "staging" }) === null);
  r.check("production is its own production", env.productionIdOf({ id: "p1", environment_of: null, environment: null }) === "p1");
  r.check("an environment's production is its parent", env.productionIdOf({ id: "p2", environment_of: "p1", environment: "staging" }) === "p1");

  // --- who may have one -------------------------------------------------------------
  const github = { source_type: "github", source_url: "https://github.com/acme/shop", environment_of: null };
  r.check("a GitHub project may have environments", env.environmentsBlocker(github) === null);
  r.check("an uploaded one may not: it has no branch", /repository GitHub/.test(env.environmentsBlocker({ ...github, source_type: "upload", source_url: null }) ?? ""));
  r.check("nor one with no repository yet", env.environmentsBlocker({ ...github, source_url: null }) !== null);
  r.check("nor an environment: families are one level deep", /già un ambiente/.test(env.environmentsBlocker({ ...github, environment_of: "p0" }) ?? ""));

  // --- names ------------------------------------------------------------------------
  r.check("staging is named after production", env.stagingName("Negozio") === "Negozio (staging)");
  const long = env.stagingName("x".repeat(120));
  r.check("within the 100 characters a name may have", long.length === 100 && long.endsWith(" (staging)"), String(long.length));
  r.check("the slug follows production's", env.environmentSlug("shop", "staging", new Set(["shop"])) === "shop-staging");
  r.check(
    "and never takes one in use, production's or a sibling's",
    env.environmentSlug("shop", "staging", new Set(["shop", "shop-staging", "shop-staging-2"])) === "shop-staging-3"
  );

  // --- the branch -----------------------------------------------------------------------
  r.check("staging is offered when the repository has it", env.defaultStagingBranch("main", ["main", "develop", "staging"]) === "staging");
  r.check("develop when it has only that", env.defaultStagingBranch("main", ["main", "develop"]) === "develop");
  r.check("staging when it has neither, for the operator to correct", env.defaultStagingBranch("main", ["main"]) === "staging");
  r.check("staging with no list at all", env.defaultStagingBranch("main", null) === "staging");
  r.check("never the branch production follows", env.defaultStagingBranch("staging", ["staging", "develop"]) === "develop");
  r.check("which is refused when typed", /Produzione segue già main/.test(env.stagingBranchProblem("main", "main") ?? ""));
  r.check("another branch is fine", env.stagingBranchProblem("develop", "main") === null);

  // --- promote ----------------------------------------------------------------------------
  const facts = { stagingKind: "staging", productionExists: true, productionSourceType: "github", stagingCommit: "a".repeat(40) };
  r.check("a staging with a working version can be promoted", env.promoteBlocker(facts) === null);
  r.check("not before a deploy has worked there", /versione funzionante/.test(env.promoteBlocker({ ...facts, stagingCommit: null }) ?? ""));
  r.check("not a preview", env.promoteBlocker({ ...facts, stagingKind: "preview" }) !== null);
  r.check("not an ordinary project", env.promoteBlocker({ ...facts, stagingKind: null }) !== null);
  r.check("not when production is gone", /non esiste più/.test(env.promoteBlocker({ ...facts, productionExists: false }) ?? ""));
  r.check("not when production no longer comes from GitHub", env.promoteBlocker({ ...facts, productionSourceType: "upload" }) !== null);

  // --- the variables a promote mentions ------------------------------------------------------
  const diff = env.diffVariables(
    { SAME: "1", ONLY_STAGING: "x", DIFFERENT: "staging", BROKEN: null, A_NEW: "y" },
    { SAME: "1", ONLY_PROD: "z", DIFFERENT: "prod", BROKEN: null }
  );
  r.check(
    "what production lacks first, then what differs, then what only production has",
    JSON.stringify(diff) ===
      JSON.stringify([
        { key: "A_NEW", change: "added" },
        { key: "ONLY_STAGING", change: "added" },
        { key: "BROKEN", change: "changed" },
        { key: "DIFFERENT", change: "changed" },
        { key: "ONLY_PROD", change: "removed" },
      ]),
    JSON.stringify(diff)
  );
  r.check("the same values are not mentioned", !diff.some((d) => d.key === "SAME"));
  r.check("two identical sets differ in nothing", env.diffVariables({ A: "1" }, { A: "1" }).length === 0);

  // --- inherited variables that read production's databases ------------------------------------
  r.check("a reference to production's database is held back", env.readsDatabaseOf([{ kind: "db", project: "shop", service: "main" }], "shop"));
  r.check("one to a database with no project is not", !env.readsDatabaseOf([{ kind: "db", project: null, service: "cache" }], "shop"));
  r.check("nor one to another project's", !env.readsDatabaseOf([{ kind: "db", project: "blog", service: "main" }], "shop"));
  r.check("nor a shared variable", !env.readsDatabaseOf([{ kind: "shared", group: "smtp", key: "HOST" }], "shop"));

  // --- deleting production ------------------------------------------------------------------------
  r.check("without environments production goes as always", env.productionDeleteProblem(0, false) === null);
  r.check("with one it is refused, saying what to do", /eliminalo prima/.test(env.productionDeleteProblem(1, false) ?? ""));
  r.check("with several too", /ha 3 ambienti/.test(env.productionDeleteProblem(3, false) ?? ""));
  r.check("unless they go with it, confirmed", env.productionDeleteProblem(3, true) === null);

  await migration(r, repoRoot);
  return r.result();
}

async function migration(r, repoRoot) {
  const require = createRequire(join(repoRoot, "package.json"));
  let Kysely, SqliteDialect, SQLite;
  try {
    ({ Kysely, SqliteDialect } = require("kysely"));
    SQLite = require("better-sqlite3");
  } catch (err) {
    r.note(`store checks skipped: ${err.message}`);
    return;
  }

  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const dir = join(repoRoot, "lib", "db", "migrations");
  const m001 = await import(pathToFileURL(join(dir, "001-initial.ts")).href);
  const m053 = await import(pathToFileURL(join(dir, "053-environments.ts")).href);

  try {
    await m001.up(db);
    const now = new Date().toISOString();
    const row = (id, slug) => ({
      id, name: slug, slug, source_type: "github", source_branch: "main", runtime_type: "docker",
      builder_config: "{}", status: "stopped", auto_deploy: 0, webhook_secret: "s", created_at: now, updated_at: now,
    });
    // A store with a project already in it: the columns go onto a populated table.
    await db.insertInto("projects").values(row("p1", "shop")).execute();
    await m053.up(db);
    let again = true;
    try {
      await m053.up(db);
    } catch {
      again = false;
    }
    r.check("migration 053 runs twice over the same store", again);

    const before = await db.selectFrom("projects").selectAll().where("id", "=", "p1").executeTakeFirst();
    r.check("an existing project is no environment", before?.environment_of === null && before?.environment === null, JSON.stringify(before));

    await db.insertInto("projects").values({ ...row("p2", "shop-staging"), environment_of: "p1", environment: "staging" }).execute();
    const family = await db.selectFrom("projects").select("id").where("environment_of", "=", "p1").execute();
    r.check("a project's environments are found by their parent", family.map((f) => f.id).join() === "p2");

    // No foreign key, on purpose: the panel removes the environments with their
    // containers before production, and a cascade would leave those behind.
    await db.deleteFrom("projects").where("id", "=", "p1").execute();
    const orphan = await db.selectFrom("projects").select(["id", "environment_of"]).where("id", "=", "p2").executeTakeFirst();
    r.check("the store never deletes an environment by itself", orphan?.id === "p2", JSON.stringify(orphan));
  } finally {
    await db.destroy();
  }
}
