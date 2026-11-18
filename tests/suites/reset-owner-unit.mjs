import { createReporter } from "../harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `scripts/reset-owner.mjs`, the way back in for an owner with no password and
 * no phone. It writes to the panel's real store from a shell, so it is run here
 * against a store built by the real migrations in a throwaway directory, with
 * the answers piped in — never against a data directory that matters.
 *
 * What has to hold: nothing changes without the confirmation; afterwards the
 * new password works, every session of the owner is gone, the sign-in limits
 * are cleared (and nobody else's), the second step is off only when asked, and
 * the activity log says what happened.
 */
export const meta = { name: "reset-owner-unit", needsDocker: false, drivers: [], standalone: true };

const OWNER = "owner@runpanel.test";

export async function run({ repoRoot }) {
  const r = createReporter("reset-owner-unit");
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect } = require("kysely");
  const SQLite = require("better-sqlite3");
  const bcrypt = require("bcryptjs");

  const dataDir = mkdtempSync(join(tmpdir(), "runpanel-reset-owner-"));
  const file = join(dataDir, "runpanel.db");

  // The store, as the panel would have made it: the migrations the script reads.
  {
    const db = new Kysely({ dialect: new SqliteDialect({ database: new SQLite(file) }) });
    for (const name of ["001-initial", "003-sessions-and-limits", "023-users-and-permissions", "024-cluster", "035-two-factor"]) {
      const migration = await import(pathToFileURL(join(repoRoot, "lib", "db", "migrations", `${name}.ts`)).href);
      await migration.up(db);
    }
    await db.destroy();
  }

  const sqlite = new SQLite(file);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, is_owner, disabled, created_by, created_at, last_login_at, updated_at) VALUES (?, ?, ?, 1, 0, NULL, ?, NULL, ?)")
    .run("owner1", OWNER, bcrypt.hashSync("old-password", 4), now, "2030-01-01T00:00:00.000Z");
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, is_owner, disabled, created_by, created_at, last_login_at, updated_at) VALUES (?, ?, ?, 0, 0, NULL, ?, NULL, ?)")
    .run("member1", "member@runpanel.test", bcrypt.hashSync("member-password", 4), now, now);
  const session = sqlite.prepare("INSERT INTO sessions (id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at, user_id) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)");
  session.run("s-owner-1", "h1", now, now, later, "owner1");
  session.run("s-owner-2", "h2", now, now, later, "owner1");
  session.run("s-member", "h3", now, now, later, "member1");
  sqlite.prepare("INSERT INTO user_two_factor (user_id, secret_enc, enabled_at, last_used_step, created_at) VALUES ('owner1', 'sealed', ?, NULL, ?)").run(now, now);
  sqlite.prepare("INSERT INTO user_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES ('rc1', 'owner1', 's1$00$00', NULL, ?)").run(now);
  sqlite.prepare("INSERT INTO trusted_devices (id, user_id, token_hash, user_agent, ip, created_at, last_used_at, expires_at) VALUES ('td1', 'owner1', 'dh1', NULL, NULL, ?, NULL, ?)").run(now, later);
  sqlite.prepare("INSERT INTO trusted_devices (id, user_id, token_hash, user_agent, ip, created_at, last_used_at, expires_at) VALUES ('td2', 'member1', 'dh2', NULL, NULL, ?, NULL, ?)").run(now, later);
  const limit = sqlite.prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 99, ?)");
  for (const key of ["login:global", "login:email:abc", "login:2fa:owner1", "login:2fa-day:owner1", "account:pw:owner1", "account:pw:member1", "invite:global"]) {
    limit.run(key, later);
  }

  // The child sees no RunPanel configuration but the directory it is given.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPANEL_") && key !== "DATABASE_URL"));
  const script = (answers, ...flags) =>
    spawnSync(process.execPath, [join(repoRoot, "scripts", "reset-owner.mjs"), "--data-dir", dataDir, "--no-env-file", ...flags], {
      input: answers.map((a) => `${a}\n`).join(""),
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
  const ownerRow = () => sqlite.prepare("SELECT password_hash, updated_at FROM users WHERE id = 'owner1'").get();
  const count = (sql, ...args) => sqlite.prepare(sql).get(...args).n;

  try {
    // --- refused without the confirmation -----------------------------------------
    const before = ownerRow();
    const refused = script(["someone@else.test", "new-password-1", "new-password-1", "s"]);
    r.check("a wrong confirmation exits with an error", refused.status === 1, `status ${refused.status}: ${refused.stderr}`);
    r.check("and changes nothing", ownerRow().password_hash === before.password_hash && count("SELECT COUNT(*) n FROM sessions WHERE user_id = 'owner1'") === 2);
    r.check("it says which store it opened before asking", refused.stdout.includes(file), refused.stdout.slice(0, 300));

    const mismatch = script([OWNER, "new-password-1", "another-password", "s"]);
    r.check("two different passwords are refused", mismatch.status === 1 && ownerRow().password_hash === before.password_hash, mismatch.stderr);

    // --- a typed password, the second step kept ------------------------------------
    const kept = script([OWNER, "new-password-1", "new-password-1", "n"]);
    r.check("the reset runs", kept.status === 0, `${kept.status}: ${kept.stderr}${kept.stdout.slice(-400)}`);
    const after = ownerRow();
    r.check("the new password is the owner's", bcrypt.compareSync("new-password-1", after.password_hash));
    r.check("the old one no longer is", !bcrypt.compareSync("old-password", after.password_hash));
    r.check("the edit is stamped after what the row carried, so a cluster merge keeps it", after.updated_at > "2030-01-01T00:00:00.000Z", after.updated_at);
    r.check("every session of the owner is closed", count("SELECT COUNT(*) n FROM sessions WHERE user_id = 'owner1'") === 0);
    r.check("another account's session is not", count("SELECT COUNT(*) n FROM sessions WHERE user_id = 'member1'") === 1);
    r.check("the owner's remembered devices are forgotten, nobody else's", count("SELECT COUNT(*) n FROM trusted_devices WHERE user_id = 'owner1'") === 0 && count("SELECT COUNT(*) n FROM trusted_devices WHERE user_id = 'member1'") === 1);
    r.check("answering no keeps two-step sign-in on", count("SELECT COUNT(*) n FROM user_two_factor WHERE user_id = 'owner1'") === 1 && count("SELECT COUNT(*) n FROM user_recovery_codes") === 1);
    const keys = sqlite.prepare("SELECT key FROM rate_limits ORDER BY key").all().map((row) => row.key);
    r.check("the sign-in limits and the owner's password limit are cleared", keys.join() === "account:pw:member1,invite:global", keys.join());
    const entry = sqlite.prepare("SELECT * FROM audit_log WHERE action = 'auth.owner-reset'").get();
    r.check("the activity log records it as a security event about the owner", entry?.category === "security" && entry.scope === "user" && entry.scope_id === "owner1", JSON.stringify(entry));
    r.check("the password is never printed when it was typed", !kept.stdout.includes("new-password-1"));

    // --- a generated password, the second step off ---------------------------------
    sqlite.prepare("INSERT INTO sessions (id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at, user_id) VALUES ('s-owner-3', 'h4', NULL, NULL, ?, ?, ?, 'owner1')").run(now, now, later);
    const generated = script([OWNER, ""], "--disable-2fa");
    r.check("a second reset runs", generated.status === 0, generated.stderr);
    const printed = /Nuova password: (\S+)/.exec(generated.stdout)?.[1];
    r.check("an empty answer generates a password and prints it once", Boolean(printed) && printed.length >= 16, generated.stdout.slice(-400));
    r.check("the generated password works", Boolean(printed) && bcrypt.compareSync(printed, ownerRow().password_hash));
    r.check("--disable-2fa turns the second step off", count("SELECT COUNT(*) n FROM user_two_factor") === 0 && count("SELECT COUNT(*) n FROM user_recovery_codes") === 0);
    r.check("the log says the second step was turned off", count("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.owner-reset' AND detail LIKE '%disattivata%'") === 1);
    r.check("and the session opened in between is closed too", count("SELECT COUNT(*) n FROM sessions WHERE user_id = 'owner1'") === 0);

    // --- a directory without a store --------------------------------------------------
    const empty = mkdtempSync(join(tmpdir(), "runpanel-reset-empty-"));
    const missing = spawnSync(process.execPath, [join(repoRoot, "scripts", "reset-owner.mjs"), "--data-dir", empty, "--no-env-file"], {
      input: "",
      env: childEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    r.check("a directory with no store is refused with a pointer to --data-dir", missing.status === 1 && missing.stderr.includes("--data-dir"), missing.stderr);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    sqlite.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the file for a moment */
    }
  }

  return r.result();
}
