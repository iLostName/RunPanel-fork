"use client";

import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

/**
 * Every placeholder pulses on the same clock.
 *
 * A CSS animation starts from its first frame whenever its element is created,
 * and a navigation creates two skeletons in a row — the route's `loading.tsx`,
 * then the page's own while its first fetch runs. Each started its own pulse,
 * so the hand-over was a jump from half-faded back to full. Started at the
 * document's time origin instead, every block is at the same point of the
 * cycle however late it arrived, and the new one picks up where the old one
 * left off. The same holds for a block drawn by the server and hydrated later.
 */
function inPhase(element: HTMLDivElement | null) {
  if (!element) return;
  for (const animation of element.getAnimations()) animation.startTime = 0;
}

/**
 * Shape-matched placeholders. A skeleton that matches the real layout keeps the
 * page from jumping when data lands — a centred spinner, which is what every
 * route used before, guarantees it will.
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div ref={inPhase} className={cn("bg-default animate-pulse rounded-[var(--radius)]", className)} />;
}

export function SkeletonText({ className }: { className?: string }) {
  return <div ref={inPhase} className={cn("bg-default h-3 animate-pulse rounded-full", className)} />;
}

/** Placeholder for a page built from a header, a stat row and a list. */
/**
 * The page before its data.
 *
 * With `title`, the real header is drawn instead of a grey bar: it is known
 * before the fetch, and keeping it in place means the page does not jump when
 * the content arrives. `tiles` matches the stat row the page really has —
 * four grey tiles above a page with three read as a layout that changed.
 *
 * No fade-in. A navigation draws this twice in a row — the route's
 * `loading.tsx`, then the page's own while its first fetch runs — and the
 * second is a new element, so a fade started over from transparent: the
 * skeleton came up, vanished, and came up again before the data. Where a page
 * draws a different one from the generic, its folder has a `loading.tsx` that
 * draws the same, so the hand-over is invisible.
 */
export function PageSkeleton({
  title,
  description,
  tiles = 4,
}: {
  title?: string;
  description?: string;
  tiles?: number;
} = {}) {
  return (
    <div>
      {title ? (
        <PageHeader title={title} description={description} />
      ) : (
        <div className="mb-6 space-y-2">
          <SkeletonText className="h-5 w-48" />
          <SkeletonText className="w-72" />
        </div>
      )}

      {tiles > 0 && (
        <div className={cn("mb-6 grid grid-cols-2 gap-3", tiles === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
          {Array.from({ length: tiles }, (_, i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
      )}

      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
