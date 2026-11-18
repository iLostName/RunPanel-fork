"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import {
  formatTimeout,
  TASK_TIMEOUT_CHOICES,
  TASK_TIMEOUT_DEFAULT_SEC,
  type TasksResponse,
  type TaskView,
} from "@/lib/tasks-rules";
import { CommandField } from "@/components/ui/CommandField";
import { FormDialog } from "@/components/ui/FormDialog";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { SchedulePicker } from "@/components/ui/SchedulePicker";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Advanced } from "@/components/ui/Technical";

/**
 * Creating or editing a scheduled task.
 *
 * Four questions, in the order people think of them: what it is called, what
 * it does, when, and — for whoever wants it — how long it may take. The
 * schedule is the backups' own `SchedulePicker`, with "Solo su richiesta" for
 * a command kept at hand for "Esegui ora". Saving never runs it.
 */

/** Where the command runs, in one sentence: the project's runtime decides, not the task. */
export function whereTasksRun(runtimeType: string): string {
  if (runtimeType === "docker") return "Il comando gira dentro il container dell'app, con le sue variabili e i suoi file.";
  if (runtimeType === "compose") return "Il comando gira dentro il servizio dello stack che scegli, con le sue variabili e i suoi file.";
  return "Il comando gira sul server, nella cartella del progetto, con le variabili del progetto.";
}

const PLACEHOLDER: Record<string, string> = {
  docker: "php artisan cache:clear",
  compose: "wp cron event run --due-now",
  node: "npm run cleanup",
  static: "find dist -name '*.tmp' -delete",
  custom: "./scripts/cleanup.sh",
};

export function TasksDialog({
  projectId,
  task,
  info,
  onClose,
  onSaved,
}: {
  projectId: string;
  /** Null when creating. */
  task: TaskView | null;
  info: TasksResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useNodeApi();
  const compose = info.runtimeType === "compose";
  // The stack's services are asked of Docker, so only while this is open.
  const services = useResource<TasksResponse>(compose ? api(`/api/projects/${projectId}/tasks?include=services`) : null);
  const serviceNames = [...new Set([...(services.data?.composeServices ?? []), ...(task?.service ? [task.service] : [])])];

  const [name, setName] = useState(task?.name ?? "");
  const [command, setCommand] = useState(task?.command ?? "");
  const [cron, setCron] = useState(task?.cron ?? "0 3 * * *");
  const [timezone, setTimezone] = useState<string | null>(task?.timezone ?? null);
  const [timeoutSec, setTimeoutSec] = useState(task?.timeoutSec ?? TASK_TIMEOUT_DEFAULT_SEC);
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [service, setService] = useState(task?.service ?? "");
  const [cronError, setCronError] = useState<string | null>(null);

  const timeouts = [...new Set<number>([...TASK_TIMEOUT_CHOICES, timeoutSec])].sort((a, b) => a - b);
  const problem = !name.trim()
    ? "Dai un nome all'attività"
    : !command.trim()
      ? "Scrivi il comando da eseguire"
      : compose && !service.trim()
        ? "Scegli in quale servizio dello stack far girare il comando"
        : cron && cronError
          ? cronError
          : null;

  async function submit(): Promise<boolean> {
    if (problem) {
      toast.error(problem);
      return false;
    }
    const payload = {
      name: name.trim(),
      command,
      cron,
      timezone,
      timeoutSec,
      enabled,
      ...(compose ? { service: service.trim() } : {}),
    };
    try {
      const res = await fetch(api(`/api/projects/${projectId}/tasks${task ? `/${task.id}` : ""}`), {
        method: task ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? (task ? MSG.saveFailed : MSG.createFailed));
        return false;
      }
      toast.success(
        task
          ? "Attività salvata"
          : cron && enabled
            ? "Attività creata: parte all'orario che hai scelto"
            : "Attività creata: parte quando premi «Esegui ora»"
      );
      onSaved();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={task ? `Modifica «${task.name}»` : "Nuova attività pianificata"}
      description={whereTasksRun(info.runtimeType)}
      submitLabel={task ? (task.needsReview ? "Conferma e salva" : "Salva") : "Crea l'attività"}
      isSubmitDisabled={Boolean(problem)}
      wide
      onSubmit={submit}
    >
      {task?.needsReview && (
        <Hint tone="warn" title="Il progetto ora gira in un altro modo">
          Questo comando era stato scritto per {task.runsIn === "container" ? "un container" : "girare sul server"}, e
          finché non lo confermi l&apos;attività salta ogni giro. Controlla che abbia ancora senso, poi salva.
        </Hint>
      )}

      <TextField value={name} onChange={setName}>
        <Label>Nome</Label>
        <Input placeholder="Svuota la cache" maxLength={80} />
      </TextField>

      {compose && (
        <div>
          {serviceNames.length > 0 ? (
            <SelectField
              label="Servizio dello stack"
              value={service || null}
              onChange={setService}
              options={serviceNames.map((entry) => ({ value: entry, label: entry }))}
            />
          ) : (
            <TextField value={service} onChange={setService}>
              <Label>Servizio dello stack</Label>
              <Input placeholder="app" className="font-mono text-sm" />
            </TextField>
          )}
          <FieldHint>
            {serviceNames.length > 0
              ? "Il nome del servizio nel file compose. Deve essere acceso quando l'attività parte, altrimenti salta il giro."
              : "Lo stack non è acceso, quindi non posso elencarne i servizi: scrivi il nome che ha nel file compose."}
          </FieldHint>
        </div>
      )}

      <CommandField
        label="Comando"
        value={command}
        onChange={setCommand}
        rows={3}
        placeholder={PLACEHOLDER[info.runtimeType] ?? PLACEHOLDER.custom}
        hint="Un comando per riga: girano in ordine nella stessa shell, e il primo che fallisce ferma gli altri. Non metterci password: il comando resta nella cronologia, e così il suo output."
      />

      <div className="border-separator border-t pt-4">
        <p className="text-foreground mb-3 text-sm font-medium">Quando</p>
        <SchedulePicker
          value={cron}
          onChange={setCron}
          timeZone={timezone}
          onTimeZoneChange={setTimezone}
          panelTimeZone={info.panelTimeZone}
          onValidityChange={setCronError}
        />
      </div>

      <Advanced summary={`tempo massimo ${formatTimeout(timeoutSec)}${enabled ? "" : " · spenta"}`}>
        <div>
          <SelectField
            label="Tempo massimo"
            value={String(timeoutSec)}
            onChange={(value) => setTimeoutSec(Number(value))}
            options={timeouts.map((seconds) => ({ value: String(seconds), label: formatTimeout(seconds) }))}
          />
          <FieldHint>
            Oltre questo tempo l&apos;attività viene fermata, insieme a tutto quello che ha avviato, e conta come non
            riuscita. Finché gira, il giro successivo viene saltato.
          </FieldHint>
        </div>
        {cron && (
          <SettingToggle
            label="Accesa"
            description={enabled ? "Parte da sola all'orario scelto" : "Spenta: parte solo quando premi «Esegui ora»"}
            isSelected={enabled}
            onChange={setEnabled}
          />
        )}
      </Advanced>
    </FormDialog>
  );
}
