import { createReporter } from "../harness.mjs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTs } from "../ts-modules.mjs";

/**
 * Previews of pull requests, without a server: the settings, what a pull
 * request delivery says, what each event does — the fork gate above all —
 * the names and addresses, the ceiling, the idle sweep and what the poller
 * reads as opened or closed. And migration 054, twice over the same store.
 *
 * The routes, the webhook payloads and the cleanup are the `previews` suite.
 */
export const meta = { name: "previews-unit", needsDocker: false, drivers: [], standalone: true };

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function payload(overrides = {}) {
  return {
    number: 7,
    state: "open",
    title: "Checkout in one page",
    html_url: "https://github.com/acme/shop/pull/7",
    user: { login: "ada" },
    merged: false,
    head: { sha: SHA1, ref: "feature/checkout", repo: { full_name: "acme/shop" } },
    base: { ref: "main", repo: { full_name: "acme/shop" } },
    ...overrides,
  };
}

export async function run({ repoRoot }) {
  const r = createReporter("previews-unit");
  const p = await loadTs(repoRoot, "lib", "previews.ts");

  // --- settings ---------------------------------------------------------------------
  const defaults = p.parsePreviewSettings(null);
  r.check("off by default, three at most, a week idle", defaults.enabled === false && defaults.maxPreviews === 3 && defaults.idleDays === 7 && defaults.domainId === null && defaults.commitStatus === false, JSON.stringify(defaults));
  r.check("garbage reads as the defaults", JSON.stringify(p.parsePreviewSettings("{nope")) === JSON.stringify(defaults));
  const odd = p.parsePreviewSettings(JSON.stringify({ enabled: "yes", maxPreviews: 99, idleDays: 0, domainId: 5 }));
  r.check("anything out of range falls back, nothing is guessed", odd.enabled === false && odd.maxPreviews === 3 && odd.idleDays === 7 && odd.domainId === null, JSON.stringify(odd));
  const set = p.parsePreviewSettings(JSON.stringify({ enabled: true, maxPreviews: 5, idleDays: 14, domainId: "d1", commitStatus: true }));
  r.check("what was saved is read back", set.enabled && set.maxPreviews === 5 && set.idleDays === 14 && set.domainId === "d1" && set.commitStatus, JSON.stringify(set));

  // --- a pull request ---------------------------------------------------------------
  const pr = p.parsePullRequest(payload());
  r.check("a pull request is read", pr?.number === 7 && pr?.headSha === SHA1 && pr?.headRef === "feature/checkout" && pr?.baseRef === "main" && pr?.author === "ada", JSON.stringify(pr));
  r.check("one from the same repository is not a fork", pr?.fork === false);
  r.check("one from another repository is", p.parsePullRequest(payload({ head: { sha: SHA1, ref: "x", repo: { full_name: "mallory/shop" } } }))?.fork === true);
  r.check("and so is one whose fork was deleted", p.parsePullRequest(payload({ head: { sha: SHA1, ref: "x", repo: null } }))?.fork === true);
  r.check("the case of a name does not make a fork", p.parsePullRequest(payload({ head: { sha: SHA1, ref: "x", repo: { full_name: "ACME/Shop" } } }))?.fork === false);
  r.check("a head that is not a full commit is not acted on", p.parsePullRequest(payload({ head: { sha: "abc123", ref: "x", repo: { full_name: "acme/shop" } } })) === null);
  r.check("nor a branch git would read as an option", p.parsePullRequest(payload({ head: { sha: SHA1, ref: "-x", repo: { full_name: "acme/shop" } } })) === null);
  r.check("nor one walking out of a path", p.parsePullRequest(payload({ base: { ref: "a/../b", repo: { full_name: "acme/shop" } } })) === null);
  r.check("nor something that is not a pull request", p.parsePullRequest({ number: "7" }) === null && p.parsePullRequest(null) === null);

  // --- what an event does ------------------------------------------------------------
  const decide = (action, prOver = {}, known = null, enabled = true) =>
    p.decidePreview({ settings: { enabled }, productionBranch: "main", action, pr: { ...pr, ...prOver }, known });
  r.check("opened deploys the head", JSON.stringify(decide("opened")) === JSON.stringify({ kind: "deploy", sha: SHA1 }));
  r.check("a new push deploys the new head", decide("synchronize", { headSha: SHA2 }, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "deploy");
  r.check("the same delivery twice deploys once", decide("synchronize", {}, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "ignore");
  r.check("closed removes the preview", decide("closed", { state: "closed" }, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "remove");
  r.check("merged removes it too", decide("closed", { state: "closed", merged: true }, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "remove");
  r.check("closed with nothing known does nothing", decide("closed", { state: "closed" }).kind === "ignore");
  r.check("off, nothing is created", decide("opened", {}, null, false).kind === "ignore");
  r.check("off, what is left is removed", decide("synchronize", {}, { headSha: SHA1, approvedSha: null, hasProject: true }, false).kind === "remove");
  r.check("a pull request against another branch is not production's", decide("opened", { baseRef: "develop" }).kind === "ignore");
  r.check("one retargeted away loses its preview", decide("edited", { baseRef: "develop" }, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "remove");
  r.check("a new title only updates the record", decide("edited", {}, { headSha: SHA1, approvedSha: null, hasProject: true }).kind === "update");
  r.check("labels and reviews are not handled", decide("labeled").kind === "ignore" && decide("review_requested").kind === "ignore");

  // --- the fork gate -------------------------------------------------------------------
  const fork = { fork: true, headRepo: "mallory/shop" };
  r.check("a fork is never deployed by itself", decide("opened", fork).kind === "wait");
  r.check("its approved commit is", decide("opened", fork, { headSha: SHA1, approvedSha: SHA1, hasProject: false }).kind === "deploy");
  r.check(
    "a new push to it waits again, approval is per commit",
    decide("synchronize", { ...fork, headSha: SHA2 }, { headSha: SHA1, approvedSha: SHA1, hasProject: true }).kind === "wait"
  );
  r.check("reopening it does not skip the gate", decide("reopened", fork, { headSha: SHA1, approvedSha: null, hasProject: false }).kind === "wait");

  // --- names and addresses -----------------------------------------------------------------
  r.check("the slug carries the number", p.previewSlugSuffix(12) === "pr-12");
  r.check("the name says which pull request", p.previewName("Negozio", 12) === "Negozio · PR #12");
  r.check("within 100 characters", p.previewName("x".repeat(120), 12).length === 100);
  r.check("under the operator's domain the address is pr-<n>", p.previewLabel(12) === "pr-12");
  r.check("an instant one carries the project, sharing its domain with the others", p.previewLabel(12, "negozio") === "pr-12-negozio");
  const longLabel = p.previewLabel(12, "a".repeat(80));
  r.check("in one DNS label", longLabel.length <= 63 && !longLabel.endsWith("-"), longLabel);

  // --- the ceiling and the idle sweep ------------------------------------------------------
  const running = [
    { id: "b", lastActivityAt: "2026-11-10T10:00:00.000Z" },
    { id: "a", lastActivityAt: "2026-11-01T10:00:00.000Z" },
    { id: "c", lastActivityAt: "2026-11-15T10:00:00.000Z" },
  ];
  r.check("under the ceiling nothing stops", p.previewsToStop(running.slice(0, 2), 3).length === 0);
  r.check("at it, the one idle the longest makes room", JSON.stringify(p.previewsToStop(running, 3)) === JSON.stringify(["a"]));
  r.check("a lowered ceiling stops as many as it takes", JSON.stringify(p.previewsToStop(running, 1)) === JSON.stringify(["a", "b", "c"]));
  const now = new Date("2026-11-19T10:00:00.000Z");
  r.check("idle past the days set is stopped", p.idlePreviews(running, now, 7).sort().join() === "a,b", JSON.stringify(p.idlePreviews(running, now, 7)));
  r.check("and nothing within them", p.idlePreviews(running, now, 30).length === 0);

  // --- the poller ----------------------------------------------------------------------------
  const pr8 = { ...pr, number: 8, headSha: SHA2 };
  const changes = p.pollChanges([{ prNumber: 7, headSha: SHA1 }, { prNumber: 9, headSha: SHA1 }], [pr, pr8]);
  r.check("a pull request seen for the first time is new", changes.changed.map((c) => c.number).join() === "8", JSON.stringify(changes));
  r.check("one gone from the open list is closed", changes.closed.join() === "9");
  r.check("one with the same head is left alone", !changes.changed.some((c) => c.number === 7));
  r.check("a new head is a change", p.pollChanges([{ prNumber: 7, headSha: SHA2 }], [pr]).changed.length === 1);

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
  const m054 = await import(pathToFileURL(join(dir, "054-previews.ts")).href);
  try {
    await m001.up(db);
    await m053.up(db);
    await m054.up(db);
    let again = true;
    try {
      await m054.up(db);
    } catch {
      again = false;
    }
    r.check("migration 054 runs twice over the same store", again);

    const now = new Date().toISOString();
    await db
      .insertInto("projects")
      .values({ id: "p1", name: "Shop", slug: "shop", source_type: "github", source_branch: "main", runtime_type: "docker", builder_config: "{}", status: "stopped", auto_deploy: 0, webhook_secret: "s", created_at: now, updated_at: now })
      .execute();
    const row = (id, n) => ({
      id, production_id: "p1", pr_number: n, title: "t", author: "a", url: "u", head_ref: "f", head_sha: SHA1, state: "waiting", last_activity_at: now, created_at: now, updated_at: now,
    });
    await db.insertInto("project_previews").values(row("r1", 7)).execute();
    let refused = false;
    try {
      await db.insertInto("project_previews").values(row("r2", 7)).execute();
    } catch {
      refused = true;
    }
    r.check("a pull request is known once per project", refused);
    const stored = await db.selectFrom("project_previews").selectAll().where("id", "=", "r1").executeTakeFirst();
    r.check("a fork flag defaults to no", stored?.fork === 0 && stored?.project_id === null, JSON.stringify(stored));
    await db.deleteFrom("projects").where("id", "=", "p1").execute();
    r.check("the records go with production", (await db.selectFrom("project_previews").select("id").execute()).length === 0);
  } finally {
    await db.destroy();
  }
}
