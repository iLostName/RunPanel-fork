"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldHint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { useNodeApi } from "@/lib/hooks/useNode";
import {
  KEY_MISSING,
  countChanges,
  listProblem,
  pasteSummaryText,
  rowProblems,
  rowsToPairs,
  serverIssuesToRows,
  type EnvPair,
  type EnvRow,
  type PasteSummary,
  type RowProblem,
} from "@/lib/env-table";
// The project tab's table and paste dialog: one way to edit variables in the panel.
import { EnvTable, type EnvRowContext } from "@/app/(panel)/projects/[projectId]/_components/EnvTable";
import { EnvPasteDialog } from "@/app/(panel)/projects/[projectId]/_components/EnvPasteDialog";

let rowSeq = 0;
const newRow = (pair: EnvPair): EnvRow => ({ id: ++rowSeq, key: pair.key, value: pair.value });
const NO_OVERRIDES: ReadonlyMap<string, string> = new Map();
const noPrefix = () => null;

export interface SaveResult {
  changed: boolean;
  /** Projects the change reaches, for the offer to redeploy them. */
  affected: number;
}

/**
 * A group's variables, edited the way a project's are: the same table, the
 * same rules, saved whole with one bar. Values hidden until asked for, one row
 * at a time; references are checked by the server, and what it refuses comes
 * back onto the row that has it.
 */
export function GroupVarsEditor({
  groupId,
  initialVars,
  onSaved,
}: {
  groupId: string;
  initialVars: EnvPair[];
  onSaved: (result: SaveResult) => void;
}) {
  const api = useNodeApi();
  const [saved, setSaved] = useState<EnvPair[]>(() => initialVars);
  const [rows, setRows] = useState<EnvRow[]>(() => initialVars.map(newRow));
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [serverProblems, setServerProblems] = useState<ReadonlyMap<number, RowProblem>>(() => new Map());
  const [general, setGeneral] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [paste, setPaste] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const sent = useMemo(() => rowsToPairs(rows), [rows]);
  const changes = useMemo(() => countChanges(saved, sent.pairs), [saved, sent]);
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
  const context = useMemo<EnvRowContext>(
    () => ({ readOnly: false, isDocker: false, onChange: changeRow, onRemove: removeRow, onToggleReveal: toggleReveal }),
    [changeRow, removeRow, toggleReveal]
  );
  const allRevealed = rows.length > 0 && rows.every((row) => revealed.has(row.id));

  function addRow() {
    const row = newRow({ key: "", value: "" });
    setRows((current) => [...current, row]);
    setRevealed((current) => new Set(current).add(row.id));
    setFocusId(row.id);
  }

  function applyPaste(pairs: EnvPair[], summary: PasteSummary) {
    const ids = new Map(rows.map((row) => [row.key.trim(), row.id]));
    setRows(pairs.map((pair) => (ids.has(pair.key) ? { id: ids.get(pair.key) as number, ...pair } : newRow(pair))));
    toast.success(`Incollate: ${pasteSummaryText(summary)}`, { description: "Premi Salva per applicarle." });
  }

  function reset() {
    setRows(saved.map(newRow));
    setRevealed(new Set());
    setServerProblems(new Map());
    setGeneral(null);
    setAttempted(false);
  }

  function save() {
    if (saving) return;
    setAttempted(true);
    const found = rowProblems(rows);
    const tooMany = listProblem(sent.pairs);
    setGeneral(tooMany);
    if (found.size > 0) {
      toast.error(found.size === 1 ? "Una variabile ha un problema: è segnata in rosso" : `${found.size} variabili hanno un problema: sono segnate in rosso`);
      return;
    }
    if (tooMany) {
      toast.error(tooMany);
      return;
    }
    if (sent.pairs.length === 0 && saved.length > 0) {
      setConfirmClear(true);
      return;
    }
    void send(sent);
  }

  async function send(body: { pairs: EnvPair[]; ids: number[] }): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/env-groups/${groupId}/vars`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: body.pairs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const mapped = serverIssuesToRows(data.details, body.ids);
        setServerProblems(mapped.rows);
        setGeneral(mapped.general ?? (mapped.rows.size === 0 ? (data.error ?? null) : null));
        toast.error(data.error ?? MSG.saveFailed);
        return false;
      }
      setSaved(body.pairs);
      setRows(body.pairs.map((pair, i) => ({ id: body.ids[i], ...pair })));
      setServerProblems(new Map());
      setGeneral(null);
      setAttempted(false);
      toast.success(body.pairs.length === 1 ? "1 variabile salvata" : `${body.pairs.length} variabili salvate`, {
        description: "Valgono dal prossimo deploy o riavvio dei progetti che usano il gruppo.",
      });
      onSaved({ changed: data.changed !== false, affected: typeof data.affected === "number" ? data.affected : 0 });
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel className="space-y-3">
      <PanelHeader
        title="Variabili"
        description={sent.pairs.length === 0 ? "Nessuna variabile, per ora" : `${sent.pairs.length === 1 ? "1 variabile" : `${sent.pairs.length} variabili`}, cifrate nel pannello`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {rows.length > 0 && (
              <Button variant="ghost" size="sm" onPress={() => setRevealed(allRevealed ? new Set() : new Set(rows.map((row) => row.id)))}>
                <Icon icon={allRevealed ? "solar:eye-closed-linear" : "solar:eye-linear"} width={16} aria-hidden />
                {allRevealed ? "Nascondi i valori" : "Mostra i valori"}
              </Button>
            )}
            <Button variant="outline" size="sm" onPress={() => setPaste(Date.now())}>
              <Icon icon="solar:clipboard-text-linear" width={16} aria-hidden />
              Incolla .env
            </Button>
            <Button variant="outline" size="sm" onPress={addRow}>
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Aggiungi
            </Button>
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="solar:key-linear"
          title="Nessuna variabile"
          description="Incolla un .env o aggiungile una alla volta: arrivano a ogni progetto che collega il gruppo."
        />
      ) : (
        <EnvTable
          rows={rows}
          revealed={revealed}
          problems={problems}
          buildPrefixes={noPrefix}
          overrides={NO_OVERRIDES}
          focusId={focusId}
          context={context}
        />
      )}

      {general && (
        <p role="alert" className="text-danger text-sm">
          {general}
        </p>
      )}
      <FieldHint className="mt-0">
        Un valore può leggere quello di un altro gruppo, di un database o di un progetto con un riferimento, come nella scheda
        Variabili dei progetti. Per scrivere {"${{"} così com&apos;è usa {"$${{"}.
      </FieldHint>

      <StickySaveBar
        isDirty={changes > 0}
        isPending={saving}
        onSave={save}
        onReset={reset}
        message={changes === 1 ? "1 modifica non salvata" : `${changes} modifiche non salvate`}
        saveLabel="Salva"
      />

      {paste !== null && (
        <EnvPasteDialog
          key={paste}
          isOpen
          onOpenChange={(open) => {
            if (!open) setPaste(null);
          }}
          existing={sent.pairs}
          initialText=""
          onApply={applyPaste}
        />
      )}

      <ConfirmDialog
        isOpen={confirmClear}
        onOpenChange={setConfirmClear}
        title="Togliere tutte le variabili?"
        description="Il gruppo resta, vuoto: dal prossimo deploy o riavvio i progetti che lo usano non ne ricevono più nessuna."
        confirmLabel="Togli tutte"
        destructive
        onConfirm={async () => ((await send({ pairs: [], ids: [] })) ? undefined : false)}
      />
    </Panel>
  );
}
