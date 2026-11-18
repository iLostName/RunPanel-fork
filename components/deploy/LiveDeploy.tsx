"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { Advanced } from "@/components/ui/Technical";
import { Hint } from "@/components/ui/Hint";
import { formatDurationBetween } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  DEPLOY_PHASES,
  deployPhase,
  deploymentActive,
  deploymentSucceeded,
  explainDeployError,
  type DeployErrorExplanation,
  type DeployPhase,
} from "@/lib/deploy-explain";
import { useNodeApi } from "@/lib/hooks/useNode";

export interface DeploymentView {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  build_log: string | null;
  commit_sha?: string | null;
  commit_message?: string | null;
}

const POLL_MS = 1500;
const TAIL_LINES = 400;

/**
 * A deploy as it happens: where it is, how long it has taken, and its log.
 *
 * Polls the deployment until it settles. Polling rather than a stream because
 * the endpoint already serves the log's tail, a deploy lasts minutes, and a
 * dropped connection then costs one missed refresh instead of a reconnect
 * dance.
 *
 * On failure it leads with what went wrong in words (`lib/deploy-explain.ts`)
 * and the fixes the caller can offer; the raw message stays under "Dettagli".
 */
export function LiveDeploy({
  deploymentId,
  onSettled,
  renderFixes,
  className,
}: {
  deploymentId: string;
  /** Called once, when the deploy stops being active. */
  onSettled?: (deployment: DeploymentView, explanation: DeployErrorExplanation | null) => void;
  /** Buttons for a failed deploy, given its explanation. */
  renderFixes?: (explanation: DeployErrorExplanation) => ReactNode;
  className?: string;
}) {
  const api = useNodeApi();
  const [view, setView] = useState<DeploymentView | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  const active = view ? deploymentActive(view.status) : true;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const res = await fetch(api(`/api/deployments/${deploymentId}?tail=${TAIL_LINES}`), { cache: "no-store" });
        if (stopped) return;
        if (res.ok) {
          const data = (await res.json()) as DeploymentView;
          if (stopped) return;
          setView(data);
          setConnection(null);
          if (!deploymentActive(data.status)) {
            const failed = data.status === "failed";
            settledRef.current?.(data, failed ? explainDeployError(data.error_message, data.build_log) : null);
            return;
          }
        } else {
          setConnection(res.status === 404 ? "Deploy non trovato" : `Il server ha risposto ${res.status}, riprovo…`);
          if (res.status === 404) return;
        }
      } catch {
        if (stopped) return;
        setConnection("Connessione persa, riprovo…");
      }
      timer = setTimeout(tick, POLL_MS);
    }

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, deploymentId]);

  // The elapsed time ticks on its own; the poll only replaces the data.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const phase: DeployPhase = view
    ? deploymentSucceeded(view.status)
      ? "done"
      : view.status === "failed"
        ? "failed"
        : deployPhase(view.build_log)
    : "queued";
  const reached = phaseIndex(view?.build_log ?? "", phase);
  const failed = phase === "failed";
  const explanation = failed && view ? explainDeployError(view.error_message, view.build_log) : null;

  const lines: LogLine[] = useMemo(
    () =>
      (view?.build_log ?? "")
        .split(/\r?\n/)
        .filter((text, i, all) => text !== "" || i < all.length - 1)
        .map((text, id) => ({ id, text })),
    [view?.build_log]
  );

  const elapsed = view
    ? formatDurationBetween(view.started_at, view.finished_at ?? new Date(now).toISOString())
    : null;

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {view ? <StatusBadge status={view.status} /> : <StatusBadge status="pending" />}
        {elapsed && <span className="text-muted text-sm tabular-nums">{elapsed}</span>}
        {view?.commit_sha && (
          <span className="text-muted min-w-0 truncate text-sm">
            <span className="font-mono">{view.commit_sha.slice(0, 7)}</span>
            {view.commit_message ? ` · ${view.commit_message}` : ""}
          </span>
        )}
        {connection && <span className="text-warning text-sm">{connection}</span>}
      </div>

      <ol className="grid gap-2 sm:grid-cols-4" aria-label="Fasi del deploy">
        {DEPLOY_PHASES.map((step, i) => {
          const state =
            phase === "done" || i < reached ? "done" : i === reached ? (failed ? "failed" : "current") : "todo";
          return (
            <li
              key={step.id}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius)] border px-3 py-2 text-sm",
                state === "done" && "border-success/30 text-foreground",
                state === "current" && "border-accent/40 text-foreground",
                state === "failed" && "border-danger/40 text-danger",
                state === "todo" && "border-border text-muted"
              )}
            >
              <PhaseIcon state={state} />
              <span className="min-w-0 truncate">{step.label}</span>
            </li>
          );
        })}
      </ol>

      {explanation && (
        <Hint tone="warn" title={explanation.title}>
          <p>{explanation.hint}</p>
          {renderFixes && <div className="mt-3 flex flex-wrap gap-2">{renderFixes(explanation)}</div>}
          {view?.error_message && (
            <Advanced summary="messaggio originale" title="Dettagli" className="mt-3">
              <pre className="text-danger overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
                {view.error_message}
              </pre>
            </Advanced>
          )}
        </Hint>
      )}

      <LogViewer
        lines={lines}
        ariaLabel="Log del deploy"
        emptyMessage={view ? "Il deploy sta per cominciare…" : "Collegamento al deploy…"}
        className="h-80"
      />
    </div>
  );
}

/** How far into DEPLOY_PHASES the deploy got, for the step list. */
function phaseIndex(log: string, phase: DeployPhase): number {
  if (phase === "done") return DEPLOY_PHASES.length;
  if (phase === "queued") return 0;
  if (phase === "failed") {
    // Failed during the last phase the log reached.
    const lastReached = [...DEPLOY_PHASES].reverse().find((step) => deployPhase(stripFailure(log)) === step.id);
    return lastReached ? DEPLOY_PHASES.indexOf(lastReached) : 0;
  }
  return Math.max(0, DEPLOY_PHASES.findIndex((step) => step.id === phase));
}

/** The log without its failure banner, so the phase before it can be read. */
function stripFailure(log: string): string {
  return log.replace(/^\s*=== .* FAILED.*$/gm, "");
}

function PhaseIcon({ state }: { state: "done" | "current" | "failed" | "todo" }) {
  if (state === "done") return <Icon icon="solar:check-circle-bold" width={16} className="text-success shrink-0" aria-hidden />;
  if (state === "failed") return <Icon icon="solar:close-circle-bold" width={16} className="text-danger shrink-0" aria-hidden />;
  if (state === "current")
    return <Icon icon="solar:refresh-linear" width={16} className="text-accent shrink-0 motion-safe:animate-spin" aria-hidden />;
  return <span className="border-border size-4 shrink-0 rounded-full border" aria-hidden />;
}
