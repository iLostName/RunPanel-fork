import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { pushDeviceUpdateSchema } from "@/lib/validation";
import { deleteDevice, getUserDevice, toPublicDevice, updateDevice } from "@/services/notify/push-devices";
import { getVapidKeys } from "@/services/notify/push-keys";

/**
 * One of the signed-in account's devices: rename it, choose what it receives,
 * switch it off, or remove it.
 *
 * Only the account's own. Another account's device answers 404, exactly like
 * one that does not exist — the owner included: a device is a person's, and
 * removing someone's is done by removing their account, or by their browser
 * turning notifications on for another account.
 */

type Params = { params: Promise<{ deviceId: string }> };

const notFound = () => NextResponse.json({ error: "Dispositivo non trovato" }, { status: 404 });

export async function PATCH(request: NextRequest, { params }: Params) {
  const { deviceId } = await params;
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const userId = ctx.session.user.id;

  const device = await getUserDevice(userId, deviceId);
  if (!device) return notFound();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = pushDeviceUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  const updated = await updateDevice(device, parsed.data);
  await audit({ userId, category: "security", action: "account.push.update", scope: "user", scopeId: userId, detail: updated.name, request });
  const keys = await getVapidKeys();
  return NextResponse.json({ device: toPublicDevice(updated, keys.publicKey) });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { deviceId } = await params;
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const userId = ctx.session.user.id;

  const device = await getUserDevice(userId, deviceId);
  if (!device || !(await deleteDevice(device.id))) return notFound();
  await audit({ userId, category: "security", action: "account.push.delete", scope: "user", scopeId: userId, detail: device.name, request });
  return NextResponse.json({ ok: true });
}
