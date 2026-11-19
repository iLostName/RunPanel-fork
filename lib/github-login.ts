import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { decrypt, encrypt } from "./crypto";
import { getDb, nowIso, rowCount } from "./db";
import { getSetting, setSetting } from "./settings";
import { generateId } from "./utils";
import { inspectInvite } from "./users";
import { hashToken } from "./auth";
import {
  FLOW_TTL_MS,
  authorizeUrl,
  githubEndpoints,
  isPkceVerifier,
  matchesHash,
  newFlowSecrets,
  parseGithubUser,
  parseTokenResponse,
  randomToken,
  readVerifyAnswer,
  sha256Hex,
  type FlowIntent,
  type GithubEndpoints,
  type GithubIdentity,
  type TokenResult,
  type VerifyOutcome,
} from "./github-oauth";

/**
 * Signing in with GitHub, the panel's half: the OAuth App the owner sets up,
 * the sign-ins between leaving for GitHub and coming back, the accounts linked
 * to users, and the three requests to GitHub. The protocol's rules are
 * lib/github-oauth.ts; the routes are `app/api/auth/github/**` (sign-in, link)
 * and `app/api/github-login` (the owner's settings).
 *
 * A GitHub account never creates a user. It is linked to one that exists —
 * from the account page while signed in, or by accepting an invitation — and
 * matched afterwards by GitHub's numeric id alone. The token GitHub returns is
 * used once to read that id, then revoked and forgotten.
 *
 * All of it stays on this panel, like two-step sign-in: the OAuth App names
 * this panel's address, and `users` is the only row the cluster replicates.
 */

// --- the OAuth App ------------------------------------------------------------------

export const GITHUB_LOGIN_SETTING = "github_login";
export const GITHUB_LOGIN_SECRET_SETTING = "github_login_secret";
/** Key purposes (lib/crypto.ts): the secret and a sign-in's sealed values open as nothing else. */
const SECRET_PURPOSE = "github-login";
const FLOW_PURPOSE = "github-login-flow";

interface StoredApp {
  clientId: string;
  enabled: boolean;
  /** The Authorization callback URL the owner was shown, and registered on GitHub. */
  callbackUrl: string;
  updatedAt: string;
}

export interface GithubLoginConfig extends StoredApp {
  /** Null when there is none, or it was sealed with a key this panel no longer has. */
  secret: string | null;
  secretUnreadable: boolean;
}

function parseStoredApp(raw: string | null): StoredApp | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredApp>;
    if (typeof value.clientId !== "string" || !value.clientId || typeof value.callbackUrl !== "string") return null;
    return {
      clientId: value.clientId,
      enabled: value.enabled === true,
      callbackUrl: value.callbackUrl,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export async function readGithubLoginConfig(): Promise<GithubLoginConfig | null> {
  const [raw, sealed] = await Promise.all([getSetting(GITHUB_LOGIN_SETTING), getSetting(GITHUB_LOGIN_SECRET_SETTING)]);
  const app = parseStoredApp(raw);
  if (!app) return null;
  let secret: string | null = null;
  if (sealed) {
    try {
      secret = decrypt(sealed, SECRET_PURPOSE);
    } catch {
      // Sealed under another RUNPANEL_SECRET, after a restore elsewhere.
      secret = null;
    }
  }
  return { ...app, secret, secretUnreadable: Boolean(sealed) && secret === null };
}

/** Configured with a secret this panel can read: GitHub would accept a sign-in. */
export function isGithubLoginReady(config: GithubLoginConfig | null): config is GithubLoginConfig & { secret: string } {
  return Boolean(config && config.clientId && config.secret && config.callbackUrl);
}

/** Whether "Accedi con GitHub" is offered: ready, and switched on by the owner. */
export async function githubLoginAvailable(): Promise<boolean> {
  const config = await readGithubLoginConfig().catch(() => null);
  return isGithubLoginReady(config) && config.enabled;
}

/**
 * Save the app. A secret left out keeps the stored one; the callback URL is
 * the one worked out for this save, so it always names the address the owner
 * was shown. Whether sign-ins are allowed is not touched here.
 */
export async function saveGithubLoginApp(input: { clientId: string; secret?: string; callbackUrl: string }): Promise<void> {
  const current = parseStoredApp(await getSetting(GITHUB_LOGIN_SETTING));
  const app: StoredApp = {
    clientId: input.clientId,
    enabled: current?.enabled ?? false,
    callbackUrl: input.callbackUrl,
    updatedAt: nowIso(),
  };
  if (input.secret) await setSetting(GITHUB_LOGIN_SECRET_SETTING, encrypt(input.secret, SECRET_PURPOSE));
  await setSetting(GITHUB_LOGIN_SETTING, JSON.stringify(app));
}

export async function setGithubLoginEnabled(enabled: boolean): Promise<void> {
  const current = parseStoredApp(await getSetting(GITHUB_LOGIN_SETTING));
  if (!current) return;
  await setSetting(GITHUB_LOGIN_SETTING, JSON.stringify({ ...current, enabled, updatedAt: nowIso() }));
}

/** Forget the app. The links stay: GitHub's ids are the same for any app, so a new one finds them. */
export async function clearGithubLoginConfig(): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("settings").where("key", "in", [GITHUB_LOGIN_SETTING, GITHUB_LOGIN_SECRET_SETTING]).execute();
  await db.deleteFrom("github_login_states").execute();
}

// --- where GitHub is -----------------------------------------------------------------

let warned = false;

/** The real GitHub, unless the test suite's stand-in is fenced in (lib/github-oauth.ts). */
export function endpoints(): GithubEndpoints {
  const found = githubEndpoints(process.env);
  if (found.overridden && !warned) {
    warned = true;
    console.warn(`[RunPanel] GitHub sign-in is talking to ${found.web}, a test stand-in. Never on a real panel.`);
  }
  return found;
}

// --- the address a request came from ------------------------------------------------------

/**
 * The origin the browser is on. `Origin` when it sent one — a sign-in starts
 * with a POST, which always has it — else the forwarded or direct host, for a
 * client that is not a browser.
 */
export function requestOrigin(request: NextRequest): string | null {
  const sent = request.headers.get("origin");
  if (sent && sent !== "null") {
    try {
      return new URL(sent).origin;
    } catch {
      return null;
    }
  }
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  if (!host) return null;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (request.url.startsWith("https:") ? "https" : "http");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

// --- one sign-in, between leaving and coming back ------------------------------------------------

export interface FlowStart {
  intent: FlowIntent;
  /** The signed-in user a link is for. */
  userId: string | null;
  /** The invitation being accepted. Sealed in the row, never stored readable. */
  inviteToken: string | null;
  next: string | null;
  redirectUri: string;
}

/** Leave for GitHub: the URL to send the browser to, and the binding for its cookie. */
export async function beginFlow(
  config: GithubLoginConfig & { secret: string },
  start: FlowStart
): Promise<{ url: string; binding: string }> {
  const secrets = newFlowSecrets();
  const now = Date.now();
  const db = await getDb();
  // Nothing else reaps them; a sign-in abandoned on GitHub's page leaves one.
  await db.deleteFrom("github_login_states").where("expires_at", "<", new Date(now).toISOString()).execute();
  await db
    .insertInto("github_login_states")
    .values({
      id: generateId(),
      state_hash: sha256Hex(secrets.state),
      binding_hash: sha256Hex(secrets.binding),
      intent: start.intent,
      user_id: start.userId,
      sealed: encrypt(JSON.stringify({ verifier: secrets.verifier, invite: start.inviteToken }), FLOW_PURPOSE),
      redirect_uri: start.redirectUri,
      next_path: start.next,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + FLOW_TTL_MS).toISOString(),
    })
    .execute();

  const url = authorizeUrl({
    web: endpoints().web,
    clientId: config.clientId,
    redirectUri: start.redirectUri,
    state: secrets.state,
    challenge: secrets.challenge,
  });
  return { url, binding: secrets.binding };
}

export interface ClaimedFlow {
  intent: FlowIntent;
  userId: string | null;
  inviteToken: string | null;
  next: string | null;
  redirectUri: string;
  verifier: string;
}

const INTENTS = new Set<string>(["login", "link", "invite"]);

/**
 * The sign-in a return names — spent, so the same return cannot be replayed —
 * or null. Null for a state nobody issued, one that expired, one already used,
 * and one that came back to a browser other than the one that left: the
 * binding in that browser's cookie must be the one the row was made with. A
 * mismatch leaves the row alone, so whoever sent a stray return cannot spend
 * the sign-in of the browser it belongs to.
 */
export async function claimFlow(state: unknown, binding: unknown): Promise<ClaimedFlow | null> {
  if (typeof state !== "string" || state.length < 20 || state.length > 128) return null;
  if (typeof binding !== "string" || binding.length < 20 || binding.length > 128) return null;
  const db = await getDb();
  const row = await db
    .selectFrom("github_login_states")
    .selectAll()
    .where("state_hash", "=", sha256Hex(state))
    .executeTakeFirst();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.deleteFrom("github_login_states").where("id", "=", row.id).execute();
    return null;
  }
  if (!matchesHash(binding, row.binding_hash)) return null;
  const spent = await db.deleteFrom("github_login_states").where("id", "=", row.id).executeTakeFirst();
  if (rowCount(spent) === 0) return null;
  if (!INTENTS.has(row.intent)) return null;

  let sealed: { verifier?: unknown; invite?: unknown };
  try {
    sealed = JSON.parse(decrypt(row.sealed, FLOW_PURPOSE)) as { verifier?: unknown; invite?: unknown };
  } catch {
    return null;
  }
  if (!isPkceVerifier(sealed.verifier)) return null;
  return {
    intent: row.intent as FlowIntent,
    userId: row.user_id,
    inviteToken: typeof sealed.invite === "string" ? sealed.invite : null,
    next: row.next_path,
    redirectUri: row.redirect_uri,
    verifier: sealed.verifier,
  };
}

// --- the cookies -------------------------------------------------------------------------

/** Holds the binding between leaving and coming back. Sent only to the callback. */
const FLOW_COOKIE = "runpanel_github_flow";
const FLOW_COOKIE_PATH = "/api/auth/github/callback";
/**
 * Holds the sign-in after GitHub, until the page finishes it. Sent only to the
 * route that does, and only from the panel's own pages (`Strict`): that route
 * is also where the remembered-device cookie, `Strict` too, can be read.
 */
const PENDING_COOKIE = "runpanel_github_pending";
const PENDING_COOKIE_PATH = "/api/auth/github/continue";
const PENDING_SECONDS = 5 * 60;

/**
 * `Secure` from the callback's own scheme. The sign-in starts and ends on the
 * callback's origin, so it is the scheme the browser is on — and the return
 * from GitHub is a navigation, which carries no `Origin` to tell it from.
 */
function secureFor(redirectUri: string): boolean {
  return redirectUri.startsWith("https:");
}

/**
 * `Lax`, not `Strict`: the return is a navigation that GitHub starts, and a
 * `Strict` cookie is not sent on it — the sign-in would always look as if it
 * came back to another browser.
 */
export async function setFlowCookie(binding: string, redirectUri: string): Promise<void> {
  (await cookies()).set(FLOW_COOKIE, binding, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureFor(redirectUri),
    maxAge: FLOW_TTL_MS / 1000,
    path: FLOW_COOKIE_PATH,
  });
}

/** The binding this browser holds, if any; the cookie goes either way. */
export async function takeFlowCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(FLOW_COOKIE)?.value ?? null;
  if (value !== null) store.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", maxAge: 0, path: FLOW_COOKIE_PATH });
  return value;
}

export async function setPendingCookie(token: string, redirectUri: string): Promise<void> {
  (await cookies()).set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureFor(redirectUri),
    maxAge: PENDING_SECONDS,
    path: PENDING_COOKIE_PATH,
  });
}

export async function takePendingCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(PENDING_COOKIE)?.value ?? null;
  if (value !== null) store.set(PENDING_COOKIE, "", { httpOnly: true, sameSite: "strict", maxAge: 0, path: PENDING_COOKIE_PATH });
  return value;
}

// --- the three requests to GitHub -------------------------------------------------------------

const TIMEOUT_MS = 10_000;
const USER_AGENT = "RunPanel";

async function exchange(
  config: GithubLoginConfig & { secret: string },
  fields: Record<string, string>
): Promise<TokenResult> {
  try {
    const res = await fetch(new URL("/login/oauth/access_token", endpoints().web), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.secret, ...fields }).toString(),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return parseTokenResponse(res.status, body);
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

/** Trade the code for a token, with the verifier that proves this panel began the sign-in. */
export function exchangeCode(
  config: GithubLoginConfig & { secret: string },
  input: { code: string; redirectUri: string; verifier: string }
): Promise<TokenResult> {
  return exchange(config, { code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier });
}

/** Who the token belongs to: its id and login, read once. */
export async function fetchIdentity(token: string): Promise<GithubIdentity | null> {
  try {
    const res = await fetch(new URL("/user", endpoints().api), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseGithubUser(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Revoke the token at GitHub. A token of an OAuth App does not expire by
 * itself, and this one has done its only job: not storing it is half of
 * discarding it, this is the other half. Off the request path and best
 * effort — a sign-in does not wait for it, nor fail with it.
 */
export function revokeToken(config: GithubLoginConfig & { secret: string }, token: string): void {
  const basic = Buffer.from(`${config.clientId}:${config.secret}`).toString("base64");
  void fetch(new URL(`/applications/${encodeURIComponent(config.clientId)}/token`, endpoints().api), {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ access_token: token }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}

/** "Verifica": exchange a code nobody was given, and read what GitHub objects to. */
export async function verifyGithubApp(config: GithubLoginConfig & { secret: string }): Promise<VerifyOutcome | "unreachable"> {
  const result = await exchange(config, { code: `runpanel-verify-${randomToken()}`, redirect_uri: config.callbackUrl });
  if (!result.ok && result.error === "unreachable") return "unreachable";
  return readVerifyAnswer(result);
}

// --- linked accounts ---------------------------------------------------------------------------

export interface GithubLink {
  githubId: string;
  login: string;
  linkedAt: string;
  lastUsedAt: string | null;
}

export async function githubLinkOf(userId: string): Promise<GithubLink | null> {
  const db = await getDb();
  const row = await db.selectFrom("user_github").selectAll().where("user_id", "=", userId).executeTakeFirst();
  return row ? { githubId: row.github_id, login: row.github_login, linkedAt: row.linked_at, lastUsedAt: row.last_used_at } : null;
}

/** The user a GitHub account is linked to, by its numeric id — never by its login. */
export async function userIdForGithub(githubId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.selectFrom("user_github").select("user_id").where("github_id", "=", githubId).executeTakeFirst();
  return row?.user_id ?? null;
}

export type LinkOutcome = "linked" | "same" | "taken" | "already";

/**
 * Link a GitHub account to a user. `taken` when it already belongs to another
 * user, `already` when this user has a different one; `same` refreshes the
 * login of the one they have.
 */
export async function linkGithub(userId: string, identity: GithubIdentity): Promise<LinkOutcome> {
  const db = await getDb();
  const mine = await db.selectFrom("user_github").select("github_id").where("user_id", "=", userId).executeTakeFirst();
  if (mine) {
    if (mine.github_id !== identity.id) return "already";
    await db.updateTable("user_github").set({ github_login: identity.login }).where("user_id", "=", userId).execute();
    return "same";
  }
  const owner = await userIdForGithub(identity.id);
  if (owner) return owner === userId ? "same" : "taken";
  try {
    await db
      .insertInto("user_github")
      .values({ user_id: userId, github_id: identity.id, github_login: identity.login, linked_at: nowIso(), last_used_at: null })
      .execute();
    return "linked";
  } catch {
    // Linked elsewhere in the instant between the check and the insert: the
    // unique index decided.
    return "taken";
  }
}

export async function unlinkGithub(userId: string): Promise<GithubLink | null> {
  const link = await githubLinkOf(userId);
  if (!link) return null;
  const db = await getDb();
  await db.deleteFrom("user_github").where("user_id", "=", userId).execute();
  return link;
}

/** The login as GitHub spells it today: people rename themselves. */
export async function refreshGithubLogin(userId: string, login: string): Promise<void> {
  const db = await getDb();
  await db.updateTable("user_github").set({ github_login: login }).where("user_id", "=", userId).execute();
}

/** A session was opened through the link. */
export async function markGithubSignIn(userId: string): Promise<void> {
  const db = await getDb();
  await db.updateTable("user_github").set({ last_used_at: nowIso() }).where("user_id", "=", userId).execute();
}

/**
 * The users who could not get in without GitHub: linked, active, and with no
 * password. Turning GitHub sign-in off would shut them out.
 */
export async function passwordlessGithubUsers(): Promise<Array<{ id: string; email: string | null; githubLogin: string }>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("user_github")
    .innerJoin("users", "users.id", "user_github.user_id")
    .select(["users.id", "users.email", "user_github.github_login"])
    .where("users.password_hash", "is", null)
    .where("users.disabled", "=", 0)
    .orderBy("users.email", "asc")
    .execute();
  return rows.map((row) => ({ id: row.id, email: row.email, githubLogin: row.github_login }));
}

export async function countGithubLinks(): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("user_github")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

// --- an invitation accepted with GitHub ----------------------------------------------------------

class Refused extends Error {
  constructor(readonly reason: "invite" | "taken" | "already") {
    super(reason);
  }
}

/**
 * Spend an invitation by linking a GitHub account instead of choosing a
 * password. Only an invitation, never a reset link: a reset is how a password
 * is chosen again. The claim and the link land together or not at all, so a
 * GitHub account already taken leaves the invitation usable for another try.
 */
export async function redeemInviteWithGithub(
  token: string,
  identity: GithubIdentity
): Promise<{ ok: true; userId: string } | { ok: false; reason: "invite" | "taken" | "already" }> {
  const invite = await inspectInvite(token);
  if (!invite || invite.kind !== "invite") return { ok: false, reason: "invite" };
  const db = await getDb();
  try {
    await db.transaction().execute(async (trx) => {
      const owner = await trx.selectFrom("user_github").select("user_id").where("github_id", "=", identity.id).executeTakeFirst();
      if (owner && owner.user_id !== invite.userId) throw new Refused("taken");
      const mine = await trx.selectFrom("user_github").select("github_id").where("user_id", "=", invite.userId).executeTakeFirst();
      if (mine && mine.github_id !== identity.id) throw new Refused("already");
      const claimed = await trx
        .updateTable("user_invites")
        .set({ used_at: nowIso() })
        .where("token_hash", "=", hashToken(token))
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (rowCount(claimed) === 0) throw new Refused("invite");
      if (!mine) {
        await trx
          .insertInto("user_github")
          .values({ user_id: invite.userId, github_id: identity.id, github_login: identity.login, linked_at: nowIso(), last_used_at: null })
          .execute();
      }
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Refused ? err.reason : "taken" };
  }
  return { ok: true, userId: invite.userId };
}
