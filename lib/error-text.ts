/**
 * What a failed request means, in the words the operator should read.
 *
 * `useResource` throws `HTTP 500`, the browser says `Failed to fetch`, Node
 * says `ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3988`. All true, none of
 * them a sentence, and they reached the screen as they were. The raw string
 * stays available as `detail` where it helps someone debugging; a message that
 * is already a sentence (the routes answer in Italian) passes through untouched.
 *
 * No imports, so the unit suites load it directly.
 */

export interface ReadableError {
  text: string;
  /** The original, when it says more than `text`. Null when it adds nothing. */
  detail: string | null;
  /** Refused, not failed: asking again gets the same answer. */
  forbidden: boolean;
}

export const FORBIDDEN_TEXT = "Non hai il permesso di vedere questa pagina";

/** What the browser reports when the request never reached the panel. */
const BROWSER_NETWORK = /^(Failed to fetch|NetworkError\b|Load failed|Network request failed|Request failed|Errore di rete)/i;

/**
 * What `services/cluster/client.ts` reports when a server did not answer: a
 * system or TLS code, on its own or as `CODE: message`.
 */
const SERVER_DOWN = /^[A-Z][A-Z0-9_]{3,}(:|$)|^fetch failed$|^socket hang up/;

const HTTP_STATUS = /^(?:HTTP|Il server ha risposto)\s+(\d{3})\b/;

function statusText(status: number, fromServer: boolean): string {
  // A member refusing this panel's signature is not the reader's session.
  if (status === 401) return fromServer ? "Il server non riconosce questo pannello" : "Sessione scaduta: accedi di nuovo";
  if (status === 404) return "Non trovato: potrebbe essere stato eliminato";
  if (status === 429) return "Troppe richieste: riprova tra poco";
  if (status === 502 || status === 503 || status === 504) return "Il server non risponde";
  if (status >= 500) return "Errore interno del server";
  return "Il server ha rifiutato la richiesta";
}

export function readableError(raw: string): ReadableError {
  const http = HTTP_STATUS.exec(raw);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { text: FORBIDDEN_TEXT, detail: null, forbidden: true };
    return { text: statusText(status, raw.endsWith("dal server")), detail: raw, forbidden: false };
  }
  // The routes' own refusals, which arrive already written.
  if (raw.startsWith("Non hai il permesso")) return { text: FORBIDDEN_TEXT, detail: null, forbidden: true };
  if (raw.startsWith("Solo il proprietario")) return { text: raw, detail: null, forbidden: true };

  if (BROWSER_NETWORK.test(raw)) return { text: "Non riesco a contattare il pannello", detail: null, forbidden: false };
  if (SERVER_DOWN.test(raw)) return { text: "Server non raggiungibile", detail: raw, forbidden: false };
  return { text: raw, detail: null, forbidden: false };
}

/**
 * The bracket after "non disponibile per il tuo account". Empty for a refusal:
 * the sentence has already said it, and saying it again in brackets adds nothing.
 */
export function refusalNote(raw: string | null): string {
  if (!raw) return "";
  const { text, forbidden } = readableError(raw);
  return forbidden ? "" : ` (${text})`;
}
