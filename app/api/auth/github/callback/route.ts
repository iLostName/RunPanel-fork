import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { destroyUserSessions, getSession, isClusterSession } from "@/lib/auth";
import {
  claimFlow,
  exchangeCode,
  fetchIdentity,
  isGithubLoginReady,
  linkGithub,
  readGithubLoginConfig,
  redeemInviteWithGithub,
  refreshGithubLogin,
  revokeToken,
  setPendingCookie,
  takeFlowCookie,
  userIdForGithub,
  type ClaimedFlow,
} from "@/lib/github-login";
import { landingPath, type FlowResult, type GithubIdentity } from "@/lib/github-oauth";
import { consumeRateLimit } from "@/lib/rate-limit";
import { forgetTrustedDevices, issueLoginChallenge } from "@/lib/two-factor";
import { getUser } from "@/lib/users";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * Where GitHub sends the browser back: `?code=…&state=…`, or `?error=…` when
 * the person said no.
 *
 * Public, and a GET with consequences, as every OAuth return is: the browser
 * arrives from github.com with no say in the method. What makes it safe is
 * that nothing here is decided by the URL alone. The state must name a
 * sign-in this panel began, not expired and not already spent, and the
 * browser must hold the cookie that sign-in set; the code is worth nothing to
 * GitHub without the verifier the panel kept (PKCE); and the token it buys is
 * used once to read the account's numeric id, then revoked and forgotten.
 *
 * It never opens a session itself. A sign-in leaves here holding a short-lived
 * token in a `Strict` cookie and lands on the sign-in page, which finishes it
 * from the panel's own origin (`/api/auth/github/continue`): there the
 * remembered-device cookie, `Strict` too, can be read, and the second step is
 * asked for exactly as after a password.
 *
 * Every answer is a redirect to a fixed page of the panel. The Location is a
 * path, resolved by the browser against the address it is on, so a `Host`
 * header cannot point it anywhere else.
 */

const MAX_BAD_RETURNS_LOGGED = 30;
const WINDOW_MS = 15 * 60 * 1000;

function redirect(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // Read and cleared whatever happens next: a binding is good for one return.
  const binding = await takeFlowCookie();

  if (await isNodeOnly()) return redirect("/login?github=managed");

  const flow = await claimFlow(params.get("state"), binding);
  if (!flow) {
    // Unknown, expired, already used, or begun in another browser — which is
    // what a forged return looks like. Logged, but within a budget: this is
    // an address anyone can call.
    const budget = await consumeRateLimit("login:github:bad-return", MAX_BAD_RETURNS_LOGGED, WINDOW_MS);
    if (budget.allowed) {
      await audit({
        userId: null,
        category: "security",
        action: "auth.github.refused",
        detail: binding ? "ritorno da GitHub scaduto, già usato o di un'altra richiesta" : "ritorno da GitHub senza il cookie di questo browser",
        request,
      });
    }
    const session = await getSession();
    return redirect(session ? "/account?github=expired" : "/login?github=expired");
  }

  const land = (result: FlowResult) => redirect(landingPath(flow, result));

  const error = params.get("error");
  if (error) return land(error === "access_denied" ? "denied" : "github");

  const code = params.get("code");
  if (!code || code.length > 256) return land("github");

  const config = await readGithubLoginConfig();
  if (!isGithubLoginReady(config) || !config.enabled) return land("off");

  const token = await exchangeCode(config, { code, redirectUri: flow.redirectUri, verifier: flow.verifier });
  if (!token.ok) {
    await audit({
      userId: flow.userId,
      category: "security",
      action: "auth.github.refused",
      scope: flow.userId ? "user" : null,
      scopeId: flow.userId,
      detail: `GitHub non ha accettato il codice (${token.error})`,
      request,
    });
    return land("github");
  }

  let identity: GithubIdentity | null;
  try {
    identity = await fetchIdentity(token.token);
  } finally {
    // Its only job is done, whatever the answer was.
    revokeToken(config, token.token);
  }
  if (!identity) return land("github");

  if (flow.intent === "link") return link(request, flow, identity, land);
  if (flow.intent === "invite") return acceptInvite(request, flow, identity, land);
  return signIn(request, flow, identity, land);
}

async function signIn(
  request: NextRequest,
  flow: ClaimedFlow,
  identity: GithubIdentity,
  land: (result: FlowResult) => NextResponse
): Promise<NextResponse> {
  const userId = await userIdForGithub(identity.id);
  const user = userId ? await getUser(userId) : null;
  if (!user || user.disabled === 1) {
    // The same words for both on the page, as the password step does: a
    // disabled account is not told apart from a missing one. The log tells.
    await audit({
      userId: user?.id ?? null,
      category: "security",
      action: "auth.github.refused",
      scope: user ? "user" : null,
      scopeId: user?.id ?? null,
      detail: user
        ? `GitHub @${identity.login}: account disattivato`
        : `GitHub @${identity.login} (id ${identity.id}): non collegato a nessun utente`,
      request,
    });
    return land("unlinked");
  }

  await refreshGithubLogin(user.id, identity.login);
  await setPendingCookie(await issueLoginChallenge(user.id, "github"), flow.redirectUri);
  return land("continue");
}

async function link(
  request: NextRequest,
  flow: ClaimedFlow,
  identity: GithubIdentity,
  land: (result: FlowResult) => NextResponse
): Promise<NextResponse> {
  // Still the person who asked: a sign-out and someone else's sign-in in the
  // same browser while GitHub's page was open would otherwise receive the link.
  const session = await getSession();
  if (!flow.userId || !session || session.apiToken || isClusterSession(session.sessionId) || session.user.id !== flow.userId) {
    return land("session");
  }

  const outcome = await linkGithub(flow.userId, identity);
  if (outcome === "taken") {
    await audit({
      userId: flow.userId,
      category: "security",
      action: "auth.github.refused",
      scope: "user",
      scopeId: flow.userId,
      detail: `GitHub @${identity.login} è già collegato a un altro utente`,
      request,
    });
    return land("taken");
  }
  if (outcome === "already") return land("already");

  await audit({
    userId: flow.userId,
    category: "security",
    action: "account.github.link",
    scope: "user",
    scopeId: flow.userId,
    detail: `@${identity.login} (id ${identity.id})`,
    request,
  });
  return land("linked");
}

async function acceptInvite(
  request: NextRequest,
  flow: ClaimedFlow,
  identity: GithubIdentity,
  land: (result: FlowResult) => NextResponse
): Promise<NextResponse> {
  if (!flow.inviteToken) return land("invite");
  const outcome = await redeemInviteWithGithub(flow.inviteToken, identity);
  if (!outcome.ok) {
    if (outcome.reason === "taken") {
      await audit({
        userId: null,
        category: "security",
        action: "auth.github.refused",
        detail: `invito: GitHub @${identity.login} è già collegato a un altro utente`,
        request,
      });
    }
    return land(outcome.reason);
  }

  const userId = outcome.userId;
  // As with a password chosen from the link: a fresh start for the account.
  await destroyUserSessions(userId);
  await forgetTrustedDevices(userId);
  await audit({
    userId,
    category: "security",
    action: "auth.invite.redeemed",
    scope: "user",
    scopeId: userId,
    detail: `con GitHub @${identity.login}`,
    request,
  });
  await audit({
    userId,
    category: "security",
    action: "account.github.link",
    scope: "user",
    scopeId: userId,
    detail: `@${identity.login} (id ${identity.id}), accettando l'invito`,
    request,
  });

  await setPendingCookie(await issueLoginChallenge(userId, "github"), flow.redirectUri);
  return land("continue");
}
