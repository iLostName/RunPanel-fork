import type { ComponentType } from "react";
import type {
  DestinationView,
  RcloneTargetView,
  S3TargetView,
  SftpTargetView,
  WebdavTargetView,
} from "@/components/backups/types";
import { providerLabel } from "../providers";
import { RcloneFields } from "./RcloneFields";
import { SftpFields } from "./SftpFields";
import { WebdavFields } from "./WebdavFields";
import type { KindFieldsProps } from "./types";

/**
 * The remote destination types, as the pages show them: how each is offered
 * in the form, what its fields are, and how a stored one reads in a list.
 *
 * The one place a type is registered on this side. The local disk and S3 keep
 * their long-standing code in the form; every type after them is an entry
 * here and a component of its own.
 */
export interface RemoteKind {
  type: string;
  /** The title of its card in the form. */
  label: string;
  /** One line under it: what it is for. */
  description: string;
  icon: string;
  Fields: ComponentType<KindFieldsProps>;
  /** "Server SFTP nas.lan · cartella «backup»", for the list and the policy form. */
  where(target: unknown): string;
  /** The technical line, for expert mode. */
  technical(target: unknown): string;
  /** "sul server nas.lan": where its archives stay when the destination is deleted. */
  place(target: unknown): string;
}

const folderText = (folder: string) => (folder ? `cartella «${folder}»` : "cartella principale");

export const REMOTE_KINDS: RemoteKind[] = [
  {
    type: "sftp",
    label: "Server SFTP o NAS",
    description: "Synology, QNAP, una Storage Box di Hetzner, un altro server.",
    icon: "solar:server-square-linear",
    Fields: SftpFields,
    where: (target) => {
      const t = target as SftpTargetView;
      return `Server SFTP ${t.host}${t.port !== 22 ? `:${t.port}` : ""} · ${folderText(t.folder)}`;
    },
    technical: (target) => {
      const t = target as SftpTargetView;
      return ` · porta ${t.port} · ${t.hostKeyFingerprint ? `impronta ${t.hostKeyFingerprint}` : "impronta non ancora salvata"}`;
    },
    place: (target) => `sul server ${(target as SftpTargetView).host}`,
  },
  {
    type: "webdav",
    label: "WebDAV",
    description: "Nextcloud, ownCloud, Koofr, pCloud, il WebDAV di un NAS.",
    icon: "solar:folder-cloud-linear",
    Fields: WebdavFields,
    where: (target) => {
      const t = target as WebdavTargetView;
      return `WebDAV su ${t.host} · ${folderText(t.folder)}`;
    },
    technical: (target) => ` · ${(target as WebdavTargetView).url}`,
    place: (target) => `su ${(target as WebdavTargetView).host}`,
  },
  {
    type: "rclone",
    label: "Google Drive, OneDrive, Dropbox…",
    description: "Con rclone, se è installato su questo server.",
    icon: "solar:cloud-upload-linear",
    Fields: RcloneFields,
    where: (target) => {
      const t = target as RcloneTargetView;
      return `${t.service} · ${folderText(t.folder)}`;
    },
    technical: (target) => ` · rclone ${(target as RcloneTargetView).provider}`,
    place: (target) => `su ${(target as RcloneTargetView).service}`,
  },
];

export function remoteKind(type: string): RemoteKind | null {
  return REMOTE_KINDS.find((kind) => kind.type === type) ?? null;
}

/** "Backblaze B2 · bucket «runpanel»", "Server SFTP nas.lan · cartella «backup»", or the local disk said as what it is. */
export function whereItWrites(destination: DestinationView): string {
  if (destination.type === "local") return "Disco di questo server";
  if (destination.type === "s3") {
    const target = destination.target as S3TargetView | null | undefined;
    return target ? `${providerLabel(target.endpoint)} · bucket «${target.bucket}»` : "Archivio S3";
  }
  const kind = remoteKind(destination.type);
  if (!kind) return destination.type;
  return destination.target ? kind.where(destination.target) : kind.label;
}

/** The line expert mode adds: region and endpoint, port and host key fingerprint… */
export function technicalLine(destination: DestinationView): string {
  if (destination.type === "local") return " · data/backups/archives";
  if (destination.type === "s3") {
    const target = destination.target as S3TargetView | null | undefined;
    return target ? ` · ${target.region} · ${target.endpoint}${target.prefix ? ` · /${target.prefix}` : ""}` : "";
  }
  const kind = remoteKind(destination.type);
  return kind && destination.target ? kind.technical(destination.target) : "";
}

/** Where the archives stay when a destination is deleted. */
export function wherePlace(destination: DestinationView): string {
  if (destination.type === "local") return "sul disco di questo server";
  if (destination.type === "s3") return `nel bucket «${(destination.target as S3TargetView | null | undefined)?.bucket ?? ""}»`;
  const kind = remoteKind(destination.type);
  return kind && destination.target ? kind.place(destination.target) : `in «${destination.name}»`;
}

export function destinationIcon(type: string): string {
  if (type === "local") return "solar:server-linear";
  if (type === "s3") return "solar:cloud-storage-linear";
  return remoteKind(type)?.icon ?? "solar:cloud-storage-linear";
}
