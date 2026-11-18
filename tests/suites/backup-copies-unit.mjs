import { createReporter } from "../harness.mjs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Several copies of every backup: the rules, and the migration that gives
 * every existing policy and run its first copy.
 *
 * The rules are pure (lib/backup-copies.ts), so they are checked here on
 * their own: which lists a policy may hold, the order a restore reads copies
 * in, and retention — which must count each destination by its own rule and
 * never take the newest copy anywhere. The migration runs on in-memory SQLite
 * over a store as it was before it, with a run whose destination was deleted,
 * and twice, since every migration here must be safe to run again.
 */
export const meta = { name: "backup-copies-unit", needsDocker: false, drivers: [], standalone: true };

const DAY = 86_400_000;

export async function run({ repoRoot }) {
  const r = createReporter("backup-copies-unit");
  const copies = await import(pathToFileURL(join(repoRoot, "lib", "backup-copies.ts")).href);
  const {
    MAX_COPIES,
    destinationListProblem,
    withPrimary,
    ruleFor,
    readOrder,
    primaryCopy,
    countCopies,
    copiesLabel,
    runOutcome,
    retryProblem,
    prunableCopies,
  } = copies;

  // --- which lists a policy may hold --------------------------------------------
  {
    const known = new Map([
      ["disk", { name: "Disco locale", location: "local:/data/backups/archives" }],
      ["usb", { name: "Disco USB", location: "local:/mnt/usb" }],
      ["usb2", { name: "Disco USB bis", location: "local:/mnt/usb" }],
      ["b2", { name: "Backblaze", location: "s3:s3.eu-central-003.backblazeb2.com/archivi/" }],
      ["tg", { name: "Telegram", location: null }],
      ["tg2", { name: "Telegram bis", location: null }],
    ]);
    r.check("a list of one is fine", destinationListProblem(["disk"], known) === null);
    r.check("three in three places are fine", destinationListProblem(["disk", "usb", "b2"], known) === null);
    r.check("an empty list is refused", /almeno una/.test(destinationListProblem([], known)?.error ?? ""));
    r.check(
      "so is one longer than the limit",
      Boolean(destinationListProblem(Array.from({ length: MAX_COPIES + 1 }, (_, i) => `d${i}`), known))
    );
    const unknown = destinationListProblem(["disk", "nope"], known);
    r.check("an unknown destination says so, as a not-found", unknown?.notFound === true, JSON.stringify(unknown));
    const twice = destinationListProblem(["disk", "b2", "disk"], known);
    r.check("the same destination twice is refused", /due volte/.test(twice?.error ?? "") && !twice?.notFound, JSON.stringify(twice));
    const samePlace = destinationListProblem(["disk", "usb", "usb2"], known);
    r.check(
      "two destinations writing to the same folder are refused, by name",
      /«Disco USB» e «Disco USB bis»/.test(samePlace?.error ?? ""),
      JSON.stringify(samePlace)
    );
    r.check("a type that cannot say where it writes is trusted", destinationListProblem(["tg", "tg2", "disk"], known) === null);
  }

  // --- a client that only knows one destination -----------------------------------
  {
    const list = [
      { destinationId: "disk", retention: null },
      { destinationId: "b2", retention: { count: 30, days: null, bytes: null } },
    ];
    r.check("the primary already: nothing moves", JSON.stringify(withPrimary(list, "disk")) === JSON.stringify(list));
    const front = withPrimary(list, "b2");
    r.check(
      "a listed copy moves to the front, keeping its rule and the old primary",
      front.map((e) => e.destinationId).join() === "b2,disk" && front[0].retention?.count === 30,
      JSON.stringify(front)
    );
    const replaced = withPrimary(list, "usb");
    r.check(
      "a new one takes the primary's place, and the other copies stay",
      replaced.map((e) => e.destinationId).join() === "usb,b2" && replaced[0].retention === null,
      JSON.stringify(replaced)
    );
    const policyRule = { count: 7, days: null, bytes: null };
    r.check("a copy without its own rule follows the policy's", ruleFor("disk", list, policyRule).count === 7);
    r.check("a copy with one follows its own", ruleFor("b2", list, policyRule).count === 30);
    r.check("a destination no longer listed follows the policy's", ruleFor("usb", list, policyRule).count === 7);
    r.check("so do copies whose destination was deleted", ruleFor(null, list, policyRule).count === 7);
  }

  // --- the order copies are read in -------------------------------------------------
  {
    const c = (id, position, status, local, configured = true) => ({ id, position, status, local, configured });
    const order = readOrder([
      c("bucket", 0, "done", false),
      c("usb", 2, "done", true),
      c("disk", 1, "done", true),
      c("failed", 3, "failed", true),
      c("gone", 4, "done", true, false),
      c("sending", 5, "uploading", true),
    ]);
    r.check(
      "copies on this disk first, then the policy's order; only those that hold the archive",
      order.map((x) => x.id).join() === "disk,usb,bucket",
      order.map((x) => x.id).join()
    );
    r.check("nothing to read when no copy holds it", readOrder([c("a", 0, "failed", true)]).length === 0);

    const primary = primaryCopy([c("gone", 0, "done", true, false), c("b", 1, "failed", false), c("c", 2, "done", false)]);
    r.check("a run's own archive columns follow the first copy that holds it and is reachable", primary?.id === "c", primary?.id);
    r.check("one on a deleted destination only when there is nothing else", primaryCopy([c("gone", 0, "done", true, false)])?.id === "gone");
    r.check("and none when nothing holds it", primaryCopy([c("b", 0, "failed", false)]) === null);
  }

  // --- how a run's copies add up ----------------------------------------------------------
  {
    const count = countCopies([{ status: "done" }, { status: "failed" }, { status: "uploading" }, { status: "done" }]);
    r.check("copies are counted by state", count.total === 4 && count.done === 2 && count.failed === 1 && count.inFlight === 1, JSON.stringify(count));
    r.check("a copy that did not arrive does not fail the backup", runOutcome(0, { total: 3, done: 2, failed: 1, inFlight: 0 }) === "success");
    r.check("failed items still make it partial", runOutcome(2, { total: 2, done: 1, failed: 1, inFlight: 0 }) === "partial");
    r.check("no copy at all is a failed backup", runOutcome(0, { total: 2, done: 0, failed: 2, inFlight: 0 }) === "failed");
    r.check("the list says one copy", copiesLabel({ total: 1, done: 1, failed: 0, inFlight: 0 }) === "1 copia");
    r.check("and all of several", copiesLabel({ total: 3, done: 3, failed: 0, inFlight: 0 }) === "3 copie");
    r.check("and how many of how many when some are missing", copiesLabel({ total: 3, done: 2, failed: 1, inFlight: 0 }) === "2 copie su 3");
  }

  // --- when a copy can be sent again ----------------------------------------------------------
  {
    const failed = { status: "failed", configured: true };
    const source = [{ status: "done", position: 0, configured: true, local: true }];
    r.check("a failed copy with another to start from can be retried", retryProblem(failed, source, "success") === null);
    r.check("not while the backup runs", Boolean(retryProblem(failed, source, "running")));
    r.check("not one that arrived", Boolean(retryProblem({ status: "done", configured: true }, source, "success")));
    r.check("not one on its way", Boolean(retryProblem({ status: "uploading", configured: true }, source, "success")));
    r.check("not one whose destination is gone", Boolean(retryProblem({ status: "failed", configured: false }, source, "success")));
    r.check(
      "not without a copy to start from",
      /nessuna copia/.test(retryProblem(failed, [{ status: "failed", position: 0, configured: true, local: true }], "partial") ?? "")
    );
  }

  // --- retention, one destination at a time -----------------------------------------------------
  {
    const now = Date.parse("2026-11-18T03:00:00.000Z");
    const ago = (days) => new Date(now - days * DAY).toISOString();
    // Five nightly runs, each with a copy on the disk and one in a bucket.
    const held = [];
    for (let day = 0; day < 5; day++) {
      held.push({ id: `disk-${day}`, destinationId: "disk", bytes: 100, startedAt: ago(day) });
      held.push({ id: `b2-${day}`, destinationId: "b2", bytes: 100, startedAt: ago(day) });
    }
    const rules = { disk: { count: 2, days: null, bytes: null }, b2: { count: null, days: null, bytes: null } };
    const doomed = prunableCopies(held, (id) => rules[id], now).sort();
    r.check(
      "each destination keeps by its own rule: two on the disk, every one in the bucket",
      doomed.join() === "disk-2,disk-3,disk-4",
      doomed.join()
    );

    const byDays = prunableCopies(held, () => ({ count: null, days: 2, bytes: null }), now).sort();
    r.check("an age limit counts from each run's start", byDays.join() === "b2-3,b2-4,disk-3,disk-4", byDays.join());

    const byBytes = prunableCopies(held, (id) => (id === "b2" ? { count: null, days: null, bytes: 250 } : { count: null, days: null, bytes: null }), now).sort();
    r.check("a size limit adds up one destination's copies alone", byBytes.join() === "b2-2,b2-3,b2-4", byBytes.join());

    const lonely = prunableCopies(
      [{ id: "only", destinationId: "disk", bytes: 10 ** 12, startedAt: ago(400) }],
      () => ({ count: 1, days: 1, bytes: 1024 * 1024 }),
      now
    );
    r.check("the newest copy on a destination is never removed, whatever the numbers say", lonely.length === 0);

    // The newest run's copy on the bucket is older than the disk's newest:
    // it is still the newest *there*, and stays.
    const staggered = prunableCopies(
      [
        { id: "disk-new", destinationId: "disk", bytes: 1, startedAt: ago(0) },
        { id: "disk-old", destinationId: "disk", bytes: 1, startedAt: ago(10) },
        { id: "b2-old", destinationId: "b2", bytes: 1, startedAt: ago(10) },
      ],
      () => ({ count: 1, days: null, bytes: null }),
      now
    );
    r.check("the newest per destination, not the newest overall", staggered.join() === "disk-old", staggered.join());

    const orphans = prunableCopies(
      [
        { id: "gone-new", destinationId: null, bytes: 1, startedAt: ago(1) },
        { id: "gone-old", destinationId: null, bytes: 1, startedAt: ago(9) },
      ],
      (id) => (id === null ? { count: 1, days: null, bytes: null } : { count: null, days: null, bytes: null }),
      now
    );
    r.check("copies left by deleted destinations are counted together, under the policy's rule", orphans.join() === "gone-old", orphans.join());
    r.check("no limit removes nothing", prunableCopies(held, () => ({ count: null, days: null, bytes: null }), now).length === 0);
  }

  // --- migration 045 over a store from before it --------------------------------------------------
  {
    const require = createRequire(join(repoRoot, "package.json"));
    const { Kysely, SqliteDialect } = require("kysely");
    const { Migrator } = require("kysely/migration");
    const SQLite = require("better-sqlite3");

    const dir = join(repoRoot, "lib", "db", "migrations");
    const names = readdirSync(dir)
      .filter((f) => /^\d{3}-.*\.ts$/.test(f))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    // 007 imports `@/lib/crypto`, which only resolves in the bundle: its schema half is enough here.
    const stub007 = {
      async up(db) {
        await db.schema.alterTable("services").addColumn("inject_env", "integer").execute();
        await db.schema.alterTable("services").addColumn("env_key", "text").execute();
      },
    };
    const modules = {};
    for (const name of names) {
      modules[name] = name.startsWith("007-") ? stub007 : await import(pathToFileURL(join(dir, `${name}.ts`)).href);
    }
    const listUpTo = (last) => Object.fromEntries(names.filter((n) => n <= last).map((n) => [n, modules[n]]));

    const sqlite = new SQLite(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    const migrate = (list) => new Migrator({ db, provider: { getMigrations: async () => list }, allowUnorderedMigrations: true }).migrateToLatest();

    try {
      const before = await migrate(listUpTo("044-~"));
      r.check("the store migrates to 044", !before.error, String(before.error));

      const now = "2026-11-01T03:00:00.000Z";
      const insert = (sql, ...values) => sqlite.prepare(sql).run(...values);
      insert("insert into backup_destinations (id, name, type, config, is_default, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)", "d1", "Disco locale", "local", "x", 1, now, now);
      insert("insert into backup_destinations (id, name, type, config, is_default, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)", "d2", "Bucket", "s3", "x", 0, now, now);
      insert(
        "insert into backup_policies (id, name, enabled, cron, timezone, destination_id, targets, retention_count, retention_days, retention_bytes, include_secret_key, last_run_at, next_run_at, created_at, updated_at) values (?, ?, 1, '', null, ?, '[]', 7, null, null, 0, null, null, ?, ?)",
        "p1", "Notturno", "d2", now, now
      );
      const runRow = "insert into backup_runs (id, policy_id, policy_name, trigger, status, destination_id, archive_path, archive_bytes, checksum, manifest, error_message, pinned, started_at, finished_at, heartbeat_at) values (?, ?, 'Notturno', 'schedule', ?, ?, ?, ?, null, null, null, 0, ?, ?, ?)";
      insert(runRow, "r1", "p1", "success", "d2", "runpanel/a.zip", 1234, now, now, now);
      insert(runRow, "r2", "p1", "failed", "d2", null, null, now, now, now);
      // Its destination deleted since: the path stayed, the destination did not.
      insert(runRow, "r3", null, "success", null, "archives/2026/10/b.zip", 99, now, now, now);

      const after = await migrate(listUpTo("999"));
      r.check("then 045 applies", !after.error, String(after.error));

      const entries = sqlite.prepare("select * from backup_policy_destinations").all();
      r.check(
        "every policy becomes a list of its one destination, with the policy's rule",
        entries.length === 1 && entries[0].policy_id === "p1" && entries[0].destination_id === "d2" && entries[0].position === 0 && entries[0].own_retention === 0,
        JSON.stringify(entries)
      );
      const rows = sqlite.prepare("select * from backup_run_copies order by run_id").all();
      r.check("every run with an archive gets one copy, and a failed run none", rows.map((row) => row.run_id).join() === "r1,r3", JSON.stringify(rows));
      const first = rows.find((row) => row.run_id === "r1");
      r.check(
        "the copy is the archive the run described",
        first?.status === "done" && first.destination_id === "d2" && first.ref === "runpanel/a.zip" && first.bytes === 1234 && first.destination_name === "Bucket" && first.destination_type === "s3",
        JSON.stringify(first)
      );
      const orphan = rows.find((row) => row.run_id === "r3");
      r.check(
        "a run whose destination is gone keeps its path, with no destination",
        orphan?.destination_id === null && orphan.ref === "archives/2026/10/b.zip" && orphan.status === "done",
        JSON.stringify(orphan)
      );

      await modules["045-backup-copies"].up(db);
      const again = sqlite.prepare("select count(*) as n from backup_run_copies").get().n + sqlite.prepare("select count(*) as n from backup_policy_destinations").get().n;
      r.check("running it again adds nothing", again === 3, String(again));

      let refused = false;
      try {
        insert("insert into backup_policy_destinations (id, policy_id, destination_id, position, own_retention, created_at) values ('x', 'p1', 'd2', 1, 0, ?)", now);
      } catch {
        refused = true;
      }
      r.check("the store refuses the same destination twice in one policy", refused);

      insert("delete from backup_destinations where id = 'd2'");
      r.check(
        "deleting a destination keeps the record of its copies, without it",
        sqlite.prepare("select destination_id from backup_run_copies where run_id = 'r1'").get()?.destination_id === null
      );
    } finally {
      await db.destroy();
    }
  }

  return r.result();
}
