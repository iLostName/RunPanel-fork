import { PEER_FOLDER, peerReserveBytes } from "@/lib/backup-peer";
import { config } from "@/lib/config";
import { clusterState, listMembers } from "@/services/cluster/state";
import { diskSpace, peerHost, readPeerQuotas } from "./peer-hosting";

/**
 * What this server keeps for the other servers, as its owner's page shows it:
 * every member of the cluster, whether it has sent anything or not — so a
 * limit can be set before the first copy arrives — and every folder of a
 * server that is no longer linked, whose copies stay until someone deletes
 * them.
 */

export interface HostedSource {
  /** The source server's member id: its folder's name. */
  sourceId: string;
  name: string;
  url: string | null;
  /** Still a member of this server's cluster. */
  linked: boolean;
  archives: number;
  bytes: number;
  lastReceivedAt: string | null;
  /** Uploads under way, and how much of them has arrived. */
  incoming: { count: number; bytes: number };
  /** Null: no limit of its own. 0: new copies refused. */
  quotaBytes: number | null;
}

export interface HostedOverview {
  sources: HostedSource[];
  disk: { freeBytes: number; totalBytes: number; reserveBytes: number } | null;
  folder: string;
}

export async function hostedOverview(): Promise<HostedOverview> {
  const host = peerHost();
  const [state, members, quotas] = await Promise.all([clusterState(), listMembers(), readPeerQuotas()]);
  const summaries = new Map(host.sources().map((summary) => [summary.id, summary]));
  const linked = new Map((state ? members.filter((member) => member.id !== state.selfId) : []).map((member) => [member.id, member]));

  const ids = new Set([...linked.keys(), ...summaries.keys()]);
  if (state) ids.delete(state.selfId);
  const sources: HostedSource[] = [...ids].map((sourceId) => {
    const member = linked.get(sourceId);
    const summary = summaries.get(sourceId);
    return {
      sourceId,
      name: member?.name ?? summary?.name ?? sourceId,
      url: member?.url ?? summary?.url ?? null,
      linked: Boolean(member),
      archives: summary?.archives ?? 0,
      bytes: summary?.bytes ?? 0,
      lastReceivedAt: summary?.lastReceivedAt ?? null,
      incoming: summary?.incoming ?? { count: 0, bytes: 0 },
      quotaBytes: quotas[sourceId] ?? null,
    };
  });
  sources.sort((a, b) => (a.linked !== b.linked ? (a.linked ? -1 : 1) : a.name.localeCompare(b.name)));

  const space = diskSpace(config.peerBackupsDir);
  return {
    sources,
    disk: space ? { freeBytes: space.free, totalBytes: space.total, reserveBytes: peerReserveBytes(space.total) } : null,
    folder: PEER_FOLDER,
  };
}

/** One source as the list shows it, or null when this server knows nothing of it. */
export async function hostedSource(sourceId: string): Promise<HostedSource | null> {
  return (await hostedOverview()).sources.find((source) => source.sourceId === sourceId) ?? null;
}
