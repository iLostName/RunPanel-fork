"use client";

import { useCallback, useState } from "react";
import { Button } from "@heroui/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint } from "@/components/ui/Hint";
import { FileManager } from "./FileManager";

/**
 * The project's files, in a tab of their own.
 *
 * They used to sit under the logs, where an edit looked as permanent as the
 * log above it. It is not: the next deploy puts the files back as the source
 * has them, so the tab says so before anyone edits a config file by hand and
 * loses it on Friday's deploy.
 *
 * Before the first deploy there is nothing to show, and the tab says that in
 * its own words, where it used to print the server's English error. The
 * warning goes too: there is nothing to edit that a deploy could undo.
 */
export function FilesTab({
  projectId,
  runtimeType,
  onGoToOverview,
}: {
  projectId: string;
  runtimeType: string;
  /** Where the first deploy starts: the empty state's one action. */
  onGoToOverview: () => void;
}) {
  const container = runtimeType === "docker" || runtimeType === "compose";
  const [noFiles, setNoFiles] = useState(false);
  // Stable, so the listing is not asked for again at every render of the tab.
  const markNoFiles = useCallback(() => setNoFiles(true), []);

  if (noFiles) {
    return (
      <EmptyState
        icon="solar:folder-with-files-linear"
        title="Non ci sono ancora file"
        description="Arriveranno con il primo deploy: da qui potrai sfogliarli e modificarli."
        action={
          <Button size="sm" variant="secondary" onPress={onGoToOverview}>
            Vai alla panoramica
          </Button>
        }
        className="border-border rounded-[var(--radius)] border border-dashed"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Hint tone="warn" title="Le modifiche fatte qui non sono per sempre">
        {container
          ? "Il prossimo deploy ricostruisce l'app dal codice: quello che cambi qui sparisce, tranne nelle cartelle montate (Impostazioni › Risorse)."
          : "Il prossimo deploy rimette i file come sono nel repository o nello ZIP: per una modifica che resti, cambiala nel codice."}
      </Hint>
      <FileManager projectId={projectId} runtimeType={runtimeType} onNoFiles={markNoFiles} />
    </div>
  );
}
