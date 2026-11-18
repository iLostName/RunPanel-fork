import { CHANNEL_KIND_INFO, WEBHOOK_RATE } from "@/lib/notify-channels";
import { allowRate, drainBurst, newBurst, newRate, offerBurst, type BurstState, type RateState } from "@/lib/notify-throttle";
import { generateId } from "@/lib/utils";
import { digest } from "./messages";
import { getChannel, recordDelivery, type ChannelRecord } from "./channels";
import { sendVia, type Delivery, type SendResult } from "./transports";

/**
 * Getting a message to a channel without ever holding up whoever sent it.
 *
 * `dispatch` returns at once. Behind it, per channel: messages that arrive
 * close together are held and joined (`lib/notify-throttle.ts` says why and
 * how), a webhook is capped instead, a failure that looks temporary is tried
 * once more after a pause, and the outcome lands on the channel's row — so the
 * settings screen can say "ultimo invio non riuscito: …" in the words of the
 * failure, with every secret taken out first.
 *
 * State lives on `globalThis`, like the cooldown it sits behind: losing it on a
 * restart costs at most one message sent alone that would have been joined.
 */

const globalRef = globalThis as typeof globalThis & {
  __runpanelNotifyBursts?: Map<string, BurstState<Delivery>>;
  __runpanelNotifyRates?: Map<string, RateState>;
};

const bursts = () => (globalRef.__runpanelNotifyBursts ??= new Map<string, BurstState<Delivery>>());
const rates = () => (globalRef.__runpanelNotifyRates ??= new Map<string, RateState>());

/** A pause long enough for a hiccup to pass, short enough to still be news. */
const RETRY_DEFAULT_MS = 10_000;
const RETRY_MAX_MS = 60_000;

/** Hand a message to a channel. Returns immediately; never throws. */
export function dispatch(channel: ChannelRecord, message: Delivery): void {
  const info = CHANNEL_KIND_INFO[channel.kind];
  const now = Date.now();

  if (!info.coalesce) {
    const state = rates().get(channel.id) ?? newRate(now);
    rates().set(channel.id, state);
    const verdict = allowRate(state, now, WEBHOOK_RATE.max, WEBHOOK_RATE.windowMs);
    if (verdict.refusedBefore > 0) {
      console.warn(`[notify] «${channel.name}»: ${verdict.refusedBefore} avvisi non inviati nell'intervallo precedente, troppi in poco tempo`);
    }
    if (!verdict.allowed) {
      // Said once per window, on the row, rather than once per refusal in the log.
      if (state.refused === 1) {
        void recordDelivery(channel.id, {
          ok: false,
          error: `Troppi avvisi in poco tempo: al massimo ${WEBHOOK_RATE.max} ogni ${WEBHOOK_RATE.windowMs / 60_000} minuti, gli altri non sono stati inviati.`,
        });
      }
      return;
    }
    void deliver(channel, message);
    return;
  }

  const state = bursts().get(channel.id) ?? newBurst<Delivery>();
  bursts().set(channel.id, state);
  const offer = offerBurst(state, message, now, info.burstWindowMs);
  if (offer.send) void deliver(channel, offer.send);
  if (offer.scheduleAt !== null) {
    const timer = setTimeout(() => void flush(channel.id), Math.max(0, offer.scheduleAt - now));
    timer.unref?.();
  }
}

/** Send what a channel was holding: alone if it is one message, joined if it is several. */
async function flush(channelId: string): Promise<void> {
  try {
    const state = bursts().get(channelId);
    if (!state) return;
    const { items, dropped } = drainBurst(state, Date.now());
    if (items.length === 0) return;

    // Read again: in the minute it was waiting, the channel may have been
    // switched off, edited or deleted.
    const channel = await getChannel(channelId);
    if (!channel || !channel.enabled) return;

    await deliver(channel, items.length === 1 && dropped === 0 ? items[0] : joined(items, dropped));
  } catch (err) {
    console.error("[notify] Invio degli avvisi raggruppati non riuscito:", err instanceof Error ? err.message : err);
  }
}

/** Several deliveries as one: titles in the body, the originals listed for a program. */
function joined(items: readonly Delivery[], dropped: number): Delivery {
  const message = digest(items, dropped);
  const server = items[0]?.server ?? null;
  const withLink = items.find((item) => item.link);
  let origin: string | null = null;
  try {
    origin = withLink?.link ? new URL(withLink.link).origin : null;
  } catch {
    origin = null;
  }
  return {
    id: generateId(),
    event: "digest",
    level: message.level,
    title: server ? `${server} · ${message.title}` : message.title,
    body: message.body,
    link: origin ? `${origin}/notifications` : null,
    server,
    at: new Date().toISOString(),
    data: null,
    items: items.map((item) => ({ id: item.id, event: item.event, level: item.level, title: item.title, at: item.at })),
  };
}

/**
 * Send once, retry once if it looked temporary, write the outcome down.
 *
 * `retry: false` is the test button's: the person pressing it is waiting for an
 * answer, and "it will be tried again in ten seconds" is not one.
 */
export async function deliver(channel: ChannelRecord, message: Delivery, options: { retry?: boolean } = {}): Promise<SendResult> {
  const deliveryId = generateId();
  let result: SendResult;
  try {
    result = await sendVia(channel, message, deliveryId);
    if (!result.ok && result.retryable && options.retry !== false) {
      const wait = Math.min(Math.max(result.retryAfterMs ?? RETRY_DEFAULT_MS, 2_000), RETRY_MAX_MS);
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
      result = await sendVia(channel, message, deliveryId);
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const error = result.ok ? null : redactFor(channel, result.error ?? "Invio non riuscito");
  await recordDelivery(channel.id, error === null ? { ok: true } : { ok: false, error });
  if (error !== null) console.warn(`[notify] «${channel.name}» (${CHANNEL_KIND_INFO[channel.kind].label}): ${error}`);
  return error === null ? { ok: true } : { ok: false, error };
}

/**
 * Every secret this channel holds, taken out of a piece of text.
 *
 * The errors come from libraries and remote services, and a URL that *is* a
 * credential — a Discord or Slack webhook — or a Telegram API path with the
 * bot token in it are exactly what an error message likes to quote. This runs
 * on every error before it is logged or stored.
 */
export function redactFor(channel: ChannelRecord, text: string): string {
  const fragments = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") {
      if (value.length >= 6) fragments.add(value);
      try {
        const url = new URL(value);
        for (const part of url.pathname.split("/")) if (part.length >= 12) fragments.add(part);
        if (url.search.length > 6) fragments.add(url.search);
        if (url.password) fragments.add(url.password);
      } catch {
        /* not a URL */
      }
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value)) collect(inner);
    }
  };
  collect(channel.secrets);

  let out = text;
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) out = out.split(fragment).join("•••");
  return out.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot•••");
}
