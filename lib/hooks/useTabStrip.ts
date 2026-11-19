"use client";

import { useEffect, useRef } from "react";

/**
 * A row of tabs that can be wider than its screen: seven project tabs do not
 * fit on a phone, and the one you are on used to be wherever the strip happened
 * to stop, often off the edge.
 *
 * - The active tab is scrolled into the middle of the strip whenever it
 *   changes: at once on the first paint, smoothly after that. Only the strip
 *   scrolls — `scrollIntoView` would move the page too.
 * - The first placement is done again while the page settles: when the web
 *   font replaces the fallback one and every tab changes width, or a tab
 *   arrives late. Placed only once, it was measured on widths the tabs no
 *   longer had, and "Impostazioni", opened from a link, sat past the right
 *   edge. It stops at the first change of tab or the first touch of the strip:
 *   from then on the strip is where the person put it.
 * - `data-more-start` / `data-more-end` say which edges have tabs beyond
 *   them; globals.css fades those edges on a phone (`.tab-strip`). Set on the
 *   element directly, so scrolling the strip re-renders nothing.
 *
 * The active tab is found by `aria-selected` or `aria-current`, the two ways
 * the panel marks one.
 */
export function useTabStrip<T extends HTMLElement>(activeKey: string) {
  const ref = useRef<T>(null);
  const placed = useRef(false);
  // True until the person changes tab or touches the strip.
  const settling = useRef(true);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const first = !placed.current;
    placed.current = true;
    if (!first) settling.current = false;
    center(strip, first || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [activeKey]);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => {
      const end = strip.scrollWidth - strip.clientWidth;
      strip.toggleAttribute("data-more-start", strip.scrollLeft > 1);
      strip.toggleAttribute("data-more-end", strip.scrollLeft < end - 1);
    };
    const settle = () => {
      if (settling.current) center(strip, true);
      update();
    };
    const mine = () => {
      settling.current = false;
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    strip.addEventListener("touchstart", mine, { passive: true });
    strip.addEventListener("wheel", mine, { passive: true });

    const resize = new ResizeObserver(settle);
    const watch = () => {
      resize.disconnect();
      resize.observe(strip);
      for (const tab of strip.children) resize.observe(tab);
    };
    watch();
    const tabs = new MutationObserver(() => {
      watch();
      settle();
    });
    tabs.observe(strip, { childList: true });
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) settle();
    });

    return () => {
      live = false;
      strip.removeEventListener("scroll", update);
      strip.removeEventListener("touchstart", mine);
      strip.removeEventListener("wheel", mine);
      resize.disconnect();
      tabs.disconnect();
    };
  }, []);

  return ref;
}

function center(strip: HTMLElement, still: boolean) {
  const tab = strip.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
  if (!tab || strip.scrollWidth <= strip.clientWidth) return;
  const stripBox = strip.getBoundingClientRect();
  const tabBox = tab.getBoundingClientRect();
  const left = tabBox.left - stripBox.left + strip.scrollLeft - (strip.clientWidth - tabBox.width) / 2;
  strip.scrollTo({ left: Math.max(0, left), behavior: still ? "instant" : "smooth" });
}
