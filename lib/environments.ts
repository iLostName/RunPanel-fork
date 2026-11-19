/**
 * Environments, without a database: the rules a staging copy and a preview
 * follow, decided once.
 *
 * An environment is a sibling project of a production project — its own row,
 * container, folder, port, address and resources — that runs the same code
 * from another branch (staging) or from a pull request (preview). It is linked
 * to production by `projects.environment_of` (migration 053) and:
 *
 * - takes production's permissions, never its own (lib/principal.ts);
 * - receives production's variables, under its own (services/project-env.ts),
 *   except those that read production's databases;
 * - never changes production, except through "Promuovi in produzione", which
 *   deploys on production exactly the commit staging runs.
 *
 * Zero imports: the unit suite loads this file directly, and the pages run it
 * in the browser to label what they show.
 */

export const ENVIRONMENT_KINDS = ["staging", "preview"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export function isEnvironmentKind(value: unknown): value is EnvironmentKind {
  return typeof value === "string" && (ENVIRONMENT_KINDS as readonly string[]).includes(value);
}

/** How the pages name each member of a family. */
export const ENVIRONMENT_LABEL: Record<EnvironmentKind | "production", string> = {
  production: "Produzione",
  staging: "Staging",
  preview: "Anteprima",
};

/** The two columns that place a project in a family. */
export interface EnvironmentColumns {
  environment_of: string | null;
  environment: string | null;
}

/**
 * Which kind of member a row is. A row naming a parent with no kind it knows
 * — written by a newer panel, say — reads as staging, the one that is never
 * removed by itself; a kind with no parent reads as an ordinary project.
 */
export function environmentKindOf(row: EnvironmentColumns): EnvironmentKind | null {
  if (!row.environment_of) return null;
  return isEnvironmentKind(row.environment) ? row.environment : "staging";
}

/** The production project of a family, given any of its members. */
export function productionIdOf(row: { id: string } & EnvironmentColumns): string {
  return row.environment_of ?? row.id;
}

/**
 * Why a project cannot have environments, or null when it can.
 *
 * A branch is what tells two environments apart, so the source has to be a
 * repository: an uploaded ZIP has one version, the one on disk. And a family
 * is one level deep — an environment of an environment would take its
 * permissions and variables from a project that takes them from another.
 */
export function environmentsBlocker(project: {
  source_type: string;
  source_url: string | null;
  environment_of: string | null;
}): string | null {
  if (project.environment_of) {
    return "Questo progetto è già un ambiente: gli ambienti si creano dal progetto di produzione.";
  }
  if (project.source_type !== "github" || !project.source_url) {
    return "Un ambiente segue un branch: serve un repository GitHub come sorgente del progetto.";
  }
  return null;
}

/**
 * The projects an environment inherits its variables from, lowest first.
 *
 * Staging inherits from production. A preview inherits from staging when
 * there is one — the closest thing to what it will become — which itself
 * inherits from production, so both come along, production first. An
 * ordinary project, or one whose production is gone, inherits nothing.
 */
export function inheritanceChain<T extends { id: string } & EnvironmentColumns>(self: T, all: readonly T[]): T[] {
  const kind = environmentKindOf(self);
  if (!kind) return [];
  const production = all.find((p) => p.id === self.environment_of && !p.environment_of);
  if (!production) return [];
  if (kind !== "preview") return [production];
  const staging = all.find((p) => p.environment_of === production.id && environmentKindOf(p) === "staging");
  return staging ? [production, staging] : [production];
}

// --- names ---------------------------------------------------------------------

const NAME_MAX = 100;

/** `Negozio (staging)`, within the 100 characters a project's name may have. */
export function stagingName(productionName: string): string {
  const suffix = " (staging)";
  return `${productionName.trim().slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/**
 * A slug for a sibling: `negozio-staging`, `negozio-pr-12`, with `-2`, `-3`…
 * after it while one is taken. The container, the image, the folder and the
 * volumes all derive from the slug, so it must never be production's or
 * another sibling's — exact names are what keeps deleting one from touching
 * the other (services/docker/labels.ts filters on the whole value).
 */
export function environmentSlug(productionSlug: string, suffix: string, taken: ReadonlySet<string>): string {
  const base = `${productionSlug}-${suffix}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// --- the staging branch ----------------------------------------------------------

/** What staging usually follows, in the order a repository tends to have them. */
export const STAGING_BRANCHES = ["staging", "develop"] as const;

/**
 * The branch proposed for a new staging environment: `staging` or `develop`,
 * whichever the repository has, never the branch production follows — two
 * environments on one branch would deploy every push twice, and a promote
 * would deploy what production already has. With no list (no GitHub account
 * connected, or GitHub did not answer) the first candidate, for the operator
 * to correct.
 */
export function defaultStagingBranch(productionBranch: string, branches: readonly string[] | null): string {
  const candidates = STAGING_BRANCHES.filter((name) => name !== productionBranch);
  if (branches) {
    const found = candidates.find((name) => branches.includes(name));
    if (found) return found;
  }
  return candidates[0] ?? "staging";
}

/** Why a branch cannot be staging's, or null. */
export function stagingBranchProblem(branch: string, productionBranch: string): string | null {
  if (branch === productionBranch) {
    return `Produzione segue già ${productionBranch}: scegli un altro branch per lo staging.`;
  }
  return null;
}

// --- promote ---------------------------------------------------------------------

/**
 * Why staging cannot be promoted now, or null.
 *
 * `stagingCommit` is the commit of staging's live deployment — the one that
 * answers on its address — not the head of its branch: "what staging runs" is
 * what was tried there.
 */
export function promoteBlocker(input: {
  stagingKind: EnvironmentKind | null;
  productionExists: boolean;
  productionSourceType: string | null;
  stagingCommit: string | null;
}): string | null {
  if (input.stagingKind !== "staging") return "Si promuove in produzione solo un ambiente di staging.";
  if (!input.productionExists) return "Il progetto di produzione non esiste più.";
  if (input.productionSourceType !== "github") {
    return "Produzione non parte più da un repository GitHub: non c'è un commit da distribuire.";
  }
  if (!input.stagingCommit) {
    return "Lo staging non ha ancora una versione funzionante: fai un deploy che riesca, poi promuovilo.";
  }
  return null;
}

// --- variables ---------------------------------------------------------------------

export type VariableChange = "added" | "removed" | "changed";

export interface VariableDiff {
  key: string;
  /**
   * Seen from production, which is what a promote changes:
   * `added` — staging has it and production does not, the one that breaks a
   * promoted app most often; `changed` — both, with different values;
   * `removed` — only production has it.
   */
  change: VariableChange;
}

const CHANGE_ORDER: Record<VariableChange, number> = { added: 0, changed: 1, removed: 2 };

/**
 * The variables two environments do not share, names only: the values are
 * secrets, and the question a promote asks is "will production have what
 * this code expects", which names answer. A value that did not resolve
 * (null) differs from every value, itself included.
 */
export function diffVariables(
  staging: Readonly<Record<string, string | null>>,
  production: Readonly<Record<string, string | null>>
): VariableDiff[] {
  const out: VariableDiff[] = [];
  for (const key of Object.keys(staging)) {
    if (!(key in production)) out.push({ key, change: "added" });
    else if (staging[key] === null || production[key] === null || staging[key] !== production[key]) out.push({ key, change: "changed" });
  }
  for (const key of Object.keys(production)) {
    if (!(key in staging)) out.push({ key, change: "removed" });
  }
  return out.sort((a, b) => CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] || a.key.localeCompare(b.key));
}

/**
 * Whether a variable an environment would inherit reads one of production's
 * own databases — `${{ db.<production>.<name>.… }}`, directly or through a
 * group. Such a variable is not inherited: an environment gets production's
 * databases only when somebody writes the reference into its own variables,
 * on purpose (services/environments.ts offers it, with a warning).
 */
export function readsDatabaseOf(refs: readonly { kind: string; project?: string | null }[], productionSlug: string): boolean {
  return refs.some((ref) => ref.kind === "db" && ref.project === productionSlug);
}

// --- deleting ----------------------------------------------------------------------

/**
 * Why production cannot be deleted as asked, or null. Its environments run its
 * code with its variables and its permissions: deleting production alone would
 * leave them following nothing. They go with it, or it stays.
 */
export function productionDeleteProblem(environmentCount: number, withEnvironments: boolean): string | null {
  if (environmentCount === 0 || withEnvironments) return null;
  return environmentCount === 1
    ? "Il progetto ha un ambiente: eliminalo prima, oppure conferma di eliminarlo insieme al progetto."
    : `Il progetto ha ${environmentCount} ambienti: eliminali prima, oppure conferma di eliminarli insieme al progetto.`;
}
