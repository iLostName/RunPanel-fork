"use client";

import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

/**
 * Every placeholder pulses on the same clock.
 *
 * A CSS animation starts from its first frame whenever its element is created,
 * so blocks that appear at different moments — a card's own placeholder under
 * a page that was already pulsing, a block drawn by the server and hydrated
 * later — would each pulse on their own beat. Started at the document's time
 * origin instead, every block is at the same point of the cycle however late
 * it arrived.
 *
 * Only the pulse. `skeleton-appear` (globals.css) is the delay before a
 * placeholder shows at all, and it has to count from the block's own birth:
 * moved to the time origin it would be long over, and every placeholder would
 * show at once again.
 */
function inPhase(element: HTMLDivElement | null) {
  if (!element) return;
  for (const animation of element.getAnimations()) {
    if (animation instanceof CSSAnimation && animation.animationName === "skeleton-appear") continue;
    animation.startTime = 0;
  }
}

/**
 * Shape-matched placeholders. A skeleton that matches the real layout keeps the
 * page from jumping when data lands — a centred spinner, which is what every
 * route used before, guarantees it will.
 *
 * They show after a short delay (the `skeleton` class): an answer that comes
 * back sooner goes straight to the content, without a grey blink first.
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div ref={inPhase} className={cn("bg-default skeleton rounded-[var(--radius)]", className)} />;
}

export function SkeletonText({ className }: { className?: string }) {
  return <div ref={inPhase} className={cn("bg-default skeleton h-3 rounded-full", className)} />;
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
 * Drawn once per navigation, by the page itself. The panel's routes have no
 * `loading.tsx`: a route-level placeholder followed by the page's own was two
 * different grey pages in a row, which is the flash this replaced. While the
 * next page is on its way, the current one stays on screen under the bar of
 * `NavigationProgress`.
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
