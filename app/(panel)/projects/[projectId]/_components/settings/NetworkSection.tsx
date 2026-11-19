"use client";

import { useMemo } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { InfoTip } from "@/components/ui/Tooltip";
import { Code, FieldHint } from "@/components/ui/Hint";
import { PortHint } from "@/components/DeployHints";
import { AccessSection } from "@/components/AccessSection";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";

/**
 * Where the app listens and who may reach it.
 *
 * The port saves with the rest of the form; the access restriction keeps its
 * own save, because applying it moves the port the app listens on and so
 * restarts the app — the shared bar never means "and also restart".
 */
export function NetworkSection({
  form,
  project,
  onProjectChange,
}: {
  form: DeployForm;
  project: Project;
  onProjectChange: (update: Project | ((prev: Project) => Project)) => void;
}) {
  const { values, patchContract } = form;
  const { contract, runtimeType } = values;
  const isDocker = runtimeType === "docker";

  /*
    Three shapes the access restriction would have to lie about: Compose
    publishes its ports from a file the operator owns, `network: host` has no
    published port to move, and without a port there is nothing to restrict.
  */
  const accessUnavailable = useMemo(() => {
    if (runtimeType === "compose") {
      return "Le porte le pubblica il tuo file compose. RunPanel non lo riscrive: per limitare l'accesso metti il binding su 127.0.0.1 lì.";
    }
    if (isDocker && contract.docker.network === "host") {
      return "Con rete host il container condivide la rete della macchina: non c'è una porta pubblicata da spostare. Passa a bridge o project.";
    }
    if (!project.port) return "Questo progetto non ha una porta, quindi non c'è niente da limitare.";
    return undefined;
  }, [runtimeType, project.port, isDocker, contract.docker.network]);

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Porta" description="Dove l'app aspetta le richieste" />
        <div className="max-w-xs">
          <TextField value={values.port} onChange={(v) => form.set("port", v)}>
            <Label>Porta</Label>
            <Input type="number" placeholder="3000" />
          </TextField>
          <PortHint runtimeType={runtimeType} />
          {/* Deployed without downtime the port stays the app's own, inside its
              container; on the server it is published elsewhere, on loopback. */}
          {project.live_port ? (
            <FieldHint>
              Con il deploy senza interruzioni l&apos;app ascolta su questa porta dentro il suo container; sul server non è
              aperta e la raggiungi dai suoi indirizzi.
            </FieldHint>
          ) : null}
        </div>
      </Panel>

      <AccessSection
        kind="project"
        targetId={project.id}
        name={project.name}
        publicPort={project.port}
        access={project.access}
        gate={project.gate}
        unavailable={accessUnavailable}
        onSaved={(updated) => onProjectChange((prev) => ({ ...prev, ...(updated as Partial<Project>) }))}
      />

      {isDocker && (
        <Panel className="space-y-4">
          <PanelHeader title="Rete del container" />
          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="text-muted text-sm font-medium">Rete</span>
              <InfoTip title="Rete del container">
                <Code>project</Code> mette app e database sulla stessa rete, dove si raggiungono per nome: è quello che rende
                automatico il collegamento del database. <Code>bridge</Code> lascia l&apos;app isolata. <Code>host</Code>{" "}
                condivide la rete della macchina: niente porte pubblicate, e <Code>localhost</Code> è già quello del server.
              </InfoTip>
            </div>
            <Segmented
              label="Rete del container"
              value={contract.docker.network}
              onChange={(network) => patchContract({ docker: { ...contract.docker, network } })}
              options={[
                { value: "project", label: "project (consigliata)" },
                { value: "bridge", label: "bridge" },
                { value: "host", label: "host" },
              ]}
            />
          </div>
          <div className="max-w-xs">
            <TextField
              value={contract.docker.hostname ?? ""}
              onChange={(v) => patchContract({ docker: { ...contract.docker, hostname: v || undefined } })}
            >
              <Label>Hostname</Label>
              <Input placeholder="app" className="font-mono text-sm" />
            </TextField>
            <FieldHint>Il nome che il container dà a se stesso. Gli altri lo raggiungono col nome del container.</FieldHint>
          </div>
        </Panel>
      )}
    </div>
  );
}
