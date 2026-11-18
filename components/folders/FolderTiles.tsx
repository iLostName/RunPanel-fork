"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { FolderIcon, StatusBar } from "@/components/folders/FolderLook";
import {
  breakdownText,
  parseProjectDrag,
  projectCountLabel,
  PROJECT_DRAG_TYPE,
  type ProjectDrag,
  type StatusSlice,
} from "@/lib/project-folders";
import { cn } from "@/lib/utils";

export interface FolderTile {
  /** `selectionKey` of what the tile selects. */
  key: string;
  href: string;
  label: string;
  kind: "all" | "none" | "folder";
  hue?: number;
  count: number;
  slices: StatusSlice[];
  /** Where a project dropped here goes; absent on "Tutti", which is not a place. */
  dropTo?: { folderId: string | null };
}

/** A plain left click, the only one a tile handles itself: the others open a tab or a menu, as on any link. */
function isPlainClick(event: React.MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The folders as tiles, at the top of the Projects page, each one a link to
 * the list filtered to it and a place to drop a project.
 *
 * Real links, so a folder opens in a new tab, has an address to share and sits
 * in the history; a plain click is handled here and written with
 * `history.pushState` (`onSelect`), which Next keeps `useSearchParams` in step
 * with — no request, no jump to the top, and Back walks through the folders.
 *
 * While a project is dragged the strip sticks under the top bar, so the
 * folders are in reach from the bottom of a long list; the places it can go
 * get a dashed edge, and the rest — "Tutti", and the folder it is already in —
 * step back.
 */
export function FolderTiles({
  tiles,
  selectedKey,
  drag,
  onSelect,
  onDrop,
  onCreate,
}: {
  tiles: FolderTile[];
  selectedKey: string;
  /** The project being dragged on this page, if any. */
  drag: ProjectDrag | null;
  onSelect: (href: string) => void;
  onDrop: (drag: ProjectDrag, folderId: string | null) => void;
  /** Absent for whoever may not create folders. */
  onCreate?: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // On a phone the open folder can sit past the edge of the strip — opened
  // from a link, or by Back. Only the strip moves to it, never the page.
  useEffect(() => {
    const list = listRef.current;
    const tile = list?.querySelector('[aria-current="page"]');
    if (!list || !tile || list.scrollWidth <= list.clientWidth) return;
    const box = list.getBoundingClientRect();
    const at = tile.getBoundingClientRect();
    const gutter = 16;
    if (at.left < box.left + gutter) list.scrollLeft -= box.left + gutter - at.left;
    else if (at.right > box.right - gutter) list.scrollLeft += at.right - (box.right - gutter);
  }, [selectedKey]);

  return (
    <nav
      aria-label="Cartelle"
      className={cn(
        // Edge to edge on a phone, where the strip scrolls sideways under the
        // 16px gutter of the page instead of wrapping into a wall of tiles.
        "-mx-4 mb-3 sm:mx-0 sm:mb-5",
        drag && "bg-background/90 sticky top-14 z-20 backdrop-blur-md"
      )}
    >
      {/* No scrollbar: the tile cut off at the edge already says there is more. */}
      <ul
        ref={listRef}
        className="flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pt-1 pb-3 [scrollbar-width:none] sm:grid sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] sm:overflow-visible sm:p-0 [&::-webkit-scrollbar]:hidden"
      >
        {tiles.map((tile) => (
          <li key={tile.key} className="w-40 shrink-0 snap-start sm:w-auto">
            <Tile tile={tile} selected={tile.key === selectedKey} drag={drag} onSelect={onSelect} onDrop={onDrop} />
          </li>
        ))}
        {onCreate && (
          <li className="w-40 shrink-0 snap-start sm:w-auto">
            <button
              type="button"
              onClick={onCreate}
              className={cn(
                "border-border text-muted hover:border-accent/60 hover:text-foreground flex h-full min-h-[5.75rem] w-full flex-col items-center justify-center gap-1.5 rounded-[var(--radius)] border border-dashed p-3 text-sm transition-[color,border-color,opacity]",
                drag && "opacity-40"
              )}
            >
              <Icon icon="solar:add-folder-linear" width={20} aria-hidden />
              Nuova cartella
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}

function Tile({
  tile,
  selected,
  drag,
  onSelect,
  onDrop,
}: {
  tile: FolderTile;
  selected: boolean;
  drag: ProjectDrag | null;
  onSelect: (href: string) => void;
  onDrop: (drag: ProjectDrag, folderId: string | null) => void;
}) {
  const { dropTo } = tile;
  const [over, setOver] = useState(false);
  // A drag from this page knows where the project is; one from another tab of
  // the panel does not, and the drop itself checks again.
  const accepts = dropTo !== undefined && (!drag || drag.folderId !== dropTo.folderId);
  const dropping = over && accepts;

  // A drag of this page that ended, wherever it ended, leaves no tile lit.
  const [lastDrag, setLastDrag] = useState(drag);
  if (drag !== lastDrag) {
    setLastDrag(drag);
    if (!drag) setOver(false);
  }

  const isProject = (event: React.DragEvent) => event.dataTransfer.types.includes(PROJECT_DRAG_TYPE);

  const dropHandlers = dropTo
    ? {
        onDragEnter(event: React.DragEvent) {
          if (!isProject(event)) return;
          event.preventDefault();
          setOver(true);
        },
        // Fires every few milliseconds while over the tile, so it also puts the
        // light back after a leave that a browser reported for a child.
        onDragOver(event: React.DragEvent) {
          if (!isProject(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = accepts ? "move" : "none";
          setOver(true);
        },
        onDragLeave(event: React.DragEvent) {
          if (!isProject(event)) return;
          // Moving onto the icon or the label is still being over the tile.
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setOver(false);
        },
        onDrop(event: React.DragEvent) {
          if (!isProject(event)) return;
          // Also what stops a browser from following the dragged link.
          event.preventDefault();
          setOver(false);
          const dropped = parseProjectDrag(event.dataTransfer.getData(PROJECT_DRAG_TYPE));
          if (dropped) onDrop(dropped, dropTo.folderId);
        },
      }
    : {};

  return (
    <a
      href={tile.href}
      aria-current={selected ? "page" : undefined}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onSelect(tile.href);
      }}
      {...dropHandlers}
      className={cn(
        // `relative` holds the screen-reader text inside the tile: positioned
        // against the page instead, the text of a tile scrolled out of a phone's
        // strip pushed the whole page sideways.
        "relative flex h-full min-h-[5.75rem] flex-col justify-between gap-3 rounded-[var(--radius)] border p-3 transition-[background-color,border-color,box-shadow,opacity,transform] duration-150",
        dropping
          ? "border-accent bg-accent/10 scale-[1.02]"
          : selected
            ? "selected border-transparent"
            : drag && accepts
              ? "bg-surface border-accent/60 border-dashed"
              : "border-border bg-surface hover:bg-surface-hover shadow-[var(--surface-shadow)]",
        // Every tile a drop would not change steps back, the open one too: lit
        // by its selection, it read as one more place to drop.
        drag && !accepts && "opacity-50"
      )}
    >
      {/* Icon above the words on a phone, where a tile is too narrow for both
          side by side without the count wrapping; beside them from `sm` up. */}
      <span className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        {tile.kind === "folder" ? (
          <FolderIcon hue={tile.hue} open={selected || dropping} />
        ) : (
          <span
            aria-hidden
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg",
              selected ? "bg-accent/15 text-accent" : "bg-default text-muted"
            )}
          >
            <Icon icon={tile.kind === "all" ? "solar:layers-linear" : "solar:inbox-linear"} width={18} />
          </span>
        )}
        <span className="max-w-full min-w-0">
          <span className="text-foreground block truncate text-sm font-medium" title={tile.label}>
            {tile.label}
          </span>
          <span className="text-muted block text-xs">{projectCountLabel(tile.count)}</span>
        </span>
      </span>
      <StatusBar slices={tile.slices} />
      {tile.slices.length > 0 && <span className="sr-only">{breakdownText(tile.slices)}</span>}
    </a>
  );
}
