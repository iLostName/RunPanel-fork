"use client";

import { useMemo } from "react";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { KeyValue } from "@/components/ui/KeyValue";
import { Code, FieldHint } from "@/components/ui/Hint";
import { composeFile, type CatalogTemplate, type EnvEntry } from "@/lib/app-catalog";

/**
 * What an install writes, for whoever wants to read it first: the compose
 * file exactly as it lands in the project, the variables it reads and where
 * each value comes from, and the volumes that keep the data.
 *
 * Values that are typed or derived are shown as they will be written; the
 * generated ones do not exist yet — the server makes them when the button is
 * pressed — and a typed password is not repeated on screen.
 */
export function TemplateDetails({ template, preview }: { template: CatalogTemplate; preview: EnvEntry[] }) {
  const compose = useMemo(() => composeFile(template).trimEnd(), [template]);

  return (
    <>
      <div className="space-y-2">
        <p className="text-foreground text-sm">Il file Compose</p>
        <FieldHint className="mt-0">
          Va nella cartella del progetto come <Code>compose.yaml</Code>. È un file Compose come un altro: dopo
          l&apos;installazione lo cambi dalla scheda File e fai un nuovo deploy.
        </FieldHint>
        <CommandBlock commands={[compose]} label="File Compose copiato" className="max-h-96 overflow-y-auto" />
      </div>

      {preview.length > 0 && (
        <div className="space-y-2">
          <p className="text-foreground text-sm">Le variabili del progetto</p>
          <FieldHint className="mt-0">
            Il file le legge tra graffe. Sono cifrate come tutte le variabili e le cambi dalla scheda Variabili: valgono
            dal deploy successivo.
          </FieldHint>
          <KeyValue
            items={preview.map((entry) => ({
              label: <Code>{entry.key}</Code>,
              value: describe(entry),
              mono: entry.source !== "secret" && !entry.sensitive && entry.value !== "",
            }))}
          />
        </div>
      )}

      <div className="space-y-2">
        <p className="text-foreground text-sm">Dove restano i dati</p>
        <ul className="space-y-1.5">
          {template.volumes.map((volume) => (
            <li key={volume.name} className="text-muted text-sm">
              <Code>{volume.name}</Code> in <Code>{volume.path}</Code> · {volume.label}
            </li>
          ))}
        </ul>
        <FieldHint className="mt-0">
          Volumi Docker con nome: un nuovo deploy li ritrova, e i backup del progetto li includono quando scegli anche i
          volumi.
        </FieldHint>
      </div>
    </>
  );
}

function describe(entry: EnvEntry): string {
  if (entry.source === "secret") return "generata all'installazione, te la mostro una volta";
  if (entry.sensitive) return "la tua risposta";
  return entry.value || "vuota";
}
