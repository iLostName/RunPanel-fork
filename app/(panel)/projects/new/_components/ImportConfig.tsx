"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { KeyValue } from "@/components/ui/KeyValue";
import { Hint } from "@/components/ui/Hint";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { runtimeLabel } from "@/lib/labels";
import { readConfigFile, type ProjectConfigFile } from "@/lib/project-config-file";

/**
 * A project from a file made by "Esporta configurazione".
 *
 * Expert mode, next to the empty project: it is how a project moves to
 * another server, or comes back after being deleted. The file carries no
 * secrets, so the variables are added afterwards; auto-deploy is left off,
 * since turning it on registers this project's own webhook. Created in two
 * calls (create, configure); if the second fails the first is undone.
 */
export function ImportConfig() {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<ProjectConfigFile | null>(null);
  const [name, setName] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    const result = readConfigFile(await file.text());
    if (fileInput.current) fileInput.current.value = "";
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setConfig(result.config);
    setName(result.config.name);
  }

  async function create() {
    if (!config) return false;
    const res = await fetch(api("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(created.error ?? "Creazione non riuscita");
      return false;
    }

    // The exported port may be taken here: the first free one from it.
    let port = config.port;
    if (port !== null) {
      const [projects, services] = await Promise.all([
        fetch(api("/api/projects")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        fetch(api("/api/services")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      const others = (Array.isArray(projects) ? projects : []).filter((p: { id?: string }) => p.id !== created.id);
      port = firstFreePort(port, portsInUse([...others, ...(Array.isArray(services) ? services : [])]));
    }

    const body: Record<string, unknown> = { runtimeType: config.runtime };
    if (config.source.type === "github") {
      body.sourceType = "github";
      body.sourceUrl = config.source.url;
      body.sourceBranch = config.source.branch;
    }
    if (port !== null) body.port = port;
    if (Object.keys(config.contract).length > 0) body.builderConfig = config.contract;
    if (config.restartCron) body.restartCron = config.restartCron;

    const patch = await fetch(api(`/api/projects/${created.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!patch.ok) {
      const data = await patch.json().catch(() => ({}));
      await fetch(api(`/api/projects/${created.id}`), { method: "DELETE" }).catch(() => undefined);
      toast.error(data.details?.[0]?.message ?? data.error ?? "Configurazione non riuscita: non è stato creato nulla");
      return false;
    }
    toast.success(`Importato «${created.name}»: aggiungi le variabili, poi fai il primo deploy`);
    router.push(href(`/projects/${created.id}`));
  }

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button variant="ghost" size="sm" onPress={() => fileInput.current?.click()}>
        <Icon icon="solar:import-linear" width={16} aria-hidden />
        Importa una configurazione esportata
      </Button>

      <FormDialog
        isOpen={config !== null}
        onOpenChange={(open) => !open && setConfig(null)}
        title="Importa il progetto"
        submitLabel="Crea"
        isSubmitDisabled={!name.trim()}
        onSubmit={create}
      >
        {config && (
          <>
            <TextField value={name} onChange={setName} autoFocus>
              <Label>Nome</Label>
              <Input />
            </TextField>
            <KeyValue
              items={[
                { label: "Sorgente", value: config.source.type === "github" ? `${config.source.url} @ ${config.source.branch}` : "Archivio ZIP (da caricare)", mono: config.source.type === "github" },
                { label: "Runtime", value: runtimeLabel(config.runtime) },
                { label: "Porta", value: config.port ? String(config.port) : "nessuna", mono: true },
              ]}
            />
            <Hint tone="info" title="Da fare dopo">
              Il file non contiene segreti: aggiungi le variabili nella scheda Variabili
              {config.source.type === "upload" ? ", carica lo ZIP in Impostazioni › Sorgente" : ""}
              {config.autoDeploy ? " e riaccendi gli aggiornamenti a ogni push" : ""}. Indirizzi e database non vengono creati.
            </Hint>
          </>
        )}
      </FormDialog>
    </>
  );
}
