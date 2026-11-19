"use client";

import { useMemo, useState } from "react";
import { Button, Input, Label, SearchField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { LinkButton } from "@/components/ui/LinkButton";
import { Code } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { useExpertMode } from "@/components/Providers";
import { makeLogFilter, type LogStream } from "@/lib/log-search";
import { useNodeApi } from "@/lib/hooks/useNode";
import { LogHistory } from "./LogHistory";

type Mode = "live" | "history";
type StreamChoice = "all" | LogStream;

/**
 * What the app prints: live, or as the panel saved it.
 *
 * Live is the page's buffer — the current run, from the event stream — and
 * everything done to it here is done to the view only. Pause freezes what is
 * on screen while the buffer keeps filling, so a line being read does not
 * scroll away; "Pulisci" hides what is there, and the next lines start a clean
 * view. Neither deletes anything: the saved log ("Storico") has it all.
 */
export function LogAppPanel({
  projectId,
  lines,
  connected,
  runtimeType,
}: {
  projectId?: string;
  lines: LogLine[];
  connected: boolean;
  runtimeType?: string;
}) {
  const api = useNodeApi();
  const { expert } = useExpertMode();
  const [mode, setMode] = useState<Mode>("live");
  const [query, setQuery] = useState("");
  const [stream, setStream] = useState<StreamChoice>("all");
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const [clearedAfter, setClearedAfter] = useState<number | null>(null);

  const base = frozen ?? lines;
  const visible = useMemo(
    () => (clearedAfter === null ? base : base.filter((line) => line.id > clearedAfter)),
    [base, clearedAfter]
  );
  const needle = query.trim();
  const filter = useMemo(() => makeLogFilter({ query: needle, stream }), [needle, stream]);
  const shown = useMemo(() => (needle || stream !== "all" ? visible.filter(filter) : visible), [visible, filter, needle, stream]);

  const lastFrozen = frozen?.at(-1)?.id ?? null;
  const waiting = frozen ? lines.filter((line) => lastFrozen === null || line.id > lastFrozen).length : 0;
  // A container's output reaches the live view as one stream: Docker's
  // follower merges the two pipes. The saved log keeps them apart.
  const mergedLive = mode === "live" && stream !== "all" && (runtimeType === "docker" || runtimeType === "compose");

  const emptyMessage =
    visible.length === 0
      ? clearedAfter !== null
        ? "Vista pulita: qui compariranno solo le righe nuove."
        : connected
          ? "L'app non ha ancora scritto niente in questa esecuzione. Le righe nuove compariranno qui appena arrivano."
          : "Collegamento al pannello interrotto: le righe compariranno appena torna."
      : needle
        ? `Nessuna riga contiene «${needle}». Per cercare anche prima dell'ultimo riavvio usa lo Storico.`
        : stream === "stderr"
          ? "Nessun errore fra queste righe."
          : "Nessuna riga di output fra queste righe.";

  return (
    <Panel className="space-y-3">
      <PanelHeader
        title="Output dell'app"
        description={
          mode === "live" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted"}`} aria-hidden />
              {connected ? "In diretta" : "Collegamento interrotto, riprovo…"}
            </span>
          ) : (
            "Salvato da RunPanel, anche prima dei riavvii e dei nuovi deploy"
          )
        }
        actions={
          <Segmented
            value={mode}
            onChange={setMode}
            label="Cosa mostrare"
            options={[
              { value: "live", label: "In diretta", icon: "solar:play-circle-linear" },
              { value: "history", label: "Storico", icon: "solar:history-linear", isDisabled: !projectId },
            ]}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-52">
          <SearchField value={query} onChange={setQuery} aria-label="Cerca nel log dell'app">
            <Label className="sr-only">Cerca nel log dell&apos;app</Label>
            <Input placeholder={mode === "live" ? "Cerca fra le righe mostrate" : "Cerca in tutto lo storico"} className="text-sm" />
          </SearchField>
        </div>
        <Segmented
          value={stream}
          onChange={setStream}
          label="Quali righe"
          options={[
            { value: "all", label: "Tutte" },
            { value: "stdout", label: expert ? "stdout" : "Output" },
            { value: "stderr", label: expert ? "stderr" : "Errori" },
          ]}
        />
        {/* Glyphs only on a phone, their names kept for screen readers: with
            the words the toolbar took three lines above the log it is for. */}
        {mode === "live" && (
          <>
            <Button size="sm" variant="secondary" onPress={() => setFrozen(frozen ? null : lines)}>
              <Icon icon={frozen ? "solar:play-linear" : "solar:pause-linear"} width={15} aria-hidden />
              <span className="max-md:sr-only">{frozen ? "Riprendi" : "Pausa"}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={visible.length === 0}
              onPress={() => setClearedAfter(base.at(-1)?.id ?? clearedAfter)}
            >
              <Icon icon="solar:eraser-linear" width={15} aria-hidden />
              <span className="max-md:sr-only">Pulisci</span>
            </Button>
          </>
        )}
        {projectId && (
          <LinkButton
            href={api(`/api/projects/${projectId}/logs/app/download`)}
            download
            aria-label="Scarica tutto il log salvato dell'app"
          >
            <Icon icon="solar:download-minimalistic-linear" width={15} aria-hidden />
            <span className="max-md:sr-only">Scarica</span>
          </LinkButton>
        )}
      </div>

      {mode === "live" && frozen && (
        <div
          role="status"
          className="border-warning/35 bg-warning/10 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border px-3 py-2"
        >
          <Icon icon="solar:pause-circle-linear" width={16} className="text-warning shrink-0" aria-hidden />
          <span className="text-foreground min-w-0 flex-1 text-sm">
            {waiting > 0
              ? `In pausa: ${waiting === 1 ? "1 riga nuova" : `${waiting} righe nuove`} da mostrare`
              : "In pausa: le righe nuove arrivano, ma la vista resta ferma"}
          </span>
          <Button size="sm" variant="secondary" onPress={() => setFrozen(null)}>
            Riprendi
          </Button>
        </div>
      )}

      {mode === "live" && clearedAfter !== null && (
        <p className="text-muted flex items-center gap-2 text-meta">
          Righe precedenti nascoste dalla vista.
          <button type="button" className="text-accent hover:underline" onClick={() => setClearedAfter(null)}>
            Mostra di nuovo
          </button>
        </p>
      )}

      {mergedLive && (
        <p className="text-muted text-meta">
          Nella diretta dei container output ed errori arrivano insieme: per separarli usa lo Storico.
        </p>
      )}

      {mode === "live" ? (
        <LogViewer
          lines={shown}
          highlight={needle || undefined}
          className="h-[320px] sm:h-[440px]"
          emptyMessage={emptyMessage}
          ariaLabel="Output dell'app"
        />
      ) : (
        projectId && <LogHistory projectId={projectId} query={query} stream={stream} />
      )}

      {mode === "live" && (
        <Technical>
          <p className="text-muted text-meta leading-relaxed">
            La diretta mostra le ultime 2000 righe dell&apos;esecuzione attuale, dal runtime (<Code>stdout</Code> e{" "}
            <Code>stderr</Code> separati solo per le app native). Ricerca e filtri qui valgono per queste righe; lo
            Storico cerca sul server in tutto quello che è stato salvato.
          </p>
        </Technical>
      )}
    </Panel>
  );
}
