"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * A page's tab, kept in `?tab=` so that a reload lands where it was.
 *
 * The pages read `?tab=` once, on mount, and never wrote it back: a link could
 * open a tab, but a reload always went back to the first one. It is written
 * with `history.replaceState`, which Next keeps `useSearchParams` in step with,
 * so a tab change is not a navigation — no request, no loading state — and
 * leaves no entry for Back to walk through. The other params stay, `?server=`
 * in a cluster above all.
 */
export function useUrlTab<T extends string>(ids: readonly T[], fallback: T): [T, (next: T) => void] {
  const raw = useSearchParams().get("tab");
  const fromUrl = raw !== null && (ids as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const [tab, setTab] = useState<T>(fromUrl);
  // A link to another tab of the page already open changes the URL without
  // remounting it: follow the URL when it moves, the state otherwise.
  const [seen, setSeen] = useState<T>(fromUrl);
  if (fromUrl !== seen) {
    setSeen(fromUrl);
    setTab(fromUrl);
  }

  const select = useCallback(
    (next: T) => {
      setTab(next);
      const params = new URLSearchParams(window.location.search);
      if (next === fallback) params.delete("tab");
      else params.set("tab", next);
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    },
    [fallback]
  );

  return [tab, select];
}
