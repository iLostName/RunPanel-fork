import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";
import { refuseCrossOrigin } from "@/lib/request-origin";
import {
  claimLoginChallenge,
  consumeCodeAttempt,
  forgiveCodeAttempts,
  readLoginChallenge,
  recordChallengeFailure,
  rememberDevice,
  verifySecondFactor,
} from "@/lib/two-factor";
import { getUser, recordLogin } from "@/lib/users";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * The second step of signing in: the token the password step handed out, and
 * a code from the authenticator app or a recovery code.
 *
 * Public like the password step, and limited three ways. The challenge allows
 * five wrong codes before the password has to be typed again; the account
 * allows a few per quarter hour and twenty per day, across every challenge and
 * everything else that takes a code (lib/two-factor.ts), which is the limit
 * that actually bounds guessing; and, behind a trusted proxy, the address.
 * The password step's global ceiling is not spent again here: the account is
 * known now, and its own limit is the precise one.
 */

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ATTEMPTS_PER_IP = 10;
const WINDOW_MS = 15 * 60 * 1000;

const tooMany = (retryAfter: number, what = "tentativi") =>
  NextResponse.json(
    { error: `Troppi ${what}. Riprova tra ${Math.max(1, Math.ceil(retryAfter / 60))} minuti.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );

/** One answer for every dead challenge, whatever killed it: the page restarts from the password. */
const expired = () =>
  NextResponse.json(
    { error: "L'accesso è scaduto: inserisci di nuovo email e password.", code: "challenge_expired" },
    { status: 401 }
  );

export async function POST(request: NextRequest) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  const ip = trustedClientIp(request);
  const ipKey = ip ? `login:code:${ip}` : null;
  if (ipKey) {
    const limit = await consumeRateLimit(ipKey, MAX_ATTEMPTS_PER_IP, WINDOW_MS);
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
  const { challenge: token, code, remember } = (body ?? {}) as { challenge?: unknown; code?: unknown; remember?: unknown };

  if (await isNodeOnly()) {
    return NextResponse.json({ error: "Questo server è gestito da un altro RunPanel: accedi da lì." }, { status: 403 });
  }

  const challenge = await readLoginChallenge(token);
  if (!challenge) return expired();

  // Counted before the code is looked at, so parallel guesses all pay.
  const attempt = await consumeCodeAttempt(challenge.userId);
  if (!attempt.allowed) return tooMany(attempt.retryAfter, "codici sbagliati");

  const result = await verifySecondFactor(challenge.userId, code);
  if (!result.ok) {
    await recordChallengeFailure(challenge.id);
    await audit({
      userId: challenge.userId,
      category: "security",
      action: "auth.two-factor.failed",
      scope: "user",
      scopeId: challenge.userId,
      request,
    });
    return NextResponse.json({ error: "Codice non valido" }, { status: 401 });
  }

  // Spent once: two right codes sent together still open one session.
  if (!(await claimLoginChallenge(challenge.id))) return expired();
  const user = await getUser(challenge.userId);
  if (!user || user.disabled === 1) return expired();

  await forgiveCodeAttempts(user.id);
  if (ipKey) await clearRateLimit(ipKey);

  const meta = { userAgent: request.headers.get("user-agent") ?? undefined, ip: ip ?? undefined };
  await createSession(user.id, meta);
  await recordLogin(user.id);
  if (remember === true) await rememberDevice(user.id, meta);

  const recovery = result.method === "recovery";
  await audit({
    userId: user.id,
    category: "security",
    action: "auth.login",
    scope: "user",
    scopeId: user.id,
    detail: recovery
      ? `con un codice di recupero, ne restano ${result.recoveryCodesLeft}`
      : `con la verifica in due passaggi${remember === true ? ", dispositivo ricordato" : ""}`,
    request,
  });
  return NextResponse.json({
    success: true,
    emailRequired: user.email === null,
    ...(recovery ? { recoveryCodesLeft: result.recoveryCodesLeft } : {}),
  });
}
