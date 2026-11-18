"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { useUrlTab } from "@/lib/hooks/useUrlTab";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useLineBuffer } from "@/lib/hooks/useLineBuffer";
import { useServiceStream, type ConsoleMode, type MountApply } from "@/lib/hooks/useServiceStream";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/LinkButton";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import type { LogLine } from "@/components/ui/LogViewer";
import { ResourceHeader } from "@/components/resource/ResourceHeader";
import { serviceLabel } from "@/lib/service-env";
import { ConnectionPanel } from "./_components/ConnectionPanel";
import { ConsolePanel } from "./_components/ConsolePanel";
import { DatabasesPanel } from "./_components/DatabasesPanel";
import { ServiceOverview } from "./_components/ServiceOverview";
import { ServiceSettings } from "./_components/ServiceSettings";
import type { Credentials, From, Service, ServiceTabId } from "./_components/types";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { serviceControlText } from "@/lib/status";
import { locateMember } from "@/lib/locate-member";

/**
 * A database: the same header as a project, and the same order of tabs —
 * Panoramica first, the settings and the delete last.
 *
 * Every tab stays mounted and is only hidden. The console holds a live
 * `docker exec` session whose server side outlives the component by ten
 * minutes; unmounting it on a tab switch would lose its transcript, and two
 * mounted copies would be two sessions.
 */

const TABS: readonly TabItem<ServiceTabId>[] = [
  { id: "overview", label: "Panoramica", icon: "solar:widget-2-linear" },
  { id: "connection", label: "Connessione", icon: "solar:link-circle-linear" },
  { id: "console", label: "Console", icon: "solar:monitor-linear" },
  { id: "databases", label: "Database interni", icon: "solar:database-linear" },
  { id: "backup", label: "Backup", icon: "solar:safe-square-linear" },
  { id: "settings", label: "Impostazioni", icon: "solar:settings-linear" },
];

const TAB_IDS = TABS.map((tab) => tab.id);

/** Same cap as the project page's transcript, for the same burst of output. */
const MAX_CONSOLE_LINES = 2000;

let lineId = 0;
const toLine = (text: string): LogLine => ({ id: lineId++, text });

export default function ServiceDetailPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const { isSolo, selected } = useNode();
  const poll5000 = usePollInterval(5000);
  const params = useParams();
  const router = useRouter();
  const serviceId = params.serviceId as string;

  const { data: service, loading, error: loadError, refresh } = useResource<Service>(api(`/api/services/${serviceId}`), {
    intervalMs: poll5000,
  });
  useCrumbLabel(serviceId, service?.display_name || service?.name);

  // In a cluster a 404 may only mean the link was made on another server:
  // follow the service there. Solo mode keeps the plain "non trovato" page.
  const notFound = !service && Boolean(loadError?.includes("404"));
  useEffect(() => {
    if (isSolo || !notFound) return;
    let cancelled = false;
    void locateMember("service", serviceId).then((memberId) => {
      if (cancelled || !memberId || memberId === selected) return;
      const tabNow = new URLSearchParams(window.location.search).get("tab");
      const tab = tabNow ? `?tab=${encodeURIComponent(tabNow)}` : "";
      router.replace(href(`/services/${serviceId}${tab}`, memberId));
    });
    return () => {
      cancelled = true;
    };
  }, [isSolo, notFound, serviceId, selected, href, router]);

  const [creds, setCreds] = useState<Credentials | null>(null);
  // Null until chosen, so the default can depend on data not loaded yet.
  const [fromChoice, setFromChoice] = useState<From | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [activeTab, setActiveTab] = useUrlTab(TAB_IDS, "overview");

  // The project the service belongs to, if any: without one nothing is
  // injected anywhere, and that is worth saying.
  const { data: project } = useResource<{ id: string; name: string }>(
    service?.project_id ? api(`/api/projects/${service.project_id}`) : null
  );

  const [consoleMode, setConsoleMode] = useState<ConsoleMode>("engine");
  const [consoleActive, setConsoleActive] = useState(false);
  const consoleLines = useLineBuffer<LogLine>(MAX_CONSOLE_LINES);

  /**
   * What is left of a chunk that did not end on a newline: `proc.stdout` is
   * not line-aligned and `LogViewer` renders one row per line.
   */
  const carry = useRef("");
  const pushOutput = useCallback(
    (text: string) => {
      carry.current += text;
      const parts = carry.current.split("\n");
      carry.current = parts.pop() ?? "";
      for (const part of parts) consoleLines.push(toLine(part));
    },
    [consoleLines]
  );
  const flushCarry = useCallback(() => {
    if (!carry.current) return;
    consoleLines.push(toLine(carry.current));
    carry.current = "";
  }, [consoleLines]);

  const applyLines = useLineBuffer<LogLine>(MAX_CONSOLE_LINES);
  const [apply, setApply] = useState<MountApply | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ copiedKb: number; totalKb: number | null } | null>(null);

  useServiceStream(serviceId, (event) => {
    switch (event.type) {
      case "ready":
        setConsoleActive(Boolean(event.console?.active));
        if (event.console) setConsoleMode(event.console.mode);
        setApply(event.apply);
        break;
      case "console:output":
        pushOutput(event.text);
        break;
      case "console:closed":
        flushCarry();
        setConsoleActive(false);
        break;
      case "mount:log":
        applyLines.push(toLine(event.line));
        break;
      case "mount:phase":
        setApply((prev) => (prev ? { ...prev, phase: event.phase, error: event.error } : prev));
        if (event.phase === "done" || event.phase === "failed") {
          setApplyProgress(null);
          refresh();
        }
        break;
      case "mount:progress":
        setApplyProgress({ copiedKb: event.copiedKb, totalKb: event.totalKb });
        break;
    }
  });

  const handleModeChange = useCallback(
    (next: ConsoleMode) => {
      // One session at a time, and its transcript belongs to the mode that made it.
      if (consoleActive) {
        void fetch(api(`/api/services/${serviceId}/console`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      }
      setConsoleActive(false);
      carry.current = "";
      consoleLines.reset();
      setConsoleMode(next);
    },
    [api, consoleActive, consoleLines, serviceId]
  );

  const echo = useCallback((text: string) => consoleLines.push(toLine(text.trimEnd())), [consoleLines]);

  async function revealCredentials() {
    const res = await fetch(api(`/api/services/${serviceId}?reveal=true`));
    if (!res.ok) {
      toast.error("Impossibile leggere le credenziali");
      return;
    }
    const data = await res.json();
    try {
      setCreds(JSON.parse(data.credentials));
    } catch {
      toast.error("Credenziali illeggibili");
    }
  }

  async function handleControl(action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(api(`/api/services/${serviceId}/control`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast.error(body.error ?? serviceControlText(action).failed);
        return;
      }
      toast.success(serviceControlText(action).done);
      refresh();
    } catch {
      toast.error(serviceControlText(action).failed);
    }
  }

  /** The name the panel shows. The technical one is in the volume's name and never changes. */
  async function rename(next: string): Promise<boolean> {
    const res = await fetch(api(`/api/services/${serviceId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.details?.[0]?.message ?? data.error ?? "Rinomina non riuscita");
      return false;
    }
    toast.success("Database rinominato");
    await refresh();
    return true;
  }

  if (loading && !service) return <PageSkeleton />;

  // Only a 404 means it is gone. Anything else must not invite the operator
  // to recreate a service that still exists.
  if (!service && loadError && !loadError.includes("404")) {
    return (
      <>
        <PageHeader title="Database" back={{ href: href("/services"), label: "Torna ai database" }} />
        <LoadError what="il database" error={loadError} onRetry={() => void refresh()} />
      </>
    );
  }

  if (!service) {
    return (
      <>
        <PageHeader title="Database" back={{ href: href("/services"), label: "Torna ai database" }} />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Database non trovato"
            description="È stato eliminato, oppure il link non è più valido."
            action={
              <Link href={href("/services")} className="text-accent text-sm hover:underline">
                Torna ai database
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  const running = service.status === "running";
  const label = serviceLabel(service.type);
  // The line that is actually needed by default: the container name only if
  // the project's app reaches it that way, otherwise the host.
  const from: From =
    fromChoice ?? (service.injection?.from === "container" ? "network" : service.project_id ? "host" : "container");
  const canManage = (service.permission?.level ?? "manage") === "manage";
  const canOperate = service.permission?.level !== "read";
  const shown = (id: ServiceTabId) => ({ hidden: activeTab !== id });

  return (
    <>
      <ResourceHeader
        backHref={href("/services")}
        backLabel="Torna ai database"
        name={service.displayName}
        onRename={canManage ? rename : undefined}
        status={service.status}
        meta={
          <>
            <span>
              {label} {service.version}
            </span>
            <span aria-hidden>·</span>
            <span>porta {service.port}</span>
            {project && (
              <>
                <span aria-hidden>·</span>
                <Link href={href(`/projects/${project.id}`)} className="text-accent hover:underline">
                  {project.name}
                </Link>
              </>
            )}
          </>
        }
        actions={
          canOperate ? (
            running ? (
              <>
                <Button variant="outline" size="sm" onPress={() => handleControl("restart")}>
                  <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                  Riavvia
                </Button>
                <Button variant="outline" size="sm" onPress={() => setStopOpen(true)}>
                  <Icon icon="solar:stop-linear" width={16} aria-hidden />
                  Ferma
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onPress={() => handleControl("start")}>
                <Icon icon="solar:play-linear" width={16} aria-hidden />
                Avvia
              </Button>
            )
          ) : undefined
        }
        menu={
          canManage
            ? [{ id: "delete", label: "Elimina il database", icon: "solar:trash-bin-minimalistic-linear", danger: true, onAction: () => setActiveTab("settings") }]
            : []
        }
        menuLabel="Altre azioni sul database"
      />

      {service.pendingContainerName && (
        <Hint tone="info" title="Nome del container in attesa del prossimo deploy" className="mb-4">
          Al prossimo deploy di <Code>{service.projectSlug}</Code> il container <Code>{service.containerName}</Code> diventa{" "}
          <Code>{service.pendingContainerName}</Code>, e l&apos;app riceve il nuovo host. Il database si riavvia per qualche
          secondo; i dati restano nel volume, e il vecchio nome continua a funzionare come alias.
        </Hint>
      )}
      {service.display_name && !service.projectSlug && service.display_name !== service.name && (
        <FieldHint className="mb-4">
          Il container resta <Code>{service.containerName}</Code>: prende il nome nuovo al deploy del progetto a cui è
          collegato, e questo database non è collegato a nessuno.
        </FieldHint>
      )}

      <Tabs tabs={TABS} value={activeTab} onChange={setActiveTab} label="Sezioni del database" />

      <div className="max-w-4xl">
        <div {...shown("overview")}>
          <ServiceOverview service={service} project={project ?? null} onControl={(a) => void handleControl(a)} onGoTo={setActiveTab} />
        </div>
        <div {...shown("connection")}>
          <ConnectionPanel
            service={service}
            project={project ?? null}
            creds={creds}
            from={from}
            onFromChange={setFromChoice}
            onReveal={revealCredentials}
            onSaved={refresh}
          />
        </div>
        <div {...shown("console")}>
          <ConsolePanel
            serviceId={serviceId}
            running={running}
            mode={consoleMode}
            onModeChange={handleModeChange}
            active={consoleActive}
            onActiveChange={setConsoleActive}
            lines={consoleLines.lines}
            onLocalEcho={echo}
          />
        </div>
        <div {...shown("databases")}>
          <DatabasesPanel
            serviceId={service.id}
            type={service.type}
            // The same host the paste-ready line uses, following the chosen viewpoint.
            host={from === "network" ? service.containerName : from === "container" ? "host.docker.internal" : "localhost"}
            port={from === "network" ? service.internalPort : service.port}
            envKey={service.envKey}
            credentials={creds}
          />
        </div>
        <div {...shown("backup")}>
          <Panel className="space-y-3">
            <PanelHeader title="Backup" description="Copie dei dati, pianificate o al volo" />
            <p className="text-muted text-sm">
              I backup si pianificano in Backup: il preset notturno include già tutti i database, e puoi farne uno subito
              quando vuoi.
            </p>
            <LinkButton href={href("/backups")} variant="secondary">
              Apri i backup
            </LinkButton>
          </Panel>
        </div>
        <div {...shown("settings")}>
          <ServiceSettings
            service={service}
            apply={apply ?? service.mountApply}
            applyLines={applyLines.lines}
            applyProgress={applyProgress}
            onChanged={() => void refresh()}
            onDeleted={() => router.push(href("/services"))}
          />
        </div>
      </div>

      <ConfirmDialog
        isOpen={stopOpen}
        onOpenChange={setStopOpen}
        title={`Fermare ${service.displayName}?`}
        description={project ? `${project.name} non lo raggiunge più finché non lo riavvii. I dati restano.` : "Le app che lo usano non lo raggiungono più finché non lo riavvii. I dati restano."}
        confirmLabel="Ferma"
        destructive
        onConfirm={() => handleControl("stop")}
      />
    </>
  );
}
