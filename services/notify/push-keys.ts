import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { panelBaseUrl } from "@/lib/panel-url";
import { getSetting, setSettingIfAbsent } from "@/lib/settings";
import { generateVapidKeys, isVapidKeys, type VapidKeys } from "@/lib/web-push";

/**
 * The panel's VAPID key pair: how a push service knows that a message for a
 * subscription comes from the panel that subscription was made for.
 *
 * Made once, the first time anyone asks, and kept in `settings` sealed with
 * the panel's key under its own purpose. Per server and never replicated: in
 * a cluster each server signs its own pushes, to the browsers that subscribed
 * to it.
 *
 * A store restored under another `RUNPANEL_SECRET` cannot open the pair. Then
 * a new one is made, and the devices that subscribed with the old public key
 * are left alone, marked in the list as waiting to be activated again: each
 * subscribes anew the next time the panel is opened on it
 * (components/pwa/PushRuntime.tsx), which is the only way a subscription can
 * change keys.
 */

export const VAPID_SETTING = "push_vapid_keys";
const PURPOSE = "vapid";

const globalRef = globalThis as typeof globalThis & {
  /** The decrypted pair and the stored text it came from, so a replaced one is noticed. */
  __runpanelVapid?: { stored: string; keys: VapidKeys };
};

function open(stored: string): VapidKeys | null {
  const plain = tryDecrypt(stored, PURPOSE);
  if (plain === null) return null;
  try {
    const parsed = JSON.parse(plain) as unknown;
    return isVapidKeys(parsed) ? { publicKey: parsed.publicKey, privateKey: parsed.privateKey } : null;
  } catch {
    return null;
  }
}

function seal(keys: VapidKeys): string {
  return encrypt(JSON.stringify(keys), PURPOSE);
}

/**
 * The pair, made on first use. Two requests making it at once agree on one:
 * the first write wins and the other reads it back. Replacing an unreadable
 * pair is a compare-and-swap on the text that could not be read, for the same
 * reason.
 */
export async function getVapidKeys(): Promise<VapidKeys> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await getSetting(VAPID_SETTING);
    if (stored) {
      const cached = globalRef.__runpanelVapid;
      if (cached && cached.stored === stored) return cached.keys;
      const keys = open(stored);
      if (keys) {
        globalRef.__runpanelVapid = { stored, keys };
        return keys;
      }
      // Sealed with another key: replace it, unless someone already has.
      const fresh = generateVapidKeys();
      const sealed = seal(fresh);
      const db = await getDb();
      const result = await db
        .updateTable("settings")
        .set({ value: sealed })
        .where("key", "=", VAPID_SETTING)
        .where("value", "=", stored)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) > 0) {
        console.warn("[push] Le chiavi VAPID salvate non si aprono con la chiave del pannello: ne ho create di nuove. I dispositivi si riattivano da soli alla prossima apertura del pannello.");
        globalRef.__runpanelVapid = { stored: sealed, keys: fresh };
        return fresh;
      }
      continue;
    }

    const fresh = generateVapidKeys();
    const sealed = seal(fresh);
    if (await setSettingIfAbsent(VAPID_SETTING, sealed)) {
      globalRef.__runpanelVapid = { stored: sealed, keys: fresh };
      return fresh;
    }
  }
  throw new Error("Le chiavi per le notifiche push non si riescono a preparare");
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function contactFrom(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !LOCAL.test(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The `sub` claim: whom the push service may contact about these messages.
 *
 * The panel's public address when it is set and on https, otherwise the
 * address the device subscribed from — the panel as its owner reaches it.
 * Apple refuses a token without a usable contact, and a panel tried out on
 * `localhost` has none to give: a placeholder then, which the push services
 * that care about it (not Google's) will only meet from a browser on the same
 * machine.
 */
export async function vapidSubject(deviceOrigin: string | null): Promise<string> {
  const configured = await panelBaseUrl().catch(() => null);
  return contactFrom(configured?.origin) ?? contactFrom(deviceOrigin) ?? "mailto:runpanel@localhost";
}
