import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getSession, isClusterSession, isFirstRun, verifyPassword } from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import {
  beginFlow,
  githubLinkOf,
  isGithubLoginReady,
  readGithubLoginConfig,
  requestOrigin,
  setFlowCookie,
} from "@/lib/github-login";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { safeNextPath } from "@/lib/safe-path";
import { getUser, inspectInvite } from "@/lib/users";
import { githubStartSchema } from "@/lib/validation";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * Leave for GitHub: sign in, link one's own account, or accept an invitation.
 *
 * Public like the password step — under `/api/auth`, which `proxy.ts` leaves
 * alone — because signing in begins without a session. Linking checks the
 * session itself and asks for the password again: whoever finds a session
 * left open must not be able to tie their own GitHub account to it and walk
 * back in whenever they like. The cross-origin check the proxy would have made
 * is made here.
 *
 * The answer is the URL to send the browser to, and a cookie holding the value
 * the return must bring back to this same browser (lib/github-login.ts).
 *
 * Limited per address behind a trusted proxy and across everyone always, like
 * the password step: each start writes a row, and each return costs requests
 * to GitHub. `login:` so `scripts/reset-owner.mjs` clears them with the others.
 */

const MAX_BODY_BYTES = 4 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_STARTS_GLOBAL = 60;
const MAX_STARTS_PER_IP = 20;
const MAX_PASSWORD_ATTEMPTS = 5;

const noStore = { "Cache-Control": "no-store" };

const tooMany = (retryAfter: number) =>
  NextResponse.json(
    { error: `Troppi tentativi. Riprova tra ${Math.max(1, Math.ceil(retryAfter / 60))} minuti.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );

export async function POST(request: NextRequest) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  const ip = trustedClientIp(request);
  const buckets = [{ key: "login:github", limit: MAX_STARTS_GLOBAL }];
  if (ip) buckets.unshift({ key: `login:github:${ip}`, limit: MAX_STARTS_PER_IP });
  for (const bucket of buckets) {
    const limit = await consumeRateLimit(bucket.key, bucket.limit, WINDOW_MS);
    if (!limit.allowed) return tooMany(limit.retryAfter);
  }

  let body: unknown;
  try {
    const raw = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!raw) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = githubStartSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  const input = parsed.data;

  if (await isNodeOnly()) {
    return NextResponse.json({ error: "Questo server è gestito da un altro RunPanel: accedi da lì." }, { status: 403 });
  }
  if (await isFirstRun()) {
    return NextResponse.json({ error: "Il pannello non è ancora configurato. Ricarica la pagina." }, { status: 409 });
  }

  const config = await readGithubLoginConfig();
  if (!isGithubLoginReady(config) || !config.enabled) {
    return NextResponse.json({ error: "L'accesso con GitHub non è attivo su questo pannello.", code: "off" }, { status: 409 });
  }

  // The cookie set below belongs to the address the browser is on, and GitHub
  // brings the browser back to the address in the callback URL. On any other
  // address the return would find no cookie and fail on GitHub's side of the
  // trip; better to say where to go before leaving.
  const callbackOrigin = new URL(config.callbackUrl).origin;
  const here = requestOrigin(request);
  if (here !== callbackOrigin) {
    return NextResponse.json(
      {
        error: `Per entrare con GitHub apri il pannello dal suo indirizzo, ${callbackOrigin}: è quello registrato su GitHub.`,
        code: "wrong_origin",
        url: `${callbackOrigin}/login`,
      },
      { status: 409 }
    );
  }

  let userId: string | null = null;
  let inviteToken: string | null = null;
  let next: string | null = null;

  if (input.intent === "login") {
    next = safeNextPath(input.next);
  } else if (input.intent === "link") {
    const session = await getSession();
    // A person in a browser: an API token never reaches this route with a
    // session (the proxy is what marks one), and a cluster call is not a person.
    if (!session || session.apiToken || isClusterSession(session.sessionId)) {
      return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
    }
    const user = await getUser(session.user.id);
    if (!user || user.disabled === 1) return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
    if (await githubLinkOf(user.id)) {
      return NextResponse.json(
        { error: "Hai già un account GitHub collegato: scollegalo prima di collegarne un altro." },
        { status: 409 }
      );
    }
    if (!user.password_hash) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });

    const key = `account:pw:${user.id}`;
    const limit = await consumeRateLimit(key, MAX_PASSWORD_ATTEMPTS, WINDOW_MS);
    if (!limit.allowed) return tooMany(limit.retryAfter);
    if (!(await verifyPassword(input.password, user.password_hash))) {
      await audit({ userId: user.id, category: "security", action: "account.password.failed", scope: "user", scopeId: user.id, request });
      return NextResponse.json({ error: "Password attuale errata" }, { status: 401 });
    }
    await clearRateLimit(key);
    userId = user.id;
  } else {
    // The invitation's own budget too: its token is a credential, and this is
    // one more place that looks it up.
    const limit = await consumeRateLimit("invite:global", 30, WINDOW_MS);
    if (!limit.allowed) return tooMany(limit.retryAfter);
    const invite = await inspectInvite(input.token);
    if (!invite || invite.kind !== "invite") {
      return NextResponse.json({ error: "Link non valido o scaduto. Chiedi un nuovo invito." }, { status: 400 });
    }
    inviteToken = input.token;
  }

  const { url, binding } = await beginFlow(config, {
    intent: input.intent,
    userId,
    inviteToken,
    next,
    redirectUri: config.callbackUrl,
  });
  await setFlowCookie(binding, config.callbackUrl);
  return NextResponse.json({ url }, { headers: noStore });
}
