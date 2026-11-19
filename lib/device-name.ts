/**
 * A device in words, from its user agent: "Chrome su Windows", "Safari su iOS".
 *
 * Shared by the list of sessions and the list of devices with notifications,
 * which name the same phones and computers. Zero imports.
 */

function osOf(userAgent: string): string | null {
  return /Windows/i.test(userAgent)
    ? "Windows"
    : /Android/i.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iOS/i.test(userAgent)
        ? "iOS"
        : /Mac OS X|Macintosh/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;
}

function browserOf(userAgent: string): string | null {
  return /Edg\//i.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/i.test(userAgent)
      ? "Opera"
      : /Firefox\//i.test(userAgent)
        ? "Firefox"
        : /Chrome\//i.test(userAgent)
          ? "Chrome"
          : /Safari\//i.test(userAgent)
            ? "Safari"
            : null;
}

/** A user agent string is unreadable; this is the part anyone cares about. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo sconosciuto";
  const os = osOf(userAgent);
  const browser = browserOf(userAgent);
  if (browser && os) return `${browser} su ${os}`;
  return browser ?? os ?? userAgent.slice(0, 40);
}

/**
 * What a device that turns notifications on is called until its owner renames
 * it. The installed app is "App su …", since it is no longer the browser
 * that receives them; an iPhone or an iPad is named as such, the one thing
 * its owner will recognise in the list.
 */
export function pushDeviceName(userAgent: string, installed: boolean, touch = false): string {
  const os = osOf(userAgent);
  // An iPad introduces itself as a Mac, and only its touch screen gives it away.
  const ipad = /iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touch);
  const where = ipad ? "iPad" : os === "iOS" ? "iPhone" : os;
  if (installed) return `App RunPanel su ${where ?? "questo dispositivo"}`;
  return describeDevice(userAgent);
}

/** A phone or a tablet, for the icon in the list. */
export function isMobileAgent(userAgent: string | null): boolean {
  return Boolean(userAgent && /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent));
}
