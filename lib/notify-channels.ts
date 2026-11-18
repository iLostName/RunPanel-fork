import type { NotifyEventKey, NotifyFilter } from "./notify-events";

/**
 * The ways a notification can leave the panel, and the rules for their fields.
 *
 * Shared by the settings screen, which draws its forms and checks a field as it
 * is typed, and by the API, which validates the same fields with the same
 * patterns (`lib/notify-schema.ts`) before anything is stored. Zero imports at
 * runtime — the two above are types — so the unit suite loads it directly.
 *
 * A channel has a kind, a name, the events it receives and how bad they have to
 * be, a few plain settings (a chat id, a topic, the addresses an email goes to)
 * and its secrets. The secrets are stored encrypted and never come back to the
 * browser: the screen is told which ones are set, which is all it needs to draw
 * "configurato" and leave the field blank to keep it.
 */

export const CHANNEL_KINDS = ["email", "telegram", "discord", "slack", "ntfy", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export function isChannelKind(value: unknown): value is ChannelKind {
  return CHANNEL_KINDS.includes(value as ChannelKind);
}

export interface ChannelKindInfo {
  label: string;
  /** One line, in the words of someone choosing where to be told. */
  description: string;
  /** Iconify name. A literal, because the icon bundler greps for these. */
  icon: string;
  /** The fields that are secrets: stored encrypted, never sent back. */
  secrets: readonly string[];
  /**
   * Whether messages close together are joined into one.
   *
   * True for everything a person reads. When Docker goes down, every service
   * on it stops at once, and the sweep reports each one honestly: on a phone
   * that is twenty buzzes for one event. A webhook is read by a program, which
   * wants each event as its own request, so it is rate-capped instead.
   */
  coalesce: boolean;
  /**
   * After a message, how long the channel waits before the next one. What
   * arrives in between is sent together when the wait is over, as one message.
   */
  burstWindowMs: number;
}

export const CHANNEL_KIND_INFO: Record<ChannelKind, ChannelKindInfo> = {
  email: {
    label: "Email",
    description: "A uno o più indirizzi, dal server di posta del pannello.",
    icon: "solar:letter-linear",
    secrets: [],
    coalesce: true,
    // Longer than the chats: an inbox that fills up during an incident is read
    // later, and one message with five lines reads better than five.
    burstWindowMs: 120_000,
  },
  telegram: {
    label: "Telegram",
    description: "Un messaggio da un tuo bot, in una chat o in un gruppo.",
    icon: "solar:plain-linear",
    secrets: ["botToken"],
    coalesce: true,
    burstWindowMs: 60_000,
  },
  discord: {
    label: "Discord",
    description: "Un messaggio in un canale del tuo server, con un webhook.",
    icon: "solar:chat-round-dots-linear",
    secrets: ["webhookUrl"],
    coalesce: true,
    burstWindowMs: 60_000,
  },
  slack: {
    label: "Slack",
    description: "Un messaggio in un canale, con un'app «Incoming Webhooks».",
    icon: "solar:hashtag-square-linear",
    secrets: ["webhookUrl"],
    coalesce: true,
    burstWindowMs: 60_000,
  },
  ntfy: {
    label: "ntfy",
    description: "Una notifica push sul telefono, con l'app ntfy: anche con un server tuo.",
    icon: "solar:smartphone-2-linear",
    secrets: ["token"],
    coalesce: true,
    burstWindowMs: 60_000,
  },
  webhook: {
    label: "Webhook",
    description: "Una richiesta HTTP firmata verso un tuo servizio, per automatizzare.",
    icon: "solar:code-square-linear",
    secrets: ["url", "signingSecret", "headers"],
    coalesce: false,
    burstWindowMs: 0,
  },
};

/** More would be a mistake rather than a need, and every one is tried on every event. */
export const MAX_CHANNELS = 20;

/** At most this many requests per window to one webhook, the cap it gets instead of being joined. */
export const WEBHOOK_RATE = { max: 30, windowMs: 10 * 60_000 } as const;

// --- Field rules ---------------------------------------------------------------

/**
 * `123456789:AA...`, which is the shape BotFather issues.
 *
 * Checked because the alternative is a save that succeeds, a test that fails
 * with "Unauthorized", and no way to tell a mistyped token from a revoked one.
 */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

/**
 * A numeric id, negative for groups and supergroups, or an `@channelname`.
 *
 * A username instead of an id is the usual mistake, and it fails with "chat
 * not found" hours later.
 */
export const TELEGRAM_CHAT_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** Discord's own hosts only: the URL is the credential, and a look-alike host would be handed it. */
export const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,200}$/;

/**
 * An Incoming Webhook, `/services/…`. Workflow and trigger URLs on the same
 * host take variables a workflow defines, not a message, and would refuse
 * what the panel sends with an `invalid_payload` nobody could act on.
 */
export const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/;

/** What ntfy accepts as a topic name. */
export const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

/**
 * Deliberately plain: a local part and a domain with a dot, no spaces, no
 * brackets. The SMTP server is the real judge; this is about a typo being
 * refused while the field is still on screen.
 */
export const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export const MAX_EMAIL_RECIPIENTS = 10;

/** A header name as HTTP allows it, without the oddities nobody uses. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** No control characters: a newline in a value is a second header. */
export const HEADER_VALUE_PATTERN = /^[\x20-\x7e\t]{1,1000}$/;

export const MAX_WEBHOOK_HEADERS = 10;

/** At least this long, so it cannot be guessed; the panel offers to generate one. */
export const MIN_SIGNING_SECRET = 16;

/**
 * Headers the panel sets itself. A custom header with one of these names would
 * either break the request or let a receiver be told a different signature
 * from the one that was computed.
 */
const RESERVED_HEADERS = new Set(["content-type", "content-length", "host", "user-agent", "connection", "transfer-encoding"]);

export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.has(lower) || lower.startsWith("x-runpanel-");
}

/** One address per line, or separated by commas or semicolons; duplicates dropped. */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const address = part.trim().toLowerCase();
    if (address) seen.add(address);
  }
  return [...seen];
}

// --- What can be shown of a secret ---------------------------------------------

/**
 * A recognisable, harmless piece of a URL that is itself a credential.
 *
 * A Discord or Slack webhook URL *is* the password: whoever holds it can post
 * to the channel. The screen still needs to tell two of them apart, so it gets
 * the part that names the target and none of the part that authorises it — the
 * host and the webhook's numeric id for Discord, the workspace and channel ids
 * for Slack, only the origin for anything else.
 */
export function urlHint(kind: ChannelKind, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (kind === "discord") {
    const id = /\/webhooks\/(\d+)\//.exec(url.pathname)?.[1];
    return id ? `${url.host} · webhook ${id}` : url.host;
  }
  if (kind === "slack") {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 3 ? `${url.host}/${parts[0]}/${parts[1]}/${parts[2]}/…` : url.host;
  }
  return url.origin;
}

// --- Custom headers ---------------------------------------------------------------

export interface HeaderInput {
  name: string;
  /** Blank keeps the value already stored under this name. */
  value?: string | null;
}

/**
 * The webhook's custom headers after an edit.
 *
 * Their values may be credentials (`Authorization: Bearer …`), so they are
 * stored with the secrets and never shown again: the screen lists the names and
 * a blank value means "keep what is there". A name that is no longer in the
 * list is removed. A blank value for a name that has nothing stored is reported
 * back, rather than silently becoming an empty header.
 */
export function mergeHeaders(
  stored: Readonly<Record<string, string>>,
  incoming: readonly HeaderInput[]
): { headers: Record<string, string>; missing: string[] } {
  const byLower = new Map(Object.entries(stored).map(([name, value]) => [name.toLowerCase(), value]));
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const entry of incoming) {
    const name = entry.name.trim();
    if (!name) continue;
    const value = entry.value?.trim();
    if (value) {
      headers[name] = value;
      continue;
    }
    const kept = byLower.get(name.toLowerCase());
    if (kept !== undefined) headers[name] = kept;
    else missing.push(name);
  }
  return { headers, missing };
}

// --- The channel as the browser sees it ---------------------------------------

export interface PublicChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  /** What it receives, defaults filled in: see `selectedEvents`. */
  events: NotifyEventKey[];
  filter: NotifyFilter;
  /** The plain settings: a chat id, a topic, recipients, a URL hint, header names. */
  config: Record<string, unknown>;
  /** Which secrets are set. Never their values. */
  secrets: Record<string, boolean>;
  /** False when the stored secrets cannot be read: the panel's key changed under them. */
  secretsReadable: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelHealth = "off" | "never" | "ok" | "failing";

/** One word for the list: off, never used, working, or failing since its last attempt. */
export function channelHealth(channel: Pick<PublicChannel, "enabled" | "lastOkAt" | "lastErrorAt">): ChannelHealth {
  if (!channel.enabled) return "off";
  if (!channel.lastOkAt && !channel.lastErrorAt) return "never";
  if (channel.lastErrorAt && (!channel.lastOkAt || channel.lastErrorAt > channel.lastOkAt)) return "failing";
  return "ok";
}

/** How Telegram names a chat, in the words the screen uses. */
export const TELEGRAM_CHAT_KIND: Record<string, string> = {
  private: "Chat privata",
  group: "Gruppo",
  supergroup: "Gruppo",
  channel: "Canale",
};
