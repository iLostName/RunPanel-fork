"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { DangerZone } from "@/components/ui/DangerAction";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { LinkedServiceDelete, type LinkedServiceRow } from "../LinkedServiceDelete";
import type { Project } from "../types";

/**
 * The two irreversible actions, together and last.
 *
 * Deleting the project used to take its databases with it, volumes included.
 * The linked services are listed here, each deletable on its own, and going
 * with the project is an opt-in box: "I no longer need this app" and "I no
 * longer need this data" are different sentences. The project's own name has
 * to be typed to delete it.
 */
export function DangerSection({ project }: { project: Project }) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const [deleteServices, setDeleteServices] = useState(false);

  const { data: servicesData, refresh: refreshServices } = useResource<LinkedServiceRow[]>(api("/api/services"));
  const linkedServices = useMemo(
    () => (Array.isArray(servicesData) ? servicesData : []).filter((s) => s.project_id === project.id),
    [servicesData, project.id]
  );

  return (
    <div className="space-y-4">
      <DangerZone
        title="Rimuovi l'app"
        description="Il progetto e i suoi database restano"
        actionLabel="Rimuovi app"
        confirm={{
          title: "Rimuovere l'app?",
          confirmLabel: "Rimuovi",
          description:
            "Processo, file, immagini Docker e cronologia dei deploy verranno eliminati. Il progetto e i suoi database restano.",
        }}
        onConfirm={async () => {
          const res = await fetch(api(`/api/projects/${project.id}/app`), { method: "DELETE" });
          if (res.ok) {
            toast.success("App rimossa");
            router.push(href("/home"));
          } else {
            toast.error(MSG.removeFailed);
          }
        }}
      />

      <DangerZone
        title="Elimina il progetto"
        description={linkedServices.length > 0 ? "I database collegati restano, se non li includi" : "Processi, file, immagini e cronologia dei deploy"}
        actionLabel="Elimina progetto"
        confirm={{
          title: `Eliminare ${project.name}?`,
          confirmLabel: deleteServices ? "Elimina tutto" : "Elimina progetto",
          confirmText: project.name,
          description: deleteServices
            ? "Processi, container, immagini e cronologia verranno eliminati, insieme ai database collegati e ai loro dati. I dati non sono recuperabili."
            : linkedServices.length > 0
              ? "Processi, file, immagini e cronologia verranno eliminati. I database collegati restano, con i loro dati."
              : "Processi, file, immagini e cronologia dei deploy verranno eliminati.",
        }}
        onConfirm={async () => {
          const res = await fetch(api(`/api/projects/${project.id}${deleteServices ? "?services=delete" : ""}`), { method: "DELETE" });
          if (res.ok) {
            toast.success("Progetto eliminato");
            router.push(href("/home"));
          } else {
            toast.error(MSG.deleteFailed);
          }
        }}
      >
        {linkedServices.length > 0 && (
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {linkedServices.map((service) => (
                <LinkedServiceDelete key={service.id} service={service} onDeleted={refreshServices} />
              ))}
            </ul>
            <CheckboxField
              isSelected={deleteServices}
              onChange={setDeleteServices}
              label={
                <span className="text-muted text-xs leading-relaxed">
                  Elimina anche {linkedServices.length === 1 ? "il database collegato" : `i ${linkedServices.length} database collegati`}{" "}
                  e i loro dati. <strong className="text-foreground">Non è recuperabile.</strong> Senza la spunta restano come
                  database autonomi, con i loro volumi.
                </span>
              }
            />
          </div>
        )}
      </DangerZone>
    </div>
  );
}
