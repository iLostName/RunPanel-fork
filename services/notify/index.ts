import { panelBaseUrl } from "@/lib/panel-url";
import { channelWants } from "@/lib/notify-events";
import { Cooldown } from "@/lib/notify-throttle";
import { generateId } from "@/lib/utils";
import { clusterState, getMember } from "@/services/cluster/state";
import { describe, escapeHtml, withRepeats, type NotifyEvent, type NotifyMessage } from "./messages";
import { hasReadyChannel, listChannels, type ChannelRecord } from "./channels";
import { noteRepeat, recordNotification, resolveSubject, type Subject } from "./center";
import { deliver, dispatch } from "./deliver";
import type { Delivery, SendResult } from "./transports";

/**
 * The one door out of the panel for "something happened that you would want to
 * know about".
 *
 * Everything about this function is arranged around a single rule: **a
 * notification must never be able to break the thing it is reporting on.** It
 * is called from inside a deploy, from a backup run and from a background
 * sweep, and every one of those is code where an unhandled rejection is a real
 * problem. So it never throws, never rejects, and never makes its caller wait
 * for a channel — callers use `void notify(...)` and carry on.
 *
 * What happens to an event, in order:
 *
 *  1. the cooldown: the same thing about the same subject is said once per
 *     quarter of an hour, and the repeats are counted;
 *  2. the panel's own record, the notification centre behind the bell, which
 *     gets every event and decides per reader who may see it (`center.ts`);
 *  3. every channel that asked for this event at this level, through
 *     `deliver.ts`, which joins bursts, retries once and writes down how it
 *     went.
 *
 * The subsystems emit *events* rather than strings, which is why none of them
 * had to change when the panel learnt to speak to more than Telegram.
 */

/**
 * How long the same event has to stay quiet after it has been sent.
 *
 * This is the difference between a useful channel and one that gets muted. A
 * project under a restart policy that crash-loops flaps stopped/running every
 * few seconds, and the status sweep reports each flap honestly; without a
 * cooldown that is a message every thirty seconds until somebody notices. The
 * first one says everything the twentieth would.
 *
 * Keyed per event *and per subject*, so a crash-looping project does not
 * silence a different one that falls over at the same time.
 */
const COOLDOWN_MS = 15 * 60_000;

/** Repeats are mentioned only when the previous notice is recent enough for "since then" to mean something. */
const REPEATS_RELEVANT_MS = 60 * 60_000;

/** In memory on purpose: losing it on restart costs one duplicate message. */
const globalRef = globalThis as typeof globalThis & {
  __runpanelNotifyCooldown?: Cooldown;
  /** The notification each cooldown key last filed, for counting its repeats. */
  __runpanelNotifyLastRow?: Map<string, string>;
};

const cooldown = () => (globalRef.__runpanelNotifyCooldown ??= new Cooldown(COOLDOWN_MS));
const lastRows = () => (globalRef.__runpanelNotifyLastRow ??= new Map<string, string>());

function cooldownKey(event: NotifyEvent): string {
  switch (event.key) {
    case "project.crashed":
      return `${event.key}:${event.slug}`;
    case "service.crashed":
      return `${event.key}:${event.name}`;
    case "restart.scheduled":
      // Never suppressed: a schedule fires at most once per occurrence, and
      // two occurrences minutes apart are two things that happened.
      return "";
    case "docker.down":
      return `${event.key}:${event.up ? "up" : "down"}`;
    case "disk.low":
      // Per disk and per level, and per policy for a backup that will not fit:
      // a disk going from low to critical is new, and so is a second policy.
      if ("backup" in event) return `${event.key}:backup:${event.backup.policy}:${event.up ? "up" : "down"}`;
      return `${event.key}:${event.scope ?? "data"}:${event.level ?? (event.up ? "ok" : "low")}`;
    case "deploy.finished":
      // Never suppressed: two deploys of the same project minutes apart are two
      // pieces of news, and a deploy is something a person just caused.
      return "";
    case "backup.finished":
      return "";
    case "panel.update":
      return `${event.key}:${event.to ?? ""}`;
    case "panel.restarted":
      return event.key;
  }
}

function rememberRow(key: string, id: string): void {
  const rows = lastRows();
  rows.delete(key);
  rows.set(key, id);
  // Insertion order is age order: the oldest goes first.
  if (rows.size > 500) rows.delete(rows.keys().next().value as string);
}

/**
 * In a cluster every server notifies on its own, so each message starts with
 * the name of the server that sent it. Null in solo mode.
 */
async function serverName(): Promise<string | null> {
  try {
    const state = await clusterState();
    if (!state) return null;
    return (await getMember(state.selfId))?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * A link back into the panel, when it knows its own address.
 *
 * Only when `panel_public_url` is set: everywhere else in the panel an absolute
 * URL is built from the request, and there is no request here. Guessing would
 * produce a link to `localhost` on somebody's phone.
 */
async function panelLink(href: string | null): Promise<string | null> {
  try {
    const base = await panelBaseUrl();
    if (!base) return null;
    return `${base.origin}${href && href.startsWith("/") ? href : ""}`;
  } catch {
    return null;
  }
}

/** The message as every channel receives it: the server's name in front, a link at the end. */
async function deliveryFor(
  id: string,
  event: { key: string } & Record<string, unknown>,
  message: NotifyMessage,
  subject: Pick<Subject, "href">
): Promise<Delivery> {
  const server = await serverName();
  const { key, ...data } = event;
  return {
    id,
    event: key,
    level: message.level,
    title: server ? `${server} · ${message.title}` : message.title,
    body: message.body,
    link: await panelLink(subject.href),
    server,
    at: new Date().toISOString(),
    data,
  };
}

/**
 * Announce an event. Fire-and-forget: callers do not await it, and nothing
 * observes the result but the log and the channels' rows.
 */
export async function notify(event: NotifyEvent): Promise<void> {
  try {
    const now = Date.now();
    const key = cooldownKey(event);
    const verdict = cooldown().admit(key, now);
    if (!verdict.send) {
      const previous = lastRows().get(key);
      if (previous) await noteRepeat(previous);
      return;
    }

    const recent = verdict.previousAt !== null && now - verdict.previousAt < REPEATS_RELEVANT_MS;
    const message = recent ? withRepeats(describe(event), verdict.repeats) : describe(event);
    const subject = await resolveSubject(event);
    const id = await recordNotification(event.key, message, subject);
    if (id && key) rememberRow(key, id);

    const fields = event as unknown as { key: string } & Record<string, unknown>;
    const channels = (await listChannels()).filter(
      (channel) => channel.enabled && channelWants(channel, fields, message.level)
    );
    if (channels.length === 0) return;

    const delivery = await deliveryFor(id ?? generateId(), fields, message, subject);
    for (const channel of channels) dispatch(channel, delivery);
  } catch (err) {
    // Reaching here means something the panel does not control went wrong —
    // the store, the network stack. It must not surface as a failed deploy.
    console.error("[notify] Notifica non inviata:", err instanceof Error ? err.message : err);
  }
}

/**
 * The test button. Sent at once — not joined with anything, not retried — and
 * reports its outcome, unlike `notify`. The outcome is also written on the
 * channel's row, like any other delivery.
 */
export async function testChannel(channel: ChannelRecord): Promise<SendResult> {
  const message: NotifyMessage = {
    level: "ok",
    title: "RunPanel è collegato",
    body: escapeHtml(
      `Questa è una prova del canale «${channel.name}». Da qui in poi ti arrivano gli avvisi che hai scelto per questo canale.`
    ),
  };
  const delivery = await deliveryFor(generateId(), { key: "test" }, message, { href: "/notifications" });
  return deliver(channel, delivery, { retry: false });
}

/**
 * Kept for `app/api/onboarding`: whether anything is set up that would reach a
 * person. The shape is the old one's in name only — there is no single
 * configuration any more, only channels.
 */
export async function readConfig(): Promise<{ ready: boolean }> {
  return { ready: await hasReadyChannel() };
}

export function isConfigured(config: { ready: boolean }): boolean {
  return config.ready;
}

export type { NotifyEvent } from "./messages";
