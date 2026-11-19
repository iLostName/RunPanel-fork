import { pushDeviceName } from "../device-name";
import type { PublicPushDevice } from "../push-rules";
import { isIosDevice, isStandalone } from "./install";

/**
 * Notifications on this device, from the browser's side: whether they can
 * work here, turning them on, recognising this browser in the account's list,
 * keeping its subscription current, and letting it go at sign-out.
 *
 * Everything talks to the panel serving the page, never to a server selected
 * in the bar: a browser subscribes to the address it is on, and that panel is
 * the one that sends to it (docs: Notifiche › Sul telefono e sul computer).
 */

/**
 * Whether notifications can be turned on here, and if not, which of the
 * reasons a person can do something about:
 *
 * - `insecure`: no padlock. Browsers give push to HTTPS pages only (and to
 *   `localhost`), and the fix is in the panel's own settings.
 * - `ios-install`: an iPhone or an iPad in the browser. Since iOS 16.4 only the
 *   app added to the home screen gets notifications; the browser tab never does.
 * - `ios-old`: the app is on the home screen, but iOS is older than 16.4.
 * - `unsupported`: a browser without them at all.
 */
export type PushAvailability = "ready" | "insecure" | "ios-install" | "ios-old" | "unsupported";

export function pushAvailability(): PushAvailability {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  const ios = isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  if (ios && !isStandalone()) return "ios-install";
  const api = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!api) return ios ? "ios-old" : "unsupported";
  return "ready";
}

export function notificationPermission(): NotificationPermission | null {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : null;
}

/** The name a device gets when its notifications are turned on: "Chrome su Windows", "App RunPanel su iPhone". */
export function defaultDeviceName(): string {
  return pushDeviceName(navigator.userAgent, isStandalone(), navigator.maxTouchPoints > 1);
}

/** The key the panel sends with, as `pushManager.subscribe` wants it. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The panel key a subscription was made with, when the browser says (all current ones do). */
function keyOf(subscription: PushSubscription): string | null {
  const key = subscription.options?.applicationServerKey;
  return key ? bytesToBase64Url(key) : null;
}

/** The same hash the panel keeps of the endpoint, so this browser can find its own row in the list. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const READY_TIMEOUT_MS = 10_000;

/**
 * The panel's service worker, active. It registers on every page of a
 * production build (components/pwa/PwaRuntime.tsx); under `next dev` there is
 * none, and pushes have nothing to arrive at.
 */
async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing?.active) return existing;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PushError("Il pannello non ha ancora attivato il suo service worker: ricarica la pagina e riprova.", "no_worker")),
          READY_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** This browser's subscription, if it has one. Null wherever push is not available. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== "ready") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export class PushError extends Error {
  readonly code: string | undefined;
  /** What the browser or the panel said, word for word, for "Dettagli". */
  readonly detail: string | undefined;
  constructor(message: string, code?: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Subscribe this browser and register it with the account.
 *
 * The permission must have been asked already, in the press handler itself:
 * Safari grants it only from inside a user gesture, before anything awaited.
 * A subscription made with an older key of the panel is replaced, its row kept.
 */
export async function subscribeThisDevice(publicKey: string, name: string): Promise<PublicPushDevice> {
  const registration = await workerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  let previousEndpoint: string | null = null;
  if (subscription && keyOf(subscription) !== publicKey) {
    previousEndpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  const created = subscription === null;
  try {
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  } catch (err) {
    // The browser's own words are English and say little ("Registration
    // failed - push service error"); the usual causes are these.
    throw new PushError(
      "Il browser non è riuscito a iscriversi alle notifiche: succede in una finestra in incognito, senza connessione, o con le notifiche dei siti spente nelle impostazioni del browser.",
      "subscribe_failed",
      err instanceof Error ? err.message : String(err)
    );
  }

  let res: Response;
  try {
    res = await post("/api/account/push/devices", {
      subscription: subscription.toJSON(),
      name,
      previousEndpoint,
      applicationServerKey: publicKey,
    });
  } catch {
    if (created) await subscription.unsubscribe().catch(() => false);
    throw new PushError("Impossibile raggiungere il pannello");
  }
  const body = (await res.json().catch(() => ({}))) as { device?: PublicPushDevice; error?: string; code?: string };
  if (!res.ok || !body.device) {
    // A subscription made just now that the panel did not take is one nothing
    // will ever send to; one this browser already had is left as it was.
    if (created) await subscription.unsubscribe().catch(() => false);
    throw new PushError(body.error ?? "Attivazione non riuscita", body.code);
  }
  return body.device;
}

/**
 * Turn notifications off here: the row goes, and the browser lets its
 * subscription go. Done at "Esci" too, so whoever signs in next in this
 * browser does not receive this account's notifications.
 */
export async function forgetThisDevice(): Promise<void> {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  try {
    const res = await post("/api/account/push/sync", { endpoint: subscription.endpoint });
    const body = (await res.json().catch(() => ({}))) as { device?: PublicPushDevice | null };
    if (body.device) await fetch(`/api/account/push/devices/${encodeURIComponent(body.device.id)}`, { method: "DELETE" });
  } finally {
    await subscription.unsubscribe().catch(() => false);
    setAppBadge(0);
  }
}

let syncing = false;

/**
 * Keep this browser's subscription and the account's list in agreement, once
 * per visit (components/pwa/PushRuntime.tsx):
 *
 * - its row is gone (removed from another device, dropped after a 410, or the
 *   browser now belongs to another account): the subscription goes too;
 * - the panel's keys changed since it subscribed: it subscribes again, and the
 *   row keeps its name and its events.
 */
export async function syncThisDevice(): Promise<void> {
  if (syncing || notificationPermission() !== "granted") return;
  syncing = true;
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    const res = await post("/api/account/push/sync", { endpoint: subscription.endpoint });
    if (!res.ok) return;
    const body = (await res.json()) as { device: PublicPushDevice | null; publicKey: string };
    if (!body.device) {
      await subscription.unsubscribe().catch(() => false);
      return;
    }
    if (body.device.stale || keyOf(subscription) !== body.publicKey) await subscribeThisDevice(body.publicKey, body.device.name);
  } catch {
    /* the next visit tries again */
  } finally {
    syncing = false;
  }
}

/** The number on the installed app's icon, where the browser has one (the Badging API). */
export function setAppBadge(count: number): void {
  if (typeof navigator === "undefined") return;
  const badging = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void badging.setAppBadge?.(count).catch(() => {});
    else void badging.clearAppBadge?.().catch(() => {});
  } catch {
    /* not here */
  }
}
