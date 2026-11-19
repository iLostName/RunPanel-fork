import { createReporter, sleep, SETUP_TOKEN } from "../harness.mjs";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Signing in with GitHub, end to end, against a GitHub that lives in this file.
 *
 * The stand-in answers the four endpoints the panel uses — the authorization
 * page, the code exchange, the profile and the token revocation — the way
 * GitHub does: a code is good once, only with the verifier its challenge was
 * made from and the same redirect URI, and an exchange that fails says so with
 * 200 and an `error`. The server reaches it through `RUNPANEL_TEST_GITHUB_URL`,
 * which a production build — the one the harness runs — honours only with
 * `RUNPANEL_ALLOW_TEST_OVERRIDES=1` beside it.
 *
 * The suite plays the browser: it asks the panel to start, follows GitHub's
 * redirect by hand, and brings the return to the callback with whatever
 * cookies the browser holds. What it proves: a GitHub account signs in only
 * the user it was linked to, by its numeric id; an unknown or disabled one is
 * refused; the second step is still asked for; a return with a wrong state, from
 * another browser, or replayed, opens nothing; a code is spent once; the token
 * is revoked; an invitation can be accepted with GitHub; and turning GitHub off
 * neither strands anyone silently nor leaves a way in.
 */

const CLIENT_ID = "Ov23liTestClient0001";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";

/** The GitHub of this suite. One per process, reset for each server. */
const fake = {
  server: null,
  url: null,
  callbackUrl: null,
  /** The GitHub user approving the next authorization. */
  as: null,
  deny: false,
  codes: new Map(),
  tokens: new Map(),
  issued: [],
  revoked: [],
  exchanges: [],
  scopes: [],
  reset() {
    this.callbackUrl = null;
    this.as = null;
    this.deny = false;
    this.codes.clear();
    this.tokens.clear();
    this.issued = [];
    this.revoked = [];
    this.exchanges = [];
    this.scopes = [];
  },
};

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function startFake() {
  if (fake.server) return;
  fake.server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake.invalid");

    if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== CLIENT_ID) return reply(res, 404, "unknown app", "text/plain");
      if (fake.callbackUrl && q.get("redirect_uri") !== fake.callbackUrl) {
        return reply(res, 400, "The redirect_uri is not associated with this application.", "text/plain");
      }
      if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")) {
        return reply(res, 400, "PKCE required", "text/plain");
      }
      fake.scopes.push(q.get("scope"));
      const back = new URL(q.get("redirect_uri"));
      if (fake.deny) {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(10).toString("hex");
        fake.codes.set(code, { user: fake.as, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), used: false });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(body);
      const answer = (fields) => {
        fake.exchanges.push(fields.error ?? "token");
        reply(res, 200, fields);
      };
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
        return answer({ error: "incorrect_client_credentials" });
      }
      const entry = fake.codes.get(form.get("code") ?? "");
      if (!entry || entry.used) return answer({ error: "bad_verification_code" });
      if (form.get("redirect_uri") !== entry.redirectUri) return answer({ error: "redirect_uri_mismatch" });
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
        return answer({ error: "bad_verification_code" });
      }
      entry.used = true;
      const token = `gho_${randomBytes(16).toString("hex")}`;
      fake.tokens.set(token, entry.user);
      fake.issued.push(token);
      return answer({ access_token: token, token_type: "bearer", scope: "read:user" });
    }

    if (req.method === "GET" && url.pathname === "/user") {
      const user = fake.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!user) return reply(res, 401, { message: "Bad credentials" });
      return reply(res, 200, { id: user.id, login: user.login, type: "User", email: `${user.login}@users.noreply.example` });
    }

    const revoke = /^\/applications\/([^/]+)\/token$/.exec(url.pathname);
    if (req.method === "DELETE" && revoke) {
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
      if (decodeURIComponent(revoke[1]) !== CLIENT_ID || basic !== `${CLIENT_ID}:${CLIENT_SECRET}`) {
        return reply(res, 404, { message: "Not Found" });
      }
      const token = JSON.parse(body || "{}").access_token;
      fake.tokens.delete(token);
      fake.revoked.push(token);
      res.writeHead(204);
      return res.end();
    }

    reply(res, 404, { message: "Not Found" });
  });
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${fake.server.address().port}`;
}

export const meta = {
  name: "github-login",
  needsDocker: false,
  drivers: ["sqlite", "postgres"],
  async env() {
    await startFake();
    return { RUNPANEL_TEST_GITHUB_URL: fake.url, RUNPANEL_ALLOW_TEST_OVERRIDES: "1" };
  },
};

/** A browser: every cookie it is given, sent back with every request. */
function browser(base) {
  const cookies = new Map();
  return {
    cookies,
    has: (name) => cookies.has(name),
    async call(path, init = {}) {
      const res = await fetch(base + path, {
        redirect: "manual",
        ...init,
        headers: {
          "content-type": "application/json",
          ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...(init.headers ?? {}),
        },
      });
      const setCookies = res.headers.getSetCookie();
      for (const line of setCookies) {
        const [pair, ...attrs] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
        if (gone) cookies.delete(name);
        else cookies.set(name, value);
      }
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body, location: res.headers.get("location"), setCookies };
    },
  };
}

const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body) => ({ method: "PUT", body: JSON.stringify(body) });

export async function run({ base, dataDir, repoRoot }) {
  const r = createReporter("github-login");
  fake.reset();
  const totp = await import(pathToFileURL(join(repoRoot, "lib", "totp.ts")).href);

  /** Leave for GitHub as `who`, come back: what the panel answered at each step. */
  async function trip(b, body, who, options = {}) {
    fake.as = who;
    fake.deny = options.deny === true;
    const start = await b.call("/api/auth/github/start", post(body));
    if (start.status !== 200 || typeof start.body?.url !== "string") return { start };
    const authorize = new URL(start.body.url);
    const atGithub = await fetch(start.body.url, { redirect: "manual" });
    const back = atGithub.headers.get("location") ?? "";
    const returnPath = back.startsWith(base) ? back.slice(base.length) : back;
    const callback = options.skipCallback ? null : await b.call(returnPath, { headers: options.callbackHeaders ?? {} });
    return { start, authorize, githubStatus: atGithub.status, returnPath, callback, landing: callback?.location ?? null };
  }

  /** Back on the sign-in page: finish it as the page does. */
  const finish = (b) => b.call("/api/auth/github/continue", post({}));
  const me = async (b) => (await b.call("/api/auth/me")).body?.user ?? null;

  // --- the owner, and a GitHub that is not set up ---------------------------------------
  const owner = browser(base);
  await owner.call("/api/auth/login", post({ setup: true, email: "owner@runpanel.test", password: "owner-pw-1234", setupToken: SETUP_TOKEN }));
  r.check("the owner is signed in", (await me(owner))?.isOwner === true);
  r.check("the sign-in page offers no GitHub yet", (await owner.call("/api/auth/check")).body?.github === false);
  const early = await browser(base).call("/api/auth/github/start", post({ intent: "login" }));
  r.check("a sign-in cannot start before the owner sets it up", early.status === 409 && early.body?.code === "off", JSON.stringify(early.body));

  // --- the owner sets up the OAuth App -----------------------------------------------------
  let settings = await owner.call("/api/github-login");
  const expectedCallback = `${base}/api/auth/github/callback`;
  r.check(
    "the settings offer the callback URL to paste, from this address",
    settings.status === 200 && settings.body.callbackUrl === expectedCallback && settings.body.callbackProblem === null,
    JSON.stringify(settings.body)
  );
  r.check("and say the stand-in is in use", settings.body.testStandIn === true);
  fake.callbackUrl = expectedCallback;
  r.check("a Client ID with spaces is refused", (await owner.call("/api/github-login", put({ clientId: "not an id", clientSecret: CLIENT_SECRET }))).status === 400);
  r.check("the first save needs the secret", (await owner.call("/api/github-login", put({ clientId: CLIENT_ID }))).status === 400);
  const saved = await owner.call("/api/github-login", put({ clientId: CLIENT_ID, clientSecret: "f".repeat(40) }));
  r.check("the app is saved", saved.status === 200 && saved.body.configured === true && saved.body.secretSet === true, JSON.stringify(saved.body));
  let verify = await owner.call("/api/github-login", post({ action: "verify" }));
  r.check("Verifica says when GitHub does not know the secret", verify.status === 200 && verify.body.ok === false && verify.body.outcome === "credentials", JSON.stringify(verify.body));
  await owner.call("/api/github-login", put({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
  verify = await owner.call("/api/github-login", post({ action: "verify" }));
  r.check("and when it does", verify.body?.ok === true && verify.body?.outcome === "ok", JSON.stringify(verify.body));
  settings = await owner.call("/api/github-login");
  r.check("the secret is never read back", !JSON.stringify(settings.body).includes(CLIENT_SECRET) && settings.body.enabled === false);
  r.check("still off until the owner turns it on", (await owner.call("/api/auth/check")).body?.github === false);
  const on = await owner.call("/api/github-login", put({ enabled: true }));
  r.check("the owner turns it on", on.status === 200 && on.body.enabled === true, JSON.stringify(on.body));
  r.check("the sign-in page now offers GitHub", (await browser(base).call("/api/auth/check")).body?.github === true);

  // --- leaving for GitHub ---------------------------------------------------------------------
  const crossOrigin = await browser(base).call("/api/auth/github/start", { ...post({ intent: "login" }), headers: { origin: "http://evil.example" } });
  r.check("a page on another origin cannot start a sign-in", crossOrigin.status === 403);
  const elsewhere = await browser(base).call("/api/auth/github/start", {
    ...post({ intent: "login" }),
    headers: { "x-forwarded-host": "other.example", "x-forwarded-proto": "https" },
  });
  r.check(
    "from another address the panel says where to go instead of leaving",
    elsewhere.status === 409 && elsewhere.body?.code === "wrong_origin" && elsewhere.body?.url === `${base}/login`,
    JSON.stringify(elsewhere.body)
  );

  // --- a GitHub account linked to nobody ------------------------------------------------------
  const strangerBrowser = browser(base);
  const stranger = await trip(strangerBrowser, { intent: "login" }, { id: 9001, login: "stranger" });
  r.check("the authorization asks for read:user only, with PKCE", fake.scopes.at(-1) === "read:user" && stranger.authorize.searchParams.get("code_challenge_method") === "S256");
  r.check("GitHub sends the browser back to the callback", stranger.githubStatus === 302 && stranger.returnPath.startsWith("/api/auth/github/callback?code="), stranger.returnPath);
  r.check("an unlinked GitHub account is refused, by code, on the sign-in page", stranger.landing === "/login?github=unlinked", String(stranger.landing));
  r.check("and gets no session", (await me(strangerBrowser)) === null);
  r.check("nor a half-finished one", (await finish(strangerBrowser)).status === 401);

  // --- linking, from the account page ----------------------------------------------------------
  r.check("linking needs a session", (await browser(base).call("/api/auth/github/start", post({ intent: "link", password: "owner-pw-1234" }))).status === 401);
  r.check("and the password again", (await owner.call("/api/auth/github/start", post({ intent: "link", password: "wrong-pw" }))).status === 401);
  const ownerGithub = { id: 1001, login: "octo-owner" };
  const linked = await trip(owner, { intent: "link", password: "owner-pw-1234" }, ownerGithub);
  r.check("the link comes back to the account page", linked.landing === "/account?github=linked", String(linked.landing));
  let mine = await owner.call("/api/auth/github");
  r.check("the account shows the linked GitHub account", mine.body?.linked?.login === "octo-owner" && mine.body?.available === true, JSON.stringify(mine.body));
  const linkedToken = fake.issued.at(-1);
  let revoked = false;
  for (let i = 0; i < 20 && !revoked; i++) {
    revoked = fake.revoked.includes(linkedToken);
    if (!revoked) await sleep(100);
  }
  r.check("the token GitHub gave is revoked once read", revoked);
  r.check("and no longer works at GitHub", (await fetch(`${fake.url}/user`, { headers: { authorization: `Bearer ${linkedToken}` } })).status === 401);
  const again = await owner.call("/api/auth/github/start", post({ intent: "link", password: "owner-pw-1234" }));
  r.check("a second link over the first is refused", again.status === 409, JSON.stringify(again.body));

  // --- signing in with it ----------------------------------------------------------------------
  const laptop = browser(base);
  const signIn = await trip(laptop, { intent: "login", next: "/projects" }, ownerGithub);
  r.check("a linked account goes on to finish on the sign-in page", signIn.landing === "/login?github=continue&next=%2Fprojects", String(signIn.landing));
  const flowCookie = signIn.start.setCookies.find((line) => line.startsWith("runpanel_github_flow=")) ?? "";
  r.check(
    "the browser's binding is httpOnly, Lax, and sent only to the callback",
    /;\s*HttpOnly/i.test(flowCookie) && /;\s*SameSite=Lax/i.test(flowCookie) && /;\s*Path=\/api\/auth\/github\/callback/i.test(flowCookie),
    flowCookie
  );
  const pendingCookie = signIn.callback.setCookies.find((line) => line.startsWith("runpanel_github_pending=")) ?? "";
  r.check(
    "the sign-in waiting to be finished is httpOnly, Strict, and sent only to the step that finishes it",
    /;\s*HttpOnly/i.test(pendingCookie) && /;\s*SameSite=Strict/i.test(pendingCookie) && /;\s*Path=\/api\/auth\/github\/continue/i.test(pendingCookie),
    pendingCookie
  );
  r.check("the return clears the binding", signIn.callback.setCookies.some((line) => /^runpanel_github_flow=;/.test(line) || /^runpanel_github_flow=.*Max-Age=0/i.test(line)));
  r.check("no session before the page finishes it", (await me(laptop)) === null && laptop.has("runpanel_github_pending"));
  const done = await finish(laptop);
  r.check("finishing opens the session", done.status === 200 && done.body?.success === true, JSON.stringify(done.body));
  r.check("as the owner", (await me(laptop))?.isOwner === true);
  r.check("the half-finished sign-in is spent", (await finish(laptop)).status === 401);
  const offsite = await trip(browser(base), { intent: "login", next: "//evil.example/x" }, ownerGithub);
  r.check("a next page off the panel is dropped", offsite.landing === "/login?github=continue", String(offsite.landing));

  // --- the state ------------------------------------------------------------------------------------
  const tamper = browser(base);
  const tampered = await trip(tamper, { intent: "login" }, ownerGithub, { skipCallback: true });
  const forged = tampered.returnPath.replace(/state=[^&]+/, `state=${randomBytes(32).toString("base64url")}`);
  const exchangesBeforeForged = fake.exchanges.length;
  const forgedReturn = await tamper.call(forged);
  r.check("a return with a state the panel did not issue opens nothing", forgedReturn.location === "/login?github=expired" && (await me(tamper)) === null, String(forgedReturn.location));
  r.check("and its code is never even taken to GitHub", fake.exchanges.length === exchangesBeforeForged);

  const victim = browser(base);
  const victimTrip = await trip(victim, { intent: "login" }, ownerGithub, { skipCallback: true });
  const attacker = browser(base);
  const stolen = await attacker.call(victimTrip.returnPath);
  r.check("a return brought to another browser opens nothing there", stolen.location === "/login?github=expired" && (await me(attacker)) === null, String(stolen.location));
  // Login CSRF: the attacker's own return, planted in the victim's browser.
  const planted = await trip(attacker, { intent: "login" }, { id: 9001, login: "stranger" }, { skipCallback: true });
  const plantedReturn = await victim.call(planted.returnPath);
  r.check("another browser's return planted in this one opens nothing", plantedReturn.location === "/login?github=expired" && (await me(victim)) === null, String(plantedReturn.location));
  r.check("and does not cost this browser its own sign-in under way", victim.has("runpanel_github_flow"));
  const rightful = await victim.call(victimTrip.returnPath);
  r.check("and does not spend the sign-in of the browser that left", rightful.location === "/login?github=continue", String(rightful.location));
  r.check("which finishes it", (await finish(victim)).body?.success === true && (await me(victim))?.isOwner === true);
  const bare = await browser(base).call(`/api/auth/github/callback?code=abc&state=${randomBytes(32).toString("base64url")}`);
  r.check("a return with no cookie at all is refused", bare.status === 303 && bare.location === "/login?github=expired", `${bare.status} ${bare.location}`);

  // --- a code is good once --------------------------------------------------------------------------
  // Signed in by now, so the refusal lands on the account page rather than the sign-in page.
  const sessionsBefore = (await owner.call("/api/sessions")).body?.sessions?.length;
  const replayed = await victim.call(victimTrip.returnPath);
  r.check("the same return replayed is refused", replayed.location === "/account?github=expired", String(replayed.location));
  r.check("and opens no session", (await owner.call("/api/sessions")).body?.sessions?.length === sessionsBefore && (await finish(victim)).status === 401);
  const reuse = browser(base);
  const fresh = await trip(reuse, { intent: "login" }, ownerGithub, { skipCallback: true });
  const usedCode = new URLSearchParams(victimTrip.returnPath.split("?")[1]).get("code");
  const withOldCode = fresh.returnPath.replace(/code=[^&]+/, `code=${usedCode}`);
  const exchangesBefore = fake.exchanges.length;
  const reused = await reuse.call(withOldCode);
  r.check("a code already exchanged is refused by GitHub, and so by the panel", reused.location === "/login?github=github" && fake.exchanges.slice(exchangesBefore).includes("bad_verification_code"), `${reused.location} ${fake.exchanges.slice(exchangesBefore)}`);
  r.check("and opens no session", (await me(reuse)) === null && (await finish(reuse)).status === 401);

  // --- saying no on GitHub ------------------------------------------------------------------------------
  const denied = await trip(browser(base), { intent: "login" }, ownerGithub, { deny: true });
  r.check("cancelling on GitHub comes back as cancelled", denied.landing === "/login?github=denied", String(denied.landing));

  // --- the second step after GitHub ----------------------------------------------------------------------
  const invited = await owner.call("/api/users", post({ email: "member@runpanel.test", hours: 24 }));
  const memberId = invited.body?.user?.id;
  const memberToken = String(invited.body?.invitePath ?? "").split("/").pop();
  const member = browser(base);
  await member.call("/api/auth/invite", post({ token: memberToken, password: "member-pw-1234" }));
  const setup = await member.call("/api/auth/two-factor", post({ action: "setup", password: "member-pw-1234" }));
  const key = totp.base32Decode(setup.body?.secret ?? "");
  const step = () => totp.totpStep(Date.now());
  let used = step();
  await member.call("/api/auth/two-factor", post({ action: "enable", code: totp.hotp(key, used) }));
  r.check("the member has two-step sign-in on", (await member.call("/api/auth/two-factor")).body?.enabled === true);
  const memberGithub = { id: 2002, login: "octo-member" };
  const memberLink = await trip(member, { intent: "link", password: "member-pw-1234" }, memberGithub);
  r.check("the member links GitHub", memberLink.landing === "/account?github=linked", String(memberLink.landing));

  const phone = browser(base);
  const twoStep = await trip(phone, { intent: "login" }, memberGithub);
  r.check("GitHub alone does not get past the second step", twoStep.landing === "/login?github=continue");
  const asked = await finish(phone);
  r.check("finishing asks for the code", asked.status === 200 && asked.body?.twoFactorRequired === true && typeof asked.body?.challenge === "string", JSON.stringify(asked.body));
  r.check("with no session yet", (await me(phone)) === null);
  const wrongCode = ["111111", "222222"].find((c) => ![-1, 0, 1].some((d) => totp.hotp(key, step() + d) === c));
  r.check("a wrong code is refused", (await phone.call("/api/auth/login/two-factor", post({ challenge: asked.body?.challenge, code: wrongCode }))).status === 401);
  used += 1;
  const coded = await phone.call("/api/auth/login/two-factor", post({ challenge: asked.body?.challenge, code: totp.hotp(key, used), remember: true }));
  r.check("the right code opens the session", coded.status === 200 && coded.body?.success === true && (await me(phone))?.id === memberId, JSON.stringify(coded.body));
  await phone.call("/api/auth/logout", post({}));
  const rememberedTrip = await trip(phone, { intent: "login" }, memberGithub);
  const rememberedDone = await finish(phone);
  r.check(
    "a remembered browser skips the code after GitHub too",
    rememberedTrip.landing === "/login?github=continue" && rememberedDone.body?.success === true && !rememberedDone.body?.twoFactorRequired,
    JSON.stringify(rememberedDone.body)
  );
  const otherPhone = browser(base);
  await trip(otherPhone, { intent: "login" }, memberGithub);
  r.check("but not another browser", (await finish(otherPhone)).body?.twoFactorRequired === true);

  // --- a disabled user ------------------------------------------------------------------------------------------
  await owner.call(`/api/users/${memberId}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) });
  const disabledBrowser = browser(base);
  const disabledTrip = await trip(disabledBrowser, { intent: "login" }, memberGithub);
  r.check("a disabled user is refused, like an unknown account", disabledTrip.landing === "/login?github=unlinked", String(disabledTrip.landing));
  r.check("with no session", (await me(disabledBrowser)) === null && (await finish(disabledBrowser)).status === 401);
  const pendingBefore = browser(base);
  await owner.call(`/api/users/${memberId}`, { method: "PATCH", body: JSON.stringify({ disabled: false }) });
  await trip(pendingBefore, { intent: "login" }, memberGithub);
  await owner.call(`/api/users/${memberId}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) });
  r.check("a sign-in half way through when the account is disabled is not finished", (await finish(pendingBefore)).status === 401);
  await owner.call(`/api/users/${memberId}`, { method: "PATCH", body: JSON.stringify({ disabled: false }) });

  // --- an invitation accepted with GitHub -------------------------------------------------------------------------
  const invite = await owner.call("/api/users", post({ email: "github@runpanel.test", hours: 24 }));
  const inviteeId = invite.body?.user?.id;
  const inviteToken = String(invite.body?.invitePath ?? "").split("/").pop();
  const inviteeBrowser = browser(base);
  r.check("the invitation offers GitHub", (await inviteeBrowser.call(`/api/auth/invite?token=${inviteToken}`)).body?.github === true);
  const takenTrip = await trip(inviteeBrowser, { intent: "invite", token: inviteToken }, ownerGithub);
  r.check(
    "a GitHub account already linked to someone cannot accept it",
    takenTrip.landing === `/invite/${inviteToken}?github=taken`,
    String(takenTrip.landing)
  );
  r.check("and the invitation is still there to use", (await inviteeBrowser.call(`/api/auth/invite?token=${inviteToken}`)).status === 200);
  const inviteeGithub = { id: 3003, login: "octo-invitee" };
  const accepted = await trip(inviteeBrowser, { intent: "invite", token: inviteToken }, inviteeGithub);
  r.check("accepted with GitHub, it goes on to finish the sign-in", accepted.landing === "/login?github=continue", String(accepted.landing));
  r.check("which signs the new user in", (await finish(inviteeBrowser)).body?.success === true && (await me(inviteeBrowser))?.id === inviteeId);
  r.check("the invitation is spent", (await browser(base).call(`/api/auth/invite?token=${inviteToken}`)).status === 400);
  let users = (await owner.call("/api/users")).body?.users ?? [];
  let invitee = users.find((u) => u.id === inviteeId);
  r.check(
    "the team page shows it active, with GitHub and no password",
    invitee?.status === "active" && invitee?.githubLogin === "octo-invitee" && invitee?.hasPassword === false,
    JSON.stringify(invitee)
  );
  r.check("and which users have GitHub", users.find((u) => u.isOwner)?.githubLogin === "octo-owner" && users.find((u) => u.id === memberId)?.githubLogin === "octo-member");
  r.check("a reset link would ask it for a password", (await owner.call(`/api/users/${inviteeId}/invite`, post({ hours: 1 }))).body?.kind === "reset");
  const resetToken = String((await owner.call(`/api/users/${inviteeId}/invite`, post({ hours: 1 }))).body?.invitePath ?? "").split("/").pop();
  r.check("a reset link never offers GitHub", (await browser(base).call(`/api/auth/invite?token=${resetToken}`)).body?.github === false);
  r.check("nor can it be spent with GitHub", (await browser(base).call("/api/auth/github/start", post({ intent: "invite", token: resetToken }))).status === 400);

  // --- nobody is locked out ---------------------------------------------------------------------------------------------
  const unlinkAlone = await inviteeBrowser.call("/api/auth/github", { method: "DELETE" });
  r.check("an account with only GitHub cannot unlink it", unlinkAlone.status === 409 && unlinkAlone.body?.code === "password_required", JSON.stringify(unlinkAlone.body));
  const offRefused = await owner.call("/api/github-login", put({ enabled: false }));
  r.check(
    "turning GitHub off is refused while someone has nothing else, and names them",
    offRefused.status === 409 && offRefused.body?.code === "passwordless_users" && offRefused.body?.users?.some((u) => u.id === inviteeId),
    JSON.stringify(offRefused.body)
  );
  r.check("so it stays on", (await owner.call("/api/github-login")).body?.enabled === true);

  const storeFile = join(dataDir, "runpanel.db");
  if (existsSync(storeFile)) {
    // Ten minutes are not waited for: the session is made old in the store.
    const Database = (await import("better-sqlite3")).default;
    const store = new Database(storeFile);
    store.prepare("UPDATE sessions SET created_at = ? WHERE user_id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), inviteeId);
    store.close();
    const stale = await inviteeBrowser.call("/api/account", { method: "PATCH", body: JSON.stringify({ newPassword: "invitee-pw-1" }) });
    r.check("an old session cannot choose the first password", stale.status === 403 && stale.body?.code === "reauth_required", JSON.stringify(stale.body));
    await trip(inviteeBrowser, { intent: "login", next: "/account" }, inviteeGithub);
    await finish(inviteeBrowser);
  }
  const firstPassword = await inviteeBrowser.call("/api/account", { method: "PATCH", body: JSON.stringify({ newPassword: "invitee-pw-1" }) });
  r.check("right after a sign-in it can", firstPassword.status === 200, JSON.stringify(firstPassword.body));
  r.check("and reads as having one", (await inviteeBrowser.call("/api/account")).body?.hasPassword === true);
  r.check("with it, it signs in by password", (await browser(base).call("/api/auth/login", post({ email: "github@runpanel.test", password: "invitee-pw-1" }))).body?.success === true);
  const offForced = await owner.call("/api/github-login", put({ enabled: false }));
  r.check("now GitHub can be turned off", offForced.status === 200 && offForced.body?.enabled === false, JSON.stringify(offForced.body));
  r.check("the sign-in page stops offering it", (await browser(base).call("/api/auth/check")).body?.github === false);
  const whenOff = await browser(base).call("/api/auth/github/start", post({ intent: "login" }));
  r.check("and no sign-in starts", whenOff.status === 409 && whenOff.body?.code === "off");

  // A return that left before the switch is not let in after it.
  await owner.call("/api/github-login", put({ enabled: true }));
  const inFlight = browser(base);
  const inFlightTrip = await trip(inFlight, { intent: "login" }, ownerGithub, { skipCallback: true });
  await owner.call("/api/github-login", put({ enabled: false }));
  const lateReturn = await inFlight.call(inFlightTrip.returnPath);
  r.check("a return after GitHub was turned off opens nothing", lateReturn.location === "/login?github=off" && (await me(inFlight)) === null, String(lateReturn.location));
  await owner.call("/api/github-login", put({ enabled: true }));

  // --- unlinking ------------------------------------------------------------------------------------------------------------
  r.check("the owner can unlink", (await owner.call("/api/auth/github", { method: "DELETE" })).status === 200);
  mine = await owner.call("/api/auth/github");
  r.check("and the account shows nothing linked", mine.body?.linked === null);
  r.check("after which that GitHub account is a stranger", (await trip(browser(base), { intent: "login" }, ownerGithub)).landing === "/login?github=unlinked");

  // --- who may see and change it --------------------------------------------------------------------------------------------
  // The invitee: signed in, not the owner (the member was signed out when disabled).
  r.check("only the owner reads the settings", (await inviteeBrowser.call("/api/github-login")).status === 403);
  r.check("or changes them", (await inviteeBrowser.call("/api/github-login", put({ enabled: false }))).status === 403);
  await owner.call("/api/api-tokens", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  const minted = await owner.call("/api/api-tokens", post({ name: "ci", access: "full", expiresInDays: 30 }));
  const bearer = { authorization: `Bearer ${minted.body?.token}` };
  r.check("an API token is not a session for one's own GitHub link", (await fetch(`${base}/api/auth/github`, { headers: bearer })).status === 401);
  r.check(
    "nor can it start a link",
    (await fetch(`${base}/api/auth/github/start`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ intent: "link", password: "owner-pw-1234" }) })).status === 401
  );

  // --- the activity log --------------------------------------------------------------------------------------------------------
  const log = (await owner.call("/api/audit?limit=200")).body?.entries ?? [];
  const has = (action, detail) => log.some((e) => e.action === action && (!detail || String(e.detail ?? "").includes(detail)));
  r.check("the log has the links and the unlink", has("account.github.link", "octo-owner") && has("account.github.link", "octo-invitee") && has("account.github.unlink", "octo-owner"));
  r.check("the sign-ins through GitHub", has("auth.login", "con GitHub") && has("auth.login", "con GitHub e la verifica in due passaggi"));
  r.check("the refusals", has("auth.github.refused", "stranger") && has("auth.github.refused", "account disattivato") && has("auth.github.refused", "ritorno da GitHub") && has("auth.github.refused", "bad_verification_code"));
  r.check("the invitation accepted with GitHub", has("auth.invite.redeemed", "con GitHub @octo-invitee"));
  r.check("and the owner's settings", has("github-login.settings") && has("github-login.enable") && has("github-login.disable") && has("github-login.verify"));
  r.check("never the secret or a token", !JSON.stringify(log).includes(CLIENT_SECRET) && !fake.issued.some((t) => JSON.stringify(log).includes(t)));

  return r.result();
}
