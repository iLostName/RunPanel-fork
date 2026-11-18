"use client";

import Link from "next/link";
import { Icon } from "@iconify/react";
import { isNotFound } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import { LoadError } from "./LoadError";
import { Panel } from "./Panel";
import { SkeletonBlock, SkeletonText } from "./Skeletons";

/**
 * What a page shows while its data is not there: loading, failed, gone, empty.
 *
 * Every page answered these four on its own, so the same situation looked four
 * different ways: a generic skeleton with stat tiles on pages that have none,
 * "riprova" for something that was deleted, a bare paragraph for an empty list.
 * Pass what the hook returned; whichever state applies is drawn, in that order,
 * and `children` only once the data is there.
 */
export function PageState({
  loading,
  error,
  hasData,
  onRetry,
  what,
  back,
  skeleton,
  empty,
  children,
}: {
  /** True only while there is nothing to show yet. A refresh keeps the old data on screen. */
  loading: boolean;
  error?: string | null;
  /** Whether data arrived at least once; an error after that is a stale page, not a broken one. */
  hasData: boolean;
  onRetry?: () => void;
  /** What failed to load, in words: "il progetto", "i backup". */
  what: string;
  /** Where to go when the thing no longer exists. */
  back?: { href: string; label: string };
  /** The shape of the page, so nothing jumps when it arrives. */
  skeleton?: React.ReactNode;
  /** Drawn instead of `children` when the data is there but there is nothing in it. */
  empty?: React.ReactNode | false;
  children: React.ReactNode;
}) {
  if (!hasData && error) {
    if (isNotFound(error)) {
      return (
        <Panel className="flex flex-col items-center gap-2 py-12 text-center">
          <Icon icon="solar:ghost-linear" width={32} className="text-muted/60" aria-hidden />
          <p className="text-foreground text-sm font-medium">Non esiste più</p>
          <p className="text-muted max-w-sm text-xs">
            Potrebbe essere stato eliminato o spostato su un altro server.
          </p>
          {back && (
            <Link href={back.href} className="text-accent mt-2 text-sm hover:underline">
              {back.label}
            </Link>
          )}
        </Panel>
      );
    }
    return <LoadError what={what} error={error} onRetry={onRetry} />;
  }
  if (!hasData && loading) return <>{skeleton ?? <ListSkeleton />}</>;
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}

/** A list in a panel: the shape of most pages while they load. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <Panel padding="flush" className={cn("divide-separator divide-y", className)} aria-busy="true" aria-label="Caricamento">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <SkeletonBlock className="size-8 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <SkeletonText className="w-40" />
            <SkeletonText className="w-64 opacity-70" />
          </div>
        </div>
      ))}
    </Panel>
  );
}

/** A detail page: a header line, tabs, and two panels. */
export function DetailSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Caricamento">
      <div className="space-y-2">
        <SkeletonText className="h-5 w-56" />
        <SkeletonText className="w-80 opacity-70" />
      </div>
      <SkeletonText className="h-8 w-full max-w-lg" />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonBlock className="h-40" />
        <SkeletonBlock className="h-40" />
      </div>
    </div>
  );
}
