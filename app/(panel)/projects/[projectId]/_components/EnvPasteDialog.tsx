"use client";

import { useMemo, useState } from "react";
import { TextArea, TextField } from "@heroui/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Segmented } from "@/components/ui/Segmented";
import { mergeEnv, parseDotenv } from "@/lib/dotenv-parse";
import { pasteSummary, pasteSummaryText, type EnvPair, type PasteMode, type PasteSummary } from "@/lib/env-table";

/**
 * A `.env` pasted over the variables there are.
 *
 * Adds, never removes: whatever the file does not mention stays as it is. For
 * a name that is already there with another value, the operator says once
 * which one wins, and the dialog says what the paste is about to do before it
 * does it — "3 aggiunte, 1 sostituita, 2 uguali". Nothing is saved here: the
 * result lands in the editor and waits for "Salva" like any other edit.
 *
 * Mounted per opening (the parent keys it), so each paste starts empty, or
 * with the file that was just chosen.
 */
export function EnvPasteDialog({
  isOpen,
  onOpenChange,
  existing,
  initialText,
  onApply,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  existing: readonly EnvPair[];
  initialText: string;
  onApply: (vars: EnvPair[], summary: PasteSummary) => void;
}) {
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState<PasteMode>("overwrite");
  const parsed = useMemo(() => parseDotenv(text), [text]);
  const summary = useMemo(() => pasteSummary(existing, parsed.vars, mode), [existing, parsed, mode]);
  const read = parsed.vars.length;

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Incolla un file .env"
      description="Le variabili lette si aggiungono a quelle che ci sono già. Niente viene salvato finché non premi Salva."
      submitLabel="Aggiungi alle variabili"
      isSubmitDisabled={read === 0}
      wide
      onSubmit={() => onApply(mergeEnv(existing, parsed.vars, mode).vars, summary)}
    >
      <TextField aria-label="Contenuto del file .env" value={text} onChange={setText} autoFocus>
        <TextArea
          rows={10}
          placeholder={"API_KEY=…\nDATABASE_URL=postgresql://…"}
          className="font-mono text-sm"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </TextField>

      <div className="space-y-1.5">
        <p className="text-foreground text-sm">Se una variabile c&apos;è già con un altro valore</p>
        <Segmented
          value={mode}
          onChange={setMode}
          label="Se una variabile c'è già"
          options={[
            { value: "overwrite", label: "Sovrascrivi" },
            { value: "skip", label: "Salta" },
          ]}
        />
      </div>

      {read > 0 && (
        <p role="status" className="text-muted text-sm">
          {read === 1 ? "1 variabile letta" : `${read} variabili lette`}:{" "}
          <span className="text-foreground font-medium">{pasteSummaryText(summary)}</span>.
        </p>
      )}

      {parsed.invalid.length > 0 && (
        <ul role="alert" className="text-danger space-y-1 text-sm">
          {parsed.invalid.map((issue) => (
            <li key={issue.line}>
              Riga {issue.line}: {issue.reason}. Non viene aggiunta.
            </li>
          ))}
        </ul>
      )}
      {parsed.duplicates.length > 0 && (
        <p className="text-warning text-sm">Ripetute nel file: {parsed.duplicates.join(", ")}. Vale l&apos;ultima.</p>
      )}
    </FormDialog>
  );
}
