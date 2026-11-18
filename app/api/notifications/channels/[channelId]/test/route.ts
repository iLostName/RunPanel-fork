import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { isMailReady } from "@/services/mail";
import { getChannel } from "@/services/notify/channels";
import { testChannel } from "@/services/notify";

/**
 * "Invia una prova": one message, now, and the answer.
 *
 * 200 with the reason inside, not a 4xx, when the message did not get there:
 * "chat not found" is a successful question with an answer the operator has
 * to act on. A few a minute per account, so the button cannot be used to
 * flood whatever the channel points at.
 */

type Params = { params: Promise<{ channelId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { channelId } = await params;
  return withAudit(request, { category: "system", action: "notifications.channel.test", scope: "permission", scopeId: "notifications" }, async () => {
    const denied = await requirePermission("notifications");
    if (isDenied(denied)) return denied;

    const channel = await getChannel(channelId);
    if (!channel) return NextResponse.json({ error: "Canale non trovato" }, { status: 404 });

    const limit = await consumeRateLimit(`notify-test:${denied.session.user.id}`, 10, 60_000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppe prove di fila: riprova tra ${limit.retryAfter} secondi.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }

    if (channel.kind === "email" && !(await isMailReady())) {
      return NextResponse.json({
        ok: false,
        error: "Il server di posta non è configurato: lo imposta il proprietario, in Impostazioni › Generale › Server di posta.",
      });
    }

    const result = await testChannel(channel);
    return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error });
  });
}
