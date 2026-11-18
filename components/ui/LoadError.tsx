"use client";

import { Button } from "@heroui/react";
import { readableError } from "@/lib/error-text";
import { Hint } from "./Hint";

/**
 * The raw error, folded away: of no use to most readers, and the one thing an
 * operator needs when the sentence above it is not enough.
 */
export function ErrorDetail({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null;
  return (
    <details className="text-muted mt-1 text-xs">
      <summary className="cursor-pointer select-none">Dettaglio tecnico</summary>
      <code className="mt-1 block font-mono break-all">{detail}</code>
    </details>
  );
}

/**
 * What a section shows when its data did not load.
 *
 * Without it a failed fetch looked like an empty list or a clean verdict, and
 * an editor seeded from "nothing" could save that nothing over the real data.
 * A section that failed to load renders this instead of its content.
 *
 * `error` can be whatever the request threw; it is put into words here, so no
 * caller has to. A refusal offers no retry: the answer would be the same.
 */
export function LoadError({
  error,
  onRetry,
  what = "i dati",
  note,
  className,
}: {
  error: string;
  onRetry?: () => void;
  /** What failed to load, as it reads after "Impossibile caricare". */
  what?: string;
  /** A sentence after the error: what happens next. Not shown on a refusal. */
  note?: string;
  className?: string;
}) {
  const { text, detail, forbidden } = readableError(error);
  return (
    <div role="alert" className={className}>
      <Hint tone="warn" title={`Impossibile caricare ${what}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="break-words">{note && !forbidden ? `${text}. ${note}` : text}</span>
          {onRetry && !forbidden && (
            <Button size="sm" variant="secondary" onPress={onRetry}>
              Riprova
            </Button>
          )}
        </div>
        <ErrorDetail detail={detail} />
      </Hint>
    </div>
  );
}
