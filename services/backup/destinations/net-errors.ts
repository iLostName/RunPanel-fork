import { clip, problem, type DestinationProblem } from "./problem";

/**
 * A request over HTTP that never got an answer: what `fetch` threw, said in
 * Italian.
 *
 * The same walk as the S3 adapter's (lib/s3-errors.ts) — Node's fetch says
 * "fetch failed" and hides the reason in `cause`, sometimes twice — with
 * sentences about a server of one's own rather than about buckets, for the
 * destinations that talk HTTP: WebDAV today.
 */

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function chain(err: unknown): { codes: string[]; messages: string[]; names: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  const names: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return;
    seen.add(value);
    const e = value as ErrorLike;
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.message === "string") messages.push(e.message);
    if (typeof e.name === "string") names.push(e.name);
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) for (const inner of e.errors) visit(inner, depth + 1);
  };
  visit(err, 0);
  return { codes, messages, names };
}

const TLS_UNTRUSTED = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

export interface NetContext {
  host: string;
  /** An upload whose connection is reset was most often refused, not cut. */
  uploading: boolean;
}

export function describeNetworkError(err: unknown, ctx: NetContext): DestinationProblem {
  const { codes, messages, names } = chain(err);
  const has = (...wanted: string[]) => codes.some((code) => wanted.includes(code));
  const said = (pattern: RegExp) => messages.some((message) => pattern.test(message));
  const detail = clip([...new Set([...codes, ...messages])].join(" · ") || String(err), 300);
  const out = (code: string, cause: string, fix: string) => problem(code, cause, fix, detail);
  const host = ctx.host;

  if (names.includes("TimeoutError") || has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "ESOCKETTIMEDOUT")) {
    return out(
      "TIMEOUT",
      `${host} non ha risposto in tempo.`,
      "Controlla l'indirizzo e che questo server possa raggiungerlo su quella porta (firewall, router, VPN)."
    );
  }
  if (names.includes("AbortError")) {
    return out("ABORTED", "L'operazione è stata annullata prima di finire.", "Riprova quando vuoi: un archivio interrotto non prende mai il suo nome definitivo.");
  }
  if (has("ENOTFOUND", "EAI_NONAME")) {
    return out("DNS", `L'indirizzo ${host} non esiste.`, "Controlla di averlo scritto giusto, per intero (per esempio cloud.esempio.it).");
  }
  if (has("EAI_AGAIN")) {
    return out("DNS_UNAVAILABLE", "Il DNS di questo server non risponde.", "Riprova tra poco; se continua, controlla la configurazione di rete del server.");
  }
  if (has("ECONNREFUSED")) {
    return out("REFUSED", `Nessun servizio risponde su ${host}.`, "Controlla indirizzo e porta (su Synology WebDAV usa 5006 in https, 5005 in http) e che il servizio sia acceso.");
  }
  if (has("EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL")) {
    return out("UNREACHABLE", `La rete di questo server non arriva a ${host}.`, "Controlla la connessione del server; se il servizio è in un'altra rete, serve una VPN o un indirizzo pubblico.");
  }
  if (has("CERT_HAS_EXPIRED")) {
    return out("TLS_EXPIRED", `Il certificato HTTPS di ${host} è scaduto.`, "Va rinnovato sul server del servizio.");
  }
  if (has("ERR_TLS_CERT_ALTNAME_INVALID") || said(/Hostname\/IP does not match certificate/i)) {
    return out("TLS_NAME", `Il certificato HTTPS non vale per ${host}.`, "Scrivi l'indirizzo con lo stesso nome del certificato (quello con cui apri il sito nel browser).");
  }
  if (codes.some((code) => TLS_UNTRUSTED.has(code))) {
    return out(
      "TLS_UNTRUSTED",
      `Il certificato HTTPS di ${host} non è firmato da un'autorità riconosciuta.`,
      "Usa un certificato valido (per esempio Let's Encrypt); dentro una rete privata puoi usare http:// verso un indirizzo privato."
    );
  }
  if (has("ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO") || said(/wrong version number|packet length too long/i)) {
    return out("TLS_NOT_HTTPS", `${host} non parla HTTPS su quella porta.`, "Se il servizio è in http, scrivi l'indirizzo con http:// (ammesso solo verso indirizzi privati); altrimenti controlla la porta.");
  }
  if (codes.some((code) => /^(ERR_TLS|ERR_SSL|CERT_)/.test(code)) || said(/certificate|ssl|tls/i)) {
    return out("TLS", `La connessione sicura con ${host} non è riuscita.`, "Controlla il certificato HTTPS del servizio e che l'indirizzo sia giusto.");
  }
  if (has("UND_ERR_BODY_TIMEOUT")) {
    return out("STALLED", "Il trasferimento si è fermato a metà.", "Rete lenta o instabile tra questo server e il servizio: riprova.");
  }
  if (has("UND_ERR_REQ_CONTENT_LENGTH_MISMATCH")) {
    return out("LOCAL_CHANGED", "L'archivio è cambiato sul disco di questo server mentre veniva caricato.", "Riprova il backup.");
  }
  if (has("ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNABORTED") || said(/other side closed|socket hang up|terminated/i)) {
    return out(
      "RESET",
      `${host} ha chiuso la connessione a metà trasferimento.`,
      ctx.uploading
        ? "Con un archivio grande, di solito è il limite di dimensione del reverse proxy davanti al server (client_max_body_size in nginx, 100 MB su Cloudflare): premi Verifica sulla destinazione per sapere di più."
        : "Rete instabile o servizio sovraccarico: riprova tra poco."
    );
  }
  if (has("ERR_INVALID_URL") || said(/Invalid URL/i)) {
    return out("BAD_URL", "L'indirizzo non è valido.", "Scrivilo per intero, con https:// davanti.");
  }
  const message = messages.find((m) => m && m !== "fetch failed") ?? messages[0] ?? "errore sconosciuto";
  return out("NETWORK", `Non riesco a raggiungere ${host}: ${clip(message, 120)}.`, "Controlla l'indirizzo e la connessione di questo server.");
}
