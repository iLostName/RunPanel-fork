import type {
  AppLocation,
  CatalogCategory,
  CatalogQuestion,
  CatalogTemplate,
  DeriveContext,
  EnvEntry,
} from "./types";

/**
 * Everything an install decides before it touches the server, as pure functions.
 *
 * The install page and `POST /api/catalog/install` both run these: the page to
 * show what will be deployed, the route to decide it. One copy, so the preview
 * an expert reads under "Avanzate" is the configuration the route then writes.
 *
 * There is no escaping step anywhere in here, and that is the design rather
 * than an omission. Answers become project variables, encrypted like every
 * other; the deploy hands them to `docker compose` as its environment; the
 * compose file names them as `${KEY:-}`. Compose substitutes after it has
 * parsed the YAML, and never parses a substituted value again, so a quote, a
 * `$` or a `#` in a password arrives in the container exactly as typed. Writing
 * them into a `.env` would have meant a second parser — Compose's, which expands
 * `$` inside double quotes and stops at an unclosed `${` — and a file of secrets
 * in clear. What is refused is only what an environment cannot carry, or what
 * nobody types on purpose: control characters, and lengths past reason.
 *
 * Zero imports besides the types next door: the unit suite loads it directly.
 */

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  automation: "Automazione",
  websites: "Siti e blog",
  monitoring: "Monitoraggio",
  analytics: "Statistiche",
  storage: "File e archiviazione",
  security: "Password e sicurezza",
  development: "Sviluppo",
};

/** The order categories are offered in. */
export const CATEGORY_ORDER: readonly CatalogCategory[] = [
  "automation",
  "websites",
  "monitoring",
  "analytics",
  "storage",
  "security",
  "development",
];

/** Newlines, tabs, NUL and the rest: an environment block cannot hold NUL, and nobody means the others. */
const CONTROL = /[\u0000-\u001f\u007f]/;

const LIMITS = { text: 200, email: 254, password: 128, passwordMin: 8 } as const;

/** Lowest port a template may publish: below it are the system's own services. */
export const MIN_APP_PORT = 1024;

// --- where the app answers ---------------------------------------------------

/** A host name or IP literal, as a URL can carry it. Nothing else: this ends up in links. */
export function isPublicHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (value.includes(":")) return /^[0-9a-f:.]+$/i.test(value) && (value.match(/:/g) ?? []).length >= 2 && value.length <= 45;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(value);
}

/**
 * The URL the app is reached at, which several apps need to know to write
 * their own links: Ghost redirects to it, n8n prints webhook URLs with it.
 *
 * The chosen address when there is one, always over HTTPS — the panel's proxy
 * requests the certificate. Otherwise the server's own name and the port.
 */
export function locateApp(input: { hostname: string | null; publicHost: string; port: number }): AppLocation {
  if (input.hostname) return { url: `https://${input.hostname}`, host: input.hostname, https: true };
  const host = input.publicHost.toLowerCase();
  const inUrl = host.includes(":") ? `[${host}]` : host;
  return { url: input.port === 80 ? `http://${inUrl}` : `http://${inUrl}:${input.port}`, host, https: false };
}

/** `APP_URL` and `APP_HOST`: what most templates derive, under the same names everywhere. */
export function urlVariables(ctx: DeriveContext): { APP_URL: string; APP_HOST: string } {
  return { APP_URL: ctx.url, APP_HOST: ctx.host };
}

// --- answers -----------------------------------------------------------------

export function isTimeZone(value: string): boolean {
  if (!value || value.length > 64 || CONTROL.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface AnswerIssue {
  key: string;
  message: string;
}

/** The first thing wrong with one answer, in Italian, or null. Port availability is the server's to check. */
export function answerProblem(question: CatalogQuestion, value: string): string | null {
  if (value === "") return question.required ? `Serve un valore per «${question.label}»` : null;
  if (CONTROL.test(value)) return "Niente a capo, tabulazioni o caratteri di controllo";

  switch (question.type) {
    case "text": {
      const max = question.maxLength ?? LIMITS.text;
      if (value.length > max) return `Al massimo ${max} caratteri`;
      if (question.minLength && value.length < question.minLength) return `Almeno ${question.minLength} caratteri`;
      if (question.format === "timezone" && !isTimeZone(value)) return "Fuso orario sconosciuto: scrivilo come Europe/Rome";
      if (question.format === "username" && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(value)) {
        return "Lettere, numeri e . _ @ -, senza spazi";
      }
      return null;
    }
    case "email":
      if (value.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Un indirizzo email valido";
      return null;
    case "password": {
      const min = question.minLength ?? LIMITS.passwordMin;
      if (value.length < min) return `Almeno ${min} caratteri`;
      if (value.length > (question.maxLength ?? LIMITS.password)) return `Al massimo ${question.maxLength ?? LIMITS.password} caratteri`;
      return null;
    }
    case "number": {
      if (!/^\d{1,9}$/.test(value)) return "Un numero intero";
      const n = Number(value);
      const min = question.port ? Math.max(MIN_APP_PORT, question.min ?? 0) : question.min;
      const max = question.port ? Math.min(65535, question.max ?? 65535) : question.max;
      if (min !== undefined && n < min) return question.port ? `Una porta tra ${min} e ${max}` : `Almeno ${min}`;
      if (max !== undefined && n > max) return question.port ? `Una porta tra ${min} e ${max}` : `Al massimo ${max}`;
      return null;
    }
    case "boolean": {
      const { on, off } = question.values ?? { on: "true", off: "false" };
      return value === on || value === off ? null : "Sì o no";
    }
  }
}

/** A raw answer as the variable will hold it, or null when it is of the wrong kind. */
function canonical(question: CatalogQuestion, raw: unknown): string | null {
  if (question.type === "boolean") {
    const { on, off } = question.values ?? { on: "true", off: "false" };
    if (raw === true || raw === "true" || raw === on) return on;
    if (raw === false || raw === "false" || raw === off) return off;
    return null;
  }
  if (question.type === "number") {
    if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? String(raw) : null;
    return typeof raw === "string" ? raw.trim() : null;
  }
  if (typeof raw !== "string") return null;
  // A password keeps its spaces: they may be part of it.
  return question.type === "password" ? raw : raw.trim();
}

/** The answers a form starts from. Port questions start empty: the server picks one that is free. */
export function defaultAnswers(template: CatalogTemplate, ctx: { timezone: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const question of template.questions) {
    if (question.port) continue;
    if (question.defaultFrom === "timezone") out[question.key] = isTimeZone(ctx.timezone) ? ctx.timezone : "UTC";
    else if (question.default !== undefined) out[question.key] = question.default;
    else if (question.type === "boolean") out[question.key] = question.values?.off ?? "false";
    else out[question.key] = "";
  }
  return out;
}

/**
 * Check what was sent against the template's questions.
 *
 * A missing answer takes its default; a port question left out stays out, for
 * the server to fill with a free port. A key the template does not ask is an
 * error rather than ignored: a client that sends one believes it is setting
 * something.
 */
export function validateAnswers(
  template: CatalogTemplate,
  raw: Readonly<Record<string, unknown>>,
  ctx: { timezone: string }
): { values: Record<string, string>; issues: AnswerIssue[] } {
  const values: Record<string, string> = {};
  const issues: AnswerIssue[] = [];
  const known = new Set(template.questions.map((q) => q.key));
  const defaults = defaultAnswers(template, ctx);

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) issues.push({ key, message: `${key} non è una domanda di ${template.name}` });
  }

  for (const question of template.questions) {
    const given = Object.hasOwn(raw, question.key) ? raw[question.key] : undefined;
    if (given === undefined || given === null || given === "") {
      if (question.port) continue;
      const fallback = defaults[question.key] ?? "";
      const problem = answerProblem(question, fallback);
      if (problem) issues.push({ key: question.key, message: problem });
      else values[question.key] = fallback;
      continue;
    }
    const value = canonical(question, given);
    if (value === null) {
      issues.push({ key: question.key, message: `«${question.label}»: valore del tipo sbagliato` });
      continue;
    }
    const problem = answerProblem(question, value);
    if (problem) issues.push({ key: question.key, message: problem });
    else values[question.key] = value;
  }

  return { values, issues };
}

// --- what gets written -------------------------------------------------------

/**
 * Every project variable the install writes: the answers, the generated
 * secrets and what follows from the address, in that order.
 */
export function buildEnvironment(
  template: CatalogTemplate,
  input: { answers: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>>; location: AppLocation; port: number }
): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const question of template.questions) {
    const value = input.answers[question.key];
    if (value === undefined) continue;
    entries.push({ key: question.key, value, source: "question", sensitive: question.type === "password" });
  }
  for (const secret of template.secrets) {
    entries.push({ key: secret.key, value: input.secrets[secret.key] ?? "", source: "secret", sensitive: true });
  }
  const derived = template.derive({ ...input.location, port: input.port, answers: input.answers });
  for (const { key } of template.derived) {
    entries.push({ key, value: derived[key] ?? "", source: "derived", sensitive: false });
  }
  return entries;
}

/**
 * The compose file as it lands in the project: a header that says where it
 * came from and how it works, then the template's body.
 *
 * The header avoids the `${…}` notation on purpose. Compose ignores comments,
 * but a reader skimming for what gets substituted should find only the real ones.
 */
export function composeFile(template: CatalogTemplate): string {
  return [
    `# ${template.name}, dal catalogo di RunPanel (modello ${template.id}, revisione ${template.revision}).`,
    "#",
    "# Un file Compose come un altro: puoi cambiarlo e fare un nuovo deploy.",
    "# I valori tra graffe arrivano dalle variabili del progetto (scheda Variabili);",
    "# PORT è la porta del progetto. I dati stanno nei volumi in fondo al file:",
    "# un nuovo deploy li ritrova come li aveva lasciati.",
    "",
    template.compose.trim(),
    "",
  ].join("\n");
}

/** Every `${NAME}` / `${NAME:-fallback}` the file substitutes, and any `$` that is neither. */
export function composeVariables(text: string): { variables: { name: string; fallback: string | null }[]; strays: number } {
  const variables: { name: string; fallback: string | null }[] = [];
  let strays = 0;
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/y;

  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (let i = line.indexOf("$"); i !== -1; i = line.indexOf("$", i + 1)) {
      pattern.lastIndex = i;
      const match = pattern.exec(line);
      if (!match) {
        strays++;
        continue;
      }
      variables.push({ name: match[1], fallback: match[2] ?? null });
      i += match[0].length - 1;
    }
  }
  return { variables, strays };
}

/**
 * The services a template's compose file defines, read off its layout: the
 * two-space keys under `services:`. Enough for files written in this folder,
 * and checked against a real YAML parser by the unit suite; not a parser for
 * anybody else's compose file.
 */
export function composeServiceNames(text: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      continue;
    }
    const match = inServices ? /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/.exec(line) : null;
    if (match) names.push(match[1]);
  }
  return names;
}

/** Every volume and container on a machine, with the Compose project each belongs to (empty for none). */
export interface DockerInventory {
  volumes: { name: string; project: string }[];
  containers: { name: string; project: string }[];
}

/**
 * What a stack called `composeProject` would collide with, as "volume x" or
 * "container y".
 *
 * Deleting a Compose project keeps its named volumes, and Compose hands an
 * existing volume to a new stack of the same name without a word: a fresh
 * install would come up on the old data, with passwords that no longer match
 * it. Matched two ways, by the label Compose stamps and by the exact names it
 * would give, so a volume created by hand under one of those names counts too.
 */
export function stackLeftovers(inventory: DockerInventory, composeProject: string, template: CatalogTemplate): string[] {
  const volumes = new Set(template.volumes.map((volume) => `${composeProject}_${volume.name}`));
  const containers = new Set(composeServiceNames(template.compose).map((service) => `${composeProject}-${service}-1`));
  return [
    ...inventory.volumes.filter((v) => v.project === composeProject || volumes.has(v.name)).map((v) => `volume ${v.name}`),
    ...inventory.containers
      .filter((c) => c.project === composeProject || containers.has(c.name))
      .map((c) => `container ${c.name}`),
  ];
}

/** A note with `{KEY}` filled in from the values it may show. Unknown names stay as written. */
export function fillNote(note: string, values: Readonly<Record<string, string>>): string {
  return note.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (match, key: string) => values[key] ?? match);
}

/** The variables of a template for a page that lists them, with where each comes from. */
export function templateVariables(
  template: CatalogTemplate
): { key: string; label: string; source: EnvEntry["source"]; sensitive: boolean }[] {
  return [
    ...template.questions.map((q) => ({ key: q.key, label: q.label, source: "question" as const, sensitive: q.type === "password" })),
    ...template.secrets.map((s) => ({ key: s.key, label: s.label, source: "secret" as const, sensitive: true })),
    ...template.derived.map((d) => ({ key: d.key, label: d.label, source: "derived" as const, sensitive: false })),
  ];
}

// --- names and search -----------------------------------------------------------

/** What `slugify` in lib/utils.ts makes of a name, without its fallback. */
export function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The name itself, or "n8n 2", "n8n 3"… when a project already has it. */
export function suggestProjectName(base: string, takenSlugs: ReadonlySet<string>): string {
  const name = base.trim();
  if (!takenSlugs.has(slugPreview(name))) return name;
  for (let n = 2; n < 100; n++) {
    const next = `${name} ${n}`;
    if (!takenSlugs.has(slugPreview(next))) return next;
  }
  return `${name} ${Date.now() % 10000}`;
}

/** Lower case without accents, so "statistiche" finds "Statistiche" and "pubblicita" finds "pubblicità". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function filterCatalog<T extends CatalogTemplate>(
  templates: readonly T[],
  filter: { query?: string; category?: CatalogCategory | null }
): T[] {
  const words = fold(filter.query ?? "").split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (filter.category && template.category !== filter.category) return false;
    if (words.length === 0) return true;
    const haystack = fold(
      [template.name, template.description, CATEGORY_LABEL[template.category], ...template.keywords].join(" ")
    );
    return words.every((word) => haystack.includes(word));
  });
}
