"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current.
 *
 * False on the server and during hydration, which is the desktop layout: use it
 * to choose behaviour (a menu or an action sheet), never to decide what the
 * first paint looks like. What is drawn per screen size stays in CSS, so a
 * phone never flashes the desktop layout before switching.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

/** Below Tailwind's `md`, where the panel switches to its phone layout. */
export const PHONE_QUERY = "(width < 48rem)";

/**
 * A screen pressed with a finger, whatever its width: a tablet has no hover
 * either. What only shows on hover has to open on a tap there.
 */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
