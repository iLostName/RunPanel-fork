"use client";

import { Input, Label, TextField } from "@heroui/react";
import type { LogLine } from "@/components/ui/LogViewer";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { InfoTip } from "@/components/ui/Tooltip";
import { Code, FieldHint } from "@/components/ui/Hint";
import { MountsSection } from "../MountsSection";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";

/**
 * What the app may use: memory, CPU, build time, and for containers the
 * folders mounted into them.
 *
 * "Dai più memoria", offered when a build runs out of it, lands here: for a
 * native app that is the Node heap of the build, for a container its limit.
 */
export function ResourcesSection({
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
  const isDocker = runtimeType === "docker";

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Build" description="Quanto può durare e quanta memoria può usare" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField
              value={contract.build.nodeOptions ?? ""}
              onChange={(v) => patchContract({ build: { ...contract.build, nodeOptions: v || undefined } })}
            >
              <Label>Opzioni di Node per la build</Label>
              <Input placeholder="--max-old-space-size=4096" className="font-mono text-sm" />
            </TextField>
            <FieldHint>
              Se la build finisce la memoria, <Code>--max-old-space-size=4096</Code> le dà 4 GB. Una variabile{" "}
              <Code>NODE_OPTIONS</Code> del progetto vince su questo campo.
            </FieldHint>
          </div>
          <div>
            <TextField
              value={String(contract.build.timeoutSec)}
              onChange={(v) => patchContract({ build: { ...contract.build, timeoutSec: Number.parseInt(v, 10) || 900 } })}
            >
              <Label>Tempo massimo (s)</Label>
              <Input type="number" />
            </TextField>
            <FieldHint>Oltre, la build viene interrotta. Da 30 secondi a 2 ore.</FieldHint>
          </div>
        </div>
      </Panel>

      {isDocker && (
        <Panel className="space-y-4">
          <PanelHeader title="Container" description="Limiti e comportamento dopo un arresto" />
          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="text-muted text-sm font-medium">Riavvio</span>
              <InfoTip title="Quando riparte">
                <Code>unless-stopped</Code> riparte al riavvio della macchina, ma resta fermo se lo fermi tu. <Code>always</Code>{" "}
                riparte anche se l&apos;avevi fermato. <Code>no</Code> resta giù dopo ogni crash.
              </InfoTip>
            </div>
            <Segmented
              label="Policy di riavvio"
              value={contract.runtime.restartPolicy}
              onChange={(restartPolicy) => patchContract({ runtime: { ...contract.runtime, restartPolicy } })}
              options={[
                { value: "no", label: "no" },
                { value: "on-failure", label: "on-failure" },
                { value: "unless-stopped", label: "unless-stopped" },
                { value: "always", label: "always" },
              ]}
            />
          </div>
          <div>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField value={contract.runtime.memory ?? ""} onChange={(v) => patchContract({ runtime: { ...contract.runtime, memory: v || undefined } })}>
                <Label>Memoria</Label>
                <Input placeholder="2g" className="font-mono text-sm" />
              </TextField>
              <TextField value={contract.runtime.cpus ?? ""} onChange={(v) => patchContract({ runtime: { ...contract.runtime, cpus: v || undefined } })}>
                <Label>CPU</Label>
                <Input placeholder="1.5" className="font-mono text-sm" />
              </TextField>
              <TextField value={contract.runtime.shmSize ?? ""} onChange={(v) => patchContract({ runtime: { ...contract.runtime, shmSize: v || undefined } })}>
                <Label>shm-size</Label>
                <Input placeholder="2g" className="font-mono text-sm" />
              </TextField>
            </div>
            <FieldHint>
              Formato Docker: <Code>512m</Code>, <Code>2g</Code>. Vuoti vuol dire nessun limite. <Code>shm-size</Code> serve solo a
              browser headless e Postgres, che con il default di 64 MB si fermano senza spiegazioni.
            </FieldHint>
          </div>
        </Panel>
      )}

      {isDocker && (
        <Panel className="space-y-4">
          <PanelHeader title="Cartelle montate" description="File che sopravvivono ai deploy" />
          <MountsSection projectId={project.id} mounts={project.mounts ?? []} onApplied={onRefresh} logLines={operationLines} />
        </Panel>
      )}
    </div>
  );
}
