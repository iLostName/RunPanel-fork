import { createReporter } from "../harness.mjs";
import fs, { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What stands between a stranger, or a stolen cookie, and an account.
 *
 * Each block is a way round the sign-in that was real: a password change that
 * left another panel's sessions alive, a page on another port signing the
 * operator out, a limit any account could reset, a store other local users
 * could read, a chunked body nothing counted.
 *
 * Standalone: the modules loaded here have no imports the plain Node loader
 * cannot resolve. What can only be seen in a route, which `@/` keeps out of
 * reach, is held by a check on its source.
 */
export const meta = { name: "auth-hardening-unit", needsDocker: false, drivers: [], standalone: true };

const HASH_OLD = "$2a$12$old";
const HASH_NEW = "$2a$12$new";

function write(method, headers) {
  return { method, headers: new Headers(headers) };
}

function bodyOf(chunks, onPull) {
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Request("http://panel.test/", { method: "POST", body: stream, duplex: "half" });
}

export async function run({ repoRoot }) {
  const r = createReporter("auth-hardening-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const source = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

  // --- a replicated password change ends that user's sessions here ----------
  const { revokeSessionsOnNewPassword } = await load("services", "cluster", "revoke-sessions.ts");
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect } = require("kysely");
  const SQLite = require("better-sqlite3");
  const sqlite = new SQLite(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT)");
  sqlite.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT)");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const seed = (user, hash, ...sessions) => {
    sqlite.prepare("INSERT INTO users VALUES (?, ?)").run(user, hash);
    for (const id of sessions) sqlite.prepare("INSERT INTO sessions VALUES (?, ?)").run(id, user);
  };
  const sessionsOf = (user) =>
    sqlite.prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY id").all(user).map((row) => row.id);

  try {
    seed("changed", HASH_OLD, "s1", "s2");
    seed("bystander", HASH_OLD, "s3");
    const revoked = await revokeSessionsOnNewPassword(db, "changed", HASH_NEW);
    r.check("a new hash ends that user's sessions", sessionsOf("changed").length === 0, sessionsOf("changed").join());
    r.check("the revoked sessions are named, for the live streams", [...revoked].sort().join() === "s1,s2", revoked.join());
    r.check("another user's sessions stay", sessionsOf("bystander").join() === "s3");

    // The panel the change was made on: it already revoked, re-issued the
    // session of the person doing it, and now reads its own hash back.
    seed("origin", HASH_NEW, "fresh");
    const own = await revokeSessionsOnNewPassword(db, "origin", HASH_NEW);
    r.check("the same hash keeps the session re-issued after the change", sessionsOf("origin").join() === "fresh" && own.length === 0);

    r.check("a user not stored here yet revokes nothing", (await revokeSessionsOnNewPassword(db, "unknown", HASH_NEW)).length === 0);

    seed("cleared", HASH_OLD, "s4");
    await revokeSessionsOnNewPassword(db, "cleared", null);
    r.check("a hash taken away counts as a change", sessionsOf("cleared").length === 0);

    seed("rolled", HASH_OLD, "s5");
    await db
      .transaction()
      .execute(async (trx) => {
        await revokeSessionsOnNewPassword(trx, "rolled", HASH_NEW);
        throw new Error("merge failed");
      })
      .catch(() => {});
    r.check("a merge that fails keeps the sessions", sessionsOf("rolled").join() === "s5");
  } finally {
    await db.destroy();
  }

  const directory = source("services", "cluster", "directory.ts");
  const compared = directory.indexOf("revokeSessionsOnNewPassword(trx");
  r.check(
    "the hash is compared before the upsert overwrites it",
    compared > 0 && compared < directory.indexOf("await upsertUser(trx, u)", compared)
  );
  r.check(
    "the revocation reaches live streams only after the commit",
    directory.indexOf('type: "session-revoked"') > directory.indexOf('.insertInto("cluster_tombstones")\n        .values({ kind: t.kind')
  );

  // --- a page on another origin gets no write -------------------------------
  const { isCrossOriginWrite } = await load("lib", "request-origin.ts");
  const crossOrigin = (headers, method = "POST") => isCrossOriginWrite(write(method, headers));

  r.check("the panel by Tailscale IP over http passes: no Sec-Fetch there, Origin equals Host", !crossOrigin({ origin: "http://100.64.1.2:3000", host: "100.64.1.2:3000" }));
  r.check("an IPv6 tailnet address passes", !crossOrigin({ origin: "http://[fd7a:115c:a1e0::1]:3000", host: "[fd7a:115c:a1e0::1]:3000" }));
  r.check("behind TLS the browser's Sec-Fetch-Site decides", !crossOrigin({ "sec-fetch-site": "same-origin", origin: "https://panel.example", host: "127.0.0.1:3000" }));
  r.check("a proxy that rewrites Host passes on X-Forwarded-Host", !crossOrigin({ origin: "http://panel.example", host: "127.0.0.1:3000", "x-forwarded-host": "panel.example" }));
  r.check("a chain of proxies passes on its first X-Forwarded-Host", !crossOrigin({ origin: "http://panel.example", host: "127.0.0.1:3000", "x-forwarded-host": "panel.example, edge.internal" }));
  r.check("a proxy that keeps Host and sends a portless X-Forwarded-Host passes", !crossOrigin({ origin: "http://100.64.1.2:8080", host: "100.64.1.2:8080", "x-forwarded-host": "100.64.1.2" }));
  r.check("a default port spelled out by the proxy still matches", !crossOrigin({ origin: "http://panel.example", host: "127.0.0.1:3000", "x-forwarded-host": "panel.example:80" }));
  r.check("the case of a forwarded name does not matter", !crossOrigin({ origin: "http://panel.example", host: "127.0.0.1:3000", "x-forwarded-host": "Panel.Example" }));
  r.check("a client that sends neither header is not a browser", !crossOrigin({ host: "100.64.1.2:3000" }));

  r.check("a deployed app on another port is refused", crossOrigin({ origin: "http://100.64.1.2:3001", host: "100.64.1.2:3000" }));
  r.check("the same app is refused behind a proxy too", crossOrigin({ origin: "http://panel.example:3001", host: "127.0.0.1:3000", "x-forwarded-host": "panel.example" }));
  r.check("a browser's same-site verdict is refused", crossOrigin({ "sec-fetch-site": "same-site", origin: "https://panel.example:3001", host: "panel.example" }));
  r.check("an opaque origin is refused", crossOrigin({ origin: "null", host: "100.64.1.2:3000" }));
  r.check("a read is never a cross-origin write", !crossOrigin({ origin: "http://elsewhere.test", host: "panel.test" }, "GET"));

  for (const route of ["login", "logout", "invite"]) {
    const text = source("app", "api", "auth", route, "route.ts");
    const post = text.indexOf("export async function POST");
    const check = text.indexOf("refuseCrossOrigin(request)", post);
    r.check(`POST /api/auth/${route} checks the origin first`, post > 0 && check > post && check - post < 200);
  }

  // --- a success never resets the ceiling across accounts --------------------
  const { LOGIN_GLOBAL_KEY, bucketsResetByLogin } = await load("lib", "login-buckets.ts");
  const buckets = [{ key: "login:203.0.113.7" }, { key: LOGIN_GLOBAL_KEY }, { key: "login:email:abc" }];
  r.check(
    "a successful login resets the address and the account, not the global ceiling",
    bucketsResetByLogin(buckets).map((b) => b.key).join() === "login:203.0.113.7,login:email:abc"
  );
  const login = source("app", "api", "auth", "login", "route.ts");
  r.check("the login route clears buckets in one place only", login.match(/clearRateLimit\(/g)?.length === 1);
  r.check("that place goes through the filter", /bucketsResetByLogin\(buckets\)[\s\S]{0,40}clearRateLimit\(/.test(login));
  r.check("a success gives back its own attempt on the ceiling", login.includes("refundRateLimit(LOGIN_GLOBAL_KEY)"));

  // --- the endpoints only a panel may call -------------------------------------
  const guard = source("lib", "auth-guard.ts");
  const member = guard.slice(guard.indexOf("export async function requireMember"));
  r.check("a forwarded call never counts as a member", /if \(caller\.userId\) return forbidden\(\)/.test(member));

  // --- guessing the current password from an open session --------------------
  const account = source("app", "api", "account", "route.ts");
  const consumed = account.indexOf("consumeRateLimit(");
  const verified = account.indexOf("verifyPassword(currentPassword");
  r.check("the guess is counted before bcrypt runs", consumed > 0 && consumed < verified);
  r.check("a failed guess leaves a trace", account.includes('"account.password.failed"'));
  r.check("the right password clears the count", account.indexOf("clearRateLimit(") > verified);

  // --- the live store is the operator's alone --------------------------------
  const { restrictStoreFiles } = await load("lib", "db", "store-permissions.ts");
  const dir = mkdtempSync(join(tmpdir(), "runpanel-store-mode-"));
  const store = join(dir, "runpanel.db");
  const realChmod = fs.chmodSync;
  try {
    writeFileSync(store, "");
    writeFileSync(`${store}-wal`, "");
    writeFileSync(`${store}-shm`, "");
    const calls = [];
    fs.chmodSync = (target, mode) => {
      calls.push([target, mode]);
      realChmod(target, mode);
    };
    restrictStoreFiles(store);
    fs.chmodSync = realChmod;
    r.check(
      "the store and both WAL files are set to 0600",
      calls.length === 3 &&
        calls.every(([, mode]) => mode === 0o600) &&
        calls.map(([target]) => target).join() === [store, `${store}-wal`, `${store}-shm`].join(),
      JSON.stringify(calls)
    );
    if (process.platform === "win32") {
      r.note("mode bits not read back on Windows: it has none to set");
    } else {
      for (const file of [store, `${store}-wal`, `${store}-shm`]) {
        r.check(`${file.slice(store.length) || "the store"} ends up 0600`, (statSync(file).mode & 0o777) === 0o600);
      }
    }

    let tried = 0;
    fs.chmodSync = () => {
      tried++;
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    let threw = false;
    try {
      restrictStoreFiles(store);
    } catch {
      threw = true;
    }
    fs.chmodSync = realChmod;
    r.check("a filesystem that refuses chmod does not stop the boot", !threw && tried === 3, `threw ${threw}, tried ${tried}`);

    let missing = false;
    try {
      restrictStoreFiles(join(dir, "no-such-store.db"));
    } catch {
      missing = true;
    }
    r.check("a WAL file that is not there yet is not an error", !missing);
  } finally {
    fs.chmodSync = realChmod;
    rmSync(dir, { recursive: true, force: true });
  }

  const dbIndex = source("lib", "db", "index.ts");
  r.check(
    "the store is restricted as soon as WAL mode has created its files",
    dbIndex.indexOf("restrictStoreFiles(dbConfig.file)") > dbIndex.indexOf('sqlite.pragma("journal_mode = WAL")')
  );

  // --- a body nobody declared is still counted --------------------------------
  const { readBodyCapped } = await load("lib", "read-body.ts");
  const kib = new Uint8Array(1024);

  let pulls = 0;
  const endless = bodyOf(Array.from({ length: 1000 }, () => kib), () => pulls++);
  r.check("a chunked body over the cap is refused", (await readBodyCapped(endless, 4096)) === null);
  r.check("reading stops at the cap, not at the end of the stream", pulls < 20, `${pulls} chunks pulled`);

  const exact = await readBodyCapped(bodyOf([kib, kib]), 2048);
  r.check("a body at the cap passes whole", exact?.length === 2048, String(exact?.length));

  const declared = new Request("http://panel.test/", { method: "POST", body: "x".repeat(10), headers: { "content-length": "999999" } });
  r.check("a declared length over the cap is refused without reading", (await readBodyCapped(declared, 4096)) === null && !declared.bodyUsed);

  const text = await readBodyCapped(new Request("http://panel.test/", { method: "POST", body: '{"è":1}' }), 4096);
  r.check("the bytes come back as sent", text?.toString("utf8") === '{"è":1}');

  const empty = await readBodyCapped(new Request("http://panel.test/", { method: "POST" }), 4096);
  r.check("no body reads as empty", empty?.length === 0);

  const routes = [
    ["app", "api", "auth", "login", "route.ts"],
    ["app", "api", "auth", "invite", "route.ts"],
    ["app", "api", "cluster", "join", "route.ts"],
    ["app", "api", "webhooks", "github", "[projectId]", "route.ts"],
  ];
  for (const parts of routes) {
    const route = source(...parts);
    r.check(`${parts.slice(2, -1).join("/")} reads its body through the cap`, route.includes("readBodyCapped(request") && !route.includes("request.text()"));
  }

  return r.result();
}
