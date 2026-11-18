"use client";

import { TextArea, TextField } from "@heroui/react";
import { Code, FieldHint } from "@/components/ui/Hint";
import type { ParsedEnv } from "@/lib/dotenv-parse";

/**
 * The same variables as a `.env` file.
 *
 * What is typed here is read with the parser the paste dialog and the new
 * project wizard use, and becomes the table: the two views edit one list. A
 * line the parser cannot read is shown with its number and kept out of the
 * list — never dropped without a word — and saving waits until it is fixed.
 */
export function EnvTextView({
  text,
  readOnly,
  invalid,
  duplicates,
  onChange,
}: {
  text: string;
  readOnly: boolean;
  invalid: ParsedEnv["invalid"];
  duplicates: readonly string[];
  onChange: (text: string) => void;
}) {
  const lines = text.split("\n").length;

  return (
    <div className="space-y-2">
      <TextField aria-label="Variabili in formato .env" value={text} onChange={onChange} isReadOnly={readOnly}>
        <TextArea
          rows={Math.min(24, Math.max(8, lines + 1))}
          placeholder={"API_KEY=…\nDATABASE_URL=…"}
          className="font-mono text-sm"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          // A spell checker that sends text to a server would send the secrets.
          spellCheck={false}
        />
      </TextField>

      <FieldHint className="mt-0">
        {readOnly ? (
          "I valori sono nascosti: qui ci sono solo i nomi."
        ) : (
          <>
            Una variabile per riga, <Code>NOME=valore</Code>. Un valore con spazi all&apos;inizio o alla fine, con{" "}
            <Code>#</Code> o su più righe va tra virgolette doppie. I commenti non vengono salvati. In questa vista i
            valori sono visibili.
          </>
        )}
      </FieldHint>

      {invalid.length > 0 && (
        <ul role="alert" className="text-danger space-y-1 text-sm">
          {invalid.map((issue) => (
            <li key={issue.line}>
              Riga {issue.line}: {issue.reason}
            </li>
          ))}
        </ul>
      )}
      {duplicates.length > 0 && (
        <p className="text-warning text-sm">Ripetute: {duplicates.join(", ")}. Vale l&apos;ultima.</p>
      )}
    </div>
  );
}
