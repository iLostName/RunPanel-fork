import { clusterState, getMember } from "@/services/cluster/state";

/**
 * In a cluster every server notifies on its own, so each message starts with
 * the name of the server that sent it. Null in solo mode.
 */
export async function serverName(): Promise<string | null> {
  try {
    const state = await clusterState();
    if (!state) return null;
    return (await getMember(state.selfId))?.name ?? null;
  } catch {
    return null;
  }
}
