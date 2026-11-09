"use client";

import { useMemo } from "react";
import type { Aggregated, Located, MemberStatus } from "@/lib/cluster-merge";
import { onlyMember } from "@/lib/cluster-merge";
import { useNode } from "./useNode";
import { useResource } from "./useResource";

/**
 * A list page's data, from every server or from this one.
 *
 * In a cluster it reads the aggregated route (`/api/cluster/projects`), whose
 * rows carry their server, and narrows them to `?server=` when the URL names
 * one. In solo mode it reads the local route as always and tags the rows with
 * this server, so the page renders the same way in both.
 *
 * `everyServer` keeps the rows of every server whatever `?server=` says, for a
 * list that is the same on all of them. `offline` holds the last known rows of
 * the servers that did not answer, on the routes that keep them.
 */
export function useClusterList<T>(
  clusterPath: string,
  soloPath: string,
  opts: { intervalMs?: number; enabled?: boolean; everyServer?: boolean } = {}
): {
  items: Located<T>[] | null;
  offline: Located<T>[];
  members: MemberStatus[];
  failed: MemberStatus[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { isSolo, serverParam, selfId } = useNode();
  const enabled = opts.enabled ?? true;
  const cluster = useResource<Aggregated<T>>(enabled && !isSolo ? clusterPath : null, { intervalMs: opts.intervalMs });
  const solo = useResource<T[]>(enabled && isSolo ? soloPath : null, { intervalMs: opts.intervalMs });

  return useMemo(() => {
    if (isSolo) {
      const items = solo.data ? solo.data.map((item) => ({ ...item, memberId: selfId ?? "", memberName: "" })) : null;
      return { items, offline: [], members: [], failed: [], error: solo.error, loading: solo.loading, refresh: solo.refresh };
    }
    const narrow = opts.everyServer ? null : serverParam;
    const members = cluster.data?.members ?? [];
    const shown = narrow ? members.filter((m) => m.id === narrow) : members;
    return {
      items: cluster.data ? onlyMember(cluster.data.items, narrow) : null,
      offline: onlyMember(cluster.data?.offline ?? [], narrow),
      members,
      failed: shown.filter((m) => !m.ok),
      error: cluster.error,
      loading: cluster.loading,
      refresh: cluster.refresh,
    };
  }, [isSolo, solo.data, solo.error, solo.loading, solo.refresh, cluster.data, cluster.error, cluster.loading, cluster.refresh, serverParam, selfId, opts.everyServer]);
}
