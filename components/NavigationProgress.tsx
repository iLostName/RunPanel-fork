"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * The thin bar along the top while the next page is on its way.
 *
 * The panel's routes have no `loading.tsx`, on purpose. Every page here draws
 * its own placeholder while its first fetch runs, so a route-level one meant
 * two placeholders per navigation, of different shapes: the generic grey page,
 * then the page's own. That was the double flash. Without it, Next keeps the
 * current page on screen until the next one is ready to draw, and this bar is
 * what says the click was heard.
 *
 * It appears only after `SHOW_AFTER_MS`: a page that arrives sooner — most of
 * them, from a nearby server — changes with no bar at all, which reads as
 * instant. It runs to most of the width and waits there, then completes when
 * the address changes.
 *
 * Started from the click rather than from the router, because the app router
 * has no navigation events: the click on a same-origin link, and the back and
 * forward buttons. Code that navigates on its own can start it with
 * `startNavigationProgress()`.
 */

const SHOW_AFTER_MS = 120;
/** A navigation that never lands (cancelled, or refused by a guard) must not leave the bar up. */
const GIVE_UP_MS = 15_000;
const FINISH_MS = 300;
const EVENT = "runpanel:navigation-start";

export function startNavigationProgress() {
  window.dispatchEvent(new Event(EVENT));
}

type Phase = "idle" | "waiting" | "running" | "finishing";

/** A plain left click on a link to another page of this panel. */
function isPageLink(event: MouseEvent): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  const next = new URL(anchor.href, window.location.href);
  if (next.origin !== window.location.origin) return false;
  // The same page, or only the fragment changes: nothing will load.
  return next.pathname !== window.location.pathname || next.search !== window.location.search;
}

export function NavigationProgress() {
  const location = `${usePathname()}?${useSearchParams().toString()}`;
  const [phase, setPhase] = useState<Phase>("idle");
  const [seen, setSeen] = useState(location);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The address changed: the new page is being drawn. Settled during render,
  // the way React wants state that follows a prop, rather than in an effect
  // that would draw the stale bar once more first.
  if (seen !== location) {
    setSeen(location);
    setPhase((p) => (p === "running" ? "finishing" : "idle"));
  }

  useEffect(() => {
    const clearTimers = () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    };
    const start = () => {
      clearTimers();
      // A second click while the bar is already up carries on from there,
      // rather than hiding it and starting over.
      setPhase((p) => (p === "running" ? "running" : "waiting"));
      timers.current.push(
        setTimeout(() => setPhase((p) => (p === "waiting" ? "running" : p)), SHOW_AFTER_MS),
        setTimeout(() => setPhase("idle"), GIVE_UP_MS)
      );
    };
    const onClick = (event: MouseEvent) => {
      if (isPageLink(event)) start();
    };
    // Capture: it runs before the link's own handler, which may stop the event.
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", start);
    window.addEventListener(EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", start);
      window.removeEventListener(EVENT, start);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (phase !== "finishing") return;
    const timer = setTimeout(() => setPhase("idle"), FINISH_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "idle" || phase === "waiting") return null;
  return (
    <div aria-hidden className="nav-progress" data-phase={phase}>
      <div className="nav-progress-bar bg-accent" />
    </div>
  );
}
