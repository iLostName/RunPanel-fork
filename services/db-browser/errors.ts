import { explainEngineError } from "@/lib/db-browser/output";
import type { EngineRun } from "./exec";

/**
 * A refusal or a failure the page can show as it is: an Italian sentence, an
 * HTTP status, and the engine's own words folded under "Dettaglio tecnico".
 *
 * The detail is the engine's message, never its output: an error can quote
 * the statement that caused it, which the person typed, but not the rows.
 */
export class BrowseError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "BrowseError";
    this.status = status;
    this.detail = detail;
  }
}

export const STOPPED = "Il database è fermo: avvialo per vedere i dati.";

/**
 * What went wrong with a call that did not end well, in order of what the
 * person can do about it. `message` is the engine's error, already cleaned.
 */
export function runFailure(run: EngineRun, message: string, seconds: number): BrowseError {
  if (run.timedOut) {
    return new BrowseError(`Il database non ha risposto entro ${seconds} secondi: la lettura è stata interrotta.`, 504);
  }
  if (run.overflow) {
    return new BrowseError(
      "Il risultato è troppo grande da mostrare qui. Chiedi meno colonne o meno righe, oppure usa la console.",
      413
    );
  }
  const docker = run.stderr;
  if (/is not running|No such container/i.test(docker)) return new BrowseError(STOPPED, 409);
  const text = message.trim() || docker.trim() || `Lettura non riuscita (codice ${run.code ?? "sconosciuto"})`;
  return new BrowseError(explainEngineError(text) ?? text, 422, text);
}

/** The client program is not in the image: said plainly, since retrying will not help. */
export function missingClient(run: EngineRun): boolean {
  return /executable file not found|no such file or directory/i.test(run.stderr) && run.code !== 0;
}
