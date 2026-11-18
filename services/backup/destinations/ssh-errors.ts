import { FX, type SftpProtocolError, type SftpStatusError } from "./sftp-client";
import { clip, problem, type DestinationProblem } from "./problem";
import { formatBytes } from "@/lib/format";

/**
 * Why an SFTP destination failed, in Italian, with what to do.
 *
 * Two sources. `ssh` itself, before any file was touched: it says what went
 * wrong on stderr in a fixed set of sentences (run with LC_ALL=C, so the
 * system's part of them is in English too), and the exit code 255 says the
 * failure was its own. Then the SFTP server, once connected, which answers a
 * refused operation with a status code from a short list and, sometimes, a
 * message of its own.
 *
 * The person reading this is most often setting up a NAS for the first time:
 * the sentence names the setting to change, on the NAS where it differs.
 */

export type SftpStep = "check" | "upload" | "download" | "stat" | "delete";

export interface SshContext {
  host: string;
  port: number;
  username: string;
  folder: string;
  /** A host key was pinned, so a key that differs is a changed key and not a first contact. */
  pinned: boolean;
  step: SftpStep;
}

export interface SshExit {
  stderr: string;
  exitCode: number | null;
  /** What `spawn` failed with: `ENOENT` when there is no `ssh` at all. */
  spawnError?: NodeJS.ErrnoException | null;
  /** The SFTP conversation had started: the connection broke later, it was not refused. */
  connected: boolean;
}

/** The lines that say something, without OpenSSH's banner of `@` signs. */
function meaningful(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^@+$/.test(line) && !/^@\s/.test(line));
}

/** What `ssh` (or the absence of it) said, as a problem. */
export function describeSshExit(exit: SshExit, ctx: SshContext): DestinationProblem {
  const lines = meaningful(exit.stderr);
  const text = lines.join("\n");
  const detail = text ? clip(text, 400) : exit.exitCode !== null ? `ssh exit ${exit.exitCode}` : null;
  const has = (pattern: RegExp) => pattern.test(text);
  const where = `${ctx.host}`;
  const out = (code: string, cause: string, fix: string) => problem(code, cause, fix, detail);

  if (exit.spawnError?.code === "ENOENT") {
    return problem(
      "SSH_MISSING",
      "Su questo server manca il programma ssh, che il pannello usa per le destinazioni SFTP.",
      "Installalo dal terminale del server (su Debian e Ubuntu: «sudo apt install openssh-client»), poi verifica di nuovo.",
      exit.spawnError.message
    );
  }
  if (exit.spawnError) {
    return problem(
      "SSH_SPAWN",
      "Il pannello non riesce ad avviare il programma ssh.",
      "Controlla che l'utente con cui gira RunPanel possa eseguirlo.",
      exit.spawnError.message
    );
  }

  if (has(/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for \S+ has changed|No \S+ host key is known for/i) || (ctx.pinned && has(/Host key verification failed/i))) {
    return out(
      "HOST_KEY_CHANGED",
      `${where} si presenta con una chiave diversa da quella salvata alla prima connessione.`,
      "Può essere un server reinstallato o sostituito, ma anche qualcuno in mezzo alla connessione: confronta l'impronta con quella del server e, solo se sei sicuro, modifica la destinazione e scegli «Dimentica l'impronta»."
    );
  }
  if (has(/Host key verification failed/i)) {
    return out(
      "HOST_KEY",
      `La chiave con cui si presenta ${where} non è stata accettata.`,
      "Riprova; se continua, controlla che all'indirizzo risponda davvero il tuo server."
    );
  }
  if (has(/Temporary failure in name resolution/i)) {
    return out("DNS_UNAVAILABLE", "Il DNS di questo server non risponde.", "Riprova tra poco; se continua, controlla la configurazione di rete del server.");
  }
  if (has(/Could not resolve hostname|Name or service not known|nodename nor servname|No address associated with hostname|No such host is known/i)) {
    return out(
      "DNS",
      `L'indirizzo ${where} non esiste.`,
      "Controlla di averlo scritto giusto. Un NAS di casa di solito non ha un nome che questo server sappia risolvere: usa il suo indirizzo IP, o il nome pubblico se lo raggiungi da fuori."
    );
  }
  if (has(/Connection refused/i)) {
    return out(
      "REFUSED",
      `Nessun servizio SSH risponde su ${where}, porta ${ctx.port}.`,
      "Controlla la porta (le Storage Box di Hetzner usano la 23) e che SFTP sia attivo sul NAS o sul server."
    );
  }
  if (has(/Connection timed out|Operation timed out|timed out during banner exchange|Connection timeout/i)) {
    return out(
      "TIMEOUT",
      `${where} non ha risposto in tempo sulla porta ${ctx.port}.`,
      "Controlla indirizzo e porta, e che un firewall o il router non blocchino le connessioni che arrivano da questo server."
    );
  }
  if (has(/No route to host|Network is unreachable|Host is unreachable|Network unreachable/i)) {
    return out(
      "UNREACHABLE",
      `La rete di questo server non arriva a ${where}.`,
      "Se il NAS è in un'altra rete (a casa, dietro un router), serve una VPN o l'inoltro di una porta; controlla anche la connessione del server."
    );
  }
  if (has(/Unable to negotiate|no matching (host key type|key exchange method|cipher|MAC)/i)) {
    return out(
      "OLD_SERVER",
      `${where} usa solo algoritmi di cifratura vecchi, che il programma ssh di questo server rifiuta.`,
      "Aggiorna il firmware del NAS o OpenSSH sul server: algoritmi e chiavi di prima del 2015 non sono più considerati sicuri."
    );
  }
  const denied = /Permission denied \(([^)]*)\)/i.exec(text);
  if (denied || has(/Too many authentication failures/i)) {
    const methods = (denied?.[1] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    if (methods.length > 0 && !methods.includes("publickey")) {
      return out(
        "AUTH_NO_KEYS",
        `${where} non accetta l'accesso con chiave per l'utente «${ctx.username}» (ammette solo: ${methods.join(", ")}).`,
        "Attiva l'accesso con chiave pubblica sul server, oppure usa un utente che lo abbia."
      );
    }
    return out(
      "AUTH",
      `${where} non ha accettato la chiave del pannello per l'utente «${ctx.username}».`,
      "Aggiungi la riga della chiave pubblica al file .ssh/authorized_keys di quell'utente, con permessi 700 sulla cartella .ssh e 600 sul file. Sui NAS va attivata anche la cartella home degli utenti."
    );
  }
  if (has(/subsystem request failed/i)) {
    return out(
      "NO_SFTP",
      `${where} accetta la connessione ma non offre SFTP.`,
      "Attiva SFTP sul NAS (Synology: Pannello di controllo › Servizi file › FTP › SFTP; QNAP: Telnet/SSH › Consenti connessione SFTP) o il sottosistema sftp nella configurazione di sshd."
    );
  }
  if (has(/Load key .*: (invalid format|error in libcrypto|incorrect passphrase)/i)) {
    return out(
      "KEY_INVALID",
      "La chiave salvata per questa destinazione non è leggibile.",
      "Modifica la destinazione, genera una nuova chiave e aggiungila di nuovo sul server."
    );
  }
  if (has(/banner exchange: .*invalid format|Bad packet length|Protocol mismatch|Invalid SSH identification/i) && !exit.connected) {
    return out(
      "NOT_SSH",
      `Sulla porta ${ctx.port} di ${where} risponde qualcosa che non è SSH.`,
      "Controlla la porta: di solito 22, 23 per le Storage Box di Hetzner; 5000 e 5001 sono quelle del sito del NAS, non di SFTP."
    );
  }
  const disconnect = /Received disconnect from [^:]+(?::\s*\d+)?:\s*\d*:?\s*(.*)$/im.exec(text);
  if (disconnect && !exit.connected) {
    return out(
      "DISCONNECTED",
      `${where} ha chiuso la connessione${disconnect[1] ? `: «${clip(disconnect[1], 120)}»` : ""}.`,
      "Controlla le impostazioni di accesso del server: utente, chiave, blocchi degli IP."
    );
  }
  if (exit.connected) {
    return out(
      "CONNECTION_LOST",
      `La connessione con ${where} si è interrotta a metà.`,
      "Rete instabile tra questo server e quello di destinazione: riprova. Un archivio interrotto resta con un nome provvisorio (.partial) e non viene mai scambiato per uno completo."
    );
  }
  if (has(/kex_exchange_identification|ssh_exchange_identification|Connection closed by|Connection reset by peer|closed by remote host/i)) {
    return out(
      "CLOSED",
      `${where} ha chiuso la connessione prima dell'accesso.`,
      "Succede con la porta sbagliata, dopo troppi tentativi (fail2ban, blocco automatico degli IP sul NAS) o se il server limita le connessioni: controlla porta e blocchi, poi riprova."
    );
  }
  const last = lines[lines.length - 1];
  return out(
    "SSH_ERROR",
    `La connessione SSH con ${where} non è riuscita${last ? `: ${clip(last, 160)}` : ""}.`,
    "Controlla indirizzo, porta e utente; il dettaglio tecnico è qui sotto."
  );
}

/** The SFTP conversation broke in a way that is not ssh's to explain. */
export function describeProtocol(err: SftpProtocolError, ctx: SshContext): DestinationProblem {
  switch (err.code) {
    case "BANNER":
      return problem(
        "BANNER",
        `Dopo l'accesso, ${ctx.host} ha scritto del testo invece di parlare SFTP${err.sample ? ` («${clip(err.sample, 80)}»)` : ""}.`,
        "Di solito è un echo nel .bashrc o nel .profile dell'utente: toglilo, o fallo solo per le shell interattive.",
        err.sample
      );
    case "STALLED":
      return problem(
        "STALLED",
        `${ctx.host} ha smesso di rispondere a metà operazione.`,
        "Rete instabile o disco del server bloccato: riprova, e se succede sempre controlla il server.",
        err.message
      );
    case "ABORTED":
      return problem(
        "ABORTED",
        "L'operazione è stata annullata prima di finire.",
        "Riprova quando vuoi: un archivio interrotto resta con un nome provvisorio e non viene mai scambiato per uno completo.",
        null
      );
    default:
      return problem(
        "PROTOCOL",
        `La conversazione SFTP con ${ctx.host} si è interrotta: ${clip(err.message, 160)}.`,
        "Riprova; se continua, il server potrebbe non essere un server SFTP standard.",
        err.message
      );
  }
}

function verbOf(err: SftpStatusError): string {
  switch (err.operation) {
    case "read":
    case "stat":
    case "fstat":
    case "realpath":
      return "leggere";
    case "remove":
      return "eliminare";
    default:
      return "scrivere";
  }
}

/**
 * A status the server answered with.
 *
 * `space` is the free space where the folder lives, when the server says it:
 * a generic "failure" on a write is, most of the time, a full disk or a quota,
 * and the number turns a guess into a fact.
 */
export function describeSftpStatus(err: SftpStatusError, ctx: SshContext, space?: { available: number } | null): DestinationProblem {
  const detail = clip(`${err.operation} ${err.path}: ${err.serverMessage || `status ${err.status}`} (SFTP ${err.status})`, 300);
  const folder = ctx.folder || "cartella iniziale";
  const out = (code: string, cause: string, fix: string) => problem(code, cause, fix, detail);
  const writing = ["write", "close", "open", "fsync", "mkdir", "rename"].includes(err.operation);

  if (err.status === FX.NO_SPACE_ON_FILESYSTEM || err.status === FX.QUOTA_EXCEEDED || (writing && err.status === FX.FAILURE && space && space.available < 64 * 1024 * 1024)) {
    return out(
      err.status === FX.QUOTA_EXCEEDED ? "QUOTA" : "DISK_FULL",
      space ? `Lo spazio sul server è finito: liberi ${formatBytes(space.available)}.` : "Lo spazio sul server o la quota dell'utente sono finiti.",
      "Libera spazio o conserva meno archivi (sezione «Quanto tenerne» della pianificazione)."
    );
  }

  switch (err.status) {
    case FX.NO_SUCH_FILE:
      if (ctx.step === "download" || ctx.step === "stat" || err.operation === "read" || err.operation === "stat") {
        return out("NOT_FOUND", "L'archivio non c'è più sul server.", "È stato spostato o eliminato fuori dal pannello.");
      }
      return out(
        "NO_FOLDER",
        `La cartella «${folder}» non esiste e non si può creare.`,
        "Controlla il percorso: sui NAS la prima parte è una cartella condivisa che deve già esistere (per esempio /backup/runpanel)."
      );
    case FX.PERMISSION_DENIED:
      return out(
        "PERMISSION",
        `L'utente «${ctx.username}» non ha il permesso di ${verbOf(err)} in «${folder}».`,
        "Dagli lettura e scrittura su quella cartella (sul NAS: i permessi della cartella condivisa), oppure scegli una cartella sua."
      );
    case FX.OP_UNSUPPORTED:
      return out(
        "UNSUPPORTED",
        `${ctx.host} non supporta un'operazione che serve ai backup (${err.operation}).`,
        "Controlla il software SFTP del server: con OpenSSH, e con i NAS che lo usano, funziona."
      );
    case FX.NO_CONNECTION:
    case FX.CONNECTION_LOST:
      return out("CONNECTION_LOST", `La connessione con ${ctx.host} si è interrotta.`, "Riprova tra poco.");
    case FX.FAILURE:
      if (err.operation === "rename") {
        return out(
          "RENAME",
          `${ctx.host} non ha permesso di rinominare l'archivio appena caricato.`,
          "Il pannello carica con un nome provvisorio e lo rinomina solo alla fine: all'utente servono anche i permessi di rinominare ed eliminare nella cartella."
        );
      }
      if (err.operation === "mkdir" && /not a directory/i.test(err.serverMessage)) {
        return out("NOT_A_FOLDER", `«${folder}» sul server è un file, non una cartella.`, "Scegli un'altra cartella.");
      }
      if (writing) {
        return out(
          "WRITE_REFUSED",
          `${ctx.host} ha rifiutato la scrittura${err.serverMessage && !/^failure$/i.test(err.serverMessage) ? `: «${clip(err.serverMessage, 120)}»` : ""}.`,
          "Di solito lo spazio del disco o la quota dell'utente sono finiti: controlla sul server."
        );
      }
      break;
  }
  return out(
    `SFTP_${err.status}`,
    `${ctx.host} ha rifiutato l'operazione${err.serverMessage ? `: «${clip(err.serverMessage, 120)}»` : ` (codice ${err.status})`}.`,
    "Il dettaglio tecnico è qui sotto."
  );
}
