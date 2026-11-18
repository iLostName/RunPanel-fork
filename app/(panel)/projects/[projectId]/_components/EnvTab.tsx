"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Label, SearchField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadError } from "@/components/ui/LoadError";
import { BuildEnvHint, ManagedEnvHint, ServiceLinkHint } from "@/components/DeployHints";
import { parseDotenv } from "@/lib/dotenv-parse";
import { serviceEnvKey } from "@/lib/service-env";
import { serviceDisplayName } from "@/lib/service-name";
import {
  KEY_MISSING,
  buildPrefixOf,
  countChanges,
  filterRows,
  listProblem,
  pasteSummaryText,
  rowProblems,
  rowsToPairs,
  serializeDotenv,
  serverIssuesToRows,
  type EnvPair,
  type EnvRow,
  type PasteSummary,
  type RowProblem,
} from "@/lib/env-table";
import type { EnvVar } from "./types";
import { EnvTable, type EnvRowContext } from "./EnvTable";
import { EnvTextView } from "./EnvTextView";
import { EnvPasteDialog } from "./EnvPasteDialog";
import { EnvLinkedVars, type LinkedService } from "./EnvLinkedVars";

/**
 * The env tab as the project page mounts it: the variables are fetched here,
 * on every visit, and the editor mounts once they have arrived.
 *
 * The page used to fetch them and keep them while another tab was open. The
 * editor seeds its copy once, so coming back after a save seeded it from the
 * copy fetched before the save — the old values, which the next save would
 * have written back over the new ones.
 */
export function ProjectEnvTab(props: Omit<Parameters<typeof EnvTab>[0], "initialVars" | "loading">) {
  const api = useNodeApi();
  const { data, loading, error, refresh } = useResource<EnvVar[]>(
    api(`/api/projects/${props.projectId}/env?reveal=true`)
  );

  // Never mount the editor over a failed load: it would start empty, and
  // saving replaces the whole set, which would delete every variable.
  if (error && !data) return <LoadError what="le variabili" error={error} onRetry={() => void refresh()} />;

  // Keyed on whether the data has arrived, so the editable copy is seeded by
  // React remounting the component rather than by an effect that copies props
  // into state.
  return <EnvTab key={data ? "loaded" : "loading"} {...props} initialVars={data ?? []} loading={loading} />;
}

/** Above this many variables the list gets a search. */
const SEARCH_FROM = 8;

let rowSeq = 0;
function newRow(pair: EnvPair): EnvRow {
  return { id: ++rowSeq, key: pair.key, value: pair.value };
}

/**
 * Rows for `pairs`, keeping the id of the row that had the same name, so what
 * belongs to a row — shown or hidden, its error — follows it through a paste
 * or an edit of the text.
 */
function rowsFor(pairs: readonly EnvPair[], previous: readonly EnvRow[]): EnvRow[] {
  const ids = new Map<string, number[]>();
  for (const row of previous) {
    const key = row.key.trim();
    if (key) ids.set(key, [...(ids.get(key) ?? []), row.id]);
  }
  return pairs.map((pair) => {
    const id = pair.key ? ids.get(pair.key)?.shift() : undefined;
    return id === undefined ? newRow(pair) : { id, key: pair.key, value: pair.value };
  });
}

type View = "table" | "text";

/**
 * The editable copy is owned here and seeded from `initialVars` once. The
 * parent remounts this component (via `key`) when the fetch resolves, which is
 * how React means you to reset state from props — an effect that copies props
 * into state renders twice and fights with whatever the user has typed.
 *
 * One list, two ways to edit it: the table and the `.env` text, each written
 * from the other when it is opened. Saving sends the whole list, so what is
 * checked before it goes is everything the API would refuse, put on the row
 * that has it; what the API refuses anyway comes back onto its row as well.
 */
export function EnvTab({
  projectId,
  runtimeType,
  buildEnvPrefixes,
  initialVars,
  loading,
  readOnly = false,
  canRedeploy = true,
  onDirtyChange,
}: {
  projectId: string;
  runtimeType: string;
  buildEnvPrefixes: string[];
  initialVars: EnvVar[];
  loading: boolean;
  /** Below `manage`: the names are shown, the values arrive masked, nothing is editable. */
  readOnly?: boolean;
  /** Offer "Salva e ridistribuisci". Off for a project with nothing to deploy yet. */
  canRedeploy?: boolean;
  /**
   * Told whenever there are unsaved changes, and `false` on unmount. The tab
   * row is buttons, not links, so the save bar's guard cannot catch a switch
   * of tab: the page can, with this.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = useNodeApi();
  // What the server last confirmed. The parent reseeds it by remounting on load.
  const [saved, setSaved] = useState<EnvPair[]>(() => initialVars.map(({ key, value }) => ({ key, value })));
  const [rows, setRows] = useState<EnvRow[]>(() => initialVars.map(({ key, value }) => newRow({ key, value })));
  const [view, setView] = useState<View>("table");
  const [text, setText] = useState("");
  const [textEdited, setTextEdited] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [serverProblems, setServerProblems] = useState<ReadonlyMap<number, RowProblem>>(() => new Map());
  const [general, setGeneral] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [focusId, setFocusId] = useState<number | null>(null);
  const [paste, setPaste] = useState<{ key: number; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState<{ deploy: boolean } | null>(null);
  const [confirmLeaveText, setConfirmLeaveText] = useState(false);
  // A real file input in the tree rather than one made with
  // document.createElement; "Importa file" is the control that reaches it, by
  // pointer and by keyboard alike.
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sent = useMemo(() => rowsToPairs(rows), [rows]);
  const changes = useMemo(() => countChanges(saved, sent.pairs), [saved, sent]);
  const parsedText = useMemo(() => (view === "text" ? parseDotenv(text) : null), [view, text]);
  // Only what was typed in the text counts: a row the table already flags
  // shows up as an invalid line too, and is the table's problem.
  const textIssues = useMemo(() => (textEdited && parsedText ? parsedText.invalid : []), [textEdited, parsedText]);
  const dirty = !readOnly && (changes > 0 || textIssues.length > 0);

  // Through a ref, so a listener passed as an inline arrow is not told
  // "clean" and "dirty" again on every render.
  const dirtyListener = useRef(onDirtyChange);
  useEffect(() => {
    dirtyListener.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    dirtyListener.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyListener.current?.(false), []);

  // What is wrong, row by row. "Manca il nome" while a row is still being
  // filled in is noise; once a save was tried, it is the answer.
  const clientProblems = useMemo(() => rowProblems(rows), [rows]);
  const problems = useMemo(() => {
    const shown = new Map<number, RowProblem>();
    for (const row of rows) {
      const problem = serverProblems.get(row.id) ?? clientProblems.get(row.id);
      if (!problem) continue;
      if (!attempted && problem.key === KEY_MISSING && !problem.value && !serverProblems.has(row.id)) continue;
      shown.set(row.id, problem);
    }
    return shown;
  }, [rows, serverProblems, clientProblems, attempted]);

  // The databases this project will be handed at the next deploy. Listed here
  // because this is where someone looks for DATABASE_URL, does not find it, and
  // pastes a connection string by hand — over the one RunPanel was about to
  // inject, which then silently wins forever.
  const { data: servicesData, refresh: refreshServices } = useResource<LinkedService[]>(api("/api/services"));
  const linked = useMemo(
    () => (Array.isArray(servicesData) ? servicesData : []).filter((s) => s.project_id === projectId),
    [servicesData, projectId]
  );
  const overrides = useMemo(() => {
    const map = new Map<string, string>();
    for (const service of linked) {
      const key = serviceEnvKey(service);
      if (service.inject_env === 1 && !map.has(key)) map.set(key, serviceDisplayName(service));
    }
    return map;
  }, [linked]);
  const userKeys = useMemo(() => new Set(sent.pairs.map((pair) => pair.key).filter(Boolean)), [sent]);

  // Stable, so a keystroke re-renders the row it is in and not the whole table.
  const changeRow = useCallback((id: number, patch: Partial<EnvPair>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setServerProblems((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const removeRow = useCallback((id: number) => setRows((current) => current.filter((row) => row.id !== id)), []);
  const toggleReveal = useCallback(
    (id: number) =>
      setRevealed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
  );
  const isDocker = runtimeType === "docker";
  const context = useMemo<EnvRowContext>(
    () => ({ readOnly, isDocker, onChange: changeRow, onRemove: removeRow, onToggleReveal: toggleReveal }),
    [readOnly, isDocker, changeRow, removeRow, toggleReveal]
  );
  const prefixOf = useCallback((key: string) => buildPrefixOf(key, buildEnvPrefixes), [buildEnvPrefixes]);

  const shownRows = useMemo(() => filterRows(rows, search), [rows, search]);
  const hiddenProblems = rows.filter((row) => problems.has(row.id)).length - shownRows.filter((row) => problems.has(row.id)).length;
  const allRevealed = rows.length > 0 && rows.every((row) => revealed.has(row.id));

  function addRow() {
    const row = newRow({ key: "", value: "" });
    setRows((current) => [...current, row]);
    // Typed in the clear: hiding what someone is typing helps nobody.
    setRevealed((current) => new Set(current).add(row.id));
    setFocusId(row.id);
    setSearch("");
  }

  function switchView(next: View) {
    if (next === view) return;
    if (next === "text") {
      setText(serializeDotenv(sent.pairs));
      setTextEdited(false);
      setView("text");
      return;
    }
    if (textIssues.length > 0) {
      setConfirmLeaveText(true);
      return;
    }
    setView("table");
  }

  function editText(next: string) {
    setText(next);
    setTextEdited(true);
    setRows((current) => rowsFor(parseDotenv(next).vars, current));
    setServerProblems(new Map());
  }

  function applyPaste(pairs: EnvPair[], summary: PasteSummary) {
    setRows((current) => rowsFor(pairs, current));
    if (view === "text") {
      setText(serializeDotenv(pairs));
      setTextEdited(true);
    }
    toast.success(`Incollate: ${pasteSummaryText(summary)}`, { description: "Premi Salva per applicarle." });
  }

  async function importFile(file: File) {
    // A .env is a few kilobytes; anything this size is the wrong file.
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Questo file è troppo grande per essere un .env");
      return;
    }
    setPaste({ key: Date.now(), text: await file.text() });
  }

  function reset() {
    setRows(saved.map(newRow));
    setRevealed(new Set());
    setServerProblems(new Map());
    setGeneral(null);
    setAttempted(false);
    if (view === "text") {
      setText(serializeDotenv(saved));
      setTextEdited(false);
    }
  }

  function save(deploy: boolean) {
    if (saving) return;
    setAttempted(true);
    if (textIssues.length > 0) {
      const lines = textIssues.map((issue) => issue.line).join(", ");
      toast.error(`Correggi ${textIssues.length === 1 ? "la riga non valida" : "le righe non valide"} del testo (${lines}) prima di salvare`);
      return;
    }
    const found = rowProblems(rows);
    const tooMany = listProblem(sent.pairs);
    setGeneral(tooMany);
    if (found.size > 0) {
      setSearch("");
      toast.error(found.size === 1 ? "Una variabile ha un problema: è segnata in rosso" : `${found.size} variabili hanno un problema: sono segnate in rosso`);
      return;
    }
    if (tooMany) {
      toast.error(tooMany);
      return;
    }
    // Emptying the set is allowed, but it deletes every stored variable.
    if (sent.pairs.length === 0) {
      if (saved.length > 0) setConfirmClear({ deploy });
      return;
    }
    void send(sent, deploy);
  }

  async function send(body: { pairs: EnvPair[]; ids: number[] }, deploy: boolean): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/projects/${projectId}/env`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: body.pairs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Back onto the rows they are about — the sent list skipped blank rows,
        // which is what `ids` accounts for.
        const mapped = serverIssuesToRows(data.details, body.ids);
        setServerProblems(mapped.rows);
        setGeneral(mapped.general);
        if (mapped.rows.size > 0) setSearch("");
        toast.error(data.error ?? MSG.saveFailed);
        return false;
      }

      setSaved(body.pairs);
      // The rows as sent: names trimmed, blank rows gone, ids kept — so the
      // save bar goes away and every row keeps its shown or hidden state.
      setRows(body.pairs.map((pair, i) => ({ id: body.ids[i], ...pair })));
      setServerProblems(new Map());
      setGeneral(null);
      setAttempted(false);
      if (view === "text") {
        setText(serializeDotenv(body.pairs));
        setTextEdited(false);
      }

      const count = typeof data.count === "number" ? data.count : body.pairs.length;
      const done = count === 0 ? "Variabili eliminate" : count === 1 ? "1 variabile salvata" : `${count} variabili salvate`;
      if (deploy) await redeploy(done);
      else toast.success(done, { description: "Valgono dal prossimo deploy o riavvio." });
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function redeploy(done: string) {
    try {
      const res = await fetch(api(`/api/projects/${projectId}/deploy`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "deploy" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`${done}, ma il deploy non è partito: ${data.details?.[0]?.message ?? data.error ?? "errore sconosciuto"}`);
        return;
      }
      toast.success(data.status === "queued" ? `${done}: il deploy partirà dopo quello in corso` : `${done}, deploy avviato`);
    } catch {
      toast.error(`${done}, ma il pannello non ha risposto alla richiesta di deploy`);
    }
  }

  const count = sent.pairs.length;

  return (
    <div className="space-y-4">
      {readOnly && (
        <Hint icon="solar:lock-keyhole-minimalistic-linear" title="Solo i nomi">
          Puoi vedere quali variabili ha il progetto, non i loro valori: per vederli o cambiarli serve il permesso di
          gestire il progetto.
        </Hint>
      )}

      <Panel className="space-y-3">
        <PanelHeader
          title="Variabili d'ambiente"
          description={
            count === 0
              ? "Impostazioni che l'app legge all'avvio: chiavi, password, indirizzi"
              : `${count === 1 ? "1 variabile" : `${count} variabili`}, cifrate nel pannello`
          }
          actions={
            <Segmented
              value={view}
              onChange={switchView}
              label="Vista"
              options={[
                { value: "table", label: "Tabella", icon: "solar:list-linear" },
                { value: "text", label: "Testo .env", icon: "solar:code-file-linear" },
              ]}
            />
          }
        />

        {/* Not while loading: an edit made now would go with the editor that the
            arriving data replaces. */}
        {!loading && (!readOnly || (view === "table" && rows.length > SEARCH_FROM)) && (
          <div className="flex flex-wrap items-center gap-2">
            {view === "table" && (rows.length > SEARCH_FROM || search) && (
              <div className="min-w-0 flex-1 basis-48">
                <SearchField value={search} onChange={setSearch} aria-label="Cerca una variabile">
                  <Label className="sr-only">Cerca una variabile</Label>
                  <Input placeholder="Cerca per nome" className="text-sm" />
                </SearchField>
              </div>
            )}
            {!readOnly && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".env,.env.local,.env.production,.env.example,text/plain"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.target.value = "";
                }}
              />
              {view === "table" && rows.length > 0 && (
                <Button variant="ghost" size="sm" onPress={() => setRevealed(allRevealed ? new Set() : new Set(rows.map((row) => row.id)))}>
                  <Icon icon={allRevealed ? "solar:eye-closed-linear" : "solar:eye-linear"} width={16} aria-hidden />
                  {allRevealed ? "Nascondi i valori" : "Mostra i valori"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onPress={() => fileInputRef.current?.click()}>
                <Icon icon="solar:import-linear" width={16} aria-hidden />
                Importa file
              </Button>
              <Button variant="outline" size="sm" onPress={() => setPaste({ key: Date.now(), text: "" })}>
                <Icon icon="solar:clipboard-text-linear" width={16} aria-hidden />
                Incolla .env
              </Button>
              {view === "table" && (
                <Button variant="outline" size="sm" onPress={addRow}>
                  <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                  Aggiungi
                </Button>
              )}
            </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBlock key={i} className="h-10" />
            ))}
          </div>
        ) : view === "text" ? (
          <EnvTextView
            text={text}
            readOnly={readOnly}
            invalid={textEdited ? (parsedText?.invalid ?? []) : []}
            duplicates={textEdited ? (parsedText?.duplicates ?? []) : []}
            onChange={editText}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="solar:key-linear"
            title="Nessuna variabile"
            description={
              readOnly
                ? "Questo progetto non ha variabili d'ambiente."
                : "Il modo più rapido è incollare il file .env che usi in locale. Le variabili sono cifrate nel pannello e arrivano all'app al deploy."
            }
            action={
              !readOnly && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" variant="secondary" onPress={() => setPaste({ key: Date.now(), text: "" })}>
                    Incolla un .env
                  </Button>
                  <Button size="sm" variant="ghost" onPress={addRow}>
                    Aggiungi a mano
                  </Button>
                </div>
              )
            }
          />
        ) : shownRows.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">Nessuna variabile si chiama così.</p>
        ) : (
          <EnvTable
            rows={shownRows}
            revealed={revealed}
            problems={problems}
            buildPrefixes={prefixOf}
            overrides={overrides}
            focusId={focusId}
            context={context}
          />
        )}

        {hiddenProblems > 0 && (
          <p className="text-danger text-meta">
            {hiddenProblems === 1 ? "Una variabile con un problema è nascosta" : `${hiddenProblems} variabili con un problema sono nascoste`} dalla
            ricerca.
          </p>
        )}
        {general && (
          <p role="alert" className="text-danger text-sm">
            {general}
          </p>
        )}
        {!readOnly && rows.length > 0 && (
          <FieldHint className="mt-0">
            Salvare non riavvia l&apos;app: le variabili valgono dal prossimo deploy o riavvio.
            {canRedeploy && <> «Salva e ridistribuisci» fa le due cose insieme.</>}
          </FieldHint>
        )}
      </Panel>

      {linked.length > 0 ? (
        <EnvLinkedVars services={linked} userKeys={userKeys} onChanged={() => void refreshServices()} />
      ) : (
        !readOnly && <ServiceLinkHint projectId={projectId} />
      )}

      {/* Reference rather than instructions: under the editor and closed, so the
          thing you came here to do is the first thing on screen. */}
      <Section
        title="Come vengono usate"
        summary={
          runtimeType === "docker"
            ? "Variabili al build, quelle che mette RunPanel, host.docker.internal"
            : "Variabili al build e quelle che mette RunPanel"
        }
      >
        <BuildEnvHint prefixes={buildEnvPrefixes} />
        <ManagedEnvHint runtimeType={runtimeType} />
        {runtimeType === "docker" && (
          <Hint>
            Questo progetto gira in un container: per raggiungere qualcosa che sta sulla macchina host — un database
            installato lì, un altro servizio già attivo — usa <Code>host.docker.internal</Code> al posto di{" "}
            <Code>localhost</Code>, che dentro il container è il container stesso.
          </Hint>
        )}
      </Section>

      {/* Pinned to the viewport instead of parked at the end of the list: with
          twenty variables the button used to be a scroll away from whichever
          row you were editing. */}
      <StickySaveBar
        isDirty={dirty}
        isPending={saving}
        onSave={() => save(false)}
        onReset={reset}
        message={
          textIssues.length > 0
            ? `${textIssues.length === 1 ? "1 riga non valida" : `${textIssues.length} righe non valide`} nel testo`
            : changes === 1
              ? "1 modifica non salvata"
              : `${changes} modifiche non salvate`
        }
        saveLabel="Salva"
        secondaryLabel={canRedeploy ? "Salva e ridistribuisci" : undefined}
        onSecondary={canRedeploy ? () => save(true) : undefined}
      />

      {paste && (
        <EnvPasteDialog
          key={paste.key}
          isOpen
          onOpenChange={(open) => {
            if (!open) setPaste(null);
          }}
          existing={sent.pairs}
          initialText={paste.text}
          onApply={applyPaste}
        />
      )}

      <ConfirmDialog
        isOpen={confirmClear !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmClear(null);
        }}
        title="Eliminare tutte le variabili?"
        description="Il progetto resterà senza variabili d'ambiente. Vale dal prossimo deploy o riavvio."
        confirmLabel="Elimina tutte"
        destructive
        onConfirm={async () => (await send({ pairs: [], ids: [] }, confirmClear?.deploy ?? false)) ? undefined : false}
      />

      <ConfirmDialog
        isOpen={confirmLeaveText}
        onOpenChange={setConfirmLeaveText}
        title="Tornare alla tabella?"
        description={
          textIssues.length === 1
            ? `La riga ${textIssues[0].line} non è valida e non entra nella tabella: tornando alla tabella si perde.`
            : `Le righe ${textIssues.map((issue) => issue.line).join(", ")} non sono valide e non entrano nella tabella: tornando alla tabella si perdono.`
        }
        confirmLabel="Torna alla tabella"
        cancelLabel="Resta sul testo"
        onConfirm={() => {
          setTextEdited(false);
          setView("table");
        }}
      />
    </div>
  );
}
