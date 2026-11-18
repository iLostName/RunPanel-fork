"use client";

import { useMemo, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { formatDuration, formatWhen } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { outsideToasts } from "@/lib/toast";
import {
  STATUS_LABEL,
  STATUS_TONE,
  type TaskRunDetail,
  type TaskRunSummary,
  type TaskView,
} from "@/lib/tasks-rules";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Code } from "@/components/ui/Hint";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { Technical } from "@/components/ui/Technical";
import { cn } from "@/lib/utils";

/**
 * A task's history: every run, skipped ones included, and the log of the one
 * picked. While one runs, the list and the log refresh by themselves — the
 * output comes from the process, not from the store, until it has finished.
 */

/** An instant on the task's clock, which is not necessarily the browser's. */
export function formatInZone(iso: string, zone: string | null | undefined): string {
  if (!zone) return formatWhen(iso);
  try {
    return new Intl.DateTimeFormat("it-IT", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return formatWhen(iso);
  }
}

const TRIGGER: Record<TaskRunSummary["trigger"], string> = { schedule: "a orario", manual: "a mano" };

function toLines(output: string): LogLine[] {
  return output
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1)
    .map((line, id) =>
      line.startsWith("[stderr] ") ? { id, text: line.slice(9), stream: "stderr" as const } : { id, text: line, stream: "stdout" as const }
    );
}

export function TasksHistory({
  projectId,
  task,
  zone,
  onClose,
}: {
  projectId: string;
  task: TaskView;
  zone: string | undefined;
  onClose: () => void;
}) {
  const api = useNodeApi();
  const base = `/api/projects/${projectId}/tasks/${task.id}`;
  const [live, setLive] = useState(task.lastRun?.status === "running");
  const list = useResource<{ task: TaskView; runs: TaskRunSummary[] }>(api(base), { intervalMs: live ? 3_000 : 0 });
  const runs = useMemo(() => list.data?.runs ?? [], [list.data]);

  const anyRunning = runs.some((run) => run.status === "running");
  if (list.data && anyRunning !== live) setLive(anyRunning);

  // The newest run that has something to show, unless one was picked.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === picked) ?? runs.find((run) => run.status !== "skipped") ?? runs[0] ?? null;
  const detail = useResource<{ run: TaskRunDetail }>(selected ? api(`${base}/runs/${selected.id}`) : null, {
    intervalMs: selected?.status === "running" ? 2_000 : 0,
  });
  const lines = useMemo(() => toLines(detail.data?.run.output ?? ""), [detail.data]);
  const ownZone = task.timezone ?? zone;

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()} shouldCloseOnInteractOutside={outsideToasts}>
      <Modal.Container>
        <Modal.Dialog className="max-w-3xl">
          <Modal.Header>
            <Modal.Heading>Cronologia di «{task.name}»</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            {list.data && runs.length === 0 ? (
              <EmptyState
                icon="solar:history-linear"
                title="Ancora nessuna esecuzione"
                description="Qui finisce ogni giro dell'attività, anche quelli saltati, con il suo log."
              />
            ) : (
              <ul className="border-border divide-separator max-h-56 divide-y overflow-auto rounded-[var(--radius)] border" aria-label="Esecuzioni">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(run.id)}
                      aria-current={run.id === selected?.id ? "true" : undefined}
                      className={cn(
                        "hover:bg-surface-hover flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left text-xs transition-colors",
                        run.id === selected?.id && "bg-surface-secondary"
                      )}
                    >
                      <Badge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
                      <span className="text-foreground">{formatInZone(run.startedAt, ownZone)}</span>
                      <span className="text-muted">{TRIGGER[run.trigger]}</span>
                      {run.durationMs !== null && run.status !== "skipped" && (
                        <span className="text-muted">{formatDuration(run.durationMs)}</span>
                      )}
                      {run.exitCode !== null && <span className="text-muted font-mono">codice {run.exitCode}</span>}
                      {run.repeats > 0 && <span className="text-muted">×{run.repeats + 1}, l&apos;ultima {formatInZone(run.finishedAt ?? run.startedAt, ownZone)}</span>}
                      {run.error && <span className="text-muted w-full truncate">{run.error}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selected && selected.status !== "skipped" && (
              <div className="space-y-2">
                <div className="text-muted flex flex-wrap items-center gap-x-3 text-meta">
                  <span>
                    {selected.status === "running" ? "In corso, iniziata " : "Iniziata "}
                    {formatInZone(selected.startedAt, ownZone)}
                    {selected.scheduledFor &&
                      Math.abs(Date.parse(selected.startedAt) - Date.parse(selected.scheduledFor)) > 60_000 && (
                        <> · prevista {formatInZone(selected.scheduledFor, ownZone)}</>
                      )}
                  </span>
                  {detail.data && detail.data.run.outputDropped > 0 && (
                    <span>Output lungo: tenuti l&apos;inizio e la fine, il resto è indicato nel log.</span>
                  )}
                </div>
                <Technical>
                  {detail.data && (
                    <p className="text-muted text-meta">
                      Comando: <Code className="break-all">{detail.data.run.command}</Code>
                    </p>
                  )}
                </Technical>
                <LogViewer
                  lines={lines}
                  className="h-72"
                  ariaLabel={`Output di «${task.name}»`}
                  emptyMessage={detail.loading ? "Carico il log…" : "Non ha scritto niente."}
                />
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="justify-end">
            <Button onPress={onClose}>Chiudi</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
