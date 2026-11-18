import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { firstIssue, updateChannelSchema } from "@/lib/notify-schema";
import { ChannelUpdateError, deleteChannel, getChannel, toPublic, updateChannel } from "@/services/notify/channels";
import { getMe } from "@/services/notify/telegram";

/**
 * One channel: edit it, or remove it.
 *
 * An edit sends only what changed. A blank or absent secret keeps the stored
 * one, which is how the screen can show "configurato" and still save a new
 * name without ever having had the token.
 */

type Params = { params: Promise<{ channelId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { channelId } = await params;
  return withAudit(request, { category: "system", action: "notifications.channel.update", scope: "permission", scopeId: "notifications" }, async () => {
    const denied = await requirePermission("notifications");
    if (isDenied(denied)) return denied;

    const current = await getChannel(channelId);
    if (!current) return NextResponse.json({ error: "Canale non trovato" }, { status: 404 });

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = updateChannelSchema(current.kind).safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error.issues), details: parsed.error.issues }, { status: 400 });
    }

    const token = (parsed.data.secrets as { botToken?: string } | undefined)?.botToken;
    if (current.kind === "telegram" && token) {
      const identity = await getMe(token);
      if (!identity.ok) {
        return NextResponse.json({ error: identity.error ?? "Token rifiutato da Telegram" }, { status: 400 });
      }
    }

    try {
      const channel = await updateChannel(current, parsed.data);
      return NextResponse.json({ channel: toPublic(channel) });
    } catch (err) {
      if (err instanceof ChannelUpdateError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { channelId } = await params;
  return withAudit(request, { category: "system", action: "notifications.channel.delete", scope: "permission", scopeId: "notifications" }, async () => {
    const denied = await requirePermission("notifications");
    if (isDenied(denied)) return denied;

    if (!(await deleteChannel(channelId))) {
      return NextResponse.json({ error: "Canale non trovato" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
