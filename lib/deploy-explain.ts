/**
 * A deploy, said in words: which phase it is in, and why it failed.
 *
 * The pipeline writes a log meant for whoever debugs it and an error message
 * that is often a raw tool's stderr ("npm ERR! ERESOLVE…", "Health check
 * failed after 30s: port 3000 not responding on /"). Someone who just wanted
 * their app online needs the cause in one sentence and the place to fix it;
 * the raw text stays available under "Dettagli".
 *
 * Both readings work on what the pipeline already produces: its section
 * markers (`--- Building ---`, `=== Deploy successful ===`) and its error
 * messages. They are recognised by pattern, so a message this file does not
 * know falls back to "look at the log" rather than to a wrong explanation.
 *
 * Zero imports: the unit suite loads this file directly, and the browser uses
 * it as is.
 */

/**
 * What the pipeline appends to a deploy's error when it put the previous
 * version back online (services/deploy-pipeline.ts).
 */
export const ROLLBACK_NOTE = "è tornata online la versione precedente";

export type DeployPhase = "queued" | "source" | "build" | "start" | "health" | "done" | "failed";

/**
 * Whether a deployment row is one that worked.
 *
 * The table has no "success": a deploy that passed is `running` while it is
 * the live version and `superseded` once a newer one replaced it.
 */
export function deploymentSucceeded(status: string): boolean {
  return status === "running" || status === "superseded";
}

/** Whether a deployment row is still in progress. */
export function deploymentActive(status: string): boolean {
  return status === "pending" || status === "building";
}

/** The phases a deploy walks through, in order, with their plain names. */
export const DEPLOY_PHASES: { id: Exclude<DeployPhase, "queued" | "done" | "failed">; label: string }[] = [
  { id: "source", label: "Scarico il codice" },
  { id: "build", label: "Installo e compilo" },
  { id: "start", label: "Avvio l'app" },
  { id: "health", label: "Controllo che risponda" },
];

const MARKERS: [RegExp, DeployPhase][] = [
  [/^\s*=== .* FAILED/m, "failed"],
  [/^\s*=== .* successful ===/m, "done"],
  [/^\s*--- Health check ---/m, "health"],
  [/^\s*--- Starting application ---/m, "start"],
  [/^\s*--- (Building|Release) ---/m, "build"],
  [/^\s*--- (Fetching source|Preflight) ---/m, "source"],
];

/** The furthest phase the log has reached. */
export function deployPhase(log: string | null | undefined): DeployPhase {
  if (!log) return "queued";
  for (const [pattern, phase] of MARKERS) if (pattern.test(log)) return phase;
  return "queued";
}

export type DeployErrorCode =
  | "cancelled"
  | "no-source"
  | "branch-missing"
  | "repo-access"
  | "start-command-missing"
  | "no-package-json"
  | "out-of-memory"
  | "docker-build-failed"
  | "install-failed"
  | "health-wrong-status"
  | "health-no-answer"
  | "build-failed"
  | "unknown";

/** Where a fix lives. The UI turns each into a button or a link. */
export type DeployFix = "source" | "runtime" | "port" | "healthcheck" | "env" | "github" | "memory" | "logs";

export interface DeployErrorExplanation {
  code: DeployErrorCode;
  title: string;
  /** What to do about it, in plain Italian. */
  hint: string;
  /** Best first. */
  fixes: DeployFix[];
}

interface Rule {
  code: DeployErrorCode;
  /** Tested against the error message, then against the log when `inLog` is set. */
  test: RegExp;
  inLog?: boolean;
  explain: (match: RegExpMatchArray) => Omit<DeployErrorExplanation, "code">;
}

const RULES: Rule[] = [
  {
    code: "cancelled",
    test: /interrotto dall'operatore/i,
    explain: () => ({ title: "Deploy annullato", hint: "È stato fermato a mano. Puoi avviarne un altro quando vuoi.", fixes: [] }),
  },
  {
    code: "no-source",
    test: /No source on disk|No repository configured|Nessun repository sul disco/i,
    explain: () => ({
      title: "Manca il codice dell'app",
      hint: "Collega un repository GitHub o carica uno ZIP, poi avvia di nuovo il deploy.",
      fixes: ["source"],
    }),
  },
  {
    code: "branch-missing",
    test: /Il branch "([^"]+)" non esiste sul remote/,
    explain: (m) => ({
      title: `Il branch «${m[1]}» non esiste`,
      hint: "Controlla il nome del branch nelle impostazioni della sorgente: maiuscole e minuscole contano.",
      fixes: ["source"],
    }),
  },
  {
    code: "repo-access",
    test: /Authentication failed|Repository not found|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|returned error: 40[134]/i,
    inLog: true,
    explain: () => ({
      title: "Il pannello non riesce a leggere il repository",
      hint: "Se è privato, collega GitHub con un token che possa leggerlo. Se l'indirizzo è sbagliato, correggilo nella sorgente.",
      fixes: ["github", "source"],
    }),
  },
  {
    code: "start-command-missing",
    test: /richiede un comando di avvio/i,
    explain: () => ({
      title: "Manca il comando di avvio",
      hint: "Con il runtime personalizzato va indicato il comando che avvia l'app, per esempio python main.py.",
      fixes: ["runtime"],
    }),
  },
  {
    code: "no-package-json",
    test: /(ENOENT[^\n]*package\.json|package\.json[^\n]*(not found|no such file|missing)|Could not read package\.json|niente package\.json)/i,
    inLog: true,
    explain: () => ({
      title: "Manca package.json",
      hint: "Il runtime Node lo cerca nella cartella principale. Se l'app sta in una sottocartella indicala in Build e avvio; se non è un'app Node, scegli un altro runtime.",
      fixes: ["runtime"],
    }),
  },
  {
    code: "out-of-memory",
    test: /JavaScript heap out of memory|Reached heap limit|OOMKilled|exit code 137|signal SIGKILL|ENOMEM/i,
    inLog: true,
    explain: () => ({
      title: "Memoria esaurita durante la build",
      hint: "La build ha usato tutta la memoria disponibile. Dalle più memoria nelle impostazioni avanzate (per esempio --max-old-space-size=4096) oppure aumenta la RAM del server.",
      fixes: ["memory", "logs"],
    }),
  },
  {
    code: "docker-build-failed",
    test: /failed to solve|failed to compute cache key|dockerfile parse error|ERROR \[[^\]\n]+\]/i,
    inLog: true,
    explain: () => ({
      title: "La build Docker non è riuscita",
      hint: "Uno dei passaggi del Dockerfile è terminato con un errore: le ultime righe del log dicono quale.",
      fixes: ["logs"],
    }),
  },
  {
    code: "install-failed",
    test: /npm ERR!|npm error|ERESOLVE|ERR_PNPM|pnpm ERR|error An unexpected error occurred|YN0001|frozen-lockfile|lockfile[^\n]*(out of date|outdated|mismatch)/i,
    inLog: true,
    explain: () => ({
      title: "Installazione delle dipendenze non riuscita",
      hint: "Di solito è un lockfile non allineato al package.json, o una dipendenza che vuole un'altra versione di Node. Le ultime righe del log dicono quale.",
      fixes: ["logs"],
    }),
  },
  {
    code: "health-wrong-status",
    test: /Health check failed[^\n]*?(\S+) responded (\d{3})/i,
    explain: (m) => ({
      title: `L'app risponde, ma con un errore (${m[2]})`,
      hint: `Il controllo ha chiesto ${m[1]} e ha ricevuto lo stato ${m[2]}. Guarda gli errori dell'app nel log, oppure cambia il percorso del controllo di salute.`,
      fixes: ["logs", "healthcheck"],
    }),
  },
  {
    code: "health-no-answer",
    test: /Health check failed[^\n]*?port (\d+) not responding/i,
    explain: (m) => ({
      title: `L'app non risponde sulla porta ${m[1]}`,
      hint: "Deve mettersi in ascolto sulla porta della variabile PORT. Se è un bot o un servizio senza pagina web, spegni il controllo di salute.",
      fixes: ["port", "healthcheck", "logs"],
    }),
  },
  {
    code: "build-failed",
    test: /Build failed|exit code \d+|Comando (fallito|terminato)/i,
    explain: () => ({
      title: "La build non è riuscita",
      hint: "Uno dei comandi di build è terminato con un errore: guarda le ultime righe del log.",
      fixes: ["logs"],
    }),
  },
];

export function explainDeployError(message: string | null | undefined, log: string | null | undefined = ""): DeployErrorExplanation {
  const text = message ?? "";
  // The log is searched from its end: the cause is near the last lines, and an
  // older warning that merely mentions "npm ERR!" should not win over it.
  const tail = (log ?? "").slice(-20_000);
  const rolledBack = text.includes(ROLLBACK_NOTE);
  const note = (explanation: DeployErrorExplanation): DeployErrorExplanation =>
    rolledBack ? { ...explanation, hint: `Intanto è tornata online la versione precedente. ${explanation.hint}` } : explanation;
  for (const rule of RULES) {
    const match = text.match(rule.test) ?? (rule.inLog ? tail.match(rule.test) : null);
    if (match) return note({ code: rule.code, ...rule.explain(match) });
  }
  return note({
    code: "unknown",
    title: "Il deploy non è riuscito",
    hint: "Le ultime righe del log spiegano cosa è andato storto.",
    fixes: ["logs"],
  });
}
