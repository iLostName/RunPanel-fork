"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Asks the server for the page again while it is in view, and at once when
 * it comes back into view: a status page left open in a tab should not show
 * this morning's outage as current. `router.refresh()` re-renders the server
 * components in place — no reload, no scroll jump — and the server answers
 * from its cache (`services/status-page/snapshot.ts`), so a hundred open tabs
 * cost what one does.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => router.refresh(), everyMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, everyMs]);

  return null;
}
