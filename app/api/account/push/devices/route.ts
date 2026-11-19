import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { MAX_PUSH_DEVICES, pushEndpointProblem } from "@/lib/push-rules";
import { pushSubscribeSchema } from "@/lib/validation";
import { extraPushHosts } from "@/services/notify/push";
import { subscribeDevice, toPublicDevice } from "@/services/notify/push-devices";
import { getVapidKeys } from "@/services/notify/push-keys";

/**
 * Turn notifications on in this browser, for the signed-in account — or
 * refresh the subscription of a browser that already had them.
 *
 * The browser asked its push service for a subscription with the panel's
 * public key and sends it here. The endpoint is accepted only on a known push
 * service (`pushEndpointProblem`): the panel will POST to it, and otherwise
 * any account could aim the panel at a machine of its choosing.
 *
 * 201 for a new device, 200 when an existing one was refreshed. A browser that
 * another account had turned notifications on in becomes this account's: see
 * `subscribeDevice`.
 */

/** The address the page was on, which is who the panel is to this browser. Not trusted for anything but that. */
function pageOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  return origin && /^https?:\/\/[^/\s]+$/i.test(origin) ? origin.toLowerCase() : null;
}

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const userId = ctx.session.user.id;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = pushSubscribeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  const problem = pushEndpointProblem(input.subscription.endpoint, extraPushHosts());
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const keys = await getVapidKeys();
  if (input.applicationServerKey && input.applicationServerKey !== keys.publicKey) {
    return NextResponse.json(
      { error: "La chiave del pannello per le notifiche è cambiata: ricarica la pagina e riprova.", code: "key_changed", publicKey: keys.publicKey },
      { status: 409 }
    );
  }

  const outcome = await subscribeDevice({
    userId,
    target: { endpoint: input.subscription.endpoint, p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth },
    vapidKey: keys.publicKey,
    name: input.name,
    events: input.events,
    filter: input.filter,
    origin: pageOrigin(request),
    userAgent: request.headers.get("user-agent")?.slice(0, 255) ?? null,
    previousEndpoint: input.previousEndpoint ?? null,
  });

  if (outcome.kind === "full") {
    return NextResponse.json(
      { error: `Hai già ${MAX_PUSH_DEVICES} dispositivi con le notifiche attive: togline uno dall'elenco e riprova.` },
      { status: 409 }
    );
  }

  if (outcome.kind === "created") {
    await audit({ userId, category: "security", action: "account.push.enable", scope: "user", scopeId: userId, detail: outcome.device.name, request });
  }
  if (outcome.tookFrom) {
    // Said on the other account's record too: its notifications stopped arriving somewhere.
    await audit({ userId, category: "security", action: "account.push.taken", scope: "user", scopeId: outcome.tookFrom, detail: outcome.device.name, request });
  }

  return NextResponse.json({ device: toPublicDevice(outcome.device, keys.publicKey) }, { status: outcome.kind === "created" ? 201 : 200 });
}
