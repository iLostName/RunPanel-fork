"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { formatRelative } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { capitalize } from "@/lib/schedule";
import {
  outcomePhrase,
  STATUS_LABEL,
  STATUS_TONE,
  type TaskRunSummary,
  type TasksResponse,
  type TaskView,
} from "@/lib/tasks-rules";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint } from "@/components/ui/Hint";
import { ListRow, RowMenu, type RowAction } from "@/components/ui/ListRow";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Technical } from "@/components/ui/Technical";
import { InfoTip } from "@/components/ui/Tooltip";
import { TasksDialog, whereTasksRun } from "./TasksDialog";
import { TasksHistory, formatInZone } from "./TasksHistory";

/**
 * The project's scheduled tasks: commands that run by themselves at set
 * times, in the app's context. The engine is `services/tasks/`; the rules and
 * the words are `lib/tasks-rules.ts`, the same ones the server writes.
 *
 * Each row says three things in plain Italian — when it runs, how the last
 * run went, when it runs next — and the rest (command, exit code, zone) is
 * for expert mode and the history. While a task runs the list refreshes every
 * few seconds; otherwise every half minute.
 */

/** Why a run did not run or was stopped, when that is not already in the outcome's words. */
function why(run: TaskRunSummary): string {
  if (run.status === "skipped" && run.error) return ` (${run.error})`;
  if (run.status === "cancelled" && run.error) return ` (${run.error.replace(/^Fermata:?\s*/i, "")})`;
  return "";
}

function describe(task: TaskView): string {
  const when = capitalize(task.schedule);
  if (task.needsReview) return `${when} · in attesa di conferma`;
  const last = task.lastRun;
  if (!last) return `${when} · mai eseguita`;
  if (last.status === "running") return `${when} · in corso da ${formatRelative(last.startedAt).replace(/ fa$/, "")}`;
  const failing = task.consecutiveFailures > 1 ? ` · non riesce da ${task.consecutiveFailures} esecuzioni` : "";
  const ago = formatRelative(last.finishedAt ?? last.startedAt);
  return `${when} · ultima esecuzione ${outcomePhrase(last)} ${ago}${why(last)}${failing}`;
}

function statusBadge(task: TaskView) {
  if (task.needsReview) return <Badge tone="warning" icon="solar:danger-triangle-linear">Da confermare</Badge>;
  if (task.lastRun?.status === "running") return <Badge tone="accent">In corso</Badge>;
  if (!task.enabled && task.cron) return <Badge>Spenta</Badge>;
  if (!task.lastRun) return null;
  return <Badge tone={STATUS_TONE[task.lastRun.status]}>{STATUS_LABEL[task.lastRun.status]}</Badge>;
}

export function TasksSection({ projectId }: { projectId: string }) {
  const api = useNodeApi();
  const base = `/api/projects/${projectId}/tasks`;
  const [running, setRunning] = useState(false);
  const { data, error, loading, refresh } = useResource<TasksResponse>(api(base), { intervalMs: running ? 3_000 : 30_000 });
  const [editing, setEditing] = useState<TaskView | "new" | null>(null);
  const [history, setHistory] = useState<TaskView | null>(null);
  const [deleting, setDeleting] = useState<TaskView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tasks = data?.tasks ?? [];
  const anyRunning = tasks.some((task) => task.lastRun?.status === "running");
  if (anyRunning !== running) setRunning(anyRunning);

  const canManage = Boolean(data && (data.canEdit || data.editBlockedReason));

  async function call(task: TaskView, path: string, init: RequestInit, done: string): Promise<boolean> {
    setBusy(task.id);
    try {
      const res = await fetch(api(`${base}/${task.id}${path}`), init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? MSG.saveFailed);
        void refresh();
        return false;
      }
      toast.success(done);
      await refresh();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const runNow = (task: TaskView) => call(task, "/run", { method: "POST" }, `«${task.name}» è partita`);
  const stop = (task: TaskView) => call(task, "/run", { method: "DELETE" }, `«${task.name}» si sta fermando`);
  const toggle = (task: TaskView) =>
    call(
      task,
      "",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !task.enabled }) },
      task.enabled ? `«${task.name}» spenta: non parte più da sola` : `«${task.name}» accesa`
    );

  function menu(task: TaskView): RowAction[] {
    const actions: RowAction[] = [
      { id: "history", label: "Cronologia e log", icon: "solar:history-linear", onAction: () => setHistory(task) },
    ];
    if (data?.canEdit) {
      actions.push({ id: "edit", label: task.needsReview ? "Rivedi e conferma" : "Modifica", icon: "solar:pen-linear", onAction: () => setEditing(task) });
    }
    if (canManage && task.cron) {
      actions.push({
        id: "toggle",
        label: task.enabled ? "Spegni" : "Accendi",
        icon: task.enabled ? "solar:pause-circle-linear" : "solar:play-circle-linear",
        onAction: () => void toggle(task),
      });
    }
    if (canManage) actions.push({ id: "delete", label: "Elimina", icon: "solar:trash-bin-trash-linear", danger: true, onAction: () => setDeleting(task) });
    return actions;
  }

  function action(task: TaskView) {
    if (!data?.canRun) return null;
    const isRunning = task.lastRun?.status === "running";
    return (
      <Button
        size="sm"
        variant={isRunning ? "danger-soft" : "secondary"}
        isPending={busy === task.id}
        isDisabled={busy !== null || (!isRunning && task.needsReview)}
        onPress={() => void (isRunning ? stop(task) : runNow(task))}
      >
        <Icon icon={isRunning ? "solar:stop-circle-linear" : "solar:play-linear"} width={15} aria-hidden />
        {isRunning ? "Ferma" : "Esegui ora"}
      </Button>
    );
  }

  const zone = data?.panelTimeZone;

  return (
    <Panel padding="flush">
      <div className="p-4 sm:p-5">
        <PanelHeader
          title="Attività pianificate"
          description="Comandi che il progetto esegue da solo, a orari fissi, con un registro di ogni esecuzione"
          actions={
            <>
              <InfoTip title="Come funzionano">
                Un&apos;attività non parte mai due volte insieme e non parte durante un deploy: in quei casi salta il
                giro e lo scrive nella cronologia. Se un deploy comincia mentre gira, si ferma. Oltre il tempo massimo
                viene fermata con tutto quello che ha avviato. Se fallisce te lo dicono le notifiche, e di nuovo quando
                torna a riuscire.
              </InfoTip>
              {data?.canEdit && (
                <Button size="sm" variant="secondary" onPress={() => setEditing("new")}>
                  <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                  Nuova attività
                </Button>
              )}
            </>
          }
        />
        {data && !data.canEdit && data.editBlockedReason && (
          <Hint className="mt-3" tone="info">
            {data.editBlockedReason} Puoi eseguirle, accenderle, spegnerle ed eliminarle, ma non scriverne i comandi.
          </Hint>
        )}
        {error && !data && <p className="text-danger mt-3 text-sm">{MSG.loadFailed}</p>}
      </div>

      {!loading && data && tasks.length === 0 && (
        <EmptyState
          className="border-separator border-t py-8"
          icon="solar:alarm-linear"
          title="Nessuna attività pianificata"
          description={`Per esempio: ogni notte alle 03:00 svuota la cache, ogni lunedì manda un report. ${whereTasksRun(data.runtimeType)}`}
          action={
            data.canEdit ? (
              <Button size="sm" onPress={() => setEditing("new")}>
                <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                Nuova attività
              </Button>
            ) : undefined
          }
        />
      )}

      {tasks.length > 0 && (
        <div className="border-separator divide-separator divide-y border-t">
          {tasks.map((task) => (
            <ListRow
              key={task.id}
              icon="solar:alarm-linear"
              title={task.name}
              status={statusBadge(task)}
              description={describe(task)}
              meta={<TaskMeta task={task} zone={zone} />}
              action={action(task)}
              menu={<RowMenu label={`Azioni per ${task.name}`} actions={menu(task)} />}
            />
          ))}
        </div>
      )}

      {editing && data && (
        <TasksDialog
          projectId={projectId}
          task={editing === "new" ? null : editing}
          info={data}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
      {history && <TasksHistory projectId={projectId} task={history} zone={zone} onClose={() => setHistory(null)} />}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Eliminare «${deleting?.name ?? ""}»?`}
        description="Sparisce l'attività con tutta la sua cronologia. Se sta girando adesso, viene fermata."
        confirmLabel="Elimina"
        destructive
        onConfirm={async () => (deleting ? call(deleting, "", { method: "DELETE" }, `«${deleting.name}» eliminata`) : true)}
      />
    </Panel>
  );
}

/** When it runs next, and for experts what it runs and where. */
function TaskMeta({ task, zone }: { task: TaskView; zone: string | undefined }) {
  const ownZone = task.timezone ?? zone;
  const next =
    task.needsReview
      ? "Il progetto ora gira in un altro modo: riapri l'attività e salvala per confermare dove deve girare il comando"
      : task.enabled && task.nextRunAt
        ? `Prossima ${formatRelative(task.nextRunAt)} · ${formatInZone(task.nextRunAt, ownZone)}`
        : task.cron && !task.enabled
          ? "Spenta: parte solo con «Esegui ora»"
          : null;
  return (
    <>
      {next}
      <Technical>
        <span className="font-mono">
          {next ? " · " : ""}
          {task.command.split("\n")[0]}
          {task.cron ? ` · ${task.cron}` : ""}
          {ownZone ? ` · ${ownZone}` : ""}
          {task.lastRun?.exitCode !== null && task.lastRun?.exitCode !== undefined ? ` · exit ${task.lastRun.exitCode}` : ""}
        </span>
      </Technical>
    </>
  );
}
