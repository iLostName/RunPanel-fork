"use client";

import { memo, useMemo } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Hint } from "@/components/ui/Hint";
import { StatTile } from "@/components/ui/StatTile";
import { StatusBadge } from "@/components/StatusBadge";
import { LinkButton } from "@/components/ui/LinkButton";
import { LiveDeploy } from "@/components/deploy/LiveDeploy";
import { Technical } from "@/components/ui/Technical";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatBytes, formatDurationBetween, formatRelative, formatUptime } from "@/lib/format";
import { engineLabel } from "@/lib/labels";
import { connectionEnvKey } from "@/lib/service-env";
import { deploymentActive, deploymentSucceeded, explainDeployError, type DeployFix } from "@/lib/deploy-explain";
import { parseContractJson } from "@/lib/deploy-contract";
import { cn } from "@/lib/utils";
import { projectHasSource } from "./project-facts";
import type { ProcessInfo, Project, SettingsSectionId, TabId } from "./types";

interface LinkedService {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  status: string;
  project_id: string | null;
  env_key: string | null;
  inject_env: number | null;
  created_at: string;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "a mano",
  webhook: "da un push",
  poll: "da un push (controllo periodico)",
};

/** Where each kind of fix lives in the settings menu. */
const FIX_SECTION: Partial<Record<DeployFix, SettingsSectionId>> = {
  source: "source",
  runtime: "build",
  memory: "resources",
  healthcheck: "build",
  port: "network",
};

const FIX_LABEL: Record<DeployFix, string> = {
  source: "Cambia la sorgente",
  runtime: "Apri Build e avvio",
  memory: "Dai più memoria",
  healthcheck: "Controllo di salute",
  port: "Cambia la porta",
  env: "Apri le variabili",
  github: "Collega GitHub",
  logs: "Vedi il log",
};

/**
 * The project at a glance: how it is, and the next thing to do.
 *
 * Opens by default. It leads with one sentence about the state and the button
 * that moves it forward (choose a source, deploy, fix what broke, start it
 * again), then the facts people come back for: the last deploy, what it uses,
 * where it answers, which databases it has.
 */
export const ProjectOverview = memo(function ProjectOverview({
  project,
  processInfo,
  busy,
  onDeploy,
  onControl,
  onGoTo,
}: {
  project: Project;
  processInfo: ProcessInfo | null;
  busy: boolean;
  onDeploy: (mode: "deploy" | "rebuild") => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onGoTo: (tab: TabId, section?: SettingsSectionId) => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const canOperate = project.permission?.level !== "read";
  const canManage = (project.permission?.level ?? "manage") === "manage";
  const last = project.last_deployment ?? null;
  const hasSource = projectHasSource(project);
  const contract = useMemo(() => parseContractJson(project.builder_config), [project.builder_config]);

  const { data: servicesData } = useResource<LinkedService[]>(api("/api/services"));
  const linked = useMemo(
    () => (Array.isArray(servicesData) ? servicesData : []).filter((s) => s.project_id === project.id),
    [servicesData, project.id]
  );
  // A database added after the last deploy is not in the app's environment
  // yet: its URL is injected at deploy time.
  const waitingForDeploy = linked.filter(
    (s) => s.inject_env !== 0 && (!project.last_deploy_at || s.created_at > project.last_deploy_at)
  );

  const fixButtons = (fixes: DeployFix[]) =>
    fixes.map((fix) =>
      fix === "logs" ? (
        <Button key={fix} variant="secondary" size="sm" onPress={() => onGoTo("deployments")}>
          {FIX_LABEL.logs}
        </Button>
      ) : fix === "env" ? (
        <Button key={fix} variant="secondary" size="sm" onPress={() => onGoTo("env")}>
          {FIX_LABEL.env}
        </Button>
      ) : fix === "github" ? (
        <LinkButton key={fix} href={href("/github")} variant="secondary">
          {FIX_LABEL.github}
        </LinkButton>
      ) : canManage && FIX_SECTION[fix] ? (
        <Button key={fix} variant="secondary" size="sm" onPress={() => onGoTo("settings", FIX_SECTION[fix])}>
          {FIX_LABEL[fix]}
        </Button>
      ) : null
    );

  // --- the verdict ---------------------------------------------------------------
  let verdict: { tone: "ok" | "busy" | "warn" | "danger" | "idle"; title: string; text: string; actions?: React.ReactNode };
  if (project.status === "deploying" || (last && deploymentActive(last.status))) {
    verdict = { tone: "busy", title: "Deploy in corso", text: "La nuova versione si sta preparando: quella attuale, se c'è, resta online fino alla fine." };
  } else if (!hasSource) {
    verdict = {
      tone: "idle",
      title: "Manca il codice",
      text: "Collega un repository GitHub o carica uno ZIP: poi basta premere Deploy.",
      actions: canManage ? (
        <Button variant="primary" size="sm" onPress={() => onGoTo("settings", "source")}>
          Scegli la sorgente
        </Button>
      ) : undefined,
    };
  } else if (!last) {
    verdict = {
      tone: "idle",
      title: "Pronto per il primo deploy",
      text: "Il codice c'è: il primo deploy lo installa, lo compila e lo avvia.",
      actions: canOperate ? (
        <Button variant="primary" size="sm" isPending={busy} onPress={() => onDeploy("deploy")}>
          Fai il primo deploy
        </Button>
      ) : undefined,
    };
  } else if (last.status === "failed") {
    const explanation = explainDeployError(last.error_message);
    verdict = {
      tone: "danger",
      title: `Ultimo deploy non riuscito: ${explanation.title.charAt(0).toLowerCase()}${explanation.title.slice(1)}`,
      text: `${explanation.hint}${project.last_success_at ? " Intanto resta online la versione precedente, se era attiva." : ""}`,
      actions: canOperate ? (
        <>
          {fixButtons(explanation.fixes)}
          <Button variant="secondary" size="sm" isPending={busy} onPress={() => onDeploy("deploy")}>
            Riprova il deploy
          </Button>
        </>
      ) : undefined,
    };
  } else if (project.status === "error") {
    verdict = {
      tone: "danger",
      title: "L'app si è fermata da sola",
      text: "Il processo è terminato con un errore: il log dice perché. Riavviarla rimette su l'ultima versione riuscita.",
      actions: canOperate ? (
        <>
          <Button variant="secondary" size="sm" onPress={() => onGoTo("logs")}>
            Vedi il log
          </Button>
          <Button variant="secondary" size="sm" onPress={() => onControl("restart")}>
            Riavvia
          </Button>
        </>
      ) : undefined,
    };
  } else if (project.status === "stopped") {
    verdict = {
      tone: "warn",
      title: "Ferma",
      text: "L'app non è in esecuzione. Avviarla rimette su l'ultima versione riuscita.",
      actions:
        canOperate && project.last_success_at ? (
          <Button variant="secondary" size="sm" onPress={() => onControl("start")}>
            Avvia
          </Button>
        ) : undefined,
    };
  } else {
    const host = project.hosts?.[0];
    verdict = {
      tone: "ok",
      title: "Online",
      text: processInfo?.uptime
        ? `In esecuzione da ${formatUptime(processInfo.uptime)}${host ? `, su ${host.hostname}` : ""}.`
        : host
          ? `In esecuzione su ${host.hostname}.`
          : "In esecuzione.",
    };
  }

  const toneIcon = {
    ok: { icon: "solar:check-circle-bold", className: "text-success" },
    busy: { icon: "solar:refresh-linear", className: "text-accent motion-safe:animate-spin" },
    warn: { icon: "solar:pause-circle-linear", className: "text-warning" },
    danger: { icon: "solar:danger-triangle-bold", className: "text-danger" },
    idle: { icon: "solar:rocket-2-linear", className: "text-muted" },
  }[verdict.tone];

  // --- the checklist -----------------------------------------------------------------
  const checklist: { done: boolean; label: string; action?: () => void }[] = [
    { done: hasSource, label: "Codice collegato", action: canManage ? () => onGoTo("settings", "source") : undefined },
    { done: Boolean(project.last_success_at), label: "Primo deploy riuscito", action: canOperate && hasSource ? () => onDeploy("deploy") : undefined },
    ...(project.port
      ? [{ done: (project.hosts ?? []).length > 0, label: "Un indirizzo con HTTPS", action: canManage ? () => onGoTo("settings", "addresses") : undefined }]
      : []),
    ...(project.source_type === "github"
      ? [{ done: Boolean(project.auto_deploy), label: "Aggiornamento a ogni push", action: canManage ? () => onGoTo("settings", "automations") : undefined }]
      : []),
  ];
  const checklistDone = checklist.every((item) => item.done);

  return (
    <div className="space-y-4">
      <Panel
        className={cn(
          "space-y-3",
          verdict.tone === "danger" && "border-danger/35",
          verdict.tone === "ok" && "border-success/30"
        )}
      >
        <div className="flex items-start gap-3">
          <Icon icon={toneIcon.icon} width={24} className={cn("mt-0.5 shrink-0", toneIcon.className)} aria-hidden />
          <div className="min-w-0 space-y-1">
            <h2 className="text-foreground text-lg font-medium">{verdict.title}</h2>
            <p className="text-muted text-sm">{verdict.text}</p>
          </div>
        </div>
        {verdict.actions && <div className="flex flex-wrap gap-2 pl-9">{verdict.actions}</div>}
        {last && deploymentActive(last.status) && (
          <div className="pl-9">
            <LiveDeploy key={last.id} deploymentId={last.id} showLog={false} />
            <Button variant="ghost" size="sm" className="mt-2" onPress={() => onGoTo("deployments")}>
              Segui il log
            </Button>
          </div>
        )}
      </Panel>

      {waitingForDeploy.length > 0 && canOperate && (
        <Hint tone="tip" icon="solar:database-linear" title="Un database aspetta il prossimo deploy">
          <p>
            {waitingForDeploy.map((s) => s.display_name || s.name).join(", ")}: il suo indirizzo arriva all&apos;app al
            prossimo deploy.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" isPending={busy} onPress={() => onDeploy("deploy")}>
            Ridistribuisci ora
          </Button>
        </Hint>
      )}

      {processInfo?.running && (
        <div className="grid grid-cols-3 gap-3">
          <StatTile icon="solar:clock-circle-linear" label="Attiva da" value={formatUptime(processInfo.uptime)} />
          <StatTile icon="solar:server-linear" label="Memoria" value={formatBytes(processInfo.memory)} />
          <StatTile
            icon="solar:cpu-linear"
            label="CPU"
            value={processInfo.cpu != null ? `${processInfo.cpu}%` : "—"}
            percent={processInfo.cpu ?? undefined}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="space-y-3">
          <PanelHeader
            title="Ultimo deploy"
            actions={
              last ? (
                <Button variant="ghost" size="sm" onPress={() => onGoTo("deployments")}>
                  Tutti i deploy
                </Button>
              ) : undefined
            }
          />
          {last ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={last.status} />
                <span className="text-foreground min-w-0 truncate">
                  {last.commit_message || (deploymentSucceeded(last.status) ? "Deploy riuscito" : "Deploy")}
                </span>
              </div>
              <p className="text-muted">
                {formatRelative(last.started_at)}
                {TRIGGER_LABEL[last.trigger_type] ? `, ${TRIGGER_LABEL[last.trigger_type]}` : ""}
                {last.finished_at && ` · durata ${formatDurationBetween(last.started_at, last.finished_at)}`}
                {last.commit_sha && (
                  <>
                    {" · "}
                    <span className="font-mono">{last.commit_sha.slice(0, 7)}</span>
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="text-muted text-sm">Ancora nessun deploy.</p>
          )}
        </Panel>

        <Panel className="space-y-3">
          <PanelHeader
            title="Indirizzi"
            actions={
              canManage && project.port ? (
                <Button variant="ghost" size="sm" onPress={() => onGoTo("settings", "addresses")}>
                  {(project.hosts ?? []).length > 0 ? "Gestisci" : "Aggiungi"}
                </Button>
              ) : undefined
            }
          />
          {(project.hosts ?? []).length > 0 ? (
            <ul className="space-y-1.5">
              {(project.hosts ?? []).map((host) => (
                <li key={host.hostname} className="flex items-center gap-2 text-sm">
                  <Icon
                    icon={host.url.startsWith("https") ? "solar:lock-keyhole-minimalistic-linear" : "solar:global-linear"}
                    width={15}
                    className={host.url.startsWith("https") ? "text-success" : "text-muted"}
                    aria-label={host.url.startsWith("https") ? "HTTPS attivo" : "Senza HTTPS"}
                  />
                  <a href={host.url} target="_blank" rel="noreferrer" className="text-accent truncate font-mono hover:underline">
                    {host.hostname}
                  </a>
                  {host.locked && <span className="text-muted text-xs">con password</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">
              {project.port ? "Nessun indirizzo: l'app risponde solo sulla sua porta." : "Senza una porta non c'è un indirizzo da dare."}
              <Technical>{project.port ? ` Porta ${project.port}.` : ""}</Technical>
            </p>
          )}
        </Panel>

        <Panel className="space-y-3">
          <PanelHeader
            title="Database collegati"
            actions={
              canOperate ? (
                <LinkButton href={href(`/services/new?projectId=${project.id}`)} variant="ghost">
                  Aggiungi
                </LinkButton>
              ) : undefined
            }
          />
          {linked.length > 0 ? (
            <ul className="space-y-2">
              {linked.map((service) => (
                <li key={service.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={service.status} variant="dot" />
                  <Link href={href(`/services/${service.id}`)} className="text-foreground hover:text-accent truncate">
                    {service.display_name || service.name}
                  </Link>
                  <span className="text-muted">{engineLabel(service.type)}</span>
                  {service.inject_env !== 0 && (
                    <span className="text-muted font-mono text-xs">{service.env_key || connectionEnvKey(service.type)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">
              Nessuno. Un database aggiunto qui arriva all&apos;app come variabile, senza password da copiare.
            </p>
          )}
        </Panel>

        <Panel className="space-y-3">
          <PanelHeader
            title={checklistDone ? "Tutto a posto" : "Da completare"}
            description={checklistDone ? undefined : "Le cose che rendono il progetto affidabile"}
          />
          <ul className="space-y-1.5">
            {checklist.map((item) => (
              <li key={item.label} className="flex items-center gap-2 text-sm">
                <Icon
                  icon={item.done ? "solar:check-circle-bold" : "solar:record-circle-linear"}
                  width={16}
                  className={item.done ? "text-success shrink-0" : "text-muted shrink-0"}
                  aria-hidden
                />
                {item.done || !item.action ? (
                  <span className={item.done ? "text-foreground" : "text-muted"}>{item.label}</span>
                ) : (
                  <button type="button" onClick={item.action} className="text-accent text-left hover:underline">
                    {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {project.source_type === "github" && project.auto_deploy ? (
            <p className="text-muted text-xs">
              Si aggiorna a ogni push su <span className="font-mono">{project.source_branch}</span>
              {project.deploy_trigger === "poll" ? ", con un controllo periodico." : "."}
              {contract.healthcheck.enabled ? "" : " Controllo di salute spento."}
            </p>
          ) : null}
        </Panel>
      </div>
    </div>
  );
});
