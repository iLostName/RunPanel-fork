/**
 * Notifications on a person's own devices (Web Push): the rules the browser,
 * the API and the sender share.
 *
 * Zero imports, so the settings screen, `lib/validation.ts` (which the
 * browser loads too) and the unit suite can all read it. The cryptography is
 * `lib/web-push.ts`, on the server only.
 */

/**
 * The push services browsers use, by host.
 *
 * A browser does not let a page choose where its pushes go: Chrome, Edge on
 * Android, Opera and Samsung Internet use Google's service, Firefox Mozilla's,
 * Safari Apple's and Edge on Windows Microsoft's. The endpoint arrives from the
 * page, though, and the panel then POSTs to it — so an endpoint is accepted
 * only on these hosts, or on one the operator added (`RUNPANEL_PUSH_SERVICES`).
 * Otherwise any account could point the panel at a machine on its own network
 * and use the test button to learn which ports answer.
 *
 * A leading dot matches the subdomains of a host, and only those.
 */
export const PUSH_SERVICES: readonly { host: string; label: string }[] = [
  { host: "fcm.googleapis.com", label: "Google" },
  // The endpoints of the old GCM API, still carried by long-lived subscriptions.
  { host: "android.googleapis.com", label: "Google" },
  { host: "updates.push.services.mozilla.com", label: "Mozilla" },
  { host: ".push.services.mozilla.com", label: "Mozilla" },
  { host: "web.push.apple.com", label: "Apple" },
  { host: ".push.apple.com", label: "Apple" },
  { host: ".notify.windows.com", label: "Microsoft" },
];

function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const want = pattern.toLowerCase();
  return want.startsWith(".") ? host.endsWith(want) && host.length > want.length : host === want;
}

/** "Google", "Apple": who carries a device's notifications, for the device list. */
export function pushServiceLabel(hostname: string): string {
  return PUSH_SERVICES.find((service) => hostMatches(hostname, service.host))?.label ?? hostname;
}

/**
 * `RUNPANEL_PUSH_SERVICES`: more push service hosts, separated by commas, for
 * a browser pointed at a push server of its own. Read as hosts and nothing
 * else: a scheme, a port or a path in an entry is ignored rather than trusted.
 */
export function parsePushServices(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    let entry = part.trim().toLowerCase();
    if (!entry) continue;
    entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
    // Brackets kept for an IPv6 literal; the port, if any, dropped.
    entry = entry.startsWith("[") ? entry.replace(/^(\[[^\]]+\]).*$/, "$1") : entry.replace(/:\d+$/, "");
    if (/^\.?[a-z0-9.[\]:-]+$/.test(entry)) out.push(entry);
  }
  return out;
}

/**
 * Why an endpoint is refused, in a sentence for the screen; null when it is
 * one the panel will send to.
 *
 * The known services must be reached over https on their standard port. A
 * host the operator listed may use plain http and any port: it is their
 * machine, typically a push server beside the panel, or a test.
 */
export function pushEndpointProblem(raw: string, extraHosts: readonly string[] = []): string | null {
  if (raw.length > 2048) return "L'indirizzo del servizio push è troppo lungo";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "L'indirizzo del servizio push non è valido";
  }
  if (url.username || url.password) return "L'indirizzo del servizio push non può contenere credenziali";
  const host = url.hostname.toLowerCase();

  if (extraHosts.some((extra) => hostMatches(host, extra))) {
    return url.protocol === "https:" || url.protocol === "http:" ? null : "Il servizio push deve usare https://";
  }
  if (url.protocol !== "https:") return "Il servizio push deve usare https://";
  if (url.port && url.port !== "443") return "Il servizio push deve usare la porta standard di https";
  if (!PUSH_SERVICES.some((service) => hostMatches(host, service.host))) {
    return `Questo browser usa un servizio push che il pannello non conosce (${host}). Le notifiche push funzionano con Chrome, Edge, Firefox e Safari.`;
  }
  return null;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** How many bytes a base64url string holds, without its padding; null if it is not one. */
export function base64UrlBytes(value: string): number | null {
  const bare = value.replace(/=+$/, "");
  if (!BASE64URL.test(bare) || bare.length % 4 === 1) return null;
  return Math.floor((bare.length * 3) / 4);
}

/** The browser's key: an uncompressed P-256 point, 65 bytes starting with 0x04 — which base64url writes as `B`. */
export function isPushPublicKey(value: string): boolean {
  return base64UrlBytes(value) === 65 && value.startsWith("B");
}

/** The browser's authentication secret: 16 bytes (RFC 8291 §3.2). */
export function isPushAuthSecret(value: string): boolean {
  return base64UrlBytes(value) === 16;
}

/** One of an account's devices as its owner's browser is told: no endpoint, no keys. */
export interface PublicPushDevice {
  id: string;
  name: string;
  /** SHA-256 of the endpoint, hex: how a browser recognises its own row. */
  endpointHash: string;
  /** "Google", "Apple", "Mozilla", "Microsoft". */
  pushService: string;
  userAgent: string | null;
  enabled: boolean;
  /** Event keys from lib/notify-events.ts, defaults filled in. */
  events: string[];
  filter: "all" | "problems";
  /**
   * Made with keys the panel no longer has, or unreadable: nothing is sent to
   * it until the browser subscribes again, which it does by itself the next
   * time the panel is opened there.
   */
  stale: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Devices per account. A person has a phone, a laptop, a desk; more than this is a list nobody tends. */
export const MAX_PUSH_DEVICES = 10;
export const PUSH_DEVICE_NAME_MAX = 60;

/** What a notification shows. A phone cuts the body at two or three lines, and a lock screen is public. */
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 240;

/**
 * What travels to the device, sealed: everything the service worker needs to
 * draw the notification and to open the right page from it. Nothing that is a
 * secret, and nothing a message to Telegram would carry and a lock screen
 * should not: no log lines, errors or commit messages, only names and states.
 */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** A path inside the panel, opened (or focused) when the notification is pressed. */
  url: string;
  /** Notifications with the same tag replace each other: one per project, per service, per kind of trouble. */
  tag: string;
  level: "ok" | "warn" | "danger" | "info";
  /** The unread count of this account's notification centre, for the badge on the app's icon. */
  unread: number | null;
  /** The notifications this one stands for, marked read when it is pressed. */
  ids: string[];
  /** Milliseconds since the epoch: when it happened. */
  at: number;
  icon: string;
  /** The small monochrome picture Android shows in the status bar. */
  badge: string;
}

export const PUSH_ICON = "/icons/icon-192.png";
export const PUSH_BADGE = "/icons/monochrome-192.png";

/** A path inside the panel, or the notification centre: never another site, never `//host`. */
export function panelPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/notifications";
  return raw.length > 512 ? "/notifications" : raw;
}

/** Shortened to `max` characters on a word boundary when one is close, with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  // Half a surrogate pair is not a character: a name with an emoji would end in a box.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
