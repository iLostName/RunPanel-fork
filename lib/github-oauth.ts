import crypto from "node:crypto";
import { isLoopbackHost } from "./cookie-security";

/**
 * Signing in with GitHub, the protocol half: OAuth 2.0's authorization code
 * flow with `state` and PKCE (RFC 7636), as GitHub's web flow speaks it. No
 * database, no cookies, no network — those are lib/github-login.ts. Only
 * `node:crypto` and a neighbour with no imports, so `github-login-unit` loads
 * it directly.
 *
 * Nothing here is the deploy token of lib/github.ts. That one is a credential
 * the panel keeps so it can clone; this is a person proving who they are, and
 * the token GitHub hands back for it is read once and thrown away.
 */

/** Where GitHub sends the browser back: the route, and the URL the owner registers. */
export const CALLBACK_PATH = "/api/auth/github/callback";

/**
 * What the panel asks GitHub for. It reads two fields of the profile, `id` and
 * `login`, and `read:user` is the narrowest named scope that covers them; no
 * `user:email`, because an account is never matched by an address.
 */
export const GITHUB_SCOPE = "read:user";

/** From leaving for GitHub to coming back. GitHub's own codes last as long. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

export const FLOW_INTENTS = ["login", "link", "invite"] as const;
export type FlowIntent = (typeof FLOW_INTENTS)[number];

// --- where GitHub is -----------------------------------------------------------

export interface GithubEndpoints {
  /** github.com: the authorization page and the code exchange. */
  web: string;
  /** api.github.com: the profile, and revoking the token. */
  api: string;
  /** Pointed at a stand-in by the test-only variable below. */
  overridden: boolean;
}

const REAL_ENDPOINTS: GithubEndpoints = { web: "https://github.com", api: "https://api.github.com", overridden: false };

/**
 * The test suite's stand-in for GitHub, and nothing else's.
 *
 * Whoever answers at these addresses decides who is signing in, so the
 * override is fenced three ways: a production build — every real panel —
 * ignores it unless `RUNPANEL_ALLOW_TEST_OVERRIDES=1` says so as well; the
 * address must be this machine's own loopback; and the panel prints a warning
 * at every sign-in while it is in effect. None of it is in the documentation:
 * an operator has no reason ever to set it.
 */
export const TEST_GITHUB_URL_ENV = "RUNPANEL_TEST_GITHUB_URL";
export const TEST_OVERRIDES_ENV = "RUNPANEL_ALLOW_TEST_OVERRIDES";

export function githubEndpoints(env: Readonly<Record<string, string | undefined>>): GithubEndpoints {
  const raw = env[TEST_GITHUB_URL_ENV]?.trim();
  if (!raw) return REAL_ENDPOINTS;
  if (env.NODE_ENV === "production" && env[TEST_OVERRIDES_ENV] !== "1") return REAL_ENDPOINTS;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REAL_ENDPOINTS;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) return REAL_ENDPOINTS;
  return { web: url.origin, api: url.origin, overridden: true };
}

// --- the random values of one sign-in --------------------------------------------

/** 32 random bytes, base64url: 43 characters. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** RFC 7636 §4.1: 43 to 128 characters of the unreserved set. */
export function isPkceVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** RFC 7636 §4.2, S256 — GitHub accepts no other method. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export interface FlowSecrets {
  /** Travels to GitHub and back in the URL; the stored row is found by its hash. */
  state: string;
  /** Stays in this browser, in an httpOnly cookie; the row keeps its hash. */
  binding: string;
  /** Stays on the server; GitHub only ever sees its hash, the challenge. */
  verifier: string;
  challenge: string;
}

/**
 * Three values, not one. The state is seen by GitHub, by the browser's
 * history, by anything that logs a URL, so it cannot also be what proves that
 * the return came back to the browser that left. That is the binding's job,
 * and it never leaves the cookie. The verifier is what makes a code that
 * leaked useless to anyone else: GitHub gives a token for a code only to the
 * one who can show the value its challenge was made from (PKCE).
 */
export function newFlowSecrets(): FlowSecrets {
  const verifier = randomToken();
  return { state: randomToken(), binding: randomToken(), verifier, challenge: pkceChallenge(verifier) };
}

/** Whether `value` is what a stored SHA-256 was made from, compared in constant time. */
export function matchesHash(value: unknown, hashHex: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  if (!/^[0-9a-f]{64}$/.test(hashHex)) return false;
  const given = Buffer.from(sha256Hex(value), "hex");
  const stored = Buffer.from(hashHex, "hex");
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

// --- the callback URL ----------------------------------------------------------------

export type CallbackUrl =
  | { ok: true; url: string; origin: string }
  | { ok: false; reason: "invalid" | "insecure"; origin: string | null };

/**
 * The Authorization callback URL for the address the panel is reached at.
 *
 * https; or plain http on this machine's own loopback names only, for trying
 * it out at http://127.0.0.1:3000. Anywhere else plain http would carry the
 * code GitHub hands back, and the session cookie that follows it, in the
 * clear: refused rather than offered as something to paste into GitHub.
 */
export function callbackUrlFor(origin: string | null | undefined): CallbackUrl {
  if (!origin) return { ok: false, reason: "invalid", origin: null };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid", origin: null };
  }
  if (url.username || url.password) return { ok: false, reason: "invalid", origin: null };
  if (url.protocol === "https:") return { ok: true, url: `${url.origin}${CALLBACK_PATH}`, origin: url.origin };
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return { ok: true, url: `${url.origin}${CALLBACK_PATH}`, origin: url.origin };
    return { ok: false, reason: "insecure", origin: url.origin };
  }
  return { ok: false, reason: "invalid", origin: null };
}

// --- talking to GitHub ------------------------------------------------------------------

/** GitHub's authorization page for one sign-in. */
export function authorizeUrl(input: {
  web: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL("/login/oauth/authorize", input.web);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", GITHUB_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // No detour to create a GitHub account: one made now is linked to nobody.
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export type TokenResult = { ok: true; token: string } | { ok: false; error: string };

/**
 * GitHub's answer to the exchange of a code. It refuses with 200 and an
 * `error` field (`bad_verification_code`, `incorrect_client_credentials`,
 * `redirect_uri_mismatch`…), so the field decides before the status does.
 */
export function parseTokenResponse(status: number, body: unknown): TokenResult {
  const fields = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof fields.error === "string" && fields.error) {
    return { ok: false, error: fields.error.replace(/[^a-z0-9_]/gi, "").slice(0, 64) || "error" };
  }
  if (status < 200 || status >= 300) return { ok: false, error: `http_${status}` };
  const token = fields.access_token;
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return { ok: false, error: "no_token" };
  return { ok: true, token };
}

export interface GithubIdentity {
  /** The numeric id, as decimal text: what an account is matched on. */
  id: string;
  login: string;
}

/** GitHub's own rule, loosely: up to 39 letters, digits and hyphens, not starting with a hyphen. */
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** The two fields of `GET /user` the panel reads, or null when the answer is not a profile. */
export function parseGithubUser(body: unknown): GithubIdentity | null {
  const fields = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = fields.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof fields.login !== "string" || !LOGIN_PATTERN.test(fields.login)) return null;
  return { id: String(id), login: fields.login };
}

export type VerifyOutcome = "ok" | "credentials" | "callback" | "unexpected";

/**
 * What exchanging a code nobody was given says about the app. Like any OAuth
 * server, GitHub authenticates the client before it looks for the code (RFC
 * 6749 §4.1.3): `bad_verification_code` means the Client ID and secret were
 * accepted, `incorrect_client_credentials` that they were not. The callback
 * URL is only really proven by a sign-in.
 */
export function readVerifyAnswer(result: TokenResult): VerifyOutcome {
  if (result.ok) return "unexpected";
  if (result.error === "bad_verification_code") return "ok";
  if (result.error === "incorrect_client_credentials") return "credentials";
  if (result.error === "redirect_uri_mismatch") return "callback";
  return "unexpected";
}

// --- where the browser lands --------------------------------------------------------

/**
 * Every way a return from GitHub can end, as the page it lands on reads it
 * (`?github=<code>`). Codes rather than sentences: a message carried in a URL
 * is a message anyone can write. The sentences are lib/github-login-messages.ts.
 */
export type FlowResult =
  | "continue"
  | "linked"
  | "unlinked"
  | "taken"
  | "already"
  | "denied"
  | "expired"
  | "github"
  | "off"
  | "session"
  | "invite"
  | "managed";

const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * The page a return lands on. A sign-in goes on to the sign-in page, which
 * finishes it (and asks for the code when the account has one); a link goes
 * back to the account page; an invitation that failed goes back to its own
 * page, where the person can try another way. `next` was checked when the
 * sign-in began, and the page checks it again before following it.
 */
export function landingPath(
  flow: { intent: FlowIntent; next: string | null; inviteToken: string | null },
  result: FlowResult
): string {
  if (flow.intent === "link") return `/account?github=${result}`;
  if (result === "continue") {
    return flow.next ? `/login?github=continue&next=${encodeURIComponent(flow.next)}` : "/login?github=continue";
  }
  if (flow.intent === "invite" && flow.inviteToken && INVITE_TOKEN.test(flow.inviteToken)) {
    return `/invite/${flow.inviteToken}?github=${result}`;
  }
  return `/login?github=${result}`;
}
