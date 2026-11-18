#!/usr/bin/env node
/**
 * Get the owner back in, from the server's terminal.
 *
 *   node scripts/reset-owner.mjs                 asks everything it needs
 *   node scripts/reset-owner.mjs --disable-2fa   also turns two-step sign-in off
 *   node scripts/reset-owner.mjs --help
 *
 * The panel cannot help someone who cannot sign in to it: the owner is the one
 * account nobody else may reset, and with two-step sign-in on, a lost phone and
 * lost recovery codes would otherwise be the end of the panel. Whoever can run
 * a command in the panel's directory, as the user the panel runs as, can read
 * its whole store anyway — so that shell is the proof of identity here, and
 * the script still asks before it writes.
 *
 * What it does, in one transaction: a new password for the owner (typed, or
 * generated and printed once), every session of the owner closed, the
 * remembered devices forgotten, the sign-in limits cleared, optionally the
 * second step turned off, and a line in the activity log saying so.
 *
 * It finds the store the way the panel does (lib/env.ts): RUNPANEL_DB_DRIVER,
 * RUNPANEL_DB_FILE or RUNPANEL_DATA_DIR for SQLite, RUNPANEL_DATABASE_URL (or
 * DATABASE_URL, or the RUNPANEL_PG_* parts) for Postgres — from the
 * environment first, then from the `.env` files Next reads at boot. A panel
 * started by systemd with `Environment=` lines, or in Docker, has them in its
 * own environment: run the script there (`docker exec -it <container> node
 * scripts/reset-owner.mjs`), or pass `--data-dir` / `--db-file` /
 * `--database-url`. It prints which store it opened before touching it.
 *
 * Plain Node, no build: it has to work on the day the panel itself does not.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));

const USAGE = `Uso: node scripts/reset-owner.mjs [opzioni]

Imposta una nuova password per il proprietario del pannello, chiude le sue
sessioni e azzera i limiti di accesso. Chiede conferma prima di scrivere.

Opzioni:
  --disable-2fa          disattiva anche la verifica in due passaggi
  --keep-2fa             la lascia attiva, senza chiedere
  --data-dir <cartella>  la cartella dati del pannello (SQLite)
  --db-file <file>       il file SQLite, se non è <cartella dati>/runpanel.db
  --database-url <url>   un database Postgres
  --no-env-file          non leggere i file .env della cartella del pannello
  -h, --help             questo aiuto`;

// --- arguments ------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
function option(name) {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} vuole un valore`);
  return value;
}

function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

if (has("--help") || has("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (has("--disable-2fa") && has("--keep-2fa")) fail("--disable-2fa e --keep-2fa insieme non hanno senso");

// --- configuration, as lib/env.ts reads it -----------------------------------------

/** `KEY=value` lines, `export` allowed, quotes stripped; no variable expansion. */
function parseDotenv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^"(.*)"$/.test(value)) value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    out.push([match[1], value]);
  }
  return out;
}

/** Next's order for a production server; whatever is already in the environment wins. */
function loadEnvFiles() {
  const loaded = [];
  for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of parseDotenv(fs.readFileSync(file, "utf8"))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    loaded.push(name);
  }
  return loaded;
}

/** Empty means unset, as in lib/env.ts: `FOO=` in a .env file is not a value. */
const env = (key) => {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

function storeConfig() {
  const url = option("--database-url");
  const driver = url ? "postgres" : option("--db-file") || option("--data-dir") ? "sqlite" : (env("RUNPANEL_DB_DRIVER") ?? "sqlite");
  if (driver !== "sqlite" && driver !== "postgres") fail(`RUNPANEL_DB_DRIVER="${driver}" non è né sqlite né postgres`);

  if (driver === "sqlite") {
    const dataDir = path.resolve(ROOT, option("--data-dir") ?? env("RUNPANEL_DATA_DIR") ?? "data");
    const file = path.resolve(ROOT, option("--db-file") ?? env("RUNPANEL_DB_FILE") ?? path.join(dataDir, "runpanel.db"));
    return { driver, file, label: `SQLite, ${file}` };
  }

  const connectionString = url ?? env("RUNPANEL_DATABASE_URL") ?? env("DATABASE_URL");
  const ssl = env("RUNPANEL_PG_SSL") ?? "disable";
  const parts = {
    host: env("RUNPANEL_PG_HOST"),
    port: Number(env("RUNPANEL_PG_PORT") ?? 5432),
    user: env("RUNPANEL_PG_USER"),
    password: env("RUNPANEL_PG_PASSWORD"),
    database: env("RUNPANEL_PG_DATABASE"),
  };
  if (!connectionString && !(parts.host && parts.user && parts.database)) {
    fail("Postgres senza indirizzo: serve RUNPANEL_DATABASE_URL, oppure RUNPANEL_PG_HOST, RUNPANEL_PG_USER e RUNPANEL_PG_DATABASE (o --database-url).");
  }
  // The password never goes on screen.
  const where = connectionString
    ? connectionString.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@")
    : `${parts.user}@${parts.host}:${parts.port}/${parts.database}`;
  return { driver, connectionString, parts, ssl, label: `Postgres, ${where}` };
}

async function openStore(config) {
  const { Kysely, SqliteDialect, PostgresDialect } = require("kysely");
  if (config.driver === "sqlite") {
    if (!fs.existsSync(config.file)) {
      fail(`Nessun database in ${config.file}.\nIndica la cartella dati del pannello con --data-dir, o il file con --db-file.`);
    }
    const SQLite = require("better-sqlite3");
    const handle = new SQLite(config.file, { fileMustExist: true });
    // The panel may be running and holding the write lock for a moment.
    handle.pragma("busy_timeout = 5000");
    handle.pragma("foreign_keys = ON");
    return new Kysely({ dialect: new SqliteDialect({ database: handle }) });
  }
  const { Pool } = require("pg");
  const ssl = config.ssl === "disable" ? undefined : { rejectUnauthorized: config.ssl === "require" };
  const pool = config.connectionString
    ? new Pool({ connectionString: config.connectionString, max: 1, ssl })
    : new Pool({ ...config.parts, max: 1, ssl });
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}

// --- questions --------------------------------------------------------------------

/**
 * Questions on a terminal, with the password hidden; or, when the answers are
 * piped in, one line per question (how the unit suite drives it).
 */
function createInput() {
  if (process.stdin.isTTY) {
    return {
      ask(prompt) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) =>
          rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
          })
        );
      },
      askHidden(prompt) {
        return new Promise((resolve) => {
          const stdin = process.stdin;
          process.stdout.write(prompt);
          stdin.setRawMode(true);
          stdin.resume();
          stdin.setEncoding("utf8");
          let value = "";
          const onData = (chunk) => {
            for (const ch of chunk) {
              if (ch === "\r" || ch === "\n") {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.off("data", onData);
                process.stdout.write("\n");
                resolve(value);
                return;
              }
              if (ch === "\u0003") {
                stdin.setRawMode(false);
                process.stdout.write("\nAnnullato.\n");
                process.exit(130);
              }
              if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
              else if (ch >= " ") value += ch;
            }
          };
          stdin.on("data", onData);
        });
      },
      close() {},
    };
  }

  const lines = [];
  let ended = false;
  let waiting = null;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else lines.push(line);
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) waiting(null);
  });
  const next = () =>
    lines.length > 0 ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((resolve) => (waiting = resolve));
  const read = async (prompt) => {
    process.stdout.write(prompt);
    const line = await next();
    process.stdout.write("\n");
    if (line === null) fail("Risposte finite prima delle domande: nessuna modifica.");
    return line;
  };
  return { ask: read, askHidden: read, close: () => rl.close() };
}

// --- the reset ------------------------------------------------------------------------

/** Strictly after what the row carried (lib/cluster-directory.ts), so a cluster merge keeps this edit. */
function bumpedUpdatedAt(previous, now) {
  const prev = Date.parse(previous ?? "");
  const cur = Date.parse(now);
  if (!Number.isFinite(prev) || cur > prev) return now;
  return new Date(prev + 1).toISOString();
}

async function main() {
  const envFiles = has("--no-env-file") ? [] : loadEnvFiles();
  const config = storeConfig();
  const db = await openStore(config);
  const input = createInput();

  try {
    const tables = new Map((await db.introspection.getTables()).map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
    if (!tables.has("users")) {
      fail("In questo database non ci sono account: è il database giusto? Il pannello lo crea al primo avvio.");
    }
    const owner = await db.selectFrom("users").selectAll().where("is_owner", "=", 1).executeTakeFirst();
    if (!owner) {
      fail("Questo pannello non ha ancora un proprietario: aprilo nel browser e crealo dalla pagina di accesso.");
    }
    const twoFactor = tables.has("user_two_factor")
      ? await db.selectFrom("user_two_factor").select("enabled_at").where("user_id", "=", owner.id).executeTakeFirst()
      : undefined;
    const twoFactorOn = Boolean(twoFactor?.enabled_at);

    process.stdout.write(
      [
        "",
        "RunPanel — ripristino dell'accesso del proprietario",
        "",
        `  Database:                 ${config.label}`,
        envFiles.length ? `  Configurazione letta da:  ${envFiles.join(", ")}` : null,
        `  Proprietario:             ${owner.email ?? "(senza email)"}`,
        `  Verifica in due passaggi: ${twoFactorOn ? "attiva" : "non attiva"}`,
        "",
        "Verrà impostata una nuova password, il proprietario sarà disconnesso da ogni",
        "dispositivo e i limiti ai tentativi di accesso saranno azzerati.",
        "",
      ]
        .filter((line) => line !== null)
        .join("\n") + "\n"
    );

    const expected = owner.email ?? "RESET";
    const typed = await input.ask(owner.email ? "Per confermare scrivi l'email del proprietario: " : "Per confermare scrivi RESET: ");
    if (typed.trim().toLowerCase() !== expected.toLowerCase()) fail("Conferma non corrispondente: nessuna modifica.");

    let password = await input.askHidden("Nuova password (almeno 8 caratteri; invio per generarne una): ");
    let generated = false;
    if (password === "") {
      password = crypto.randomBytes(15).toString("base64url");
      generated = true;
    } else {
      if (password.length < 8 || password.length > 128) fail("La password deve avere tra 8 e 128 caratteri: nessuna modifica.");
      const again = await input.askHidden("Ripeti la nuova password: ");
      if (again !== password) fail("Le due password non coincidono: nessuna modifica.");
    }

    let disable2fa = false;
    if (twoFactorOn) {
      if (has("--disable-2fa")) disable2fa = true;
      else if (!has("--keep-2fa")) {
        const answer = await input.ask(
          "Disattivare anche la verifica in due passaggi? Serve se hai perso il telefono e i codici di recupero. [s/N]: "
        );
        disable2fa = /^(s|si|sì|y|yes)$/i.test(answer.trim());
      }
    }

    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const users = tables.get("users");

    const closed = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("users")
        .set(users.has("updated_at") ? { password_hash: hash, updated_at: bumpedUpdatedAt(owner.updated_at, now) } : { password_hash: hash })
        .where("id", "=", owner.id)
        .execute();
      const sessions = tables.has("sessions")
        ? await trx.deleteFrom("sessions").where("user_id", "=", owner.id).returning("id").execute()
        : [];
      for (const table of ["trusted_devices", "login_challenges"]) {
        if (tables.has(table)) await trx.deleteFrom(table).where("user_id", "=", owner.id).execute();
      }
      if (disable2fa) {
        for (const table of ["user_two_factor", "user_recovery_codes"]) {
          if (tables.has(table)) await trx.deleteFrom(table).where("user_id", "=", owner.id).execute();
        }
      }
      if (tables.has("rate_limits")) {
        await trx
          .deleteFrom("rate_limits")
          .where((eb) => eb.or([eb("key", "like", "login:%"), eb("key", "=", `account:pw:${owner.id}`)]))
          .execute();
      }
      if (tables.has("audit_log")) {
        await trx
          .insertInto("audit_log")
          .values({
            id: crypto.randomBytes(9).toString("base64url"),
            at: now,
            user_id: null,
            category: "security",
            action: "auth.owner-reset",
            scope: "user",
            scope_id: owner.id,
            detail: disable2fa ? "dal terminale, verifica in due passaggi disattivata" : "dal terminale",
            ip: null,
          })
          .execute();
      }
      return sessions.length;
    });

    const cluster = tables.has("settings")
      ? await db.selectFrom("settings").select("value").where("key", "=", "cluster_id").executeTakeFirst()
      : undefined;

    process.stdout.write(
      [
        "",
        "Fatto.",
        generated
          ? `  Nuova password: ${password}\n  Copiala ora: non verrà mostrata di nuovo. Cambiala dalla pagina Account dopo l'accesso.`
          : "  Password cambiata.",
        `  Sessioni chiuse: ${closed}.`,
        twoFactorOn ? `  Verifica in due passaggi: ${disable2fa ? "disattivata, riattivala da Account" : "ancora attiva"}.` : null,
        "  Limiti ai tentativi di accesso azzerati.",
        cluster?.value
          ? "  Questo server è in un cluster: la nuova password arriva agli altri pannelli alla prossima sincronizzazione."
          : null,
        "",
        `Ora accedi al pannello${owner.email ? ` con ${owner.email}` : " lasciando vuota l'email"} e la nuova password.`,
        "",
      ]
        .filter((line) => line !== null)
        .join("\n") + "\n"
    );
  } finally {
    input.close();
    await db.destroy();
  }
}

main().catch((err) => fail(`Ripristino non riuscito: ${err instanceof Error ? err.message : String(err)}`));
