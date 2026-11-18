import fs from "node:fs";
import { config } from "@/lib/config";
import { isPeerMemberId } from "@/lib/backup-peer";
import { getSetting, setSetting } from "@/lib/settings";
import { createPeerHost, type PeerHost } from "./peer-host";
import { FREE_SPACE_RESERVE } from "./paths";

/**
 * This server's copies of the other servers' backups (peer-host.ts), bound to
 * its data directory, its disk and the limits its owner sets.
 *
 * The limits are one setting, `{ <member id>: bytes }`: absent is no limit of
 * its own — the disk still keeps its reserve — and 0 refuses that server. A
 * setting rather than a table because there is nothing else to keep: what a
 * source holds is what is in its folder, read from the disk every time, so the
 * number shown can never drift from the space actually taken.
 */

export const PEER_QUOTAS_SETTING = "backup_peer_quotas";

export async function readPeerQuotas(): Promise<Record<string, number>> {
  const raw = await getSetting(PEER_QUOTAS_SETTING);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed ?? {})) {
      if (isPeerMemberId(id) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[id] = value;
    }
    return out;
  } catch {
    // An unreadable value limits nobody, and the next edit rewrites it whole.
    return {};
  }
}

/** Set one server's limit; null removes it. */
export async function setPeerQuota(memberId: string, bytes: number | null): Promise<void> {
  const quotas = await readPeerQuotas();
  if (bytes === null) delete quotas[memberId];
  else quotas[memberId] = bytes;
  await setSetting(PEER_QUOTAS_SETTING, JSON.stringify(quotas));
}

/** Free and total bytes of the disk holding `dir`. */
export function diskSpace(dir: string): { free: number; total: number } | null {
  try {
    const stat = fs.statfsSync(dir);
    return { free: Number(stat.bsize) * Number(stat.bavail), total: Number(stat.bsize) * Number(stat.blocks) };
  } catch {
    return null;
  }
}

export function peerHost(): PeerHost {
  const root = config.peerBackupsDir;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return createPeerHost({
    root,
    quotaFor: async (memberId) => (await readPeerQuotas())[memberId] ?? null,
    disk: () => diskSpace(root),
    // While pieces arrive the backup runner's own floor holds, whatever was
    // reserved: something else on the disk may have grown meanwhile.
    floorBytes: FREE_SPACE_RESERVE,
  });
}

/**
 * Uploads that will never finish: at boot, every one that was under way —
 * its running sha256 was in the memory of the process that stopped — and
 * then hourly, those abandoned by a sender that went away.
 */
export function sweepPeerUploads(): number {
  try {
    if (!fs.existsSync(config.peerBackupsDir)) return 0;
    return peerHost().sweep();
  } catch {
    return 0;
  }
}
