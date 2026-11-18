/**
 * What an S3-compatible service meant, in Italian, with what to do about it.
 *
 * The adapter used to surface "Scrittura rifiutata (403)" or the provider's raw
 * XML, which says something only to whoever already knows S3: a 403 is a wrong
 * key, a wrong secret, a missing permission or a clock that is off, and each one
 * has a different fix. The person setting up a Backblaze bucket for the first
 * time needs the cause and the fix; the expert reading the log still gets the
 * provider's own code and message in `detail`.
 *
 * Two entry points, because a request fails in two ways: the service answers
 * with an error (`describeS3Response`), or there is no answer at all — DNS, a
 * refused connection, a timeout, a certificate (`describeS3Exception`).
 *
 * Zero imports, so the unit suite loads it directly. Nothing here ever echoes
 * a secret: an S3 error body can carry the string-to-sign and the access key
 * id, and `detail` keeps only its code and message.
 */

export type S3Operation = "upload" | "download" | "stat" | "delete" | "write-test" | "read-test" | "delete-test";

export interface S3Context {
  operation: S3Operation;
  bucket?: string;
  region?: string;
  endpoint?: string;
  /** Bucket in the path rather than in the host name. */
  pathStyle?: boolean;
}

export interface S3Problem {
  /** The provider's error code, or one of ours (`DNS`, `TIMEOUT`, `TLS_EXPIRED`…) when there was no answer. */
  code: string;
  /** The HTTP status, when the service answered. */
  status: number | null;
  /** What is wrong, in one plain sentence. */
  cause: string;
  /** What to do about it, in one sentence. */
  fix: string;
  /** The provider's own words, for expert mode and the log. Never a secret. */
  detail: string | null;
}

interface HeaderSource {
  get(name: string): string | null;
}

/** The two sentences together, as a toast or a run's error message shows them. */
export function s3ProblemText(problem: S3Problem): string {
  return `${problem.cause} ${problem.fix}`;
}

/** An error the S3 adapter throws: the message is already the Italian text. */
export class S3Failure extends Error {
  readonly problem: S3Problem;
  constructor(problem: S3Problem) {
    super(s3ProblemText(problem));
    this.name = "S3Failure";
    this.problem = problem;
  }
}

// --- Reading the error document ---------------------------------------------

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface ParsedS3Error {
  code: string | null;
  message: string | null;
  /** The region the service says the bucket is in, when it says so. */
  region: string | null;
  /** The endpoint the service says to use, for a redirect. */
  endpoint: string | null;
}

/** The fields of an S3 `<Error>` document that are safe to read and to show. */
export function parseS3Error(body: string | null | undefined): ParsedS3Error {
  const xml = body ?? "";
  const code = tag(xml, "Code");
  const message = tag(xml, "Message");
  const endpoint = tag(xml, "Endpoint");
  // AWS says it in a field of its own, or in the message of a malformed header:
  // "the region 'us-east-1' is wrong; expecting 'eu-west-1'".
  const expected = message ? /expecting '([a-z0-9-]+)'/i.exec(message) : null;
  const region = tag(xml, "Region") || expected?.[1] || (endpoint ? regionFromHost(endpoint) : null) || null;
  return { code, message, region, endpoint };
}

/** `bucket.s3.eu-west-1.amazonaws.com` → `eu-west-1`. Other providers name regions differently. */
function regionFromHost(host: string): string | null {
  return /s3[.-]([a-z]{2}-[a-z]+-\d)\.amazonaws\.com/i.exec(host)?.[1] ?? null;
}

function headerOf(headers: HeaderSource | Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as HeaderSource).get === "function") return (headers as HeaderSource).get(name);
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key] : null;
}

function looksLikeS3(body: string): boolean {
  return /<Error>[\s\S]*<Code>/i.test(body);
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// --- Wording ------------------------------------------------------------------

function bucketName(ctx: S3Context): string {
  return ctx.bucket ? `«${ctx.bucket}»` : "indicato";
}

/** What the key was trying to do, for "non ha il permesso di …". */
function verbOf(operation: S3Operation): string {
  switch (operation) {
    case "upload":
    case "write-test":
      return "scrivere";
    case "download":
    case "read-test":
    case "stat":
      return "leggere";
    case "delete":
    case "delete-test":
      return "eliminare";
  }
}

const PERMISSIONS_FIX =
  "Dai alla chiave lettura, scrittura ed eliminazione degli oggetti di questo bucket " +
  "(su Amazon S3: s3:PutObject, s3:GetObject e s3:DeleteObject).";

const WRONG_REGION_FIX = (region: string | null) =>
  region
    ? `Imposta come regione «${region}» (e l'endpoint di quella regione), poi verifica di nuovo.`
    : "Imposta la regione in cui è stato creato il bucket, con l'endpoint di quella regione.";

function problem(
  code: string,
  status: number | null,
  cause: string,
  fix: string,
  detail: string | null
): S3Problem {
  return { code, status, cause, fix, detail };
}

/** The sentences for a code the service sent, or one inferred from a bare status. */
function known(code: string, status: number, region: string | null, detail: string | null, ctx: S3Context): S3Problem | null {
  const verb = verbOf(ctx.operation);
  const say = (cause: string, fix: string, as = code) => problem(as, status, cause, fix, detail);

  switch (code) {
    case "InvalidAccessKeyId":
      return say(
        "Questa access key ID non esiste per il servizio scelto.",
        "Controlla di averla copiata per intero e che sia di questo servizio: una chiave di Backblaze non vale su Amazon S3, né su un altro account."
      );
    case "SignatureDoesNotMatch":
      return say(
        "La secret access key non corrisponde all'access key ID.",
        "Incollala di nuovo, senza spazi all'inizio o alla fine; se hai rigenerato la chiave, servono entrambe le parti nuove."
      );
    case "RequestTimeTooSkewed":
    case "RequestExpired":
      return say(
        "L'orologio di questo server è sbagliato di diversi minuti, e il servizio rifiuta le richieste firmate con quell'ora.",
        "Sincronizza l'ora del server (per esempio con «timedatectl set-ntp true»), poi riprova."
      );
    case "ExpiredToken":
    case "InvalidToken":
    case "TokenRefreshRequired":
      return say(
        "Le credenziali sono scadute.",
        "Usa una chiave permanente: quelle temporanee scadono dopo poche ore, e il backup notturno le troverebbe già scadute."
      );
    case "NoSuchBucket":
      return say(
        `Il bucket ${bucketName(ctx)} non esiste su questo servizio.`,
        "Controlla il nome (maiuscole e minuscole contano) oppure crealo dal sito del servizio; se esiste, controlla che regione ed endpoint siano quelli del bucket."
      );
    case "NoSuchKey":
      return say(
        "L'archivio non c'è più nel bucket.",
        "È stato eliminato fuori dal pannello, oppure da una regola di scadenza (lifecycle) del bucket: controlla le regole del bucket."
      );
    case "AccessDenied":
    case "Forbidden":
      return say(`La chiave non ha il permesso di ${verb} nel bucket ${bucketName(ctx)}.`, PERMISSIONS_FIX);
    case "AllAccessDisabled":
    case "AccountProblem":
    case "NotSignedUp":
    case "InvalidPayer":
      return say(
        "Il servizio ha bloccato l'accesso a questo account.",
        "Controlla sul sito del servizio lo stato dell'account: pagamenti, verifiche o limiti in sospeso."
      );
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
    case "IllegalLocationConstraintException":
    case "InvalidLocationConstraint":
    case "InvalidRegionName":
    case "InvalidRegion": {
      const elsewhere = region && region !== ctx.region ? region : null;
      return say(
        elsewhere
          ? `Il bucket ${bucketName(ctx)} si trova in un'altra regione: «${elsewhere}», non «${ctx.region ?? "?"}».`
          : `La regione o l'endpoint non sono quelli del bucket ${bucketName(ctx)}.`,
        WRONG_REGION_FIX(elsewhere)
      );
    }
    case "TemporaryRedirect":
      return say(
        "Il bucket è stato creato da poco e il servizio non lo raggiunge ancora da questo indirizzo.",
        "Usa l'endpoint della regione del bucket, oppure riprova tra qualche ora."
      );
    case "InvalidBucketName":
      return say(
        `Il nome del bucket ${bucketName(ctx)} non è valido.`,
        "Usa il nome esatto che vedi sul sito del servizio: minuscole, numeri, trattini e punti."
      );
    case "EntityTooLarge":
    case "MaxMessageLengthExceeded":
      return say(
        "L'archivio è più grande di quanto il servizio accetti in un solo caricamento (su Amazon S3, 5 GB).",
        "Dividi quello che salva questa pianificazione in due pianificazioni più piccole, oppure escludi dai volumi le cartelle che non servono."
      );
    case "QuotaExceeded":
    case "StorageQuotaExceeded":
    case "XMinioStorageFull":
    case "StorageFull":
    case "InsufficientStorage":
      return say(
        "Lo spazio del bucket o dell'account è esaurito.",
        "Libera spazio o alza il limite dal sito del servizio, oppure conserva meno archivi (sezione «Quanto tenerne» della pianificazione)."
      );
    case "SlowDown":
    case "ServiceUnavailable":
    case "RequestTimeout":
      return say(
        "Il servizio è sovraccarico o momentaneamente non disponibile.",
        "Riprova tra qualche minuto: una pianificazione ci riproverà comunque alla prossima esecuzione."
      );
    case "InternalError":
      return say(
        "Il servizio ha avuto un errore interno.",
        "Riprova più tardi; se continua, controlla la pagina di stato del servizio."
      );
    case "MethodNotAllowed":
    case "NotImplemented":
      return say(
        "L'endpoint non accetta questa operazione.",
        "Controlla di aver indicato l'endpoint S3 del servizio (per esempio https://s3.eu-central-1.amazonaws.com), non l'indirizzo del suo sito."
      );
    case "NotS3":
      return say(
        "L'endpoint risponde, ma non sembra un servizio S3.",
        "Usa l'endpoint S3 indicato dal servizio, non l'indirizzo del suo sito: per esempio https://s3.eu-central-1.amazonaws.com."
      );
    case "Denied403":
      return say(
        `Accesso negato al bucket ${bucketName(ctx)}: access key, secret o permessi non sono quelli giusti.`,
        `Ricontrolla le due chiavi; se sono giuste, ${PERMISSIONS_FIX.charAt(0).toLowerCase()}${PERMISSIONS_FIX.slice(1)}`,
        "AccessDenied"
      );
  }
  return null;
}

/** The code a response without an error document most likely means. */
function inferredCode(status: number, body: string, region: string | null, ctx: S3Context): string | null {
  if (body && /<html|<!doctype/i.test(body)) return "NotS3";
  if (status === 301 || status === 307) return "PermanentRedirect";
  if (status === 400 && region && region !== ctx.region) return "PermanentRedirect";
  if (status === 403) return "Denied403";
  if (status === 404) return ctx.operation === "download" || ctx.operation === "stat" ? "NoSuchKey" : "NoSuchBucket";
  if (status === 413) return "EntityTooLarge";
  if (status === 507) return "InsufficientStorage";
  if (status === 503 || status === 429) return "SlowDown";
  if (status >= 500) return "InternalError";
  return null;
}

/**
 * A response the service sent with an error status.
 *
 * `body` may be empty — a HEAD never has one — and then the status and the
 * `x-amz-bucket-region` header are all there is to go on.
 */
export function describeS3Response(
  input: { status: number; body?: string | null; headers?: HeaderSource | Record<string, string> },
  ctx: S3Context
): S3Problem {
  const body = input.body ?? "";
  const status = input.status;
  const parsed = parseS3Error(body);
  const region = parsed.region ?? headerOf(input.headers, "x-amz-bucket-region");
  const detail = parsed.code
    ? clip(`${parsed.code}${parsed.message ? `: ${parsed.message}` : ""} (HTTP ${status})`)
    : body && !looksLikeS3(body)
      ? clip(`HTTP ${status}: ${body.replace(/<[^>]+>/g, " ")}`, 160)
      : `HTTP ${status}`;

  // Storage caps some providers report only in words, under a generic code
  // such as AccessDenied: "no permission" would send people to the wrong fix.
  if (/storage cap|quota exceeded|insufficient storage/i.test(parsed.message ?? "")) {
    return known("QuotaExceeded", status, region, detail, ctx) as S3Problem;
  }

  const fromCode = parsed.code ? known(parsed.code, status, region, detail, ctx) : null;
  if (fromCode) return fromCode;

  if (!parsed.code) {
    const guess = inferredCode(status, body, region, ctx);
    const fromStatus = guess ? known(guess, status, region, detail, ctx) : null;
    if (fromStatus) return fromStatus;
  }

  return problem(
    parsed.code || `HTTP_${status}`,
    status,
    `Il servizio ha rifiutato la richiesta${parsed.message ? `: ${clip(parsed.message, 160)}` : ` (HTTP ${status})`}.`,
    "Controlla endpoint, regione, bucket e chiavi; il dettaglio tecnico è qui sotto.",
    detail
  );
}

// --- No answer at all ---------------------------------------------------------

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
}

/** Every `code` and message in the chain: undici wraps the real reason in `cause`, sometimes twice. */
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
    // Happy eyeballs: one refused attempt per address, in an AggregateError.
    if (Array.isArray(e.errors)) for (const inner of e.errors) visit(inner, depth + 1);
  };
  visit(err, 0);
  return { codes, messages, names };
}

/** The host a request went to: the bucket is part of it unless the path carries it. */
function hostOf(ctx: S3Context): string {
  try {
    const url = new URL(ctx.endpoint ?? "");
    return ctx.pathStyle || !ctx.bucket ? url.host : `${ctx.bucket}.${url.host}`;
  } catch {
    return ctx.endpoint ?? "l'endpoint";
  }
}

const TLS_UNTRUSTED = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

/**
 * A request that never got an answer: what `fetch` threw.
 *
 * Node's fetch says "fetch failed" and puts the reason in `cause` — a DNS
 * code, a refused connection, a certificate check — so the chain is walked
 * rather than the top message read.
 */
export function describeS3Exception(err: unknown, ctx: S3Context): S3Problem {
  if (err instanceof S3Failure) return err.problem;

  const { codes, messages, names } = chain(err);
  const has = (...wanted: string[]) => codes.some((code) => wanted.includes(code));
  const said = (pattern: RegExp) => messages.some((message) => pattern.test(message));
  const host = hostOf(ctx);
  const detail = clip([...new Set([...codes, ...messages])].join(" · ") || String(err), 300);
  const out = (code: string, cause: string, fix: string) => problem(code, null, cause, fix, detail);

  if (names.includes("TimeoutError") || has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "ESOCKETTIMEDOUT")) {
    return out(
      "TIMEOUT",
      `${host} non ha risposto in tempo.`,
      "Controlla che l'endpoint sia giusto e che questo server possa uscire verso Internet su quella porta (firewall, proxy)."
    );
  }
  if (names.includes("AbortError")) {
    return out("ABORTED", "L'operazione è stata annullata prima di finire.", "Riprova quando vuoi: niente è stato lasciato a metà nel pannello.");
  }
  if (has("ENOTFOUND", "EAI_NONAME")) {
    return out(
      "DNS",
      `L'indirizzo ${host} non esiste.`,
      ctx.pathStyle
        ? "Controlla l'endpoint: per Cloudflare R2 sostituisci <account-id> con il tuo, per Backblaze e Hetzner la regione dev'essere quella del bucket."
        : "Controlla l'endpoint e la regione. Con «bucket nel dominio» anche il nome del bucket fa parte dell'indirizzo: per MinIO e i server propri scegli «bucket nel percorso» (in Avanzate)."
    );
  }
  if (has("EAI_AGAIN")) {
    return out("DNS_UNAVAILABLE", "Il DNS di questo server non risponde.", "Riprova tra poco; se continua, controlla la configurazione di rete del server.");
  }
  if (has("ECONNREFUSED")) {
    return out(
      "REFUSED",
      `Nessun servizio risponde su ${host}.`,
      "Controlla indirizzo e porta (MinIO di solito usa la 9000) e che il servizio sia acceso."
    );
  }
  if (has("EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL")) {
    return out(
      "UNREACHABLE",
      `La rete di questo server non arriva a ${host}.`,
      "Controlla la connessione del server; se l'endpoint ha solo un indirizzo IPv6, il server deve avere IPv6."
    );
  }
  if (has("CERT_HAS_EXPIRED")) {
    return out(
      "TLS_EXPIRED",
      `Il certificato HTTPS di ${host} è scaduto.`,
      "Va rinnovato sul server del servizio: se è un tuo MinIO, rinnova il suo certificato."
    );
  }
  if (has("ERR_TLS_CERT_ALTNAME_INVALID") || said(/Hostname\/IP does not match certificate/i)) {
    return out(
      "TLS_NAME",
      `Il certificato HTTPS non vale per ${host}.`,
      ctx.pathStyle
        ? "Controlla di aver scritto l'endpoint con lo stesso nome del certificato."
        : "Con «bucket nel dominio» l'indirizzo diventa <bucket>.<endpoint> e il certificato deve coprirlo: per MinIO e i server propri scegli «bucket nel percorso» (in Avanzate)."
    );
  }
  if (codes.some((code) => TLS_UNTRUSTED.has(code))) {
    return out(
      "TLS_UNTRUSTED",
      `Il certificato HTTPS di ${host} non è firmato da un'autorità riconosciuta.`,
      "Usa un certificato valido (per esempio Let's Encrypt); dentro una rete privata puoi usare http:// verso un indirizzo privato."
    );
  }
  if (has("ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO") || said(/wrong version number|packet length too long/i)) {
    return out(
      "TLS_NOT_HTTPS",
      `${host} non parla HTTPS su quella porta.`,
      "Se il servizio è in http, scrivi l'endpoint con http:// (ammesso solo verso indirizzi privati); altrimenti controlla la porta."
    );
  }
  if (codes.some((code) => /^(ERR_TLS|ERR_SSL|CERT_)/.test(code)) || said(/certificate|ssl|tls/i)) {
    return out("TLS", `La connessione sicura con ${host} non è riuscita.`, "Controlla il certificato HTTPS dell'endpoint e che l'indirizzo sia giusto.");
  }
  if (has("ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNABORTED") || said(/other side closed|socket hang up/i)) {
    return out(
      "RESET",
      "Il servizio ha chiuso la connessione a metà trasferimento.",
      ctx.operation === "upload"
        ? "Succede quando il servizio rifiuta il caricamento (chiave, permessi o dimensione): premi Verifica sulla destinazione per sapere il motivo."
        : "Rete instabile o servizio sovraccarico: riprova tra poco."
    );
  }
  if (has("UND_ERR_BODY_TIMEOUT")) {
    return out("STALLED", "Il trasferimento si è fermato a metà.", "Rete lenta o instabile tra questo server e il servizio: riprova.");
  }
  if (has("ERR_INVALID_URL") || said(/Invalid URL/i)) {
    return out("BAD_ENDPOINT", "L'endpoint non è un indirizzo valido.", "Scrivilo per intero, con https:// davanti: per esempio https://s3.eu-central-1.amazonaws.com.");
  }

  const message = messages.find((m) => m && m !== "fetch failed") ?? messages[0] ?? "errore sconosciuto";
  return out(
    "NETWORK",
    `Non riesco a raggiungere ${host}: ${clip(message, 120)}.`,
    "Controlla l'endpoint e la connessione di questo server."
  );
}
