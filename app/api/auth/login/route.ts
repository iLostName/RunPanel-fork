import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { audit } from "@/lib/audit";
import { isFirstRun, verifyPasswordOrDummy, createSession } from "@/lib/auth";
import { claimOwner, findLoginUser, normalizeEmail, recordLogin } from "@/lib/users";
import { trustedClientIp } from "@/lib/client-ip";
import { linkSetupSchema } from "@/lib/cluster-schema";
import { isValidSetupToken } from "@/lib/setup-token";
import { LOGIN_GLOBAL_KEY, bucketsResetByLogin } from "@/lib/login-buckets";
import { clearRateLimit, consumeRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { joinCluster } from "@/services/cluster/join";
import { isNodeOnly } from "@/services/cluster/state";
import { panelRelease } from "@/services/panel-update/release";

/** Per client address, once there is a client address worth counting. */
const MAX_ATTEMPTS_PER_IP = 5;
/**
 * Across everyone, always.
 *
 * The accounts are what is worth protecting, rather than any particular source —
 * and with no proxy configured there is no trustworthy source anyway, so this
 * and the per-account bucket below are the only limits that apply.
 *
 * Without a client identity the choice is unavoidable: a low ceiling resists
 * guessing but lets anyone lock the operator out for the window, a high one
 * does the reverse. 20 per quarter hour is well under 2000 attempts a day
 * against a password of at least eight characters, and far enough above a
 * mistyped password that an operator will not meet it. Configure
 * `RUNPANEL_TRUSTED_PROXY_HOPS` and the tighter per-address limit applies too.
 * A successful login does not reset it: see `lib/login-buckets.ts`.
 */
const MAX_ATTEMPTS_GLOBAL = 20;

/**
 * A login body is `{email, password, setup, setupToken}` and nothing else.
 *
 * This route is one of the few `proxy.ts` lets through without a session, and
 * `request.json()` buffers whatever arrives before anything can look at it. The
 * rate limiter caps how MANY of these an unauthenticated caller gets, not how
 * big each one is — twenty concurrent multi-gigabyte POSTs are inside the
 * budget. `readBodyCapped` refuses on the declared length, then on the bytes as
 * they arrive.
 */
const MAX_BODY_BYTES = 8 * 1024;
/** Per account named in the form, so one account cannot be guessed at full speed. */
const MAX_ATTEMPTS_PER_EMAIL = 10;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  // Before the limiter, so a page elsewhere cannot spend the attempts either.
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  const ip = trustedClientIp(request);

  // Both are consumed on every attempt. The per-address bucket only exists when
  // `RUNPANEL_TRUSTED_PROXY_HOPS` says an address can be believed — counting by
  // a header the caller chooses is not a limit, it is a formality.
  const buckets = [{ key: LOGIN_GLOBAL_KEY, limit: MAX_ATTEMPTS_GLOBAL }];
  if (ip) buckets.unshift({ key: `login:${ip}`, limit: MAX_ATTEMPTS_PER_IP });
  // The global ceiling is for guesses: a success gives back its own attempt, or
  // twenty good logins in a window would lock everybody out.
  const clearBuckets = () =>
    Promise.all([
      ...bucketsResetByLogin(buckets).map((bucket) => clearRateLimit(bucket.key)),
      refundRateLimit(LOGIN_GLOBAL_KEY),
    ]);

  for (const bucket of buckets) {
    const limit = await consumeRateLimit(bucket.key, bucket.limit, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
  }

  // A malformed body is a bad request, not a crash.
  let body: unknown;
  try {
    const raw = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!raw) {
      return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    }
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const { email: rawEmail, password, setup, setupToken, link } = (body ?? {}) as {
    email?: unknown;
    password?: unknown;
    setup?: unknown;
    setupToken?: unknown;
    link?: unknown;
  };

  // A managed node of a cluster signs nobody in: its panels do.
  if (await isNodeOnly()) {
    return NextResponse.json({ error: "Questo server è gestito da un altro RunPanel: accedi da lì." }, { status: 403 });
  }

  // First-run setup, the other way: join an existing cluster instead of
  // creating an owner. No password here — the accounts arrive with the link.
  if (setup && link !== undefined) {
    if (!(await isFirstRun())) {
      return NextResponse.json({ error: "Il pannello è già stato configurato. Ricarica la pagina." }, { status: 409 });
    }
    if (!isValidSetupToken(setupToken)) {
      return NextResponse.json(
        { error: "Token di setup mancante o errato. Lo trovi nel log di avvio del pannello." },
        { status: 403 }
      );
    }
    const parsed = linkSetupSchema.safeParse(link);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }
    const outcome = await joinCluster(parsed.data, (await panelRelease()).label);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    await clearBuckets();
    return NextResponse.json({ success: true, linked: true, role: outcome.role });
  }

  if (!password || typeof password !== "string" || password.length > 128) {
    return NextResponse.json({ error: "Credenziali non valide" }, { status: 400 });
  }

  const email = normalizeEmail(rawEmail);
  const emailGiven = typeof rawEmail === "string" && rawEmail.trim().length > 0;
  if (emailGiven && !email) {
    return NextResponse.json({ error: "Email non valida" }, { status: 400 });
  }

  const sessionMeta = {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: ip ?? undefined,
  };

  // Counted per account too. Hashed so the bucket key does not store addresses.
  if (email) {
    const key = `login:email:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
    const limit = await consumeRateLimit(key, MAX_ATTEMPTS_PER_EMAIL, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
    buckets.push({ key, limit: MAX_ATTEMPTS_PER_EMAIL });
  }

  // First-run setup: the owner account, with an email from the start.
  if (setup && (await isFirstRun())) {
    if (!isValidSetupToken(setupToken)) {
      return NextResponse.json(
        { error: "Token di setup mancante o errato. Lo trovi nel log di avvio del pannello." },
        { status: 403 }
      );
    }

    if (!email) {
      return NextResponse.json({ error: "Serve un'email valida" }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "La password deve avere almeno 8 caratteri" },
        { status: 400 }
      );
    }

    // Claimed rather than written: `isFirstRun()` above is a read, and two
    // requests can pass it together. The unique index on the owner decides.
    const ownerId = await claimOwner(email, password);
    if (!ownerId) {
      return NextResponse.json(
        { error: "Il pannello è già stato configurato. Ricarica la pagina." },
        { status: 409 }
      );
    }

    await createSession(ownerId, sessionMeta);
    await recordLogin(ownerId);
    await audit({ userId: ownerId, category: "security", action: "auth.setup", scope: "user", scopeId: ownerId, request });
    await clearBuckets();
    return NextResponse.json({ success: true });
  }

  if (await isFirstRun()) {
    return NextResponse.json(
      { error: "Il pannello non è ancora configurato. Ricarica la pagina." },
      { status: 400 }
    );
  }

  // Normal login. An empty email only finds the owner migrated from the single
  // password, while they have no email yet. Every failure reads the same and
  // costs the same bcrypt round, so the form does not reveal which accounts exist.
  const user = await findLoginUser(email);
  const valid = await verifyPasswordOrDummy(password, user?.password_hash ?? null);
  if (!user || !valid || user.disabled === 1) {
    // The address typed is kept only when it names a real account: a log of
    // every string anyone typed would be a list of guesses, not of events.
    await audit({
      userId: user?.id ?? null,
      category: "security",
      action: "auth.login.failed",
      scope: user ? "user" : null,
      scopeId: user?.id ?? null,
      request,
    });
    return NextResponse.json({ error: "Credenziali non valide" }, { status: 401 });
  }

  await clearBuckets();
  await createSession(user.id, sessionMeta);
  await recordLogin(user.id);
  await audit({ userId: user.id, category: "security", action: "auth.login", scope: "user", scopeId: user.id, request });
  return NextResponse.json({ success: true, emailRequired: user.email === null });
}
