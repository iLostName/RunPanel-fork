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

  useEffect(() => {
    const strip = ref.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (!strip || !tab) return;
    const first = !placed.current;
    placed.current = true;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const left = tabBox.left - stripBox.left + strip.scrollLeft - (strip.clientWidth - tabBox.width) / 2;
    const still = first || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollTo({ left: Math.max(0, left), behavior: still ? "instant" : "smooth" });
  }, [activeKey]);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => {
      const end = strip.scrollWidth - strip.clientWidth;
      strip.toggleAttribute("data-more-start", strip.scrollLeft > 1);
      strip.toggleAttribute("data-more-end", strip.scrollLeft < end - 1);
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(strip);
    return () => {
      strip.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, []);

  return ref;
}
