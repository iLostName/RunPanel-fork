/**
 * Expert mode: the same panel, with the machinery showing.
 *
 * The panel is used by people who know what a port, a container or a cron line
 * is, and by people who only want their site online. Everything is written for
 * the second first: plain words, the technical part behind "Avanzate". Expert
 * mode turns that around for the first: the technical details sit inline (the
 * runtime, the port, the container, the commit, the raw error), and every
 * "Avanzate" opens already expanded.
 *
 * Per browser, like the light/dark theme, and for the same reason: it is how
 * this person likes to read the screen, not something an owner sets for the
 * team. A cookie rather than localStorage so the server renders the right
 * variant in the first paint, with no flash of the other one.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export const EXPERT_COOKIE = "runpanel_expert";

/** A year, like the theme cookie. */
export const EXPERT_COOKIE_MAX_AGE = 31_536_000;

/** Anything but an explicit "1" is the default, which is off. */
export function resolveExpertMode(value: unknown): boolean {
  return value === "1";
}

/** The `document.cookie` assignment that remembers a choice. */
export function expertCookie(enabled: boolean): string {
  return `${EXPERT_COOKIE}=${enabled ? "1" : "0"}; path=/; max-age=${EXPERT_COOKIE_MAX_AGE}; samesite=lax`;
}
