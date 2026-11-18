import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import type { NotificationChannelsTable } from "@/lib/db/schema";
import { getSetting, setSettingIfAbsent } from "@/lib/settings";
import { generateId } from "@/lib/utils";
import {
  NOTIFY_EVENTS_SETTING,
  TELEGRAM_CHAT_SETTING,
  TELEGRAM_TOKEN_SETTING,
  choicesFor,
  isNotifyFilter,
  parseEventChoices,
  parseNotifyEvents,
  selectedEvents,
  type EventChoices,
  type NotifyFilter,
} from "@/lib/notify-events";
import {
  CHANNEL_KIND_INFO,
  DEFAULT_NTFY_SERVER,
  isChannelKind,
  mergeHeaders,
  urlHint,
  type ChannelKind,
  type PublicChannel,
} from "@/lib/notify-channels";
import type { CreateChannelInput, UpdateChannelInput } from "@/lib/notify-schema";
import { isMailReady } from "@/services/mail";

/**
 * The notification channels, as stored.
 *
 * Plain settings go in `config` as JSON, secrets in `secrets` as one encrypted
 * JSON blob, the same way a backup destination keeps its S3 keys. A channel
 * whose secrets can no longer be decrypted — the store restored under another
 * `RUNPANEL_SECRET` — is still listed, says so, and sends nothing until its
 * secrets are typed again.
 *
 * Per server. In a cluster each server notifies about its own projects, and
 * the Telegram bot the servers used to share was copied into each one's list
 * on upgrade (`importLegacyTelegram`), so nobody stops being told anything.
 */

export interface ChannelRecord {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  events: EventChoices;
  filter: NotifyFilter;
  config: Record<string, unknown>;
  /** Decrypted. Never leaves the server: see `toPublic`. */
  secrets: Record<string, unknown>;
  secretsReadable: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fromRow(row: NotificationChannelsTable): ChannelRecord | null {
  if (!isChannelKind(row.kind)) return null;
  const plain = row.secrets ? tryDecrypt(row.secrets) : "{}";
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
    events: parseEventChoices(row.events),
    filter: isNotifyFilter(row.filter) ? row.filter : "all",
    config: parseObject(row.config),
    secrets: plain === null ? {} : parseObject(plain),
    secretsReadable: plain !== null,
    lastOkAt: row.last_ok_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What the browser is told: every secret reduced to "set" or "not set". */
export function toPublic(channel: ChannelRecord): PublicChannel {
  const secrets: Record<string, boolean> = {};
  for (const field of CHANNEL_KIND_INFO[channel.kind].secrets) {
    const value = channel.secrets[field];
    secrets[field] = Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value);
  }
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    enabled: channel.enabled,
    events: selectedEvents(channel.events),
    filter: channel.filter,
    config: channel.config,
    secrets,
    secretsReadable: channel.secretsReadable,
    lastOkAt: channel.lastOkAt,
    lastErrorAt: channel.lastErrorAt,
    lastError: channel.lastError,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export async function listChannels(): Promise<ChannelRecord[]> {
  await importLegacyTelegram();
  const db = await getDb();
  const rows = await db.selectFrom("notification_channels").selectAll().orderBy("created_at", "asc").execute();
  return rows.map(fromRow).filter((channel): channel is ChannelRecord => channel !== null);
}

export async function getChannel(id: string): Promise<ChannelRecord | null> {
  const db = await getDb();
  const row = await db.selectFrom("notification_channels").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? fromRow(row) : null;
}

export async function countChannels(): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("notification_channels")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Whether this channel has everything it needs to send. An email channel also
 * needs the panel's mail server, which is asked separately (`isMailReady`).
 */
export function hasWhatItNeeds(channel: ChannelRecord): boolean {
  if (!channel.secretsReadable) return false;
  const s = channel.secrets;
  const c = channel.config;
  switch (channel.kind) {
    case "email":
      return Array.isArray(c.to) && c.to.length > 0;
    case "telegram":
      return Boolean(s.botToken) && Boolean(c.chatId);
    case "discord":
    case "slack":
      return Boolean(s.webhookUrl);
    case "ntfy":
      return Boolean(c.topic) && Boolean(c.server);
    case "webhook":
      return Boolean(s.url) && Boolean(s.signingSecret);
  }
}

/** Whether anything at all would reach a person: the onboarding checklist's question. */
export async function hasReadyChannel(): Promise<boolean> {
  const channels = (await listChannels()).filter((channel) => channel.enabled && hasWhatItNeeds(channel));
  if (channels.some((channel) => channel.kind !== "email")) return true;
  return channels.length > 0 && (await isMailReady());
}

/** The plain part of a new channel's settings, the hints of its secret URLs included. */
function configFor(input: CreateChannelInput): Record<string, unknown> {
  switch (input.kind) {
    case "email":
      return { to: input.config.to };
    case "telegram":
      return { chatId: input.config.chatId };
    case "discord":
    case "slack":
      return { hint: urlHint(input.kind, input.secrets.webhookUrl) };
    case "ntfy":
      return { server: input.config.server || DEFAULT_NTFY_SERVER, topic: input.config.topic };
    case "webhook":
      return { hint: urlHint("webhook", input.secrets.url), headerNames: (input.secrets.headers ?? []).map((h) => h.name) };
  }
}

function secretsFor(input: CreateChannelInput): Record<string, unknown> {
  switch (input.kind) {
    case "email":
      return {};
    case "telegram":
      return { botToken: input.secrets.botToken };
    case "discord":
    case "slack":
      return { webhookUrl: input.secrets.webhookUrl };
    case "ntfy":
      return input.secrets?.token ? { token: input.secrets.token } : {};
    case "webhook":
      return {
        url: input.secrets.url,
        signingSecret: input.secrets.signingSecret,
        headers: Object.fromEntries((input.secrets.headers ?? []).map((h) => [h.name.trim(), h.value.trim()])),
      };
  }
}

function sealSecrets(secrets: Record<string, unknown>): string | null {
  return Object.keys(secrets).length > 0 ? encrypt(JSON.stringify(secrets)) : null;
}

export async function createChannel(input: CreateChannelInput): Promise<ChannelRecord> {
  const db = await getDb();
  const now = nowIso();
  const id = generateId();
  await db
    .insertInto("notification_channels")
    .values({
      id,
      name: input.name,
      kind: input.kind,
      enabled: input.enabled === false ? 0 : 1,
      events: JSON.stringify(choicesFor(input.events)),
      filter: input.filter ?? "all",
      config: JSON.stringify(configFor(input)),
      secrets: sealSecrets(secretsFor(input)),
      last_ok_at: null,
      last_error: null,
      last_error_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const created = await getChannel(id);
  if (!created) throw new Error("Il canale appena creato non si rilegge");
  return created;
}

export class ChannelUpdateError extends Error {}

/**
 * Apply an edit. Absent or blank secrets keep what is stored; the plain
 * settings are merged field by field. Throws `ChannelUpdateError` with a
 * sentence for the screen when the result would be incomplete.
 */
export async function updateChannel(current: ChannelRecord, patch: UpdateChannelInput): Promise<ChannelRecord> {
  const config: Record<string, unknown> = { ...current.config };
  // A channel whose secrets were unreadable starts from nothing: what is typed
  // now replaces them, and whatever is still missing is refused below.
  const secrets: Record<string, unknown> = current.secretsReadable ? { ...current.secrets } : {};

  if (patch.config) {
    for (const [key, value] of Object.entries(patch.config)) {
      if (value !== undefined) config[key] = value;
    }
  }

  const incoming = (patch.secrets ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "headers") continue;
    if (value === null) delete secrets[key];
    else if (typeof value === "string" && value !== "") secrets[key] = value;
  }

  if (current.kind === "webhook" && Array.isArray(incoming.headers)) {
    const stored = (secrets.headers && typeof secrets.headers === "object" ? secrets.headers : {}) as Record<string, string>;
    const merged = mergeHeaders(stored, incoming.headers as { name: string; value?: string }[]);
    if (merged.missing.length > 0) {
      throw new ChannelUpdateError(`Manca il valore dell'intestazione ${merged.missing[0]}`);
    }
    secrets.headers = merged.headers;
    config.headerNames = Object.keys(merged.headers);
  }

  // The hint follows the URL it describes.
  if ((current.kind === "discord" || current.kind === "slack") && typeof secrets.webhookUrl === "string") {
    config.hint = urlHint(current.kind, secrets.webhookUrl);
  }
  if (current.kind === "webhook" && typeof secrets.url === "string") config.hint = urlHint("webhook", secrets.url);

  const next: ChannelRecord = {
    ...current,
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    events: patch.events ? choicesFor(patch.events) : current.events,
    filter: patch.filter ?? current.filter,
    config,
    secrets,
    secretsReadable: true,
  };
  if (!hasWhatItNeeds(next)) {
    throw new ChannelUpdateError(
      current.secretsReadable
        ? "Il canale resterebbe incompleto: compila i campi mancanti"
        : "I segreti salvati non sono più leggibili (la chiave del pannello è cambiata): inseriscili di nuovo"
    );
  }

  const db = await getDb();
  await db
    .updateTable("notification_channels")
    .set({
      name: next.name,
      enabled: next.enabled ? 1 : 0,
      events: JSON.stringify(next.events),
      filter: next.filter,
      config: JSON.stringify(config),
      secrets: sealSecrets(secrets),
      updated_at: nowIso(),
    })
    .where("id", "=", current.id)
    .execute();
  return (await getChannel(current.id)) ?? next;
}

export async function deleteChannel(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.deleteFrom("notification_channels").where("id", "=", id).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/** The outcome of one delivery, kept on the row for the list to show. */
export async function recordDelivery(id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  try {
    const db = await getDb();
    const now = nowIso();
    await db
      .updateTable("notification_channels")
      .set(outcome.ok ? { last_ok_at: now } : { last_error: outcome.error.slice(0, 500), last_error_at: now })
      .where("id", "=", id)
      .execute();
  } catch (err) {
    console.error("[notify] Esito dell'invio non registrato:", err instanceof Error ? err.message : err);
  }
}

// --- The bot from before there were channels -----------------------------------

const LEGACY_IMPORTED = "notify_channels_imported";

const legacyRef = globalThis as typeof globalThis & { __runpanelNotifyLegacyChecked?: boolean };

/**
 * Turn the old single Telegram configuration into the first channel, once.
 *
 * Done here and not in the migration because the token has to be decrypted to
 * be sealed again with the rest of the channel's secrets, and a migration must
 * not need the panel's key. The old settings are left where they were: in a
 * cluster they are replicated, and clearing them here would clear them on a
 * server still running the previous release.
 *
 * Claimed with a write-once setting, so two requests arriving together import
 * it once. A failure after the claim gives the claim back, so the next read
 * tries again instead of losing the bot.
 */
export async function importLegacyTelegram(): Promise<void> {
  if (legacyRef.__runpanelNotifyLegacyChecked) return;
  if (await getSetting(LEGACY_IMPORTED)) {
    legacyRef.__runpanelNotifyLegacyChecked = true;
    return;
  }

  const [storedToken, chatId, events] = await Promise.all([
    getSetting(TELEGRAM_TOKEN_SETTING),
    getSetting(TELEGRAM_CHAT_SETTING),
    getSetting(NOTIFY_EVENTS_SETTING),
  ]);
  if (!(await setSettingIfAbsent(LEGACY_IMPORTED, nowIso()))) {
    legacyRef.__runpanelNotifyLegacyChecked = true;
    return;
  }

  try {
    const token = storedToken ? tryDecrypt(storedToken) : null;
    if (token || chatId) {
      const db = await getDb();
      const now = nowIso();
      await db
        .insertInto("notification_channels")
        .values({
          id: generateId(),
          name: "Telegram",
          kind: "telegram",
          // Only on when it was working: half a configuration stays visible,
          // switched off, for whoever set it up to finish.
          enabled: token && chatId ? 1 : 0,
          events: JSON.stringify(choicesFor(parseNotifyEvents(events))),
          filter: "all",
          config: JSON.stringify({ chatId: chatId ?? "" }),
          secrets: token ? encrypt(JSON.stringify({ botToken: token })) : null,
          last_ok_at: null,
          last_error: null,
          last_error_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      console.log("[notify] Il bot Telegram configurato prima è ora il primo canale di notifica");
    }
    legacyRef.__runpanelNotifyLegacyChecked = true;
  } catch (err) {
    console.error("[notify] Importazione del bot Telegram non riuscita:", err instanceof Error ? err.message : err);
    const db = await getDb();
    await db
      .deleteFrom("settings")
      .where("key", "=", LEGACY_IMPORTED)
      .execute()
      .catch(() => {});
  }
}
