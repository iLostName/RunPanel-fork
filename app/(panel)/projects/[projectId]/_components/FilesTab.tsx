"use client";

import { Hint } from "@/components/ui/Hint";
import { FileManager } from "./FileManager";

/**
 * The project's files, in a tab of their own.
 *
 * They used to sit under the logs, where an edit looked as permanent as the
 * log above it. It is not: the next deploy puts the files back as the source
 * has them, so the tab says so before anyone edits a config file by hand and
 * loses it on Friday's deploy.
 */
export function FilesTab({ projectId, runtimeType }: { projectId: string; runtimeType: string }) {
  const container = runtimeType === "docker" || runtimeType === "compose";
  return (
    <div className="space-y-4">
      <Hint tone="warn" title="Le modifiche fatte qui non sono per sempre">
        {container
          ? "Il prossimo deploy ricostruisce l'app dal codice: quello che cambi qui sparisce, tranne nelle cartelle montate (Impostazioni › Risorse)."
          : "Il prossimo deploy rimette i file come sono nel repository o nello ZIP: per una modifica che resti, cambiala nel codice."}
      </Hint>
      <FileManager projectId={projectId} runtimeType={runtimeType} />
    </div>
  );
}
