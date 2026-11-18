import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { consumeRateLimit } from "@/lib/rate-limit";
import { telegramChatsSchema } from "@/lib/notify-schema";
import { getChannel } from "@/services/notify/channels";
import { discoverChats } from "@/services/notify/telegram";

/**
 * The chats that have written to a bot recently, so the chat id can be picked
 * from a list instead of looked up with @userinfobot.
 *
 * Works with a token typed into the form and not saved yet — the whole point
 * is to finish setting a channel up — or with the one a saved channel holds,
 * which never leaves the server. A question to Telegram, not a change: nothing
 * is stored, so nothing is audited.
 */
export async function POST(request: NextRequest) {
  const denied = await requirePermission("notifications");
  if (isDenied(denied)) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = telegramChatsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }

  let token = parsed.data.token ?? null;
  if (!token && parsed.data.channelId) {
    const channel = await getChannel(parsed.data.channelId);
    if (channel?.kind === "telegram" && typeof channel.secrets.botToken === "string") token = channel.secrets.botToken;
  }
  if (!token) return NextResponse.json({ ok: false, error: "Incolla prima il token del bot." });

  const limit = await consumeRateLimit(`notify-chats:${denied.session.user.id}`, 20, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: `Troppe richieste: riprova tra ${limit.retryAfter} secondi.` }, { status: 429 });
  }

  const found = await discoverChats(token);
  if (!found.ok) return NextResponse.json({ ok: false, error: found.error });

  return NextResponse.json({
    ok: true,
    chats: found.chats,
    ...(found.chats && found.chats.length === 0
      ? {
          error:
            "Nessuna chat trovata. Apri Telegram, scrivi un messaggio qualsiasi al bot e riprova: finché non gli scrivi tu, un bot non sa dove mandarti niente.",
        }
      : {}),
  });
}
