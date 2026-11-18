"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { uploadProjectZip } from "@/lib/upload";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";

const MAX_ZIP_BYTES = 100 * 1024 * 1024;

/**
 * Where the code comes from: a repository and its branch, or an archive.
 *
 * Changing repository or branch saves with the rest of the form and takes
 * effect at the next deploy. A new archive is an action rather than a field:
 * it replaces the files right away, with a progress bar, and then offers the
 * deploy that puts it online.
 */
export function SourceSection({
  form,
  project,
  onDeploy,
  onUploaded,
}: {
  form: DeployForm;
  project: Project;
  onDeploy: () => void;
  onUploaded: () => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  // The server guards what code a project runs behind these two (lib/host-guard.ts).
  const canHost = useCan("host");
  const canGithub = useCan("github");
  const { values } = form;
  const isGithub = values.sourceType === "github";

  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const savedAsUpload = project.source_type === "upload";

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast.error("Serve un file .zip");
      return;
    }
    if (file.size > MAX_ZIP_BYTES) {
      toast.error("L'archivio supera i 100 MB");
      return;
    }
    setProgress(0);
    try {
      await uploadProjectZip(api("/api/upload"), file, project.slug, setProgress);
      setUploaded(true);
      toast.success("Archivio caricato: i file sono stati sostituiti");
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload non riuscito");
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Sorgente" description="Da dove arriva il codice" />
        <Segmented
          label="Sorgente"
          value={values.sourceType}
          onChange={(next) => form.set("sourceType", next)}
          options={[
            { value: "github", label: "Repository GitHub", icon: "solar:code-linear", isDisabled: !canHost || !canGithub },
            { value: "upload", label: "Archivio ZIP", icon: "solar:archive-linear", isDisabled: !canHost },
          ]}
        />
        {!canHost && (
          <FieldHint>Per cambiare il codice che il progetto esegue serve il permesso «Accesso all&apos;host».</FieldHint>
        )}

        {isGithub ? (
          <>
            <div>
              <TextField value={values.sourceUrl} onChange={(v) => form.set("sourceUrl", v)} isDisabled={!canHost || !canGithub}>
                <Label>Indirizzo del repository</Label>
                <Input placeholder="https://github.com/utente/progetto" className="font-mono text-sm" />
              </TextField>
              <FieldHint>
                Per i repository privati serve GitHub collegato.{" "}
                <Link href={href("/github")} className="text-accent hover:underline">
                  Collegamento GitHub
                </Link>
              </FieldHint>
            </div>
            <div className="max-w-sm">
              <TextField value={values.branch} onChange={(v) => form.set("branch", v)} isDisabled={!canHost}>
                <Label>Branch</Label>
                <Input className="font-mono text-sm" placeholder="main" />
              </TextField>
              <FieldHint>La versione che va online. Cambia dal prossimo deploy.</FieldHint>
            </div>
            {project.pinned_sha && (
              <Hint tone="warn" icon="solar:pin-linear" title={`Fermo sul commit ${project.pinned_sha.slice(0, 7)}`}>
                I deploy rifanno quel commit, e gli aggiornamenti automatici sono sospesi, finché non torni all&apos;ultimo
                commit dalla scheda Deploy.
              </Hint>
            )}
          </>
        ) : !savedAsUpload ? (
          <Hint tone="info">Salva per passare all&apos;archivio ZIP, poi caricalo qui.</Hint>
        ) : (
          <div className="space-y-3">
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" isPending={progress !== null} isDisabled={!canHost} onPress={() => fileInput.current?.click()}>
                <Icon icon="solar:upload-linear" width={16} aria-hidden />
                Carica una nuova versione
              </Button>
              {uploaded && (
                <Button variant="primary" onPress={onDeploy}>
                  Metti online la nuova versione
                </Button>
              )}
            </div>
            {progress !== null && (
              <div
                className="bg-default h-1.5 max-w-sm overflow-hidden rounded-full"
                role="progressbar"
                aria-label="Caricamento dello ZIP"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="bg-accent h-full transition-[width]" style={{ width: `${progress * 100}%` }} />
              </div>
            )}
            <FieldHint>
              Fino a 100 MB. Sostituisce tutti i file del progetto; uno ZIP con una sola cartella dentro va bene (
              <Code>progetto.zip → progetto/package.json</Code>). Senza repository non ci sono aggiornamenti automatici.
            </FieldHint>
          </div>
        )}
      </Panel>
    </div>
  );
}
