import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import {
  clearGithubLoginConfig,
  countGithubLinks,
  endpoints,
  isGithubLoginReady,
  passwordlessGithubUsers,
  readGithubLoginConfig,
  saveGithubLoginApp,
  setGithubLoginEnabled,
  verifyGithubApp,
} from "@/lib/github-login";
import { callbackUrlFor, GITHUB_SCOPE } from "@/lib/github-oauth";
import { panelBaseUrl } from "@/lib/panel-url";
import { consumeRateLimit } from "@/lib/rate-limit";
import { githubLoginActionSchema, githubLoginSettingsSchema } from "@/lib/validation";

/**
 * Signing in with GitHub, for the owner: the OAuth App, and whether sign-ins
 * through it are allowed.
 *
 * The owner's alone. Whoever sets the app decides which GitHub page the
 * panel's users are sent to sign in, and turning it off can shut out the
 * users who have no password. The secret is write-only like every other: the
 * screen is told whether there is one.
 *
 * The callback URL is worked out here, from the panel's public address or the
 * address this page was opened at, and stored with each save: it is the one
 * the owner pasted into GitHub, and a sign-in must start and end on it.
 */

const UNREADABLE_SECRET = "Il Client secret salvato non è più leggibile: incollalo di nuovo.";

async function view(request: NextRequest) {
  const [config, base, linkedUsers, passwordless] = await Promise.all([
    readGithubLoginConfig(),
    panelBaseUrl(request),
    countGithubLinks(),
    passwordlessGithubUsers(),
  ]);
  const suggested = callbackUrlFor(base?.origin);
  return {
    configured: Boolean(config),
    enabled: config?.enabled ?? false,
    ready: isGithubLoginReady(config),
    clientId: config?.clientId ?? "",
    secretSet: Boolean(config?.secret),
    secretUnreadable: config?.secretUnreadable ?? false,
    /** What is registered on GitHub (saved), or what would be on the first save. */
    callbackUrl: config?.callbackUrl ?? (suggested.ok ? suggested.url : null),
    /** What a save would store now: differs from `callbackUrl` after the address changed. */
    suggestedCallbackUrl: suggested.ok ? suggested.url : null,
    /** Why there is no callback URL to offer: `insecure` is plain http on an address other than this machine's. */
    callbackProblem: suggested.ok ? null : suggested.reason,
    homepageUrl: suggested.origin,
    scope: GITHUB_SCOPE,
    linkedUsers,
    passwordlessUsers: passwordless,
    /** A test suite's stand-in answers instead of GitHub (lib/github-oauth.ts). */
    testStandIn: endpoints().overridden,
  };
}

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  return NextResponse.json(await view(request), { headers: noStore });
}

/** Save the app (`clientId`, and `clientSecret` unless it is kept), and/or switch sign-ins on or off. */
export async function PUT(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = githubLoginSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  const userId = denied.session.user.id;

  // Before anything is written, so a refused switch-off saves nothing else either.
  if (input.enabled === false && !input.force) {
    const stranded = await passwordlessGithubUsers();
    if (stranded.length > 0) {
      return NextResponse.json(
        {
          error: "Alcuni utenti entrano solo con GitHub e non hanno una password: spegnendo, resterebbero fuori.",
          code: "passwordless_users",
          users: stranded,
        },
        { status: 409 }
      );
    }
  }

  if (input.clientId !== undefined) {
    const suggested = callbackUrlFor((await panelBaseUrl(request))?.origin);
    if (!suggested.ok) {
      return NextResponse.json(
        {
          error:
            suggested.reason === "insecure"
              ? "Il pannello è su http: GitHub restituirebbe il codice di accesso in chiaro. Mettilo su HTTPS, o imposta un indirizzo pubblico https, poi riprova."
              : "Non riesco a ricavare l'indirizzo del pannello: impostalo in Indirizzo pubblico.",
          code: "callback_insecure",
        },
        { status: 400 }
      );
    }
    const current = await readGithubLoginConfig();
    const secret = input.clientSecret || undefined;
    if (!secret && !current?.secret) {
      return NextResponse.json(
        { error: current?.secretUnreadable ? UNREADABLE_SECRET : "Serve anche il Client secret dell'app" },
        { status: 400 }
      );
    }
    await saveGithubLoginApp({ clientId: input.clientId, secret, callbackUrl: suggested.url });
    await audit({
      userId,
      category: "security",
      action: "github-login.settings",
      detail: `Client ID ${input.clientId}${secret ? ", nuovo secret" : ""}, callback ${suggested.url}`,
      request,
    });
  }

  if (input.enabled !== undefined) {
    const config = await readGithubLoginConfig();
    if (input.enabled && !isGithubLoginReady(config)) {
      return NextResponse.json(
        { error: config?.secretUnreadable ? UNREADABLE_SECRET : "Prima salva Client ID e Client secret dell'app" },
        { status: 409 }
      );
    }
    if (config && config.enabled !== input.enabled) {
      await setGithubLoginEnabled(input.enabled);
      const stranded = input.enabled ? [] : await passwordlessGithubUsers();
      await audit({
        userId,
        category: "security",
        action: input.enabled ? "github-login.enable" : "github-login.disable",
        detail: stranded.length > 0 ? `${stranded.length} utenti senza password restano fuori` : null,
        request,
      });
    }
  }

  return NextResponse.json(await view(request), { headers: noStore });
}

/** `verify` asks GitHub whether it knows the app; `clear` forgets the app (the links stay). */
export async function POST(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = githubLoginActionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  const userId = denied.session.user.id;

  if (parsed.data.action === "clear") {
    const stranded = await passwordlessGithubUsers();
    if (stranded.length > 0 && !parsed.data.force) {
      return NextResponse.json(
        {
          error: "Alcuni utenti entrano solo con GitHub e non hanno una password: senza l'app resterebbero fuori.",
          code: "passwordless_users",
          users: stranded,
        },
        { status: 409 }
      );
    }
    await clearGithubLoginConfig();
    await audit({
      userId,
      category: "security",
      action: "github-login.clear",
      detail: stranded.length > 0 ? `${stranded.length} utenti senza password restano fuori` : null,
      request,
    });
    return NextResponse.json(await view(request), { headers: noStore });
  }

  const limit = await consumeRateLimit(`github-login-verify:${userId}`, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: `Troppe verifiche di fila: riprova tra ${limit.retryAfter} secondi.` }, { status: 429 });
  }
  const config = await readGithubLoginConfig();
  if (!isGithubLoginReady(config)) {
    return NextResponse.json(
      { error: config?.secretUnreadable ? UNREADABLE_SECRET : "Prima salva Client ID e Client secret dell'app" },
      { status: 409 }
    );
  }

  const outcome = await verifyGithubApp(config);
  await audit({ userId, category: "security", action: "github-login.verify", detail: outcome, request });
  const message = {
    ok: "GitHub riconosce Client ID e Client secret. Per provare anche l'URL di callback, collega il tuo account da Impostazioni › Account.",
    credentials: "GitHub non riconosce Client ID e Client secret: copiali di nuovo dalla pagina dell'app (il secret si vede solo quando lo generi).",
    callback: "L'URL di callback registrato su GitHub è diverso da quello del pannello: copialo di nuovo da qui.",
    unexpected: "GitHub ha risposto in un modo inatteso: riprova tra poco.",
    unreachable: "GitHub non è raggiungibile da questo server: controlla la connessione a internet del server.",
  }[outcome];
  return NextResponse.json({ ok: outcome === "ok", outcome, message }, { headers: noStore });
}
