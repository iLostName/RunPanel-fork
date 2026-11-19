import { NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { MAX_PUSH_DEVICES } from "@/lib/push-rules";
import { listUserDevices, toPublicDevice } from "@/services/notify/push-devices";
import { getVapidKeys } from "@/services/notify/push-keys";

/**
 * The signed-in account's devices for notifications, and the panel's public
 * key a browser subscribes with.
 *
 * Every account has these, like the bell: they are its own, and what reaches
 * them is decided per notification by what the account may see. The list says
 * nothing of where a device's notifications go — no endpoint, no keys — only
 * what the person needs to recognise it, and the hash its own browser matches
 * to say "questo dispositivo".
 *
 * Of the panel serving the page, whatever server is selected: a browser
 * subscribes to the panel whose address it is on.
 */
export async function GET() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;

  const keys = await getVapidKeys();
  const devices = await listUserDevices(ctx.session.user.id);
  return NextResponse.json(
    { publicKey: keys.publicKey, devices: devices.map((device) => toPublicDevice(device, keys.publicKey)), max: MAX_PUSH_DEVICES },
    { headers: { "Cache-Control": "no-store" } }
  );
}
