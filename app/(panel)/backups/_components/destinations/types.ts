/**
 * The contract between the destination form and the fields of one type.
 *
 * Each remote type (SFTP, WebDAV, rclone — and the next one) keeps its fields
 * in a component of its own and tells the form two things whenever they
 * change: the config it would send, and whether that config is complete. The
 * form does the rest the same way for every type — the check before saving,
 * "Salva comunque", the default toggle — so adding a type is a component and
 * one entry in kinds.ts.
 */

export interface KindState {
  /** What goes to the API as `config`. Secrets left empty mean "keep the stored one". */
  config: Record<string, unknown>;
  complete: boolean;
}

export interface KindFieldsProps {
  /** The stored config as `GET /api/backups/destinations/:id` returns it, when editing. */
  stored: Record<string, unknown> | null;
  /** The server the destination lives on. */
  api: (path: string) => string;
  /** Some choices — a pasted rclone configuration — are the owner's alone. */
  isOwner: boolean;
  /** Archives already stored here, when editing: changing where it writes would leave them behind. */
  archives: number;
  /** The server the destination lives on, when the page knows it: a linked server cannot be its own copy. */
  memberId?: string | null;
  onChange: (state: KindState) => void;
}

/** What `GET /api/backups/destinations/tools` answers. */
export interface DestinationTools {
  ssh: { installed: boolean; path: string | null; version: string | null };
  rclone: { installed: boolean; path: string | null; version: string | null; supported: boolean; minVersion: string };
}
