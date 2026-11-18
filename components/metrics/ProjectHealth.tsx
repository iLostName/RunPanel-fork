"use client";

import { Section } from "@/components/ui/Section";
import { useExpertMode } from "@/components/Providers";
import { UptimeCard } from "@/components/uptime/UptimeCard";
import { ResourceCharts } from "./ProjectMetrics";

/**
 * Whether the app answers, and what it has been using — the two blocks of a
 * project's health, together for the project page as it is today. Each one is
 * a component of its own (`UptimeCard`, `ProjectMetrics`), so a page laid out
 * differently places them separately.
 *
 * The charts are folded by default — the page is still mostly about the log
 * below — and open in expert mode, like every `Advanced`.
 */
export function ProjectHealth({ projectId, className }: { projectId: string; className?: string }) {
  const { expert } = useExpertMode();
  return (
    <div className={className ?? "mb-6 space-y-3"}>
      <UptimeCard projectId={projectId} />
      <Section
        title="Consumo di risorse"
        summary="CPU, memoria e rete nell'ultima ora, nelle ultime 24 ore e negli ultimi 7 giorni"
        defaultExpanded={expert}
      >
        <ResourceCharts scope="project" id={projectId} bare />
      </Section>
    </div>
  );
}
