import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { pushSyncSchema } from "@/lib/validation";
import { deleteDevice, findDeviceByEndpoint, toPublicDevice } from "@/services/notify/push-devices";
import { getVapidKeys } from "@/services/notify/push-keys";

/**
 * A browser that holds a push subscription asking whose it is.
 *
 * Asked by the panel's own page each time it opens with notifications allowed
 * (components/pwa/PushRuntime.tsx), with the endpoint only that browser and
 * the panel know. The answer, with the panel's current public key:
 *
 *  - this account's device: the page renews the subscription if the key changed;
 *  - nobody's (removed from the list, or dropped after a 410): the page lets
 *    the subscription go, so the browser stops holding one nothing sends to;
 *  - another account's: someone else signed in to this browser, and the
 *    previous account's notifications must not keep landing on their screen.
 *    The row is removed here, and the page lets the subscription go.
 */
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
  const parsed = pushSyncSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });

  const keys = await getVapidKeys();
  const device = await findDeviceByEndpoint(parsed.data.endpoint);

  if (device && device.userId !== userId) {
    await deleteDevice(device.id);
    await audit({ userId, category: "security", action: "account.push.released", scope: "user", scopeId: device.userId, detail: device.name, request });
    return NextResponse.json({ device: null, released: true, publicKey: keys.publicKey }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { device: device ? toPublicDevice(device, keys.publicKey) : null, released: false, publicKey: keys.publicKey },
    { headers: { "Cache-Control": "no-store" } }
  );
}
