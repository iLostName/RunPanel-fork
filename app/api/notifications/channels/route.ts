import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { MAX_CHANNELS } from "@/lib/notify-channels";
import { NOTIFY_GROUPS } from "@/lib/notify-events";
import { createChannelSchema, firstIssue } from "@/lib/notify-schema";
import { isMailReady } from "@/services/mail";
import { countChannels, createChannel, listChannels, toPublic } from "@/services/notify/channels";
import { getMe } from "@/services/notify/telegram";

/**
 * The channels notifications go out on, for whoever holds the Notifications
 * permission.
 *
 * A channel receives every event it asked for, about every project on this
 * server: holding this permission means reading what the panel says about all
 * of them. The secrets never come back out — `toPublic` reduces each to "set"
 * or "not set", which is all the screen needs to draw "configurato".
 */

export async function GET() {
  const denied = await requirePermission("notifications");
  if (isDenied(denied)) return denied;

  const channels = await listChannels();
  return NextResponse.json(
    {
      channels: channels.map(toPublic),
      mailReady: await isMailReady(),
      max: MAX_CHANNELS,
      // The events a channel can ask for, so an API client does not have to
      // guess the keys: the same list the settings screen draws.
      catalog: NOTIFY_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        events: group.events.map((event) => ({ key: event.key, label: event.label })),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "notifications.channel.create", scope: "permission", scopeId: "notifications" }, async () => {
    const denied = await requirePermission("notifications");
    if (isDenied(denied)) return denied;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = createChannelSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error.issues), details: parsed.error.issues }, { status: 400 });
    }

    if ((await countChannels()) >= MAX_CHANNELS) {
      return NextResponse.json({ error: `Al massimo ${MAX_CHANNELS} canali: eliminane uno prima.` }, { status: 409 });
    }

    // Checked before it is stored, so a typo is refused while the operator is
    // still looking at the field rather than discovered by a silent
    // notification three days later.
    if (parsed.data.kind === "telegram") {
      const identity = await getMe(parsed.data.secrets.botToken);
      if (!identity.ok) {
        return NextResponse.json({ error: identity.error ?? "Token rifiutato da Telegram" }, { status: 400 });
      }
    }

    const channel = await createChannel(parsed.data);
    return NextResponse.json({ channel: toPublic(channel) }, { status: 201 });
  });
}
