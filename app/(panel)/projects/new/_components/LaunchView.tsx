"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Hint } from "@/components/ui/Hint";
import { LinkButton } from "@/components/ui/LinkButton";
import { LiveDeploy } from "@/components/deploy/LiveDeploy";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useServerHref } from "@/lib/hooks/useNode";
import { LAUNCH_STEP_LABEL } from "@/lib/new-project-plan";
import { deploymentSucceeded, type DeployFix } from "@/lib/deploy-explain";
import type { LaunchProgress, StepState } from "./useLaunch";

/**
 * Step 3: the launch as it happens, then the first deploy live.
 *
 * Every call the wizard makes is a line here, so a failure says exactly which
 * part did not work, and that nothing was left behind when it was undone.
 */
export function LaunchView({
  progress,
  name,
  hostname,
  onBackToForm,
  onRedeploy,
}: {
  progress: LaunchProgress;
  name: string;
  hostname: string | null;
  onBackToForm: () => void;
  onRedeploy: () => Promise<string | null | undefined>;
}) {
  const href = useServerHref();
  const [settled, setSettled] = useState<{ id: string; ok: boolean } | null>(null);
  const [redeploying, setRedeploying] = useState(false);
  const project = progress.project;
  const projectHref = project ? href(`/projects/${project.id}`) : null;
  const outcome = progress.outcome;
  const result = settled && settled.id === progress.deploymentId ? settled : null;

  async function redeploy() {
    setRedeploying(true);
    const error = await onRedeploy();
    setRedeploying(false);
    if (error) toast.error(error);
  }

  function fixButton(fix: DeployFix) {
    if (!project) return null;
    const settingsHref = href(`/projects/${project.id}?tab=settings`);
    switch (fix) {
      case "env":
        return <LinkButton key={fix} href={href(`/projects/${project.id}?tab=env`)} variant="secondary">Apri le variabili</LinkButton>;
      case "github":
        return <LinkButton key={fix} href={href("/github")} variant="secondary">Collega GitHub</LinkButton>;
      case "source":
        return <LinkButton key={fix} href={settingsHref} variant="secondary">Cambia la sorgente</LinkButton>;
      case "port":
        return <LinkButton key={fix} href={settingsHref} variant="secondary">Cambia la porta</LinkButton>;
      case "healthcheck":
        return <LinkButton key={fix} href={settingsHref} variant="secondary">Controllo di salute</LinkButton>;
      case "runtime":
      case "memory":
        return <LinkButton key={fix} href={settingsHref} variant="secondary">Apri Build e avvio</LinkButton>;
      default:
        return null;
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Panel className="space-y-3">
        <PanelHeader title={`Metto online «${name}»`} />
        <ol className="space-y-2" aria-label="Avanzamento">
          {progress.steps.map((step) => (
            <li key={step.id} className="space-y-1">
              <div className={cn("flex items-center gap-2 text-sm", step.state === "todo" ? "text-muted" : "text-foreground")}>
                <StepIcon state={step.state} />
                <span className={cn(step.state === "undone" && "text-muted line-through")}>{LAUNCH_STEP_LABEL[step.id]}</span>
                {step.id === "upload" && step.state === "running" && progress.uploadFraction !== null && (
                  <span className="text-muted tabular-nums">{Math.round(progress.uploadFraction * 100)}%</span>
                )}
              </div>
              {step.id === "upload" && step.state === "running" && progress.uploadFraction !== null && (
                <div className="bg-default ml-6 h-1.5 overflow-hidden rounded-full" role="progressbar" aria-label="Caricamento dello ZIP" aria-valuenow={Math.round(progress.uploadFraction * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="bg-accent h-full transition-[width]" style={{ width: `${progress.uploadFraction * 100}%` }} />
                </div>
              )}
              {step.state === "failed" && step.detail && <p className="text-danger ml-6 text-sm">{step.detail}</p>}
            </li>
          ))}
        </ol>

        {progress.notes.map((text) => (
          <Hint key={text} tone="info">
            {text}
          </Hint>
        ))}

        {outcome?.kind === "undone" && (
          <Hint tone="warn" title="Non è stato creato nulla">
            <p>
              «{LAUNCH_STEP_LABEL[outcome.step]}» non è riuscito, quindi ho tolto quello che avevo già creato: non resta un
              progetto a metà. Correggi e riprova.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onPress={onBackToForm}>
              <Icon icon="solar:alt-arrow-left-linear" width={16} aria-hidden />
              Torna alle impostazioni
            </Button>
          </Hint>
        )}
        {outcome?.kind === "half-done" && projectHref && (
          <Hint tone="warn" title="Il progetto è rimasto a metà">
            <p>
              «{LAUNCH_STEP_LABEL[outcome.step]}» non è riuscito e non sono riuscito a toglierlo. Aprilo per completarlo o
              eliminarlo.
            </p>
            <LinkButton href={projectHref} variant="secondary" className="mt-3">
              Apri il progetto
            </LinkButton>
          </Hint>
        )}
        {(outcome?.kind === "deploy-not-started" || outcome?.kind === "queued") && projectHref && (
          <Hint tone={outcome.kind === "queued" ? "info" : "warn"} title={outcome.kind === "queued" ? "Deploy in coda" : "Il progetto è pronto, il deploy no"}>
            <p>{outcome.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {outcome.kind === "deploy-not-started" && (
                <Button variant="secondary" size="sm" isPending={redeploying} onPress={redeploy}>
                  Riprova il deploy
                </Button>
              )}
              <LinkButton href={projectHref} variant="secondary">
                Apri il progetto
              </LinkButton>
            </div>
          </Hint>
        )}
      </Panel>

      {progress.deploymentId && (
        <Panel className="space-y-4">
          <PanelHeader title="Primo deploy" description="Puoi chiudere la pagina: continua anche senza di te." />
          <LiveDeploy
            key={progress.deploymentId}
            deploymentId={progress.deploymentId}
            onSettled={(deployment) => setSettled({ id: deployment.id, ok: deploymentSucceeded(deployment.status) })}
            renderFixes={(explanation) => (
              <>
                {explanation.fixes.map(fixButton)}
                <Button variant="secondary" size="sm" isPending={redeploying} onPress={redeploy}>
                  Riprova il deploy
                </Button>
              </>
            )}
          />
        </Panel>
      )}

      {result?.ok && projectHref && (
        <Panel className="border-success/30 space-y-3">
          <div className="flex items-center gap-3">
            <Icon icon="solar:check-circle-bold" width={28} className="text-success shrink-0" aria-hidden />
            <div>
              <p className="text-foreground text-lg font-medium">«{name}» è online</p>
              <p className="text-muted text-sm">
                {hostname
                  ? `Risponde su ${hostname}. Il certificato HTTPS può richiedere qualche minuto la prima volta.`
                  : "Puoi dargli un indirizzo dalle impostazioni del progetto, quando vuoi."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={projectHref} variant="primary" size="md">
              Vai al progetto
              <Icon icon="solar:arrow-right-linear" width={16} aria-hidden />
            </LinkButton>
            {hostname && (
              <a
                href={`https://${hostname}`}
                target="_blank"
                rel="noreferrer"
                className="border-border bg-surface hover:bg-surface-hover text-foreground inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-4 py-2 text-sm transition-colors"
              >
                Apri l&apos;app
                <Icon icon="solar:arrow-right-up-linear" width={16} aria-hidden />
              </a>
            )}
          </div>
        </Panel>
      )}

      {result && !result.ok && projectHref && (
        <div className="flex justify-end">
          <LinkButton href={projectHref} variant="secondary">
            Vai al progetto
          </LinkButton>
        </div>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Icon icon="solar:check-circle-bold" width={16} className="text-success shrink-0" aria-label="fatto" />;
    case "failed":
      return <Icon icon="solar:close-circle-bold" width={16} className="text-danger shrink-0" aria-label="non riuscito" />;
    case "running":
      return <Icon icon="solar:refresh-linear" width={16} className="text-accent shrink-0 motion-safe:animate-spin" aria-label="in corso" />;
    case "undone":
      return <Icon icon="solar:undo-left-linear" width={16} className="text-muted shrink-0" aria-label="annullato" />;
    default:
      return <span className="border-border size-4 shrink-0 rounded-full border" aria-hidden />;
  }
}
