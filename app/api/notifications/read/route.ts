import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { readNotificationsSchema } from "@/lib/notify-schema";
import { markAllRead, markRead, unreadCount } from "@/services/notify/inbox";

/**
 * Mark notifications as read, for the signed-in user only.
 *
 * Not in the activity log, on purpose: it is the reader's own bookkeeping, like
 * a session's last-seen time, and recording every click on the bell would bury
 * what the log is for. Other open tabs hear about it over the stream and update
 * their badge.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = readNotificationsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Indica le notifiche da segnare, oppure «all: true»" }, { status: 400 });
  }

  if ("all" in parsed.data) await markAllRead(ctx.principal);
  else await markRead(ctx.principal, parsed.data.ids);

  return NextResponse.json({ ok: true, unread: await unreadCount(ctx.principal) });
}
