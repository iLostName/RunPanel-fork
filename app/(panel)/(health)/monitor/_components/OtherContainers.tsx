"use client";

import { Section } from "@/components/ui/Section";
import { Hint } from "@/components/ui/Hint";
import { formatBytes } from "@/lib/format";
import { sortByUsage, type UsageSort } from "@/lib/metrics-math";
import { Row, TableHead, containerState, type HostScale } from "./ProcessTable";
import type { OtherContainer } from "./types";

/**
 * Containers on this machine that the panel did not start.
 *
 * They are here so the Monitor adds up: on a host at 95% of its memory, a list
 * of projects using 40% leaves the reader guessing where the rest went. The
 * panel only reads them — it never stops, restarts or cleans one up.
 */
export function OtherContainers({ containers, host, sort }: { containers: OtherContainer[]; host: HostScale; sort: UsageSort }) {
  if (containers.length === 0) return null;
  const running = containers.filter((c) => c.state === "running");
  const memory = running.reduce((sum, c) => sum + (c.memory ?? 0), 0);

  return (
    <Section
      className="mt-6"
      title="Altri container"
      summary={`${containers.length === 1 ? "1 container" : `${containers.length} container`} non gestiti dal pannello${
        running.length > 0 ? ` · ${running.length} in esecuzione, ${formatBytes(memory)} di RAM` : ""
      }`}
    >
      <Hint>
        Sono stati avviati fuori da RunPanel: a mano, da un altro strumento o da un docker compose che il pannello non conosce.
        Il pannello li mostra per farti vedere chi usa il server, ma non li ferma né li modifica.
      </Hint>
      <div className="divide-border border-border divide-y overflow-hidden rounded-[var(--radius)] border">
        <TableHead first="Container" />
        {sortByUsage(containers, sort).map((container) => {
          const state = containerState(container.state);
          return (
            <Row
              key={container.name}
              label={container.name}
              sublabel={container.stack ? `stack ${container.stack}` : undefined}
              tone={state.tone}
              stateLabel={state.label}
              cpu={container.cpu}
              memory={container.memory}
              host={host}
            />
          );
        })}
      </div>
    </Section>
  );
}
