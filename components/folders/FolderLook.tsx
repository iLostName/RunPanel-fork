import { Icon } from "@iconify/react";
import { TONE_DOT } from "@/lib/status";
import { breakdownText, projectCountLabel, type StatusSlice } from "@/lib/project-folders";
import { cn } from "@/lib/utils";

/**
 * How a folder looks on the Projects page: its colour, its bar of states, the
 * chip on a row and the heading of an open folder.
 *
 * The colour is a hue handed to CSS (`folder-tint`, `folder-dot` in
 * app/globals.css); the theme decides how light and how strong it is.
 */

/** The hue for the `folder-*` utilities. A custom property, so a theme change needs no re-render. */
export function folderStyle(hue: number | undefined): React.CSSProperties | undefined {
  return hue === undefined ? undefined : ({ "--folder-hue": hue } as React.CSSProperties);
}

/** The folder icon on its tinted square: the one mark that says "this folder" wherever it appears. */
export function FolderIcon({
  hue,
  open = false,
  size = "md",
  className,
}: {
  hue: number | undefined;
  open?: boolean;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "folder-tint grid shrink-0 place-items-center",
        size === "lg" ? "size-10 rounded-xl" : "size-9 rounded-lg",
        className
      )}
      style={folderStyle(hue)}
      aria-hidden
    >
      <Icon icon={open ? "solar:folder-open-linear" : "solar:folder-linear"} width={size === "lg" ? 20 : 18} />
    </span>
  );
}

/**
 * The states of a folder's projects as one thin bar, a segment per state.
 *
 * Colour alone is not an answer, so the same breakdown is in the tooltip and,
 * for a screen reader, in the text of whatever holds the bar. An empty folder
 * is the bare track.
 */
export function StatusBar({ slices, className }: { slices: readonly StatusSlice[]; className?: string }) {
  return (
    <span
      aria-hidden
      title={slices.length > 0 ? breakdownText(slices) : undefined}
      className={cn("bg-default flex h-1.5 w-full gap-px overflow-hidden rounded-full", className)}
    >
      {slices.map((slice) => (
        <span key={slice.label} className={cn("h-full min-w-1", TONE_DOT[slice.tone])} style={{ flex: `${slice.count} 1 0` }} />
      ))}
    </span>
  );
}

/** Which folder a row is in, for the list that shows every folder at once. */
export function FolderChip({ name, hue }: { name: string; hue: number | undefined }) {
  return (
    <span
      className="bg-default text-muted inline-flex max-w-[12rem] min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs"
      title={`Cartella ${name}`}
    >
      <span className="folder-dot size-2 shrink-0 rounded-full" style={folderStyle(hue)} aria-hidden />
      <span className="truncate">
        <span className="sr-only">Cartella </span>
        {name}
      </span>
    </span>
  );
}

/**
 * The top of an open folder: what it is, how many projects it holds and how
 * they are doing, in words this time, with its actions at the end.
 */
export function FolderHeading({
  name,
  hue,
  count,
  slices,
  actions,
}: {
  name: string;
  hue: number | undefined;
  count: number;
  slices: readonly StatusSlice[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <FolderIcon hue={hue} open size="lg" />
      <div className="min-w-0 flex-1">
        <h2 className="text-foreground truncate text-base font-semibold">{name}</h2>
        <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          <span>{projectCountLabel(count)}</span>
          {slices.map((slice) => (
            <span key={slice.label} className="inline-flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", TONE_DOT[slice.tone])} aria-hidden />
              {slice.label}
              <span className="text-foreground tabular-nums">{slice.count}</span>
            </span>
          ))}
        </p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
