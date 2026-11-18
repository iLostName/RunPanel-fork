import { PEER_FOLDER } from "@/lib/backup-peer";
import type { PeerTargetView, RcloneTargetView, SftpTargetView, WebdavTargetView } from "@/components/backups/types";

/**
 * How a stored remote destination reads in a list: where it writes, the
 * technical line expert mode adds, where its archives stay when it is
 * deleted, and its icon.
 *
 * Text only, and no component imports, so `describeDestination`
 * (providers.ts), which every list uses, can call it without pulling the
 * forms in. The forms are registered in kinds.ts.
 */

interface RemoteText {
  icon: string;
  where(target: unknown): string;
  technical(target: unknown): string;
  place(target: unknown): string;
}

const folderText = (folder: string) => (folder ? `cartella «${folder}»` : "cartella principale");

const REMOTE_TEXT: Record<string, RemoteText> = {
  sftp: {
    icon: "solar:server-square-linear",
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
  webdav: {
    icon: "solar:folder-cloud-linear",
    where: (target) => {
      const t = target as WebdavTargetView;
      return `WebDAV su ${t.host} · ${folderText(t.folder)}`;
    },
    technical: (target) => ` · ${(target as WebdavTargetView).url}`,
    place: (target) => `su ${(target as WebdavTargetView).host}`,
  },
  rclone: {
    icon: "solar:cloud-upload-linear",
    where: (target) => {
      const t = target as RcloneTargetView;
      return `${t.service} · ${folderText(t.folder)}`;
    },
    technical: (target) => ` · rclone ${(target as RcloneTargetView).provider}`,
    place: (target) => `su ${(target as RcloneTargetView).service}`,
  },
  peer: {
    icon: "solar:server-path-linear",
    where: (target) => {
      const t = target as PeerTargetView;
      const name = t.memberName ?? "senza nome";
      return t.linked === false ? `Server RunPanel «${name}», non più collegato` : `Server RunPanel «${name}»`;
    },
    technical: (target) => ` · ${PEER_FOLDER}/<id di questo server> · membro ${(target as PeerTargetView).memberId}`,
    place: (target) => `sul server «${(target as PeerTargetView).memberName ?? "collegato"}»`,
  },
};

type Located = { type: string; target?: unknown };

/** "Server SFTP nas.lan · cartella «backup»"; null for a type that is not a remote one, or has no target. */
export function remoteWhere(destination: Located): string | null {
  const text = REMOTE_TEXT[destination.type];
  return text && destination.target ? text.where(destination.target) : null;
}

export function remoteTechnical(destination: Located): string | null {
  const text = REMOTE_TEXT[destination.type];
  return text && destination.target ? text.technical(destination.target) : null;
}

export function remotePlace(destination: Located): string | null {
  const text = REMOTE_TEXT[destination.type];
  return text && destination.target ? text.place(destination.target) : null;
}

export function remoteIcon(type: string): string | null {
  return REMOTE_TEXT[type]?.icon ?? null;
}
