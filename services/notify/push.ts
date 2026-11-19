import type { Principal } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { channelWants } from "@/lib/notify-events";
import { drainBurst, newBurst, offerBurst, type BurstState } from "@/lib/notify-throttle";
import { loadPrincipal } from "@/lib/principal";
import {
  PUSH_BADGE,
  PUSH_BODY_MAX,
  PUSH_ICON,
  PUSH_TITLE_MAX,
  clip,
  panelPath,
  parsePushServices,
  pushEndpointProblem,
  type PushPayload,
} from "@/lib/push-rules";
import { encryptPush, pushTopic, vapidAuthorization } from "@/lib/web-push";
import type { Subject } from "./center";
import { canSee, unreadCount } from "./inbox";
import type { NotifyEvent, NotifyLevel, NotifyMessage } from "./messages";
import { deleteDevice, getDevice, listEnabledDevices, recordPushOutcome, type DeviceRecord } from "./push-devices";
import { getVapidKeys, vapidSubject } from "./push-keys";
import { describePush, describePushDigest } from "./push-text";
import { serverName } from "./server-name";

/**
 * Notifications on people's own devices: what reaches each one, and how.
 *
 * The rule the rest is built around: **a push never says what its account may
 * not see.** Every notification is checked against the account a device
 * belongs to with the same function the bell uses (`canSee`, inbox.ts) — when
 * it happens and again when it leaves, since a burst can hold it back a
 * minute — and the words are the short ones from `push-text.ts`, which quote
 * nothing from a log or a remote service.
 *
 * The rest is the channels' behaviour, per device: what arrives in a burst is
 * held and sent as one after the first (Docker going down stops twenty
 * services at once, and a phone should buzz once); a tag per project or
 * service makes a newer notification replace the older one on the screen;
 * a temporary failure is tried once more; and a device whose push service
 * answers 404 or 410 no longer exists, so its row goes.
 *
 * Like `notify()`, nothing here throws or makes the caller wait.
 */

/** How long a device keeps quiet after a push before the next one, joining what arrives meanwhile. */
const PUSH_BURST_MS = 60_000;

/** How long a push service keeps a message for a device that is offline: a day, after which it is history, in the bell. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

const TIMEOUT_MS = 10_000;
const RETRY_DEFAULT_MS = 10_000;
const RETRY_MAX_MS = 60_000;

/** One notification as a device will receive it, with who may see it kept for the check on the way out. */
interface PushItem {
  ids: string[];
  title: string;
  body: string;
  url: string;
  tag: string;
  level: NotifyLevel;
  at: number;
  subject: Pick<Subject, "scope" | "scopeId" | "permission">;
}

export interface PushResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** The push service no longer knows the subscription: the device was removed. */
  gone?: boolean;
}

const globalRef = globalThis as typeof globalThis & { __runpanelPushBursts?: Map<string, BurstState<PushItem>> };
const bursts = () => (globalRef.__runpanelPushBursts ??= new Map<string, BurstState<PushItem>>());

/** `RUNPANEL_PUSH_SERVICES`: push servers the operator added to the known ones. */
export function extraPushHosts(): string[] {
  return parsePushServices(process.env.RUNPANEL_PUSH_SERVICES);
}

/** The account a device belongs to, as the permission checks need it; null when it is disabled or gone. */
async function readerFor(userId: string): Promise<Principal | null> {
  const db = await getDb();
  const user = await db.selectFrom("users").select(["id", "email", "is_owner", "disabled"]).where("id", "=", userId).executeTakeFirst();
  if (!user || user.disabled === 1) return null;
  return loadPrincipal({ id: user.id, email: user.email, isOwner: user.is_owner === 1 });
}

/** One per project, per service, or per kind of event about the machine: a newer one replaces the older on the screen. */
function tagFor(key: string, subject: Pick<Subject, "scope" | "scopeId">): string {
  return subject.scope && subject.scopeId ? `${subject.scope}:${subject.scopeId}` : `event:${key}`;
}

/** Offer one notification to every device that wants it and whose account may see it. Never throws. */
export async function pushToDevices(event: NotifyEvent, message: NotifyMessage, subject: Subject, notificationId: string | null): Promise<void> {
  try {
    const fields = event as unknown as { key: string } & Record<string, unknown>;
    const devices = (await listEnabledDevices()).filter((device) => channelWants(device, fields, message.level));
    if (devices.length === 0) return;

    const words = describePush(event, message);
    const server = await serverName();
    const item: PushItem = {
      ids: notificationId ? [notificationId] : [],
      title: server ? clip(`${server} · ${words.title}`, PUSH_TITLE_MAX) : words.title,
      body: words.body,
      url: panelPath(subject.href ?? "/notifications"),
      tag: tagFor(event.key, subject),
      level: message.level,
      at: Date.now(),
      subject: { scope: subject.scope, scopeId: subject.scopeId, permission: subject.permission },
    };

    const allowed = new Map<string, boolean>();
    for (const device of devices) {
      if (!allowed.has(device.userId)) {
        const reader = await readerFor(device.userId);
        allowed.set(device.userId, reader !== null && (await canSee(reader, item.subject)));
      }
      if (allowed.get(device.userId)) offer(device.id, item);
    }
  } catch (err) {
    console.error("[push] Notifiche push non inviate:", err instanceof Error ? err.message : err);
  }
}

function offer(deviceId: string, item: PushItem): void {
  const now = Date.now();
  const state = bursts().get(deviceId) ?? newBurst<PushItem>();
  bursts().set(deviceId, state);
  const verdict = offerBurst(state, item, now, PUSH_BURST_MS);
  if (verdict.send) void deliverItems(deviceId, [verdict.send], 0);
  if (verdict.scheduleAt !== null) {
    const timer = setTimeout(() => void flush(deviceId), Math.max(0, verdict.scheduleAt - now));
    timer.unref?.();
  }
}

async function flush(deviceId: string): Promise<void> {
  const state = bursts().get(deviceId);
  if (!state) return;
  const { items, dropped } = drainBurst(state, Date.now());
  if (items.length === 0 && dropped === 0) return;
  await deliverItems(deviceId, items, dropped);
}

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, ok: 1, warn: 2, danger: 3 };

/**
 * What the device is sent for what was held: the one notification as it is;
 * several about the same thing as the newest, saying how many there were;
 * several about different things as a digest that opens the notification centre.
 */
function payloadFor(items: readonly PushItem[], dropped: number, unread: number | null): PushPayload {
  const latest = items[items.length - 1];
  const level = items.reduce<NotifyLevel>((worst, item) => (LEVEL_RANK[item.level] > LEVEL_RANK[worst] ? item.level : worst), "info");
  const ids = [...new Set(items.flatMap((item) => item.ids))].slice(0, 50);
  const base = { v: 1 as const, unread, ids, at: latest.at, icon: PUSH_ICON, badge: PUSH_BADGE, level };

  if (items.length === 1 && dropped === 0) {
    return { ...base, title: latest.title, body: latest.body, url: latest.url, tag: latest.tag, level: latest.level };
  }
  if (dropped === 0 && items.every((item) => item.tag === latest.tag)) {
    return {
      ...base,
      title: latest.title,
      body: clip(`${latest.body} (${items.length} avvisi in poco tempo)`, PUSH_BODY_MAX),
      url: latest.url,
      tag: latest.tag,
    };
  }
  const digest = describePushDigest(
    items.map((item) => item.title),
    dropped
  );
  return { ...base, title: digest.title, body: digest.body, url: "/notifications", tag: "digest" };
}

async function deliverItems(deviceId: string, items: readonly PushItem[], dropped: number): Promise<void> {
  try {
    // Read again: in the minute it waited, the device may have been switched off or removed.
    const device = await getDevice(deviceId);
    if (!device || !device.enabled) return;
    const reader = await readerFor(device.userId);
    if (!reader) return;

    // And the permission again, as it leaves.
    const visible: PushItem[] = [];
    for (const item of items) if (await canSee(reader, item.subject)) visible.push(item);
    if (visible.length === 0) return;

    const unread = await unreadCount(reader).catch(() => null);
    await sendAndRecord(device, payloadFor(visible, visible.length === items.length ? dropped : 0, unread), { retry: true });
  } catch (err) {
    console.error("[push] Invio non riuscito:", err instanceof Error ? err.message : err);
  }
}

/**
 * "Invia una prova": now, alone, not retried, and with the answer — the person
 * who pressed it is waiting for one. Recorded on the row like any push.
 */
export async function testPush(device: DeviceRecord): Promise<PushResult> {
  const reader = await readerFor(device.userId);
  const payload: PushPayload = {
    v: 1,
    title: "Prova da RunPanel",
    body: clip(`Le notifiche arrivano su «${device.name}». Da qui in poi ricevi gli avvisi che hai scelto per questo dispositivo.`, PUSH_BODY_MAX),
    url: "/account?open=push",
    tag: "runpanel-test",
    level: "ok",
    unread: reader ? await unreadCount(reader).catch(() => null) : null,
    ids: [],
    at: Date.now(),
    icon: PUSH_ICON,
    badge: PUSH_BADGE,
  };
  return sendAndRecord(device, payload, { retry: false });
}

async function sendAndRecord(device: DeviceRecord, payload: PushPayload, options: { retry: boolean }): Promise<PushResult> {
  let result = await sendPush(device, payload);
  if (!result.ok && result.retryable && options.retry) {
    const wait = Math.min(Math.max(result.retryAfterMs ?? RETRY_DEFAULT_MS, 2_000), RETRY_MAX_MS);
    await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
    result = await sendPush(device, payload);
  }

  if (result.gone) {
    await deleteDevice(device.id).catch(() => false);
    console.log(`[push] «${device.name}» non è più iscritto al suo servizio push: rimosso dall'elenco`);
    return result;
  }
  await recordPushOutcome(device.id, result.ok ? { ok: true } : { ok: false, error: result.error ?? "Invio non riuscito" });
  if (!result.ok) console.warn(`[push] «${device.name}»: ${result.error}`);
  return result;
}

const REACTIVATE = "Questo dispositivo va riattivato: apri il pannello su di esso, e le notifiche ripartono da sole.";

/** One POST to the device's push service. Never throws; the endpoint never appears in what it returns. */
export async function sendPush(device: DeviceRecord, payload: PushPayload): Promise<PushResult> {
  const target = device.subscription;
  if (!target) return { ok: false, error: REACTIVATE };
  let keys;
  try {
    keys = await getVapidKeys();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (device.vapidKey !== keys.publicKey) return { ok: false, error: REACTIVATE };

  const problem = pushEndpointProblem(target.endpoint, extraPushHosts());
  if (problem) return { ok: false, error: problem };
  const host = new URL(target.endpoint).host;

  let body: Buffer;
  try {
    body = encryptPush(JSON.stringify(payload), target);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: payload.level === "danger" ? "high" : "normal",
        Topic: pushTopic(payload.tag),
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: vapidAuthorization(target.endpoint, await vapidSubject(device.origin), keys),
      },
      body: new Uint8Array(body),
      // Checked when it was saved; a redirect is how it would end up somewhere that was not.
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    // Never read: what a push service answers can quote the subscription.
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return statusProblem(res.status, host, res.headers.get("retry-after"));
  } catch (err) {
    return networkProblem(err, host);
  } finally {
    clearTimeout(timer);
  }
}

function statusProblem(status: number, host: string, retryAfterHeader: string | null): PushResult {
  if (status === 404 || status === 410) {
    return { ok: false, gone: true, error: `Il servizio push (${host}) non conosce più questo dispositivo (HTTP ${status}).` };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: `Il servizio push ha rifiutato la firma del pannello (HTTP ${status}). Disattiva e riattiva le notifiche su questo dispositivo.`,
    };
  }
  if (status === 413) return { ok: false, error: "Il messaggio è troppo grande per il servizio push (HTTP 413)." };
  if (status === 429) {
    return { ok: false, error: "Il servizio push chiede di rallentare (HTTP 429).", retryable: true, retryAfterMs: retryAfter(retryAfterHeader) };
  }
  if (status >= 500) {
    return { ok: false, error: `Il servizio push ha risposto con un errore (HTTP ${status}).`, retryable: true, retryAfterMs: retryAfter(retryAfterHeader) };
  }
  if (status >= 300 && status < 400) return { ok: false, error: `Il servizio push ha risposto con un reindirizzamento (HTTP ${status}).` };
  return { ok: false, error: `Il servizio push ha rifiutato la notifica (HTTP ${status}).` };
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function networkProblem(err: unknown, host: string): PushResult {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === "AbortError") return { ok: false, error: `Il servizio push (${host}) non ha risposto entro ${TIMEOUT_MS / 1000} s.`, retryable: true };
  const code = e?.cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { ok: false, error: `Il server non riesce a trovare ${host} (DNS): ha accesso a internet?`, retryable: code === "EAI_AGAIN" };
  }
  if (code === "ECONNREFUSED") return { ok: false, error: `${host} ha rifiutato la connessione.`, retryable: true };
  return { ok: false, error: `Richiesta a ${host} non riuscita${code ? ` (${code})` : ""}.`, retryable: true };
}
