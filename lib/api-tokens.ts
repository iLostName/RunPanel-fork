import crypto from "crypto";

import type { SessionUser } from "./auth";
import { getSecret } from "./config";
import { getDb, nowIso } from "./db";
import type { ApiTokenAccess } from "./db/schema";
import { getSetting } from "./settings";
import { generateId } from "./utils";
import { authzEvents } from "@/services/events";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * Tokens for clients that are not a browser: an AI assistant over MCP
 * (`/api/mcp`), a script, a CI job. Sent as `Authorization: Bearer rpk_…`.
 *
 * A token is its user, minus whatever `access` takes away: every route still
 * runs its own guard against that user's grants, so a token can never do what
 * its owner could not. `read` takes away every write, and the proxy enforces
 * it on the method before any handler runs.
 *
 * Three switches, any one of which ends a token at once: the owner turning API
 * access off for the whole panel, the token's own revocation or expiry, and its
 * user being disabled or deleted.
 *
 * Checked twice, like the session cookie and the cluster signature. `proxy.ts`
 * looks the token up, applies `read`, and marks the request with an HMAC only
 * this panel can produce; `getSession()` accepts a bearer token only with that
 * mark. A route the proxy does not cover (the ZIP upload, the forward to
 * another server) therefore never sees a token as a session at all — so a
 * read-only one cannot write through the back door those routes would be.
 */

export const API_TOKEN_PREFIX = "rpk_";

/** `"1"` when the owner has turned API access on. Off until they do. */
export const API_TOKENS_SETTING = "api_tokens_enabled";

/** Set by `proxy.ts` on a request whose bearer token it has checked. */
export const HDR_API_TOKEN_MARK = "x-runpanel-api-token";

/** The MCP endpoint: the one write a read-only token may send, its tools keep the limit. */
export const MCP_PATH = "/api/mcp";

/** The synthetic session id a token's requests carry. */
export const TOKEN_SESSION_PREFIX = "token:";

export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

export interface ApiTokenInfo {
  id: string;
  access: ApiTokenAccess;
  tokenHash: string;
  user: SessionUser;
}

export async function apiTokensEnabled(): Promise<boolean> {
  return (await getSetting(API_TOKENS_SETTING)) === "1";
}

/** The token in an `Authorization` header, or null when there is none of ours. */
export function readBearer(get: (name: string) => string | null): string | null {
  const header = get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match || !match[1].startsWith(API_TOKEN_PREFIX)) return null;
  return match[1];
}

export function isTokenSession(sessionId: string | undefined): boolean {
  return sessionId !== undefined && sessionId.startsWith(TOKEN_SESSION_PREFIX);
}

// --- the proxy's mark ---

export function apiTokenMark(tokenHash: string): string {
  return crypto.createHmac("sha256", getSecret()).update(`api-token\n${tokenHash}`).digest("hex");
}

export function isApiTokenMark(tokenHash: string, mark: string | null): boolean {
  if (!mark || !/^[0-9a-f]{64}$/.test(mark)) return false;
  const expected = Buffer.from(apiTokenMark(tokenHash), "hex");
  const given = Buffer.from(mark, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// --- lookup ---

/** Same digest as `hashToken` in `lib/auth`, which imports this file. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The live token a bearer value names, with its user, or null.
 *
 * Null as well when API access is off, on a managed node of a cluster (which
 * signs nobody in: its panels do), and for a disabled account.
 */
export async function lookupApiToken(token: string, touch: boolean): Promise<ApiTokenInfo | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  if (!(await apiTokensEnabled()) || (await isNodeOnly())) return null;

  const db = await getDb();
  const tokenHash = hashToken(token);
  const row = await db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.user_id")
    .select([
      "api_tokens.id as token_id",
      "api_tokens.access",
      "api_tokens.expires_at",
      "api_tokens.last_used_at",
      "users.id as user_id",
      "users.email",
      "users.is_owner",
      "users.disabled",
    ])
    .where("api_tokens.token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!row || row.disabled === 1) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Throttled, like sessions: without it every request would write a row.
  if (touch && (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000)) {
    await db.updateTable("api_tokens").set({ last_used_at: nowIso() }).where("id", "=", row.token_id).execute();
  }

  return {
    id: row.token_id,
    access: row.access === "full" ? "full" : "read",
    tokenHash,
    user: { id: row.user_id, email: row.email, isOwner: row.is_owner === 1 },
  };
}

/** Whether the token behind a token session still works — for streams opened with it. */
export async function isTokenSessionAlive(sessionId: string): Promise<boolean> {
  if (!(await apiTokensEnabled())) return false;
  const db = await getDb();
  const tokenId = sessionId.slice(TOKEN_SESSION_PREFIX.length);
  const row = await db.selectFrom("api_tokens").select("expires_at").where("id", "=", tokenId).executeTakeFirst();
  return row !== undefined && (row.expires_at === null || new Date(row.expires_at) >= new Date());
}

// --- management ---

export async function createApiToken(
  userId: string,
  opts: { name: string; access: ApiTokenAccess; expiresInDays: number | null }
): Promise<{ id: string; token: string }> {
  const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const id = generateId();
  const db = await getDb();
  await db
    .insertInto("api_tokens")
    .values({
      id,
      user_id: userId,
      name: opts.name,
      token_hash: hashToken(token),
      hint: token.slice(-4),
      access: opts.access,
      created_at: now.toISOString(),
      last_used_at: null,
      expires_at: opts.expiresInDays === null ? null : new Date(now.getTime() + opts.expiresInDays * 86_400_000).toISOString(),
    })
    .execute();
  return { id, token };
}

export async function listApiTokens(userId: string) {
  const db = await getDb();
  return db
    .selectFrom("api_tokens")
    .select(["id", "name", "hint", "access", "created_at", "last_used_at", "expires_at"])
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
}

/** Revoke one of a user's tokens. False when they have no such token. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .deleteFrom("api_tokens")
    .where("id", "=", tokenId)
    .where("user_id", "=", userId)
    .returning("id")
    .executeTakeFirst();
  if (!row) return false;
  authzEvents.emit(userId, { type: "session-revoked", sessionId: `${TOKEN_SESSION_PREFIX}${row.id}` });
  return true;
}
