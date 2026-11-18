"use client";

import { Input, Label, TextField } from "@heroui/react";
import type { LogLine } from "@/components/ui/LogViewer";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { KeyValue } from "@/components/ui/KeyValue";
import { FieldHint } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { EnvFilePathHint } from "@/components/DeployHints";
import { ScheduledRestart } from "@/components/ScheduledRestart";
import { formatRelative } from "@/lib/format";
import { RepoPathSection } from "../RepoPathSection";
import { WebhookSection } from "../WebhookSection";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";
import { TasksSection } from "./TasksSection";

/** Name, and for experts the identifiers the panel uses on disk and in Docker. */
export function GeneralSection({ form, project }: { form: DeployForm; project: Project }) {
  return (
    <Panel className="space-y-4">
      <PanelHeader title="Generale" />
      <div className="max-w-md">
        <TextField value={form.values.name} onChange={(v) => form.set("name", v)}>
          <Label>Nome del progetto</Label>
          <Input />
        </TextField>
        <FieldHint>
          Come lo vedi nel pannello. Cartelle, container e volumi usano il nome interno, che non cambia mai.
        </FieldHint>
      </div>
      <Technical>
        <KeyValue
          items={[
            { label: "Nome interno", value: project.slug, mono: true },
            { label: "ID", value: project.id, mono: true },
            { label: "Deploy fatti", value: String(project.deploy_count) },
            { label: "Ultimo deploy", value: project.last_deploy_at ? formatRelative(project.last_deploy_at) : "mai" },
          ]}
        />
      </Technical>
    </Panel>
  );
}

/**
 * What happens without anyone pressing a button: deploys on push, scheduled
 * restarts. Each keeps its own save, as before: a schedule has its own
 * preview, and auto-deploy talks to GitHub as it is switched.
 */
export function AutomationsSection({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange: (update: Project | ((prev: Project) => Project)) => void;
}) {
  return (
    <div className="space-y-4">
      <WebhookSection project={project} onProjectChange={onProjectChange} />
      <ScheduledRestart
        kind="project"
        id={project.id}
        cron={project.restart_cron ?? ""}
        nextAt={project.restart_next_at}
        lastAt={project.restart_last_at}
        lastResult={project.restart_last_result}
        onSaved={(updated) => onProjectChange((prev) => ({ ...prev, ...(updated as Partial<Project>) }))}
      />
      <TasksSection projectId={project.id} />
    </div>
  );
}

/** The settings few people need: a written .env file, where the files live. */
export function AdvancedSection({
  form,
  project,
  onRefresh,
  operationLines,
}: {
  form: DeployForm;
  project: Project;
  onRefresh: () => void;
  operationLines: LogLine[];
}) {
  const { values, patchContract } = form;
  const { contract, runtimeType } = values;
  const native = runtimeType !== "docker" && runtimeType !== "compose";

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader
          title="File .env"
          description={contract.envFile.enabled ? `Scritto in ${contract.envFile.path}` : "Le variabili arrivano solo come variabili d'ambiente"}
          actions={
            <SettingToggle
              label="Scrivi un file .env"
              isSelected={contract.envFile.enabled}
              onChange={(v) => patchContract({ envFile: { ...contract.envFile, enabled: v } })}
              className="w-auto"
            />
          }
        />
        <div className="max-w-md">
          <TextField
            value={contract.envFile.path}
            onChange={(v) => patchContract({ envFile: { ...contract.envFile, path: v } })}
            isDisabled={!contract.envFile.enabled}
          >
            <Label>Percorso del file</Label>
            <Input placeholder="/app/.env" className="font-mono text-sm" />
          </TextField>
          <EnvFilePathHint runtimeType={runtimeType} />
          <FieldHint>
            Riscritto a ogni deploy con tutte le variabili del progetto: quello che cambi lì a mano sparisce. Il posto giusto
            è la scheda Variabili.
          </FieldHint>
        </div>
      </Panel>

      {/* Native only: a container keeps its files in an image and has mounts instead. */}
      {native && project.repo_location && (
        <RepoPathSection
          projectId={project.id}
          location={project.repo_location}
          repoPath={project.repo_path}
          move={project.repoMove}
          onChanged={onRefresh}
          logLines={operationLines}
        />
      )}

      <Technical>
        <Panel className="space-y-3">
          <PanelHeader title="Configurazione salvata" description="Il contratto di deploy come lo legge la pipeline" />
          <pre className="border-border bg-background text-muted max-h-80 overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs">
            {JSON.stringify(contract, null, 2)}
          </pre>
        </Panel>
      </Technical>
    </div>
  );
}
