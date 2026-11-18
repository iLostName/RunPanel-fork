import { clip, problem, redact, type DestinationProblem } from "./problem";

/**
 * Why rclone failed, in Italian, with what to do.
 *
 * rclone says it in two ways: an exit code from a documented list (3 a
 * directory not found, 4 a file not found, 5 a temporary error, 7 a fatal
 * one…) and log lines on stderr — JSON with `--use-json-log`, so the message
 * is read without guessing where it starts. The messages carry the service's
 * own error: Google's `storageQuotaExceeded`, Dropbox's `insufficient_space`,
 * an OAuth server's `invalid_grant`. Those are what tell a full account from a
 * revoked authorization, and each has a different fix.
 */

export type RcloneStep = "check" | "upload" | "download" | "stat" | "delete" | "list";

export interface RcloneContext {
  /** "Google Drive", "OneDrive", "Dropbox", or "rclone («remote», tipo s3)". */
  service: string;
  folder: string;
  step: RcloneStep;
  /** The guided command that makes a new token, when there is one: `rclone authorize "drive"`. */
  authorize: string | null;
  /** Values to mask in what rclone printed. */
  secrets: string[];
}

export const MIN_RCLONE = { major: 1, minor: 60 } as const;

export const RCLONE_INSTALL_HINT =
  "Installalo dal terminale del server con lo script ufficiale («sudo -v ; curl https://rclone.org/install.sh | sudo bash») " +
  "o scaricando il programma da rclone.org/downloads in /usr/local/bin: il pannello non installa niente da solo.";

/** `rclone v1.68.2` (or `v1.60.1-DEV`, as Debian builds it) → its numbers. */
export function parseRcloneVersion(output: string): { major: number; minor: number; patch: number; text: string } | null {
  const match = /rclone v?(\d+)\.(\d+)(?:\.(\d+))?([^\s]*)/i.exec(output);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    text: `${match[1]}.${match[2]}${match[3] !== undefined ? `.${match[3]}` : ""}${match[4] ?? ""}`,
  };
}

export function rcloneTooOld(version: { major: number; minor: number }): boolean {
  return version.major < MIN_RCLONE.major || (version.major === MIN_RCLONE.major && version.minor < MIN_RCLONE.minor);
}

/** The messages in rclone's stderr: the `msg` of each JSON line, or the line itself. */
export function rcloneMessages(stderr: string): string[] {
  const out: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const entry = JSON.parse(line) as { level?: string; msg?: string; stats?: unknown };
        // Transfer stats are progress, not a reason.
        if (entry.msg && entry.level !== "debug" && entry.level !== "info" && !entry.stats) out.push(entry.msg);
        continue;
      } catch {
        /* not JSON after all */
      }
    }
    out.push(line);
  }
  return out;
}

function verbOf(step: RcloneStep): string {
  switch (step) {
    case "download":
    case "stat":
    case "list":
      return "leggere";
    case "delete":
      return "eliminare";
    default:
      return "scrivere";
  }
}

export function describeRcloneFailure(input: { exitCode: number | null; stderr: string; spawnError?: NodeJS.ErrnoException | null }, ctx: RcloneContext): DestinationProblem {
  if (input.spawnError?.code === "ENOENT") {
    return problem("RCLONE_MISSING", "rclone non è installato su questo server.", RCLONE_INSTALL_HINT, input.spawnError.message);
  }
  if (input.spawnError) {
    return problem("RCLONE_SPAWN", "Il pannello non riesce ad avviare rclone.", "Controlla che l'utente con cui gira RunPanel possa eseguirlo.", input.spawnError.message);
  }

  const messages = rcloneMessages(input.stderr).map((message) => redact(message, ctx.secrets));
  const text = messages.join("\n");
  const has = (pattern: RegExp) => pattern.test(text);
  const detail = text ? clip(`${input.exitCode !== null ? `exit ${input.exitCode}: ` : ""}${messages.slice(-3).join(" · ")}`, 400) : input.exitCode !== null ? `exit ${input.exitCode}` : null;
  const out = (code: string, cause: string, fix: string) => problem(code, cause, fix, detail);
  const folder = ctx.folder ? `«${ctx.folder}»` : "la cartella principale";
  const reauthorize = ctx.authorize
    ? `Modifica la destinazione e incolla un token nuovo: sul tuo computer rilancia ${ctx.authorize}.`
    : "Rifai la configurazione del remote con rclone config sul tuo computer e incolla di nuovo la sezione.";

  if (has(/unknown (flag|shorthand flag)|unknown command/i)) {
    return out("RCLONE_TOO_OLD", "La versione di rclone installata non conosce un comando che serve al pannello.", `Aggiornala: ${RCLONE_INSTALL_HINT}`);
  }
  if (has(/didn't find section in config file|couldn't find type field|didn't find backend called|unknown backend/i)) {
    return out(
      "CONFIG",
      `La configurazione di rclone per ${ctx.service} non è valida${has(/backend/i) ? ": questo rclone non conosce quel tipo di remote" : ""}.`,
      "Controlla la sezione incollata, o rifai la configurazione guidata."
    );
  }
  if (has(/unable to get drive_id and drive_type/i)) {
    return out("ONEDRIVE_DRIVE", "rclone non sa quale unità OneDrive usare.", "Modifica la destinazione e incolla di nuovo il token: il pannello rilegge l'unità.");
  }
  if (has(/invalid_grant|token (has been )?expired or revoked|token expired|couldn't fetch token|refresh token|expired_access_token|invalid_access_token|AADSTS\d+/i)) {
    return out(
      "TOKEN_REVOKED",
      `L'autorizzazione di ${ctx.service} è scaduta o è stata revocata.`,
      `Succede cambiando password, togliendo l'accesso a rclone dall'account, o dopo mesi senza backup. ${reauthorize}`
    );
  }
  if (has(/\b401\b|unauthenticated|unauthorized|invalid credentials|invalid_client|authentication failed|login failed|AccessDenied.*token/i)) {
    return out("AUTH", `${ctx.service} non accetta le credenziali.`, reauthorize);
  }
  if (has(/storageQuotaExceeded|quotaLimitReached|insufficientStorage|insufficient_space|quota.*exceeded|over quota|EOVERQUOTA|no space left on device|InsufficientStorage|\b507\b/i)) {
    return out(
      "QUOTA",
      `Lo spazio dell'account ${ctx.service} è esaurito.`,
      "Libera spazio o passa a un piano più grande, oppure conserva meno archivi (sezione «Quanto tenerne» della pianificazione)."
    );
  }
  if (has(/rateLimitExceeded|userRateLimitExceeded|too_many_requests|too_many_write_operations|\b429\b|Too Many Requests|throttl/i)) {
    return out(
      "RATE_LIMIT",
      `${ctx.service} sta limitando le richieste: troppe in poco tempo.`,
      "Riprova più tardi. Con Google Drive aiuta un client ID tuo (modalità esperto, opzioni client_id e client_secret)."
    );
  }
  if (has(/permission denied|accessDenied|insufficientFilePermissions|Insufficient Permission|forbidden|\b403\b|not allowed/i)) {
    return out("PERMISSION", `L'account non ha il permesso di ${verbOf(ctx.step)} in ${folder} su ${ctx.service}.`, "Controlla i permessi della cartella sul servizio, o scegline un'altra.");
  }
  if (input.exitCode === 3 || input.exitCode === 4 || has(/directory not found|object not found|file not found|not found/i)) {
    if (ctx.step === "download" || ctx.step === "stat" || ctx.step === "delete") {
      return out("NOT_FOUND", `L'archivio non c'è più su ${ctx.service}.`, "È stato spostato o eliminato fuori dal pannello.");
    }
    return out("NO_FOLDER", `La cartella ${folder} non esiste su ${ctx.service} e non si può creare.`, "Controlla la cartella indicata.");
  }
  if (has(/no such host|server misbehaving|lookup .* on .*:53/i)) {
    return out("DNS", `Il DNS di questo server non risolve l'indirizzo di ${ctx.service}.`, "Controlla la connessione e il DNS del server, poi riprova.");
  }
  if (has(/connection refused/i)) {
    return out("REFUSED", `${ctx.service} ha rifiutato la connessione.`, "Controlla l'indirizzo del remote (modalità esperto) e che il servizio sia raggiungibile da questo server.");
  }
  if (has(/i\/o timeout|context deadline exceeded|TLS handshake timeout|timed out|deadline/i)) {
    return out("TIMEOUT", `${ctx.service} non ha risposto in tempo.`, "Controlla la connessione di questo server; un firewall o un proxy potrebbero bloccare l'uscita.");
  }
  if (has(/x509|certificate/i)) {
    return out("TLS", `La connessione sicura con ${ctx.service} non è riuscita.`, "Controlla data e ora del server e i certificati di sistema (pacchetto ca-certificates).");
  }
  if (has(/network is unreachable|no route to host/i)) {
    return out("UNREACHABLE", `La rete di questo server non arriva a ${ctx.service}.`, "Controlla la connessione del server.");
  }
  if (input.exitCode === 5) {
    return out("TEMPORARY", `${ctx.service} ha dato un errore temporaneo.`, "Riprova tra qualche minuto: una pianificazione ci riproverà comunque alla prossima esecuzione.");
  }
  if (input.exitCode === 7) {
    return out("FATAL", `${ctx.service} ha rifiutato l'operazione in modo definitivo${messages.length ? `: ${clip(messages[messages.length - 1], 140)}` : ""}.`, "Controlla lo stato dell'account sul sito del servizio.");
  }
  const last = messages[messages.length - 1];
  return out(
    "RCLONE_ERROR",
    `rclone non è riuscito a ${verbOf(ctx.step)} su ${ctx.service}${last ? `: ${clip(last, 160)}` : ""}.`,
    "Il dettaglio tecnico è qui sotto."
  );
}
