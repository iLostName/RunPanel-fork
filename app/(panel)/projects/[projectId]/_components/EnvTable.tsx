"use client";

import { memo } from "react";
import { Button, Input, TextArea, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/Badge";
import { RowMenu, type RowAction } from "@/components/ui/ListRow";
import { Tip, TipText } from "@/components/ui/Tooltip";
import { Technical } from "@/components/ui/Technical";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { EnvPair, EnvRow, RowProblem } from "@/lib/env-table";

/** What every row needs to know besides itself, decided once by the tab. */
export interface EnvRowContext {
  readOnly: boolean;
  isDocker: boolean;
  onChange: (id: number, patch: Partial<EnvPair>) => void;
  onRemove: (id: number) => void;
  onToggleReveal: (id: number) => void;
}

/**
 * The variables as a table: name, value, and what happens to each.
 *
 * Values are hidden until asked for, one row at a time, so opening the tab in
 * front of somebody does not put every secret on the screen. The ones in this
 * browser are the ones the API sent, which it does only to who may manage the
 * project: below that the rows arrive with dots for values and nothing here
 * can show more.
 */
export function EnvTable({
  rows,
  revealed,
  problems,
  buildPrefixes,
  overrides,
  focusId,
  context,
}: {
  rows: readonly EnvRow[];
  revealed: ReadonlySet<number>;
  problems: ReadonlyMap<number, RowProblem>;
  buildPrefixes: (key: string) => string | null;
  /** Name → the linked database that replaces it at every deploy. */
  overrides: ReadonlyMap<string, string>;
  focusId: number | null;
  context: EnvRowContext;
}) {
  return (
    <div>
      <div className="text-muted hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem] gap-2 pb-1 text-meta sm:grid">
        <span>Nome</span>
        <span>Valore</span>
        <span className="sr-only">Azioni</span>
      </div>
      <ul className="divide-separator divide-y">
        {rows.map((row) => (
          <EnvRowView
            key={row.id}
            row={row}
            revealed={revealed.has(row.id)}
            keyError={problems.get(row.id)?.key}
            valueError={problems.get(row.id)?.value}
            buildPrefix={buildPrefixes(row.key)}
            override={overrides.get(row.key.trim()) ?? null}
            autoFocus={row.id === focusId}
            context={context}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One row. memo()'d with only primitives and the row itself as props, so a
 * keystroke re-renders the row being typed in and not the other 499.
 */
const EnvRowView = memo(function EnvRowView({
  row,
  revealed,
  keyError,
  valueError,
  buildPrefix,
  override,
  autoFocus,
  context,
}: {
  row: EnvRow;
  revealed: boolean;
  keyError?: string;
  valueError?: string;
  buildPrefix: string | null;
  override: string | null;
  autoFocus: boolean;
  context: EnvRowContext;
}) {
  const { readOnly, onChange, onRemove, onToggleReveal } = context;
  const name = row.key.trim() || "questa variabile";

  const actions: RowAction[] = [
    {
      id: "copy-key",
      label: "Copia il nome",
      icon: "solar:copy-linear",
      disabled: !row.key.trim(),
      onAction: () => void copy(row.key.trim(), "Nome copiato"),
    },
    ...(readOnly
      ? []
      : [
          { id: "copy-value", label: "Copia il valore", icon: "solar:copy-linear", onAction: () => void copy(row.value, "Valore copiato") },
          { id: "remove", label: "Rimuovi", icon: "solar:trash-bin-minimalistic-linear", danger: true, onAction: () => onRemove(row.id) },
        ]),
  ];

  return (
    <li className="space-y-1.5 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]">
        <div className="col-span-2 sm:col-span-1">
          <TextField
            aria-label="Nome della variabile"
            value={row.key}
            onChange={(key) => onChange(row.id, { key })}
            isReadOnly={readOnly}
            isInvalid={Boolean(keyError)}
            autoFocus={autoFocus}
          >
            <Input placeholder="NOME_VARIABILE" className="font-mono text-sm" autoComplete="off" spellCheck={false} autoCapitalize="off" />
          </TextField>
        </div>

        <div className="min-w-0">
          <ValueCell row={row} name={name} readOnly={readOnly} revealed={revealed} invalid={Boolean(valueError)} onChange={onChange} onReveal={() => onToggleReveal(row.id)} />
        </div>

        <div className="flex items-center justify-end gap-0.5 pt-0.5">
          {!readOnly && (
            <Tip content={revealed ? "Nascondi il valore" : "Mostra il valore"}>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={revealed ? `Nascondi il valore di ${name}` : `Mostra il valore di ${name}`}
                onPress={() => onToggleReveal(row.id)}
              >
                <Icon icon={revealed ? "solar:eye-closed-linear" : "solar:eye-linear"} width={16} aria-hidden />
              </Button>
            </Tip>
          )}
          <RowMenu label={`Azioni per ${name}`} actions={actions} />
        </div>
      </div>

      {(buildPrefix || override) && (
        <div className="flex flex-wrap gap-1.5">
          {buildPrefix && (
            <TipText
              content={
                <>
                  Il build la scrive dentro il codice che arriva al browser: chiunque apra il sito può leggerla. Non
                  metterci password o chiavi segrete.
                  <Technical>
                    {" "}
                    Prefisso {buildPrefix}.{" "}
                    {context.isDocker
                      ? "Al build Docker arriva come --build-arg: il Dockerfile deve dichiararla con ARG."
                      : "Nei progetti nativi il build vede tutte le variabili; queste in più finiscono nel bundle."}
                  </Technical>
                </>
              }
            >
              <Badge tone="accent" icon="solar:box-linear">
                usata nella build
              </Badge>
            </TipText>
          )}
          {override && (
            <TipText
              content={`Il database collegato «${override}» imposta ${row.key.trim()} a ogni deploy: questo valore viene ignorato finché il collegamento è acceso.`}
            >
              <Badge tone="warning" icon="solar:database-linear">
                {`vince il database ${override}`}
              </Badge>
            </TipText>
          )}
        </div>
      )}

      {(keyError || valueError) && (
        <p role="alert" className="text-danger text-meta leading-relaxed">
          {keyError ?? valueError}
        </p>
      )}
    </li>
  );
});

/** Dots until asked; a text area for a value over several lines, which an input would flatten. */
function ValueCell({
  row,
  name,
  readOnly,
  revealed,
  invalid,
  onChange,
  onReveal,
}: {
  row: EnvRow;
  name: string;
  readOnly: boolean;
  revealed: boolean;
  invalid: boolean;
  onChange: (id: number, patch: Partial<EnvPair>) => void;
  onReveal: () => void;
}) {
  const box = "border-border bg-field flex min-h-9 w-full items-center rounded-[var(--radius)] border px-3 py-1.5 text-left font-mono text-sm";

  // The API sent dots: there is nothing here to show.
  if (readOnly) return <div className={cn(box, "text-muted")}>{row.value === "" ? <Empty /> : "••••••••"}</div>;

  if (!revealed) {
    return (
      <button
        type="button"
        onClick={onReveal}
        aria-label={`Mostra il valore di ${name}`}
        className={cn(box, "text-muted hover:bg-surface-hover transition-colors", invalid && "border-danger")}
      >
        {/* Always eight: the length of a secret is part of the secret. */}
        {row.value === "" ? <Empty /> : "••••••••"}
      </button>
    );
  }

  const multiline = row.value.includes("\n");
  return (
    <TextField aria-label={`Valore di ${name}`} value={row.value} onChange={(value) => onChange(row.id, { value })} isInvalid={invalid}>
      {multiline ? (
        <TextArea
          rows={Math.min(8, row.value.split("\n").length)}
          className="font-mono text-sm"
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <Input
          placeholder="valore"
          className="font-mono text-sm"
          // Not a password field, and no password manager should treat it as one.
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          onPaste={(event) => {
            // An input drops the newlines of what is pasted into it, and a
            // private key without its newlines is a key no library will read.
            const pasted = event.clipboardData.getData("text");
            if (!/[\r\n]/.test(pasted)) return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart ?? row.value.length;
            const end = input.selectionEnd ?? row.value.length;
            onChange(row.id, { value: row.value.slice(0, start) + pasted.replace(/\r\n?/g, "\n") + row.value.slice(end) });
          }}
        />
      )}
    </TextField>
  );
}

function Empty() {
  return <span className="text-muted font-sans italic">vuota</span>;
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Copia non riuscita: il browser non lo permette qui");
  }
}
