import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import type { PushDevicesTable } from "@/lib/db/schema";
import {
  choicesFor,
  isNotifyFilter,
  parseEventChoices,
  selectedEvents,
  type EventChoices,
  type NotifyFilter,
} from "@/lib/notify-events";
import { MAX_PUSH_DEVICES, pushServiceLabel, type PublicPushDevice } from "@/lib/push-rules";
import { generateId } from "@/lib/utils";
import { endpointHash, type PushTarget } from "@/lib/web-push";

/**
 * The devices that receive their account's notifications, as stored.
 *
 * A device is a notification channel that belongs to one person: it has a
 * name, the events it receives and how bad they have to be, like the channels
 * in Impostazioni › Generale › Notifiche, but anyone may have them, each sees
 * and edits only their own, and what reaches it is decided per notification by
 * what that account may see (services/notify/push.ts).
 *
 * The endpoint and the keys are stored sealed, and found by the hash of the
 * endpoint: the endpoint is a capability URL — with the keys and the panel's
 * VAPID key it is all it takes to put a notification on someone's screen — so
 * the store keeps no readable copy of it.
 *
 * One browser is one device. The endpoint is unique, so a browser in which a
 * second account turns notifications on stops receiving the first account's,
 * and a browser subscribing again (a new key, a renewed endpoint) updates its
 * row instead of adding one.
 */

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  endpointHash: string;
  /** Decrypted; null when the panel's key changed under it. Never leaves the server. */
  subscription: PushTarget | null;
  vapidKey: string;
  pushHost: string;
  origin: string | null;
  userAgent: string | null;
  enabled: boolean;
  events: EventChoices;
  filter: NotifyFilter;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type { PublicPushDevice };

const PURPOSE = "push";

function openSubscription(sealed: string): PushTarget | null {
  const plain = tryDecrypt(sealed, PURPOSE);
  if (plain === null) return null;
  try {
    const value = JSON.parse(plain) as Partial<PushTarget>;
    if (typeof value.endpoint !== "string" || typeof value.p256dh !== "string" || typeof value.auth !== "string") return null;
    return { endpoint: value.endpoint, p256dh: value.p256dh, auth: value.auth };
  } catch {
    return null;
  }
}

function sealSubscription(target: PushTarget): string {
  return encrypt(JSON.stringify({ endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth }), PURPOSE);
}

function fromRow(row: PushDevicesTable): DeviceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    endpointHash: row.endpoint_hash,
    subscription: openSubscription(row.subscription),
    vapidKey: row.vapid_key,
    pushHost: row.push_host,
    origin: row.origin,
    userAgent: row.user_agent,
    enabled: row.enabled === 1,
    events: parseEventChoices(row.events),
    filter: isNotifyFilter(row.filter) ? row.filter : "all",
    lastOkAt: row.last_ok_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicDevice(device: DeviceRecord, currentKey: string): PublicPushDevice {
  return {
    id: device.id,
    name: device.name,
    endpointHash: device.endpointHash,
    pushService: pushServiceLabel(device.pushHost),
    userAgent: device.userAgent,
    enabled: device.enabled,
    events: selectedEvents(device.events),
    filter: device.filter,
    stale: device.subscription === null || device.vapidKey !== currentKey,
    lastOkAt: device.lastOkAt,
    lastErrorAt: device.lastErrorAt,
    lastError: device.lastError,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

export async function listUserDevices(userId: string): Promise<DeviceRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("push_devices").selectAll().where("user_id", "=", userId).orderBy("created_at", "asc").execute();
  return rows.map(fromRow);
}

/** Every device that is switched on, for the sender to sort by account. */
export async function listEnabledDevices(): Promise<DeviceRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("push_devices").selectAll().where("enabled", "=", 1).execute();
  return rows.map(fromRow);
}

export async function getDevice(id: string): Promise<DeviceRecord | null> {
  const db = await getDb();
  const row = await db.selectFrom("push_devices").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** One of this account's devices; someone else's answers like one that does not exist. */
export async function getUserDevice(userId: string, id: string): Promise<DeviceRecord | null> {
  const device = await getDevice(id);
  return device && device.userId === userId ? device : null;
}

export async function findDeviceByEndpoint(endpoint: string): Promise<DeviceRecord | null> {
  const db = await getDb();
  const row = await db.selectFrom("push_devices").selectAll().where("endpoint_hash", "=", endpointHash(endpoint)).executeTakeFirst();
  return row ? fromRow(row) : null;
}

export async function countUserDevices(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("push_devices")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export interface SubscribeInput {
  userId: string;
  target: PushTarget;
  vapidKey: string;
  name: string;
  events?: readonly string[];
  filter?: NotifyFilter;
  origin: string | null;
  userAgent: string | null;
  /** The endpoint this browser had before, when it subscribed again: its row is kept, with its name and events. */
  previousEndpoint?: string | null;
}

export type SubscribeOutcome =
  | { kind: "created" | "updated"; device: DeviceRecord; tookFrom: string | null }
  | { kind: "full" };

/**
 * Store a subscription for an account.
 *
 * - The same endpoint already this account's: its keys are refreshed, and its
 *   name and events kept unless new ones came with the request.
 * - The endpoint this browser had before (`previousEndpoint`), this account's:
 *   that row takes the new endpoint, so a renewed subscription is the same
 *   device in the list.
 * - The endpoint another account's: that row goes. The browser now belongs to
 *   whoever turned notifications on in it last; the previous account would
 *   otherwise keep landing its notifications on a screen someone else uses.
 *   `tookFrom` says whose it was, for the activity log.
 * - Otherwise a new row, unless the account already has as many as it may.
 */
export async function subscribeDevice(input: SubscribeInput): Promise<SubscribeOutcome> {
  const db = await getDb();
  const now = nowIso();
  const hash = endpointHash(input.target.endpoint);
  const sealed = sealSubscription(input.target);
  const pushHost = new URL(input.target.endpoint).hostname.toLowerCase();

  const existing = await findDeviceByEndpoint(input.target.endpoint);
  let tookFrom: string | null = null;
  if (existing && existing.userId !== input.userId) {
    tookFrom = existing.userId;
    await db.deleteFrom("push_devices").where("id", "=", existing.id).execute();
  }

  const before =
    input.previousEndpoint && input.previousEndpoint !== input.target.endpoint
      ? await findDeviceByEndpoint(input.previousEndpoint).then((device) => (device && device.userId === input.userId ? device : null))
      : null;
  const mine = existing && existing.userId === input.userId ? existing : null;
  // Both rows this browser's, the new endpoint already filed on its own (by a
  // renewal that could not name the old one): the older row is the one with
  // the name and the choices its owner gave it, so it takes the endpoint.
  if (mine && before) await db.deleteFrom("push_devices").where("id", "=", mine.id).execute();
  const previous = before ?? mine;

  if (previous) {
    await db
      .updateTable("push_devices")
      .set({
        endpoint_hash: hash,
        subscription: sealed,
        vapid_key: input.vapidKey,
        push_host: pushHost,
        origin: input.origin ?? previous.origin,
        user_agent: input.userAgent ?? previous.userAgent,
        ...(input.events ? { events: JSON.stringify(choicesFor(input.events)) } : {}),
        ...(input.filter ? { filter: input.filter } : {}),
        // Subscribing again is someone asking for notifications here: whatever
        // went wrong with the old endpoint is no longer this device's story.
        last_error: null,
        last_error_at: null,
        updated_at: now,
      })
      .where("id", "=", previous.id)
      .execute();
    const device = await getDevice(previous.id);
    if (!device) throw new Error("Il dispositivo appena aggiornato non si rilegge");
    return { kind: "updated", device, tookFrom };
  }

  if ((await countUserDevices(input.userId)) >= MAX_PUSH_DEVICES) return { kind: "full" };

  const id = generateId();
  try {
    await insertDevice(id, input, { hash, sealed, pushHost, now });
  } catch (err) {
    // Two requests for one browser at once — a double press, the worker
    // renewing while the page subscribes: the endpoint is unique, so the
    // second insert fails, and the row the first one wrote is the answer.
    const winner = await findDeviceByEndpoint(input.target.endpoint);
    if (winner && winner.userId === input.userId) return { kind: "updated", device: winner, tookFrom };
    throw err;
  }
  const device = await getDevice(id);
  if (!device) throw new Error("Il dispositivo appena creato non si rilegge");
  return { kind: "created", device, tookFrom };
}

async function insertDevice(
  id: string,
  input: SubscribeInput,
  computed: { hash: string; sealed: string; pushHost: string; now: string }
): Promise<void> {
  const db = await getDb();
  const { hash, sealed, pushHost, now } = computed;
  await db
    .insertInto("push_devices")
    .values({
      id,
      user_id: input.userId,
      name: input.name,
      endpoint_hash: hash,
      subscription: sealed,
      vapid_key: input.vapidKey,
      push_host: pushHost,
      origin: input.origin,
      user_agent: input.userAgent,
      events: JSON.stringify(choicesFor(input.events ?? selectedEvents(null))),
      filter: input.filter ?? "all",
      enabled: 1,
      last_ok_at: null,
      last_error: null,
      last_error_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

export interface DevicePatch {
  name?: string;
  events?: readonly string[];
  filter?: NotifyFilter;
  enabled?: boolean;
}

export async function updateDevice(device: DeviceRecord, patch: DevicePatch): Promise<DeviceRecord> {
  const db = await getDb();
  await db
    .updateTable("push_devices")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.events !== undefined ? { events: JSON.stringify(choicesFor(patch.events)) } : {}),
      ...(patch.filter !== undefined ? { filter: patch.filter } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      updated_at: nowIso(),
    })
    .where("id", "=", device.id)
    .execute();
  return (await getDevice(device.id)) ?? device;
}

export async function deleteDevice(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.deleteFrom("push_devices").where("id", "=", id).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/** The outcome of one push, on the row for the list to show. */
export async function recordPushOutcome(id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  try {
    const db = await getDb();
    const now = nowIso();
    await db
      .updateTable("push_devices")
      .set(outcome.ok ? { last_ok_at: now } : { last_error: outcome.error.slice(0, 500), last_error_at: now })
      .where("id", "=", id)
      .execute();
  } catch (err) {
    console.error("[push] Esito dell'invio non registrato:", err instanceof Error ? err.message : err);
  }
}
