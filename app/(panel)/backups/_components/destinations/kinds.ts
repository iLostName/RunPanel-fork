import type { ComponentType } from "react";
import { RcloneFields } from "./RcloneFields";
import { SftpFields } from "./SftpFields";
import { WebdavFields } from "./WebdavFields";
import { remoteIcon } from "./where";
import type { KindFieldsProps } from "./types";

/**
 * The remote destination types as the form offers them: the card that picks
 * one, and the component with its fields.
 *
 * The one place a type is registered on this side, with its words for the
 * lists in where.ts. The local disk, S3 and Telegram keep their own code in
 * the form; every type after them is an entry here and a component of its own,
 * which reports its config and whether it is complete (types.ts).
 */
export interface RemoteKind {
  type: string;
  /** The title of its card in the form. */
  label: string;
  /** One line under it: what it is for. */
  description: string;
  icon: string;
  Fields: ComponentType<KindFieldsProps>;
}

export const REMOTE_KINDS: RemoteKind[] = [
  {
    type: "sftp",
    label: "Server SFTP o NAS",
    description: "Synology, QNAP, una Storage Box di Hetzner, un altro server.",
    icon: remoteIcon("sftp") ?? "solar:server-square-linear",
    Fields: SftpFields,
  },
  {
    type: "webdav",
    label: "WebDAV",
    description: "Nextcloud, ownCloud, Koofr, pCloud, il WebDAV di un NAS.",
    icon: remoteIcon("webdav") ?? "solar:folder-cloud-linear",
    Fields: WebdavFields,
  },
  {
    type: "rclone",
    label: "Google Drive, OneDrive, Dropbox…",
    description: "Con rclone, se è installato su questo server.",
    icon: remoteIcon("rclone") ?? "solar:cloud-upload-linear",
    Fields: RcloneFields,
  },
];

export function remoteKind(type: string): RemoteKind | null {
  return REMOTE_KINDS.find((kind) => kind.type === type) ?? null;
}
