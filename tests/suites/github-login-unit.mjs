import { createReporter } from "../harness.mjs";
import { loadTs } from "../ts-modules.mjs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Signing in with GitHub, the parts that decide without a server.
 *
 * The state and the PKCE pair are what stop a forged or stolen return from
 * signing anyone in, and both fail silently when they are wrong — a challenge
 * GitHub cannot match is just "bad_verification_code" on every sign-in, a
 * state compared the wrong way is an open door. The redirect after a sign-in
 * is the panel's most obvious open-redirect risk. The callback URL is what
 * the owner pastes into GitHub, refused on plain http. And the test-only
 * stand-in for GitHub must stay out of a production panel unless told twice.
 *
 * Standalone: lib/github-oauth.ts, lib/safe-path.ts and the messages load
 * directly; migration 050 runs twice on in-memory SQLite.
 */
export const meta = { name: "github-login-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("github-login-unit");
  const oauth = await loadTs(repoRoot, "lib", "github-oauth.ts");
  const { safeNextPath } = await loadTs(repoRoot, "lib", "safe-path.ts");
  const { githubResultMessage } = await loadTs(repoRoot, "lib", "github-login-messages.ts");

  // --- PKCE ----------------------------------------------------------------------
  // RFC 7636, appendix B.
  r.check(
    "the S256 challenge matches RFC 7636's example",
    oauth.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
  const secrets = oauth.newFlowSecrets();
  r.check(
    "a verifier is 43 unreserved characters",
    oauth.isPkceVerifier(secrets.verifier) && secrets.verifier.length === 43,
    secrets.verifier
  );
  r.check("the challenge is the verifier's S256", secrets.challenge === oauth.pkceChallenge(secrets.verifier));
  r.check("the challenge is 43 base64url characters, as GitHub wants", /^[A-Za-z0-9_-]{43}$/.test(secrets.challenge));
  r.check(
    "a verifier outside RFC 7636 is refused",
    !oauth.isPkceVerifier("short") && !oauth.isPkceVerifier("x".repeat(129)) && !oauth.isPkceVerifier(`${"a".repeat(42)}!`) && !oauth.isPkceVerifier(42)
  );

  // --- state and binding ---------------------------------------------------------
  r.check(
    "state, binding and verifier are three different 256-bit values",
    new Set([secrets.state, secrets.binding, secrets.verifier]).size === 3 &&
      [secrets.state, secrets.binding].every((v) => /^[A-Za-z0-9_-]{43}$/.test(v))
  );
  const again = oauth.newFlowSecrets();
  r.check("two sign-ins share nothing", again.state !== secrets.state && again.binding !== secrets.binding && again.verifier !== secrets.verifier);
  const stored = createHash("sha256").update(secrets.binding).digest("hex");
  r.check("the stored hash is plain SHA-256 hex", oauth.sha256Hex(secrets.binding) === stored);
  r.check("the binding matches its own hash", oauth.matchesHash(secrets.binding, stored));
  r.check("another browser's binding does not", !oauth.matchesHash(again.binding, stored));
  r.check("the state does not stand in for the binding", !oauth.matchesHash(secrets.state, stored));
  r.check(
    "no binding, a wrong type or an absurd length never matches",
    !oauth.matchesHash(undefined, stored) && !oauth.matchesHash("", stored) && !oauth.matchesHash(null, stored) && !oauth.matchesHash("a".repeat(300), stored)
  );
  r.check("a stored value that is not a hash never matches", !oauth.matchesHash(secrets.binding, "nope") && !oauth.matchesHash(secrets.binding, ""));

  // --- the authorization URL -----------------------------------------------------
  const authorize = new URL(
    oauth.authorizeUrl({
      web: "https://github.com",
      clientId: "Ov23liExample",
      redirectUri: "https://panel.example.it/api/auth/github/callback",
      state: secrets.state,
      challenge: secrets.challenge,
    })
  );
  const q = authorize.searchParams;
  r.check("it goes to GitHub's authorize page", authorize.origin === "https://github.com" && authorize.pathname === "/login/oauth/authorize");
  r.check(
    "with the client, the callback, the state and an S256 challenge",
    q.get("client_id") === "Ov23liExample" &&
      q.get("redirect_uri") === "https://panel.example.it/api/auth/github/callback" &&
      q.get("state") === secrets.state &&
      q.get("code_challenge") === secrets.challenge &&
      q.get("code_challenge_method") === "S256"
  );
  r.check("asking for read:user and nothing more", q.get("scope") === "read:user" && oauth.GITHUB_SCOPE === "read:user");
  r.check("without the detour to create a GitHub account", q.get("allow_signup") === "false");
  r.check("and never the verifier", !authorize.toString().includes(secrets.verifier) && !authorize.toString().includes(secrets.binding));

  // --- GitHub's answers ----------------------------------------------------------
  r.check("a token answer gives the token", JSON.stringify(oauth.parseTokenResponse(200, { access_token: "gho_x", token_type: "bearer" })) === JSON.stringify({ ok: true, token: "gho_x" }));
  r.check(
    "a refusal with 200 is still a refusal",
    oauth.parseTokenResponse(200, { error: "bad_verification_code", access_token: "gho_x" }).ok === false &&
      oauth.parseTokenResponse(200, { error: "bad_verification_code" }).error === "bad_verification_code"
  );
  r.check("no token is no token", oauth.parseTokenResponse(200, {}).ok === false && oauth.parseTokenResponse(200, null).ok === false);
  r.check("a server error is an error", oauth.parseTokenResponse(502, { access_token: "x" }).error === "http_502");
  r.check("an error code cannot carry markup into the log", oauth.parseTokenResponse(200, { error: "<b>x</b> y" }).error === "bxby");
  r.check("a profile gives its numeric id as text, and the login", JSON.stringify(oauth.parseGithubUser({ id: 583231, login: "octocat", email: "x@y" })) === JSON.stringify({ id: "583231", login: "octocat" }));
  r.check(
    "an id that is not a positive integer is not a profile",
    [{ id: "583231", login: "a" }, { id: -1, login: "a" }, { id: 1.5, login: "a" }, { id: 2 ** 60, login: "a" }, { login: "a" }].every((u) => oauth.parseGithubUser(u) === null)
  );
  r.check(
    "nor is a login GitHub would not issue",
    [{ id: 1, login: "" }, { id: 1, login: "-dash" }, { id: 1, login: "a b" }, { id: 1, login: "x".repeat(40) }, { id: 1 }].every((u) => oauth.parseGithubUser(u) === null)
  );
  r.check(
    "Verifica reads GitHub's objections",
    oauth.readVerifyAnswer({ ok: false, error: "bad_verification_code" }) === "ok" &&
      oauth.readVerifyAnswer({ ok: false, error: "incorrect_client_credentials" }) === "credentials" &&
      oauth.readVerifyAnswer({ ok: false, error: "redirect_uri_mismatch" }) === "callback" &&
      oauth.readVerifyAnswer({ ok: true, token: "x" }) === "unexpected"
  );

  // --- the callback URL ------------------------------------------------------------
  const cb = (origin) => oauth.callbackUrlFor(origin);
  r.check("https gives the callback URL", cb("https://panel.example.it").ok && cb("https://panel.example.it").url === "https://panel.example.it/api/auth/github/callback");
  r.check("a port is kept", cb("https://panel.example.it:8443").url === "https://panel.example.it:8443/api/auth/github/callback");
  r.check("a path or a query on the address is dropped", cb("https://panel.example.it/sub?x=1").url === "https://panel.example.it/api/auth/github/callback");
  r.check(
    "plain http on this machine is allowed, for a try",
    ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://panel.localhost"].every((o) => cb(o).ok === true)
  );
  r.check(
    "plain http anywhere else is refused as insecure",
    ["http://panel.example.it", "http://10.0.0.5:3000", "http://100.101.102.103:3000", "http://192.168.1.10"].every((o) => cb(o).ok === false && cb(o).reason === "insecure")
  );
  r.check(
    "something that is not a web address is refused",
    [null, "", "ftp://panel.example.it", "javascript:alert(1)", "not a url", "https://user:pw@panel.example.it"].every((o) => cb(o).ok === false && cb(o).reason === "invalid")
  );
  r.check("the route and the URL are the same path", oauth.CALLBACK_PATH === "/api/auth/github/callback");

  // --- where a sign-in may send the browser --------------------------------------------
  for (const [path, expected] of [
    ["/home", "/home"],
    ["/projects/abc?tab=deploy#log", "/projects/abc?tab=deploy#log"],
    ["/account", "/account"],
    ["/a/../projects", "/projects"],
  ]) {
    r.check(`${path} is a page of the panel`, safeNextPath(path) === expected, String(safeNextPath(path)));
  }
  for (const path of [
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F%2Fevil.example",
    "/%2f/evil.example",
    "/%5Cevil.example",
    "https://evil.example/home",
    "http:evil.example",
    "javascript:alert(1)",
    "evil.example",
    "home",
    "/\t/evil.example",
    "/\n/evil.example",
    "/ /evil.example",
    "/api/projects",
    "/api",
    "/login",
    "/login?github=continue",
    "/invite/abc",
    "",
    "/" + "a".repeat(600),
  ]) {
    r.check(`${JSON.stringify(path)} is refused`, safeNextPath(path) === null, String(safeNextPath(path)));
  }
  r.check("only strings are paths", safeNextPath(undefined) === null && safeNextPath(null) === null && safeNextPath(["/home"]) === null);

  // --- where a return lands -----------------------------------------------------------------
  const login = { intent: "login", next: null, inviteToken: null };
  r.check("a sign-in goes on to the sign-in page", oauth.landingPath(login, "continue") === "/login?github=continue");
  r.check(
    "with its next page, encoded",
    oauth.landingPath({ ...login, next: "/projects/x?tab=a&b=c" }, "continue") === "/login?github=continue&next=%2Fprojects%2Fx%3Ftab%3Da%26b%3Dc"
  );
  r.check("an error is only a code", oauth.landingPath(login, "unlinked") === "/login?github=unlinked");
  r.check("a link always goes back to the account", oauth.landingPath({ intent: "link", next: "//evil", inviteToken: null }, "taken") === "/account?github=taken");
  const invite = { intent: "invite", next: null, inviteToken: "A".repeat(43) };
  r.check("an invitation that failed goes back to its page", oauth.landingPath(invite, "taken") === `/invite/${"A".repeat(43)}?github=taken`);
  r.check("an accepted one goes on to finish the sign-in", oauth.landingPath(invite, "continue") === "/login?github=continue");
  r.check(
    "an invitation token that is not one does not become a path",
    oauth.landingPath({ ...invite, inviteToken: "../../evil" }, "taken") === "/login?github=taken"
  );
  r.check("every error code has a sentence", ["unlinked", "taken", "already", "denied", "expired", "github", "off", "session", "invite", "managed"].every((c) => typeof githubResultMessage(c) === "string"));
  r.check("anything else has none", githubResultMessage("continue") === null && githubResultMessage("<script>") === null && githubResultMessage("toString") === null && githubResultMessage(null) === null);

  // --- the test-only stand-in ------------------------------------------------------------------
  const real = { web: "https://github.com", api: "https://api.github.com", overridden: false };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fake = "http://127.0.0.1:4567";
  r.check("nothing set: the real GitHub", same(oauth.githubEndpoints({}), real));
  r.check("a production build ignores the stand-in", same(oauth.githubEndpoints({ NODE_ENV: "production", RUNPANEL_TEST_GITHUB_URL: fake }), real));
  r.check(
    "unless told twice",
    same(oauth.githubEndpoints({ NODE_ENV: "production", RUNPANEL_TEST_GITHUB_URL: fake, RUNPANEL_ALLOW_TEST_OVERRIDES: "1" }), { web: fake, api: fake, overridden: true })
  );
  r.check("and only with exactly 1", same(oauth.githubEndpoints({ NODE_ENV: "production", RUNPANEL_TEST_GITHUB_URL: fake, RUNPANEL_ALLOW_TEST_OVERRIDES: "true" }), real));
  r.check("outside production one is enough", oauth.githubEndpoints({ NODE_ENV: "development", RUNPANEL_TEST_GITHUB_URL: fake }).overridden === true);
  r.check(
    "and it must be this machine",
    ["http://evil.example", "http://10.0.0.1:4567", "file:///etc/passwd", "not a url"].every(
      (url) => !oauth.githubEndpoints({ RUNPANEL_TEST_GITHUB_URL: url, RUNPANEL_ALLOW_TEST_OVERRIDES: "1" }).overridden
    )
  );

  // --- migration 050 ---------------------------------------------------------------------------
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect } = require("kysely");
  const SQLite = require("better-sqlite3");
  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const dir = join(repoRoot, "lib", "db", "migrations");
  const load = (file) => import(pathToFileURL(join(dir, file)).href);
  try {
    for (const file of ["001-initial.ts", "003-sessions-and-limits.ts", "023-users-and-permissions.ts", "035-two-factor.ts"]) {
      await (await load(file)).up(db);
    }
    const now = new Date().toISOString();
    await db.insertInto("users").values({ id: "u1", email: "a@b.it", password_hash: null, is_owner: 0, disabled: 0, created_by: null, created_at: now, last_login_at: null }).execute();
    await db.insertInto("login_challenges").values({ id: "c0", user_id: "u1", token_hash: "t0", attempts: 0, created_at: now, expires_at: now }).execute();

    const m050 = await load("050-github-login.ts");
    await m050.up(db);
    let twice = true;
    try {
      await m050.up(db);
    } catch {
      twice = false;
    }
    r.check("migration 050 runs twice without complaint", twice);
    const old = await db.selectFrom("login_challenges").selectAll().where("id", "=", "c0").executeTakeFirst();
    r.check("a challenge from before reads as a password one", old !== undefined && old.via === null, JSON.stringify(old));

    await db.insertInto("user_github").values({ user_id: "u1", github_id: "583231", github_login: "octocat", linked_at: now, last_used_at: null }).execute();
    let unique = false;
    await db.insertInto("users").values({ id: "u2", email: "c@d.it", password_hash: null, is_owner: 0, disabled: 0, created_by: null, created_at: now, last_login_at: null }).execute();
    try {
      await db.insertInto("user_github").values({ user_id: "u2", github_id: "583231", github_login: "renamed", linked_at: now, last_used_at: null }).execute();
    } catch {
      unique = true;
    }
    r.check("one GitHub account links to one user", unique);
    await db.insertInto("github_login_states").values({ id: "s1", state_hash: "h", binding_hash: "b", intent: "link", user_id: "u1", sealed: "x", redirect_uri: "https://p/cb", next_path: null, created_at: now, expires_at: now }).execute();
    await db.deleteFrom("users").where("id", "=", "u1").execute();
    const left = [
      await db.selectFrom("user_github").select("user_id").where("user_id", "=", "u1").executeTakeFirst(),
      await db.selectFrom("github_login_states").select("id").where("id", "=", "s1").executeTakeFirst(),
    ];
    r.check("a deleted user takes its link and its sign-ins with it", left.every((row) => row === undefined));
  } finally {
    await db.destroy();
  }

  return r.result();
}
