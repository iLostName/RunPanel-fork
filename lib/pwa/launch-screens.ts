/**
 * The launch screens iOS shows while an installed panel starts.
 *
 * iOS has no manifest splash: it wants one image per screen size, picked by a
 * media query on the device's size and pixel density, and shows white when
 * none matches. These are the iPhones in use today, portrait only — the app
 * starts in whatever orientation the phone is held, and a portrait image is
 * what iOS falls back to.
 *
 * The images are made by `scripts/build-pwa-assets.mjs`, one dark and one light
 * per size, and linked from app/layout.tsx. No imports, so the script can load
 * this file as it is.
 */

export interface LaunchScreen {
  /** CSS pixels, portrait. */
  width: number;
  height: number;
  ratio: 2 | 3;
}

export const LAUNCH_SCREENS: readonly LaunchScreen[] = [
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max, 17 Pro Max
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 402, height: 874, ratio: 3 }, // 16 Pro, 17, 17 Pro
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16
  { width: 428, height: 926, ratio: 3 }, // 12 Pro Max, 13 Pro Max, 14 Plus
  { width: 390, height: 844, ratio: 3 }, // 12, 13, 14, 16e
  { width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12 mini, 13 mini
  { width: 414, height: 896, ratio: 3 }, // XS Max, 11 Pro Max
  { width: 414, height: 896, ratio: 2 }, // XR, 11
  { width: 414, height: 736, ratio: 3 }, // 6s Plus, 7 Plus, 8 Plus
  { width: 375, height: 667, ratio: 2 }, // 6s, 7, 8, SE 2 and 3
];

export type LaunchScheme = "dark" | "light";

export function launchScreenFile(screen: LaunchScreen, scheme: LaunchScheme): string {
  return `/splash/${screen.width * screen.ratio}x${screen.height * screen.ratio}-${scheme}.png`;
}

/**
 * The `<link rel="apple-touch-startup-image">` entries for a theme. With a
 * scheme of its own the panel's choice decides; "Sistema" lists both and lets
 * the query on `prefers-color-scheme` pick.
 */
export function launchScreenLinks(scheme: LaunchScheme | "system"): { url: string; media: string }[] {
  const schemes: LaunchScheme[] = scheme === "system" ? ["dark", "light"] : [scheme];
  return schemes.flatMap((each) =>
    LAUNCH_SCREENS.map((screen) => ({
      url: launchScreenFile(screen, each),
      media:
        `screen and (device-width: ${screen.width}px) and (device-height: ${screen.height}px)` +
        ` and (-webkit-device-pixel-ratio: ${screen.ratio}) and (orientation: portrait)` +
        (scheme === "system" ? ` and (prefers-color-scheme: ${each})` : ""),
    }))
  );
}
