import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { testPush } from "@/services/notify/push";
import { getUserDevice } from "@/services/notify/push-devices";

/**
 * "Invia una prova" on one of the account's devices: one notification, now,
 * and the answer.
 *
 * 200 with the reason inside when it did not get there, as for the channels:
 * "the push service no longer knows this device" is an answer to act on, not
 * a failed request. When that is the answer the device is gone from the list
 * (`removed`). A few a minute per account, like every test button.
 */

type Params = { params: Promise<{ deviceId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { deviceId } = await params;
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const userId = ctx.session.user.id;

  const device = await getUserDevice(userId, deviceId);
  if (!device) return NextResponse.json({ error: "Dispositivo non trovato" }, { status: 404 });

  const limit = await consumeRateLimit(`push-test:${userId}`, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Troppe prove di fila: riprova tra ${limit.retryAfter} secondi.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const result = await testPush(device);
  await audit({ userId, category: "system", action: "account.push.test", scope: "user", scopeId: userId, detail: device.name, request });
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, error: result.error ?? "Invio non riuscito", removed: result.gone === true });
}
