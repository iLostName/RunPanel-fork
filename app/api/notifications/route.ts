import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { NOTIFY_GROUPS } from "@/lib/notify-events";
import { listInbox, type InboxQuery } from "@/services/notify/inbox";

/**
 * The signed-in user's notification centre: what the bell and the
 * Notifiche page show.
 *
 * Every account has one, so the guard is only a session. What is in it is
 * decided per row by what this account can see (`services/notify/inbox.ts`):
 * a project it was not given is not in its bell, now or later.
 *
 * Where notifications *go* — the channels — is `./channels`, and needs the
 * Notifications permission.
 */

const LEVELS = new Set(["problems", "ok", "warn", "danger", "info"]);

export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;

  const params = request.nextUrl.searchParams;
  const limit = Number.parseInt(params.get("limit") ?? "20", 10);
  const level = params.get("level");
  const group = params.get("group");
  const before = params.get("before");

  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "limit va da 1 a 100" }, { status: 400 });
  }
  if (level && !LEVELS.has(level)) {
    return NextResponse.json({ error: "Gravità sconosciuta" }, { status: 400 });
  }
  if (group && !NOTIFY_GROUPS.some((candidate) => candidate.id === group)) {
    return NextResponse.json({ error: "Gruppo di eventi sconosciuto" }, { status: 400 });
  }
  if (before && before.length > 120) {
    return NextResponse.json({ error: "Cursore non valido" }, { status: 400 });
  }

  const page = await listInbox(ctx.principal, {
    limit,
    before,
    unreadOnly: params.get("unread") === "1",
    level: (level as InboxQuery["level"]) ?? null,
    group,
  });
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
