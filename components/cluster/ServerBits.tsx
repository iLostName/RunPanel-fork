"use client";

import { Icon } from "@iconify/react";
import { SelectField } from "@/components/ui/SelectField";
import { Hint } from "@/components/ui/Hint";
import { ErrorDetail } from "@/components/ui/LoadError";
import { refusalNote } from "@/lib/error-text";
import type { MemberStatus } from "@/lib/cluster-merge";
import { useNode } from "@/lib/hooks/useNode";
import { serverOptionLabel } from "@/lib/server-url";
import { cn } from "@/lib/utils";

/**
 * The small pieces every multi-server page shares. Each renders nothing in
 * solo mode, so a page can use them unconditionally and look exactly as it
 * did before a cluster existed.
 */

const ALL = "__all__";

/** Which server a row lives on. */
export function ServerBadge({ memberId, className }: { memberId: string | null | undefined; className?: string }) {
  const { isSolo, nodes, selfId } = useNode();
  if (isSolo || !memberId) return null;
  const node = nodes.find((n) => n.id === memberId);
  if (!node) return null;
  return (
    <span
      className={cn("bg-default text-muted inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs", className)}
      title={node.id === selfId ? "Questo server" : node.url}
    >
      <Icon icon="solar:server-2-linear" width={12} aria-hidden />
      {node.name}
    </span>
  );
}

/** Narrow a list to one server, or show every server. Writes `?server=`. */
export function ServerFilter({ className }: { className?: string }) {
  const { isSolo, nodes, serverParam, select, selfId } = useNode();
  if (isSolo) return null;
  return (
    <SelectField
      ariaLabel="Server"
      // The top bar has the same selector on wider screens; this one is for
      // phones, where it takes its own line above the header's buttons rather
      // than pushing one of them onto a second.
      className={cn("w-full sm:hidden", className)}
      value={serverParam ?? ALL}
      onChange={(v) => select(v === ALL ? null : v)}
      options={[
        { value: ALL, label: "Tutti i server" },
        ...nodes.map((n) => ({ value: n.id, label: serverOptionLabel(n, selfId) })),
      ]}
    />
  );
}

/**
 * Where something new is created. Choosing a server writes `?server=`, so
 * every call the form makes from then on goes to that server.
 */
export function ServerPicker({ className, description }: { className?: string; description?: string }) {
  const { isSolo, nodes, selected, select, selfId } = useNode();
  if (isSolo) return null;
  return (
    <div className={className}>
      <SelectField
        label="Server"
        value={selected}
        onChange={(v) => select(v === selfId ? null : v)}
        options={nodes.map((n) => ({
          value: n.id,
          label: serverOptionLabel(n, selfId),
          description: n.role === "node" ? "Nodo" : "Pannello",
        }))}
      />
      {description && <p className="text-muted mt-1 text-xs">{description}</p>}
    </div>
  );
}

/**
 * One line per server that did not answer, so a shorter list is never mistaken
 * for the whole one. `lastKnown` names the servers whose last known rows are on
 * the page anyway.
 */
export function UnreachableServers({
  failed,
  what,
  lastKnown = [],
  className,
}: {
  failed: MemberStatus[];
  what: string;
  lastKnown?: string[];
  className?: string;
}) {
  if (failed.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {failed.map((m) => (
        <Hint key={m.id} tone={m.reachable ? "info" : "warn"}>
          {m.reachable
            ? `${m.name}: ${what} non disponibili per il tuo account${refusalNote(m.error)}.`
            : lastKnown.includes(m.id)
              ? `${m.name} non raggiungibile: ${what} di questo server sono quelli dell'ultimo contatto e non si possono comandare.`
              : `${m.name} non raggiungibile: ${what} di questo server non sono in elenco.`}
          {!m.reachable && <ErrorDetail detail={m.error} />}
        </Hint>
      ))}
    </div>
  );
}
