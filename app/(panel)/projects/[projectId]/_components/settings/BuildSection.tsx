"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { CommandField } from "@/components/ui/CommandField";
import { Field } from "@/components/ui/Field";
import { InfoTip } from "@/components/ui/Tooltip";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Advanced } from "@/components/ui/Technical";
import type { RuntimeType } from "@/lib/validation";
import { OneTimeCommandsSection } from "../OneTimeCommandsSection";
import type { RegisterPendingSave } from "../pending-saves";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";
import { HealthcheckPanel } from "./HealthcheckPanel";
import { ZeroDowntimePanel } from "./ZeroDowntimePanel";

interface Preset {
  id: string;
  label: string;
  description: string;
  runtime: RuntimeType;
  commands: { install?: string; build?: string; start?: string };
}

const RUNTIMES: { id: RuntimeType; label: string; hint: string; icon: string }[] = [
  { id: "node", label: "Node.js", hint: "Installa, compila e avvia lo script start", icon: "solar:code-linear" },
  { id: "static", label: "Sito statico", hint: "Pubblica i file HTML, con una build se serve", icon: "solar:document-text-linear" },
  { id: "docker", label: "Docker", hint: "Costruisce il Dockerfile del repository", icon: "solar:box-linear" },
  { id: "compose", label: "Compose", hint: "Avvia lo stack del file compose", icon: "solar:layers-linear" },
  { id: "custom", label: "Personalizzato", hint: "Comandi tuoi, qualsiasi linguaggio", icon: "solar:command-linear" },
];

/**
 * How the app is built, started and judged healthy.
 *
 * The runtime is chosen here with every option (Compose and static included,
 * which only the hidden AppForm path used to offer). A preset fills the
 * commands only when "Applica" is pressed, and the commands it would use are
 * the placeholders until then.
 */
export function BuildSection({
  form,
  project,
  registerPending,
  onProjectChange,
  onRefresh,
}: {
  form: DeployForm;
  project: Project;
  registerPending: RegisterPendingSave;
  onProjectChange: (update: Project | ((prev: Project) => Project)) => void;
  onRefresh: () => void;
}) {
  const api = useNodeApi();
  const { values, patchContract } = form;
  const { contract, runtimeType } = values;
  const isDocker = runtimeType === "docker";
  const isCompose = runtimeType === "compose";

  const [presetId, setPresetId] = useState<string | null>(null);
  const { data: presetData } = useResource<{ presets: Preset[] }>(api("/api/presets"));
  const presets = presetData?.presets ?? [];
  const preset = presets.find((entry) => entry.id === presetId) ?? null;

  /**
   * Copy a preset's commands into the form, with its runtime: they are not
   * independent choices (pip commands on a Node runtime fail on a missing
   * package.json). Replaced wholesale, and nothing is written until Salva.
   */
  function applyPreset(chosen: Preset) {
    patchContract({
      commands: {
        ...contract.commands,
        install: chosen.commands.install ?? "",
        build: chosen.commands.build ?? "",
        start: chosen.commands.start ?? "",
      },
    });
    form.set("runtimeType", chosen.runtime);
    toast.success(`Comandi di "${chosen.label}" applicati: controlla e salva`);
  }

  const setCommand = (slot: "install" | "build" | "start" | "release", value: string) =>
    patchContract({ commands: { ...contract.commands, [slot]: value } });

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Runtime" description="Come viene costruita e avviata l'app. Cambia dal prossimo deploy." />
        <ChoiceGroup label="Runtime" className="sm:grid-cols-3">
          {RUNTIMES.map((r) => (
            <ChoiceCard
              key={r.id}
              compact
              selected={runtimeType === r.id}
              onSelect={() => form.set("runtimeType", r.id)}
              icon={r.icon}
              title={r.label}
              description={r.hint}
            />
          ))}
        </ChoiceGroup>
        {runtimeType !== project.runtime_type && (
          <Hint tone="warn">
            Il prossimo deploy userà il runtime nuovo: controlla che il repository abbia quello che serve (per esempio un
            Dockerfile per Docker, un package.json per Node).
          </Hint>
        )}
      </Panel>

      {!isCompose && (
        <Panel className="space-y-4">
          <PanelHeader
            title="Comandi"
            description={isDocker ? "Il Dockerfile decide il resto" : "Vuoti: vengono ricavati dal repository a ogni deploy"}
            actions={
              <InfoTip title="Da dove arrivano">
                Lasciati vuoti, li ricava il deploy guardando i file (un preset rilevato, poi il runpanel.json del repository).
                Quelli scritti qui vincono su entrambi.
              </InfoTip>
            }
          />

          {!isDocker && presets.length > 0 && (
            <div>
              <span className="text-muted mb-2 block text-sm font-medium">Punto di partenza</span>
              <Segmented
                label="Preset di deploy"
                value={presetId ?? "none"}
                onChange={(id) => setPresetId(id === "none" ? null : id)}
                options={[{ value: "none", label: "Nessuno" }, ...presets.map((entry) => ({ value: entry.id, label: entry.label }))]}
              />
              {preset && (
                <div className="mt-2 space-y-2">
                  <FieldHint className="mt-0">{preset.description}</FieldHint>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onPress={() => applyPreset(preset)}>
                      Applica i comandi
                    </Button>
                    {preset.runtime !== runtimeType && (
                      <span className="text-warning text-meta">
                        Cambia anche il runtime: <Code>{runtimeType}</Code> → <Code>{preset.runtime}</Code>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {runtimeType === "node" && (
            <Field label="Package manager">
              <Segmented
                label="Package manager"
                value={contract.packageManager}
                onChange={(packageManager) => patchContract({ packageManager })}
                options={[
                  { value: "auto", label: "Automatico" },
                  { value: "npm", label: "npm" },
                  { value: "bun", label: "bun" },
                  { value: "pnpm", label: "pnpm" },
                  { value: "yarn", label: "yarn" },
                ]}
              />
            </Field>
          )}

          {!isDocker && (
            <>
              <CommandField
                label="Installazione"
                value={contract.commands.install ?? ""}
                // The Python fallback uses a venv: plain `pip install` is refused by
                // PEP 668 on Debian 12 / Ubuntu 23.04 and later.
                placeholder={
                  preset ? (preset.commands.install ?? "") : runtimeType === "node" ? "automatica" : "python3 -m venv venv\nvenv/bin/pip install -r requirements.txt"
                }
                hint="Un comando per riga, eseguiti in ordine nella stessa shell."
                onChange={(v) => setCommand("install", v)}
              />
              <CommandField
                label="Build"
                value={contract.commands.build ?? ""}
                placeholder={preset ? (preset.commands.build ?? "") : runtimeType === "node" ? "automatica" : "go build -o app ."}
                onChange={(v) => setCommand("build", v)}
              />
              <CommandField
                label="Avvio"
                rows={1}
                value={contract.commands.start ?? ""}
                placeholder={preset ? (preset.commands.start ?? "") : runtimeType === "node" ? "automatico" : "venv/bin/python -m uvicorn main:app"}
                hint="Solo la prima riga viene usata come comando di avvio."
                onChange={(v) => setCommand("start", v)}
              />
            </>
          )}

          <Advanced summary="comando di release, prima dell'avvio">
            <CommandField
              label="Release"
              rows={2}
              value={contract.commands.release ?? ""}
              placeholder="npx prisma migrate deploy"
              hint={
                <>
                  Eseguito una volta dopo la build e prima dell&apos;avvio. Se fallisce, fallisce il deploy e la nuova versione
                  non parte: è il posto giusto per le migrazioni.{" "}
                  {isDocker
                    ? "Gira in un container usa e getta creato dall'immagine appena costruita, con la stessa rete e lo stesso ambiente dell'app."
                    : "Gira nella cartella della nuova versione, con lo stesso ambiente e gli stessi dati dell'app."}
                </>
              }
              onChange={(v) => setCommand("release", v)}
            />
          </Advanced>
        </Panel>
      )}

      {/* Right under the commands that always run: the same question ("where do
          I put this command?") with its two answers side by side. Saved on its
          own: the queue changes by itself while a deploy runs. */}
      <OneTimeCommandsSection
        projectId={project.id}
        runtimeType={runtimeType}
        queued={project.oneTimeCommands ?? []}
        isDeploying={project.status === "deploying"}
        registerPending={registerPending}
        onChanged={(queued) => (queued ? onProjectChange((prev) => ({ ...prev, oneTimeCommands: queued })) : onRefresh())}
      />

      <HealthcheckPanel form={form} releasesSupported={project.releases?.supported ?? false} />

      {/* After the health check, which it depends on: it is what says when the new version can take over. */}
      <ZeroDowntimePanel form={form} project={project} />
    </div>
  );
}
