import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

/**
 * `replaceQueue` against a real store, with the race it has to survive.
 *
 * The race needs a claim to land between the SELECT and the write, which only
 * Postgres allows. A Kysely plugin reproduces it on SQLite: it runs the claim
 * the moment the write is compiled, so the write meets the state a concurrent
 * deploy would have left. The claim shares the connection, and so the rollback:
 * what is asserted is the error and that the rest of the replacement is undone.
 *
 * The service is loaded through a resolve hook, with the store swapped for this
 * one and the two modules that would pull in the deploy machinery stubbed.
 */
export const meta = { name: "one-time-queue-unit", needsDocker: false, drivers: [], standalone: true };

const fileUrl = (...parts) => pathToFileURL(join(...parts)).href;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

async function loadService(repoRoot) {
  const stubs = {
    "@/lib/db": moduleUrl(
      `export { nowIso, rowCount } from ${JSON.stringify(fileUrl(repoRoot, "lib", "db", "compat.ts"))};
       export const getDb = async () => globalThis.__oneTimeQueueDb;`
    ),
    "./builders/run-command": moduleUrl("export const runCommand = () => {};"),
    "./deploy-steps": moduleUrl("export const joinScript = () => ''; export const runReleaseCommand = () => {};"),
  };

  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
      if (specifier.startsWith("@/")) return nextResolve(fileUrl(repoRoot, `${specifier.slice(2)}.ts`), context);
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      return nextResolve(extensionless && context.parentURL?.endsWith(".ts") ? `${specifier}.ts` : specifier, context);
    },
  });

  try {
    return await import(fileUrl(repoRoot, "services", "one-time-commands.ts"));
  } finally {
    hook.deregister();
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("one-time-queue-unit");

  const sqlite = new Database(":memory:");
  // The rows here belong to no project: only this table is under test.
  sqlite.pragma("foreign_keys = OFF");
  /** Set by a test: runs once, right before the first write of that kind. */
  let race = null;
  const db = new Kysely({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [
      {
        transformQuery({ node }) {
          if (race?.kind === node.kind) {
            const claim = race.claim;
            race = null;
            claim();
          }
          return node;
        },
        transformResult: async ({ result }) => result,
      },
    ],
  });
  globalThis.__oneTimeQueueDb = db;

  const oneTime = await import(fileUrl(repoRoot, "lib", "db", "migrations", "016-one-time-commands.ts"));
  const historyIndex = await import(fileUrl(repoRoot, "lib", "db", "migrations", "027-one-time-history-index.ts"));
  await oneTime.up(db);

  const { replaceQueue, QueueChangedError } = await loadService(repoRoot);

  const insert = sqlite.prepare(
    `insert into one_time_commands
       (id, project_id, phase, command, continue_on_error, status, position, attempts, finished_at, created_at)
     values (?, 'p1', 'after-build', ?, 0, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`
  );
  const reset = (...rows) => {
    sqlite.exec("delete from one_time_commands");
    rows.forEach(([id, command, attempts = 0], index) => insert.run(id, command, "queued", index, attempts, null));
  };
  const stored = () =>
    sqlite.prepare("select id, command, status from one_time_commands order by position").all();
  const claimRow = (id) => () =>
    sqlite.prepare("update one_time_commands set status = 'claimed' where id = ?").run(id);
  const input = (id, command) => ({ id, phase: "after-build", command, continueOnError: false });
  const fails = async (inputs) => {
    try {
      await replaceQueue("p1", "node", inputs);
      return null;
    } catch (err) {
      return err;
    }
  };

  // --- no race: the ordinary paths keep working -------------------------------
  reset(["a", "old text", 2], ["b", "dropped"]);
  const saved = await replaceQueue("p1", "node", [input("a", "new text"), input(undefined, "added")]);
  r.check("an edit is written", stored().find((row) => row.id === "a")?.command === "new text");
  r.check(
    "an edit keeps the attempts of the row",
    sqlite.prepare("select attempts from one_time_commands where id = 'a'").get().attempts === 2
  );
  r.check("a dropped row is deleted", !stored().some((row) => row.id === "b"));
  r.check("a new row is inserted", stored().some((row) => row.command === "added"));
  r.check("the queue comes back", saved.length === 2, JSON.stringify(saved));

  reset(["a", "same"]);
  r.check("saving an unchanged row is no conflict", (await fails([input("a", "same")])) === null);

  reset(["a", "gone"]);
  sqlite.prepare("update one_time_commands set status = 'claimed' where id = 'a'").run();
  r.check(
    "an id already claimed before the read is refused",
    (await fails([input("a", "x")])) instanceof QueueChangedError
  );

  // --- a claim between the read and the UPDATE --------------------------------
  reset(["a", "first"], ["b", "second"]);
  race = { kind: "UpdateQueryNode", claim: claimRow("a") };
  const onUpdate = await fails([input("a", "fixed"), input("b", "also edited"), input(undefined, "new")]);
  r.check("a claim before the UPDATE is a conflict, not a silent 200", onUpdate instanceof QueueChangedError, String(onUpdate));
  r.check(
    "the conflict rolls the whole replacement back",
    JSON.stringify(stored().map((row) => row.command)) === '["first","second"]',
    JSON.stringify(stored())
  );

  // A later row, so writes have already happened when the conflict shows up.
  reset(["a", "first"], ["b", "second"]);
  let writes = 0;
  race = {
    kind: "UpdateQueryNode",
    claim() {
      writes += 1;
      race = { kind: "UpdateQueryNode", claim: claimRow("b") };
    },
  };
  const onSecond = await fails([input("a", "fixed"), input("b", "also edited")]);
  r.check("a conflict on a later row is reported", writes === 1 && onSecond instanceof QueueChangedError, String(onSecond));
  r.check("the row written before it is undone", stored()[0]?.command === "first", JSON.stringify(stored()));

  // --- a claim between the read and the DELETE --------------------------------
  reset(["a", "keep"], ["b", "remove"]);
  race = { kind: "DeleteQueryNode", claim: claimRow("b") };
  const onDelete = await fails([input("a", "kept and edited")]);
  r.check("a claim before the DELETE is a conflict, not a silent 200", onDelete instanceof QueueChangedError, String(onDelete));
  r.check("the edit made before the DELETE is undone", stored()[0]?.command === "keep", JSON.stringify(stored()));
  r.check("the row is still there", stored().some((row) => row.id === "b"));

  // --- the history index ------------------------------------------------------
  const plan = () =>
    sqlite
      .prepare(
        `explain query plan select * from one_time_commands
         where project_id = 'p1' and status in ('done', 'failed') order by finished_at desc limit 50`
      )
      .all()
      .map((step) => step.detail)
      .join(" | ");
  const indexes = () =>
    sqlite
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'one_time_commands'")
      .all()
      .map((row) => row.name);

  await historyIndex.up(db);
  r.check("the unused index is gone", !indexes().includes("idx_one_time_project_created"), indexes().join());
  r.check("the history index exists", indexes().includes("idx_one_time_project_finished"), indexes().join());

  sqlite.exec("delete from one_time_commands");
  for (let i = 0; i < 500; i++) {
    insert.run(`d${i}`, "x", i % 2 ? "done" : "failed", i, 1, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`);
  }
  sqlite.exec("analyze");
  r.check("the history list reads in order, with no sort", !plan().includes("TEMP B-TREE") && plan().includes("idx_one_time_project_finished"), plan());

  await historyIndex.down(db);
  r.check(
    "down restores the old index",
    indexes().includes("idx_one_time_project_created") && !indexes().includes("idx_one_time_project_finished"),
    indexes().join()
  );

  delete globalThis.__oneTimeQueueDb;
  await db.destroy();
  return r.result();
}
