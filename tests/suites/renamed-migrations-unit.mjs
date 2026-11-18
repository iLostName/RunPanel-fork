import { createReporter } from "../harness.mjs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Migrations renamed on this fork: 027-host-password → 030, 028-api-tokens → 031.
 *
 * Upstream took 027–029 for its own migrations while the fork had already
 * shipped two of its own under those numbers. Kysely refuses to migrate when a
 * recorded name is missing or out of order, so a store that ran the old names
 * would stop the panel at boot. Checked here on the three stores that exist:
 *
 *   - the fork's: ran the old names (the server that follows this branch);
 *   - upstream's: ran upstream's 027–029, never the fork's two;
 *   - a fresh one.
 *
 * Each must end with every migration recorded under its current name, and the
 * fork's must keep its rows: a token issued before the rename still works.
 *
 * Standalone, on in-memory SQLite. Migrations are loaded from their files;
 * 007 imports `@/lib/crypto`, which cannot resolve outside the bundle, so it is
 * replaced by its schema half (two nullable columns) — enough for every later
 * migration, and none of these stores has a service for its data half to touch.
 */
export const meta = { name: "renamed-migrations-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("renamed-migrations-unit");
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect } = require("kysely");
  const { Migrator } = require("kysely/migration");
  const SQLite = require("better-sqlite3");

  const dir = join(repoRoot, "lib", "db", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{3}-.*\.ts$/.test(f)).sort();
  const names = files.map((f) => f.replace(/\.ts$/, ""));

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

  const { RENAMED_MIGRATIONS, forgetRenamedMigrations } = await import(
    pathToFileURL(join(repoRoot, "lib", "db", "renamed-migrations.ts")).href
  );

  r.check(
    "the renamed migrations exist under their new names",
    Object.values(RENAMED_MIGRATIONS).every((n) => names.includes(n)),
    names.slice(-6).join(", ")
  );
  r.check(
    "no old name is still registered",
    Object.keys(RENAMED_MIGRATIONS).every((n) => !names.includes(n)),
    names.slice(-6).join(", ")
  );

  /** A migration list as a store saw it: current names, minus some, plus aliases. */
  const listOf = ({ upTo, aliases = {} }) => {
    const list = {};
    for (const name of names) if (name <= upTo) list[name] = modules[name];
    for (const [oldName, current] of Object.entries(aliases)) list[oldName] = modules[current];
    return list;
  };
  const forkList = listOf({ upTo: "026-~", aliases: RENAMED_MIGRATIONS });
  const upstreamList = listOf({ upTo: "029-~" });
  const currentList = listOf({ upTo: "999" });

  const migrate = (db, list) =>
    new Migrator({ db, provider: { getMigrations: async () => list } }).migrateToLatest();

  const open = () => {
    const sqlite = new SQLite(":memory:");
    // As the panel opens it (lib/db): the token row below has to satisfy its key.
    sqlite.pragma("foreign_keys = ON");
    return { sqlite, db: new Kysely({ dialect: new SqliteDialect({ database: sqlite }) }) };
  };

  const recorded = (sqlite) =>
    sqlite.prepare("select name from kysely_migration order by name").all().map((row) => row.name);
  const columnsOf = (sqlite, table) =>
    sqlite.prepare(`select name from pragma_table_info('${table}')`).all().map((row) => row.name);

  // --- the fork's store ------------------------------------------------------
  {
    const { sqlite, db } = open();
    try {
      const before = await migrate(db, forkList);
      r.check("the fork's store migrates with the old names", !before.error, String(before.error));

      const now = "2026-10-30T10:00:00.000Z";
      sqlite
        .prepare("insert into users (id, email, password_hash, is_owner, disabled, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)")
        .run("u1", "owner@example.test", "$2b$12$h", 1, 0, null, now);
      sqlite
        .prepare(
          "insert into api_tokens (id, user_id, name, token_hash, hint, access, created_at) values (?, ?, ?, ?, ?, ?, ?)"
        )
        .run("t1", "u1", "Claude", "hash-1", "abcd", "full", now);

      const blind = await migrate(db, currentList);
      r.check(
        "without forgetting, Kysely refuses the new list",
        Boolean(blind.error) && /corrupted migrations/.test(String(blind.error)),
        String(blind.error)
      );

      const forgotten = await forgetRenamedMigrations(db);
      r.check("both old records are forgotten", forgotten === 2, String(forgotten));

      const after = await migrate(db, currentList);
      r.check("then the new list migrates", !after.error, String(after.error));
      const applied = (after.results ?? []).filter((x) => x.status === "Success").map((x) => x.migrationName);
      r.check(
        "upstream's 027–029 run, and 030–031 run again",
        JSON.stringify(applied) === JSON.stringify(names.filter((n) => n > "026-~")),
        applied.join(", ")
      );

      r.check("every migration is recorded under its current name", JSON.stringify(recorded(sqlite)) === JSON.stringify(names), recorded(sqlite).join(", "));

      const token = sqlite.prepare("select * from api_tokens where id = 't1'").get();
      r.check("a token issued before the rename is still there", token?.token_hash === "hash-1", JSON.stringify(token));

      const hostColumns = columnsOf(sqlite, "project_hosts");
      r.check(
        "the name password columns exist once",
        hostColumns.filter((c) => c === "auth_user").length === 1 && hostColumns.filter((c) => c === "auth_hash").length === 1,
        hostColumns.join(", ")
      );

      const again = await migrate(db, currentList);
      r.check("a second boot has nothing to do", !again.error && (again.results ?? []).length === 0, String(again.error));
      r.check("and nothing left to forget", (await forgetRenamedMigrations(db)) === 0);
    } finally {
      await db.destroy();
    }
  }

  // --- upstream's store -------------------------------------------------------
  {
    const { sqlite, db } = open();
    try {
      const before = await migrate(db, upstreamList);
      r.check("upstream's store migrates to 029", !before.error, String(before.error));
      r.check("upstream's store has nothing to forget", (await forgetRenamedMigrations(db)) === 0);

      const after = await migrate(db, currentList);
      r.check("then the fork's 030–031 apply on top", !after.error, String(after.error));
      r.check("the token table exists", columnsOf(sqlite, "api_tokens").includes("token_hash"));
      r.check("the password columns exist", columnsOf(sqlite, "project_hosts").includes("auth_hash"));
      r.check("every migration is recorded", JSON.stringify(recorded(sqlite)) === JSON.stringify(names));
    } finally {
      await db.destroy();
    }
  }

  // --- a fresh store ------------------------------------------------------------
  {
    const { sqlite, db } = open();
    try {
      r.check("a fresh store has nothing to forget", (await forgetRenamedMigrations(db)) === 0);
      const result = await migrate(db, currentList);
      r.check("a fresh store migrates", !result.error, String(result.error));
      r.check("every migration is recorded", JSON.stringify(recorded(sqlite)) === JSON.stringify(names));
    } finally {
      await db.destroy();
    }
  }

  return r.result();
}
