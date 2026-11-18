/**
 * How the Projects page shows its folders: the colour of each one, what its
 * projects are doing, which folder the address points at, and what a dragged
 * row carries.
 *
 * Pure, with nothing behind it but lib/status.ts, so every rule here can be
 * asserted without a browser (`tests/suites/project-folders-unit.mjs`).
 */

import { statusMeta, type StatusTone } from "./status";

// --- Colour ------------------------------------------------------------------

/**
 * A folder's hue, 0–359, from its name: the same name has the same colour on
 * every visit, every device and every server, with nothing stored. Only the hue
 * is decided here — lightness and chroma are the theme's (`--folder-*` in
 * app/globals.css), so no folder can come out too faint on white or too loud on
 * black.
 *
 * FNV-1a, then a finalizer: FNV alone leaves names that differ in their last
 * letter ("Clienti 1", "Clienti 2") a few degrees apart, which reads as the
 * same colour. Case and outer spaces do not count, as they do not for the
 * uniqueness of a name.
 */
export function folderHue(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 360;
}

// --- What the projects are doing -----------------------------------------------

export interface StatusSlice {
  tone: StatusTone;
  /** The status as lib/status.ts words it: a slice is always named, never colour alone. */
  label: string;
  count: number;
}

/** Healthy first, then busy, broken and off: a bar reads left to right as "how much works". */
const TONE_ORDER: readonly StatusTone[] = ["success", "warning", "danger", "neutral"];

/**
 * The projects of a folder by state, for its bar and its legend.
 *
 * Grouped by label rather than by tone: "Errore" and "Non raggiungibile" are
 * both red and mean different things to whoever has to act on them. Statuses
 * nothing knows all read "Sconosciuto", so they are one slice and not several
 * with the same name.
 */
export function statusBreakdown(rows: ReadonlyArray<{ status: string }>): StatusSlice[] {
  const byLabel = new Map<string, StatusSlice>();
  for (const row of rows) {
    const meta = statusMeta(row.status);
    const slice = byLabel.get(meta.label);
    if (slice) slice.count++;
    else byLabel.set(meta.label, { tone: meta.tone, label: meta.label, count: 1 });
  }
  return [...byLabel.values()].sort(
    (a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone) || b.count - a.count || a.label.localeCompare(b.label)
  );
}

/** The same breakdown in words, for a tooltip and for a screen reader. */
export function breakdownText(slices: readonly StatusSlice[]): string {
  return slices.map((slice) => `${slice.label}: ${slice.count}`).join(", ");
}

/** "1 progetto", "3 progetti"; an empty folder says so instead of showing a zero. */
export function projectCountLabel(count: number): string {
  if (count === 0) return "Nessun progetto";
  return count === 1 ? "1 progetto" : `${count} progetti`;
}

// --- Which folder the address points at ------------------------------------------

export const FOLDER_PARAM = "cartella";
/** "In no folder". A word, not an id: generated ids are twelve characters long. */
export const NO_FOLDER = "senza";

export type FolderSelection = { kind: "all" } | { kind: "none" } | { kind: "folder"; id: string };

/**
 * `?cartella=` read back. Anything that is not empty and not `senza` is taken
 * for a folder id, even one the list does not have: a folder deleted since the
 * link was made should say it no longer exists, not quietly show everything.
 */
export function parseFolderParam(value: string | null | undefined): FolderSelection {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > 64) return { kind: "all" };
  if (raw === NO_FOLDER) return { kind: "none" };
  return { kind: "folder", id: raw };
}

/** One string per selection, for comparing two of them and for React keys. */
export function selectionKey(selection: FolderSelection): string {
  return selection.kind === "folder" ? `folder:${selection.id}` : selection.kind;
}

/**
 * The address of a selection: the same page with every other parameter kept,
 * `?server=` above all, so choosing a folder never widens a list narrowed to
 * one server.
 */
export function folderSelectionHref(pathname: string, search: string, selection: FolderSelection): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = selection.kind === "all" ? null : selection.kind === "none" ? NO_FOLDER : selection.id;
  if (value) params.set(FOLDER_PARAM, value);
  else params.delete(FOLDER_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

/**
 * Whether a project belongs on screen for a selection. A `folder_id` naming a
 * folder the list does not have counts as no folder, as on the Overview
 * (`groupOverview`): the folder went between two polls and the project must not
 * vanish with it. `known` is null while the folders are still loading, when only
 * a missing `folder_id` can be called unfiled.
 */
export function inSelection(folderId: string | null, selection: FolderSelection, known: ReadonlySet<string> | null): boolean {
  if (selection.kind === "all") return true;
  if (selection.kind === "folder") return folderId === selection.id;
  return folderId === null || (known !== null && !known.has(folderId));
}

// --- A row being dragged ----------------------------------------------------------

/**
 * A project dragged onto a folder. Its own type, so a folder only lights up for
 * a project row and ignores text, files and other links dragged over it.
 */
export const PROJECT_DRAG_TYPE = "application/x-runpanel-project";

export interface ProjectDrag {
  /** The server holding the project: the move is written there. */
  memberId: string;
  id: string;
  /** Where it is filed now, so a drop on that same folder does nothing. */
  folderId: string | null;
}

export function encodeProjectDrag(drag: ProjectDrag): string {
  return JSON.stringify({ memberId: drag.memberId, id: drag.id, folderId: drag.folderId });
}

/** What a drop carried, or null for anything that is not a project row of this panel. */
export function parseProjectDrag(raw: string | null | undefined): ProjectDrag | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { memberId, id, folderId } = value as Record<string, unknown>;
  if (typeof memberId !== "string" || typeof id !== "string" || !id) return null;
  if (folderId !== null && typeof folderId !== "string") return null;
  return { memberId, id, folderId };
}
