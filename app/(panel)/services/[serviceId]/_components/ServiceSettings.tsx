"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { DangerZone } from "@/components/ui/DangerAction";
import type { LogLine } from "@/components/ui/LogViewer";
import { ScheduledRestart } from "@/components/ScheduledRestart";
import { AccessPanel } from "@/components/users/AccessPanel";
import type { MountApply } from "@/lib/hooks/useServiceStream";
import { serviceDisplayName } from "@/lib/service-name";
import { useNodeApi } from "@/lib/hooks/useNode";
import { MountsPanel } from "./MountsPanel";
import type { Service } from "./types";

/**
 * The database's settings: when it restarts, what is mounted in it, who may
 * use it, and deleting it — the irreversible part last, with its name to type.
 */
export function ServiceSettings({
  service,
  apply,
  applyLines,
  applyProgress,
  onChanged,
  onDeleted,
}: {
  service: Service;
  apply: MountApply | null;
  applyLines: LogLine[];
  applyProgress: { copiedKb: number; totalKb: number | null } | null;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const api = useNodeApi();
  const [deleteData, setDeleteData] = useState(false);
  const canManage = (service.permission?.level ?? "manage") === "manage";

  return (
    <div className="space-y-4">
      <ScheduledRestart
        kind="service"
        id={service.id}
        cron={service.restart_cron ?? ""}
        nextAt={service.restart_next_at}
        lastAt={service.restart_last_at}
        lastResult={service.restart_last_result}
        onSaved={onChanged}
      />

      <MountsPanel service={service} apply={apply} lines={applyLines} progress={applyProgress} onApplied={onChanged} />

      <AccessPanel kind="service" id={service.id} />

      {canManage && (
        // Deleting the data is opt-in: the volume survives the container
        // unless the box is ticked, and a service recreated with the same name
        // finds it again.
        <DangerZone
          title="Elimina il database"
          description="Il container viene rimosso subito"
          actionLabel="Elimina database"
          confirm={{
            title: `Eliminare "${serviceDisplayName(service)}"?`,
            confirmLabel: deleteData ? "Elimina con i dati" : "Elimina",
            confirmText: deleteData ? serviceDisplayName(service) : undefined,
            description: deleteData
              ? "Il container e il volume con i dati vengono eliminati. I dati non sono recuperabili."
              : "Il container viene eliminato. Il volume con i dati resta, e un database ricreato con lo stesso nome lo ritrova.",
          }}
          onConfirm={async () => {
            const res = await fetch(api(`/api/services/${service.id}${deleteData ? "?deleteData=true" : ""}`), { method: "DELETE" });
            if (res.ok) {
              toast.success("Database eliminato");
              onDeleted();
            } else {
              toast.error("Eliminazione non riuscita");
            }
          }}
        >
          <CheckboxField
            isSelected={deleteData}
            onChange={setDeleteData}
            label={
              <span className="text-muted text-xs leading-relaxed">
                Elimina anche il volume con i dati. <strong className="text-foreground">Non è recuperabile.</strong> Senza la
                spunta resta lì, e un database ricreato con lo stesso nome li ritrova.
              </span>
            }
          />
        </DangerZone>
      )}
    </div>
  );
}
