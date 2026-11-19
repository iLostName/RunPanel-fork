"use client";

import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { KeyValue } from "@/components/ui/KeyValue";
import { Code } from "@/components/ui/Hint";
import { serviceLabel } from "@/lib/service-env";
import { formatRelative } from "@/lib/format";
import { useServerHref } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";
import type { Service, ServiceTabId } from "./types";

/**
 * The database at a glance: is it up, what is it, who uses it.
 *
 * The project page has had this for a while; the database page opened on
 * connection strings, which answer the second question before the first.
 */
export function ServiceOverview({
  service,
  project,
  onControl,
  onGoTo,
}: {
  service: Service;
  project: { id: string; name: string } | null;
  onControl: (action: "start" | "stop" | "restart") => void;
  onGoTo: (tab: ServiceTabId) => void;
}) {
  const href = useServerHref();
  const canOperate = service.permission?.level !== "read";
  const label = serviceLabel(service.type);

  const verdict =
    service.status === "running"
      ? { icon: "solar:check-circle-bold", tone: "text-success", title: "Attivo", text: `${label} risponde sulla porta ${service.port}.` }
      : service.status === "error"
        ? { icon: "solar:danger-triangle-bold", tone: "text-danger", title: "Si è fermato da solo", text: "Il container è terminato con un errore. Riavviarlo non tocca i dati." }
        : { icon: "solar:pause-circle-linear", tone: "text-warning", title: "Fermo", text: "Le app collegate non lo raggiungono finché non lo avvii. I dati restano nel volume." };

  return (
    <div className="space-y-4">
      <Panel className={cn("space-y-3", service.status === "error" && "border-danger/35", service.status === "running" && "border-success/30")}>
        <div className="flex items-start gap-3">
          <Icon icon={verdict.icon} width={24} className={cn("mt-0.5 shrink-0", verdict.tone)} aria-hidden />
          <div className="min-w-0 space-y-1">
            <h2 className="text-foreground text-lg font-medium">{verdict.title}</h2>
            <p className="text-muted text-sm">{verdict.text}</p>
          </div>
        </div>
        {canOperate && service.status !== "running" && (
          <div className="pl-9">
            <Button variant="primary" size="sm" onPress={() => onControl(service.status === "error" ? "restart" : "start")}>
              {service.status === "error" ? "Riavvia" : "Avvia"}
            </Button>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="space-y-3">
          <PanelHeader title="Chi lo usa" />
          {project ? (
            <p className="text-sm">
              Collegato a{" "}
              <Link href={href(`/projects/${project.id}`)} className="text-accent hover:underline">
                {project.name}
              </Link>
              : l&apos;app riceve <Code>{service.envKey}</Code> a ogni deploy, senza password da copiare.
            </p>
          ) : (
            <p className="text-muted text-sm">
              Non è collegato a un progetto: nessuna app lo riceve da sola. Per usarlo, copia i dati di connessione.
            </p>
          )}
          <Button variant="secondary" size="sm" onPress={() => onGoTo("connection")}>
            Dati di connessione
          </Button>
        </Panel>

        <Panel className="space-y-3">
          <PanelHeader title="Dettagli" />
          <KeyValue
            items={[
              { label: "Motore", value: `${label} ${service.version}` },
              { label: "Porta sul server", value: String(service.port), mono: true },
              { label: "Creato", value: formatRelative(service.created_at) },
              { label: "Container", value: service.containerName, mono: true, technical: true },
              { label: "Porta interna", value: String(service.internalPort), mono: true, technical: true },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onPress={() => onGoTo("databases")}>
              Database interni
            </Button>
            <Button variant="ghost" size="sm" onPress={() => onGoTo("backup")}>
              Backup
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
