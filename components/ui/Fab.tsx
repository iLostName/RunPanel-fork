"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * A page's one way to create, as a floating button on a phone.
 *
 * On a desktop "Nuovo progetto" sits at the top right of the header, which is
 * where §6.3 puts a page's primary action. On a phone the header is a row of
 * buttons above the content that scrolls away after the first swipe, and a
 * second button beside it wrapped the row onto two lines. This is the same
 * link floating above the tab bar, in reach of the thumb wherever the list is
 * scrolled to. Phones only: pair it with the header's button hidden there.
 *
 * Extended, with its label, rather than a bare "+": a plus in the corner of a
 * panel could be any of five things. While the page scrolls down it folds to
 * its icon, so it covers a corner of the rows being read rather than half of
 * them, and the label comes back with the first scroll up, as Android's
 * extended buttons do. `data-fab` tells globals.css to leave room under the
 * last row.
 */
export function Fab({
  href,
  label,
  icon = "solar:add-circle-linear",
  className,
}: {
  href: string;
  label: string;
  /** Iconify name, as a literal at the call site so the icon bundler finds it. */
  icon?: string;
  className?: string;
}) {
  const folded = useFoldedOnScroll();

  return (
    <Link
      href={href}
      data-fab=""
      className={cn(
        "touch-chrome bg-accent text-accent-foreground fixed z-20 inline-flex h-14 min-w-14 items-center justify-center rounded-2xl text-sm font-medium md:hidden",
        "bottom-[calc(var(--tab-bar-height)+var(--safe-bottom)+1rem)] right-[max(1rem,var(--safe-right))]",
        "shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--accent)_55%,transparent),0_2px_6px_rgb(0_0_0/0.25)]",
        "transition-[padding,transform] duration-200 ease-out active:scale-95 motion-reduce:transition-none",
        folded ? "px-4" : "pr-5 pl-4",
        className
      )}
    >
      <Icon icon={icon} width={22} aria-hidden className="shrink-0" />
      <span
        className={cn(
          "overflow-hidden whitespace-nowrap transition-[max-width,margin,opacity] duration-200 ease-out motion-reduce:transition-none",
          folded ? "ml-0 max-w-0 opacity-0" : "ml-2 max-w-60 opacity-100"
        )}
      >
        {label}
      </span>
    </Link>
  );
}

/** True while the page is being scrolled down, past the first screenful of header. */
function useFoldedOnScroll(): boolean {
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        // A few pixels either way is a finger resting, not a direction.
        if (Math.abs(y - last) < 8) return;
        setFolded(y > last && y > 64);
        last = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return folded;
}
