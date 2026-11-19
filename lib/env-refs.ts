/**
 * Shared variables and references, without a database: the syntax, the
 * precedence and the resolution.
 *
 * A value may read another value instead of repeating it:
 *
 *   ${{ shared.GROUP.NAME }}            a variable of a shared group
 *   ${{ db.NAME.field }}                a database with no project
 *   ${{ db.PROJECT.NAME.field }}        a database linked to a project
 *   ${{ project.SLUG.field }}           how to reach another project
 *
 * `$${{` writes `${{` as it is. The double brace and the namespace make a
 * reference impossible to confuse with the `${VAR}` a shell, Compose or a
 * dotenv loader expands, which already appear in real values.
 *
 * Every reference names exactly one thing, whichever project reads it. A
 * database linked to a project is named with the project for that reason: a
 * bare name that meant "the one linked to me, else the one with no project"
 * would quietly start meaning another database the day the first was unlinked
 * or deleted — a password nobody chose to hand over, arriving at the next
 * deploy. Fixed targets are also what lets the permission to use one be
 * checked once, when the reference is written, and still hold at every deploy.
 *
 * The value of a target can depend on who reads it: a database is reached by
 * container name from a container and on `localhost` from the host, exactly as
 * the injected `DATABASE_URL` is. That part is the caller's lookup.
 *
 * Zero imports: the unit suite loads this file directly, and the Variables tab
 * runs it in the browser to point at a reference that is written wrong.
 */

export interface EnvPair {
  key: string;
  value: string;
}

/** A group's name is how references find it, so it is held to what a reference can spell. */
export const GROUP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const GROUP_NAME_RULE =
  "Nome non valido: lettere minuscole, numeri, - e _, al massimo 40 caratteri, iniziando con una lettera o un numero";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,37}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

export const DB_FIELDS = ["url", "host", "port", "user", "password", "database"] as const;
export type DbField = (typeof DB_FIELDS)[number];
export const PROJECT_FIELDS = ["url", "host", "port"] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

export type SharedRef = { kind: "shared"; group: string; key: string };
/** `project` is the slug of the project the database is linked to; null for one with no project. */
export type DbRef = { kind: "db"; project: string | null; service: string; field: DbField };
export type ProjectRef = { kind: "project"; slug: string; field: ProjectField };
export type RefTarget = SharedRef | DbRef | ProjectRef;

/** `shared.smtp.HOST`, as written between the braces. */
export function refPath(ref: RefTarget): string {
  if (ref.kind === "shared") return `shared.${ref.group}.${ref.key}`;
  if (ref.kind === "db") return ref.project ? `db.${ref.project}.${ref.service}.${ref.field}` : `db.${ref.service}.${ref.field}`;
  return `project.${ref.slug}.${ref.field}`;
}

/** `${{ shared.smtp.HOST }}`, the way the docs and every message spell it. */
export function refText(ref: RefTarget): string {
  return `\${{ ${refPath(ref)} }}`;
}

/**
 * What a reference reads, without the part that only picks a piece of it: the
 * permission to use `db.cache.url` is the permission to use `db.cache.password`.
 */
export function refResource(ref: RefTarget): string {
  if (ref.kind === "shared") return `shared:${ref.group}.${ref.key}`;
  if (ref.kind === "db") return `db:${ref.project ?? ""}/${ref.service}`;
  return `project:${ref.slug}`;
}

/** Whether the value depends on where the reader runs: container name or `localhost`, inner or published port. */
export function dependsOnOrigin(ref: RefTarget): boolean {
  if (ref.kind === "db") return ref.field === "url" || ref.field === "host" || ref.field === "port";
  if (ref.kind === "project") return ref.field === "url" || ref.field === "host";
  return false;
}

export type Segment = { kind: "text"; text: string } | { kind: "ref"; ref: RefTarget };

export interface ParsedValue {
  segments: Segment[];
  refs: RefTarget[];
  /** Why the value cannot be read, in words that finish a sentence; null when it can. */
  error: string | null;
}

const OPEN = "${{";
const ESCAPED_OPEN = "$${{";
const CLOSE = "}}";

/** Why `inner` (what sits between the braces, trimmed) is not a reference, or the reference. */
export function parseRef(inner: string): { ref: RefTarget } | { error: string } {
  const shown = `«\${{ ${inner} }}»`;
  if (!inner) return { error: "c'è un ${{ }} vuoto" };
  const parts = inner.split(".");
  const [namespace] = parts;
  const bad = (name: string) => ({ error: `${shown}: "${name}" non è un nome valido` });

  if (namespace === "shared") {
    if (parts.length !== 3) return { error: `${shown}: si scrive \${{ shared.GRUPPO.VARIABILE }}` };
    const [, group, key] = parts;
    if (!GROUP_NAME_PATTERN.test(group)) return bad(group);
    if (!KEY_PATTERN.test(key)) return bad(key);
    return { ref: { kind: "shared", group, key } };
  }

  if (namespace === "db") {
    if (parts.length !== 3 && parts.length !== 4) {
      return { error: `${shown}: si scrive \${{ db.DATABASE.campo }}, o \${{ db.PROGETTO.DATABASE.campo }} per uno collegato a un progetto` };
    }
    const field = parts[parts.length - 1];
    const service = parts[parts.length - 2];
    const project = parts.length === 4 ? parts[1] : null;
    if (project !== null && !SLUG_PATTERN.test(project)) return bad(project);
    if (!SERVICE_PATTERN.test(service)) return bad(service);
    if (!(DB_FIELDS as readonly string[]).includes(field)) {
      return { error: `${shown}: "${field}" non è un campo di un database, usa ${DB_FIELDS.join(", ")}` };
    }
    return { ref: { kind: "db", project, service, field: field as DbField } };
  }

  if (namespace === "project") {
    if (parts.length !== 3) return { error: `${shown}: si scrive \${{ project.PROGETTO.campo }}` };
    const [, slug, field] = parts;
    if (!SLUG_PATTERN.test(slug)) return bad(slug);
    if (!(PROJECT_FIELDS as readonly string[]).includes(field)) {
      return { error: `${shown}: "${field}" non è un campo di un progetto, usa ${PROJECT_FIELDS.join(", ")}` };
    }
    return { ref: { kind: "project", slug, field: field as ProjectField } };
  }

  return { error: `${shown}: "${namespace}" non è un tipo di riferimento, usa shared, db o project` };
}

/**
 * A value cut into text and references.
 *
 * Read left to right: `$${{` is a literal `${{` and what follows it is plain
 * text; `${{` opens a reference that the first `}}` closes. A `$` anywhere
 * else is just a dollar — `pa$$word` stays what it is.
 */
export function parseValue(value: string): ParsedValue {
  const segments: Segment[] = [];
  const refs: RefTarget[] = [];
  let text = "";
  let i = 0;

  while (i < value.length) {
    if (value.startsWith(ESCAPED_OPEN, i)) {
      text += OPEN;
      i += ESCAPED_OPEN.length;
      continue;
    }
    if (value.startsWith(OPEN, i)) {
      const close = value.indexOf(CLOSE, i + OPEN.length);
      if (close < 0) {
        return { segments: [], refs: [], error: "un ${{ non è chiuso da }} (per scriverlo così com'è usa $${{)" };
      }
      const parsed = parseRef(value.slice(i + OPEN.length, close).trim());
      if ("error" in parsed) return { segments: [], refs: [], error: parsed.error };
      if (text) segments.push({ kind: "text", text });
      text = "";
      segments.push({ kind: "ref", ref: parsed.ref });
      refs.push(parsed.ref);
      i = close + CLOSE.length;
      continue;
    }
    text += value[i];
    i++;
  }

  if (text) segments.push({ kind: "text", text });
  return { segments, refs, error: null };
}

/** Whether a value holds a reference, or something that tries to be one. */
export function mentionsReference(value: string): boolean {
  return value.replaceAll(ESCAPED_OPEN, "").includes(OPEN);
}

// --- precedence -------------------------------------------------------------

/**
 * Where an effective variable comes from.
 *
 * `inherited` is the own variable of the project an environment inherits
 * from — production, or for a preview its staging — and `environment` says
 * which (lib/environments.ts). A group reached that way carries `via`, the
 * name of that project: the group is the same one, received through it.
 */
export type EnvSource =
  | { kind: "own" }
  | { kind: "group"; id: string; name: string; via?: string }
  | { kind: "inherited"; id: string; name: string; environment: "production" | "staging" }
  | { kind: "database"; id: string; name: string }
  | { kind: "panel" };

export interface GroupLayer {
  id: string;
  name: string;
  vars: readonly EnvPair[];
}

/** A layer under the groups, inherited from another project: see `mergeLayers`. */
export interface InheritedLayer {
  source: EnvSource;
  vars: readonly EnvPair[];
}

export interface EffectiveVar {
  key: string;
  /** As stored, references not expanded. */
  raw: string;
  source: EnvSource;
  /** The other definitions of this name, which lose to this one: the closest first. */
  overridden: EnvSource[];
  /** Every reference read to build the value, nested ones included. */
  refs: RefTarget[];
  /** The value the app receives; null when it does not resolve, or was not resolved. */
  value: string | null;
  /** Why it does not resolve: a whole sentence naming the variable. */
  problem: string | null;
}

/**
 * The project's own variables over its shared groups, and a later group over an
 * earlier one.
 *
 * Own first because it is the most specific answer: typed for this app, where a
 * group is a default several apps share. The database links sit above all of
 * this (`applyInjected`), as they always have: an enabled link is an explicit
 * choice of a value for one name, and projects already rely on it replacing a
 * stale `DATABASE_URL` of their own.
 *
 * An environment also receives what it inherits, under everything it sets
 * itself: `inherited` is that, lowest first — production's groups, then its
 * own variables (and for a preview, staging's after them). Whatever the
 * environment says wins over whatever it inherits.
 */
export function mergeLayers(
  groups: readonly GroupLayer[],
  own: readonly EnvPair[],
  inherited: readonly InheritedLayer[] = []
): EffectiveVar[] {
  const byKey = new Map<string, EffectiveVar>();
  const define = (pair: EnvPair, source: EnvSource) => {
    const previous = byKey.get(pair.key);
    byKey.set(pair.key, {
      key: pair.key,
      raw: pair.value,
      source,
      overridden: previous ? [previous.source, ...previous.overridden] : [],
      refs: [],
      value: null,
      problem: null,
    });
  };
  for (const layer of inherited) {
    for (const pair of layer.vars) define(pair, layer.source);
  }
  for (const group of groups) {
    for (const pair of group.vars) define(pair, { kind: "group", id: group.id, name: group.name });
  }
  for (const pair of own) define(pair, { kind: "own" });
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Values that replace whatever the project and its groups say for a name: the
 * connection URLs of enabled database links, and the panel's own.
 */
export function applyInjected(
  vars: readonly EffectiveVar[],
  injected: readonly { key: string; source: EnvSource; value: string | null }[]
): EffectiveVar[] {
  const byKey = new Map(vars.map((v) => [v.key, v]));
  for (const item of injected) {
    const previous = byKey.get(item.key);
    byKey.set(item.key, {
      key: item.key,
      raw: item.value ?? "",
      source: item.source,
      overridden: previous ? [previous.source, ...previous.overridden] : [],
      refs: [],
      value: item.value,
      problem: null,
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Two or more groups that define a name the project leaves to them: the later wins, and that is worth saying. */
export function groupConflict(v: EffectiveVar): string[] | null {
  if (v.source.kind !== "group") return null;
  const rivals = v.overridden.filter((s): s is Extract<EnvSource, { kind: "group" }> => s.kind === "group");
  return rivals.length > 0 ? rivals.map((s) => s.name) : null;
}

// --- resolution -------------------------------------------------------------

export interface RefLookup {
  /** A shared variable as stored: it may hold references of its own. */
  shared(group: string, key: string): { value: string } | { problem: string };
  /** What a database or project reference stands for. Never holds references. */
  resource(ref: DbRef | ProjectRef): { value: string } | { problem: string };
}

type Failure =
  | { kind: "reason"; chain: string[]; reason: string }
  | { kind: "syntax"; chain: string[]; reason: string; where: { group: string; key: string } | null }
  | { kind: "cycle"; chain: string[] };

type Outcome = { ok: true; value: string; refs: RefTarget[] } | { ok: false; failure: Failure; refs: RefTarget[] };

interface Context {
  lookup: RefLookup;
  /** Shared variables already worked out, whatever asked first. */
  memo: Map<string, Outcome>;
}

const nodeOf = (group: string, key: string) => `${group}.${key}`;

function resolveRaw(raw: string, where: { group: string; key: string } | null, stack: readonly string[], ctx: Context, local: Map<string, Outcome>): Outcome {
  const parsed = parseValue(raw);
  if (parsed.error) return { ok: false, failure: { kind: "syntax", chain: [], reason: parsed.error, where }, refs: [] };

  let out = "";
  const refs: RefTarget[] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    const ref = segment.ref;
    const shown = refText(ref);
    refs.push(ref);

    let inner: Outcome;
    if (ref.kind === "shared") {
      const node = nodeOf(ref.group, ref.key);
      if (stack.includes(node)) return { ok: false, failure: { kind: "cycle", chain: [shown] }, refs };
      const known = ctx.memo.get(node) ?? local.get(node);
      if (known) {
        inner = known;
      } else {
        const found = ctx.lookup.shared(ref.group, ref.key);
        inner =
          "problem" in found
            ? { ok: false, failure: { kind: "reason", chain: [], reason: found.problem }, refs: [] }
            : resolveRaw(found.value, { group: ref.group, key: ref.key }, [...stack, node], ctx, local);
        // A cycle is only a cycle seen from where the walk started: kept for
        // this variable, worked out again for the next, so its message names
        // the loop the way that variable meets it.
        (inner.ok || inner.failure.kind !== "cycle" ? ctx.memo : local).set(node, inner);
      }
      if (inner.ok && inner.value === "") {
        inner = { ok: false, failure: { kind: "reason", chain: [], reason: `${ref.key} del gruppo «${ref.group}» è vuota` }, refs: inner.refs };
      }
    } else {
      const found = ctx.lookup.resource(ref);
      inner =
        "problem" in found
          ? { ok: false, failure: { kind: "reason", chain: [], reason: found.problem }, refs: [] }
          : found.value === ""
            ? { ok: false, failure: { kind: "reason", chain: [], reason: "il valore è vuoto" }, refs: [] }
            : { ok: true, value: found.value, refs: [] };
    }

    refs.push(...inner.refs);
    if (!inner.ok) return { ok: false, failure: { ...inner.failure, chain: [shown, ...inner.failure.chain] }, refs };
    out += inner.value;
  }
  return { ok: true, value: out, refs };
}

function ownerOf(v: Pick<EffectiveVar, "key" | "source">): string {
  if (v.source.kind === "group") return `La variabile ${v.key} del gruppo «${v.source.name}»`;
  if (v.source.kind === "inherited") return `La variabile ${v.key} ereditata da «${v.source.name}»`;
  return `La variabile ${v.key}`;
}

/** The sentence for a failure: what was read, through what, and why it stops there. */
function describe(owner: string, failure: Failure): string {
  const uses = failure.chain.length > 0 ? ` usa ${failure.chain.join(", che usa ")}` : "";
  if (failure.kind === "cycle") {
    return `${owner}${uses}: è un riferimento circolare, il valore finisce per rimandare a se stesso.`;
  }
  if (failure.kind === "syntax") {
    if (!failure.where || failure.chain.length === 0) return `${owner} ha un riferimento scritto male: ${failure.reason}.`;
    return `${owner}${uses}, ma ${failure.where.key} del gruppo «${failure.where.group}» ha un riferimento scritto male: ${failure.reason}.`;
  }
  return `${owner}${uses}, ma ${failure.reason}.`;
}

export interface Resolution {
  vars: EffectiveVar[];
  /** Name → value, for what resolved. */
  env: Record<string, string>;
  problems: { key: string; source: EnvSource; message: string }[];
}

/**
 * Every effective value with its references expanded, and every one that
 * cannot be, with the sentence that says why.
 *
 * Nothing that fails is given a value — not an empty one, not the text of the
 * reference: the caller stops the deploy instead. `skip` names the variables a
 * database link replaces, which never reach the app and so cannot stop it.
 */
export function resolveEffective(
  vars: readonly EffectiveVar[],
  lookup: RefLookup,
  opts: { skip?: ReadonlySet<string> } = {}
): Resolution {
  const ctx: Context = { lookup, memo: new Map() };
  const env: Record<string, string> = {};
  const problems: Resolution["problems"] = [];
  const out: EffectiveVar[] = [];

  for (const v of vars) {
    if (v.source.kind === "database" || v.source.kind === "panel" || opts.skip?.has(v.key)) {
      out.push(v);
      if (v.value !== null) env[v.key] = v.value;
      continue;
    }
    const where = v.source.kind === "group" ? { group: v.source.name, key: v.key } : null;
    const node = where ? nodeOf(where.group, where.key) : null;
    const local = new Map<string, Outcome>();
    let outcome = node ? ctx.memo.get(node) : undefined;
    if (!outcome) {
      outcome = resolveRaw(v.raw, where, node ? [node] : [], ctx, local);
      if (node && (outcome.ok || outcome.failure.kind !== "cycle")) ctx.memo.set(node, outcome);
    }

    if (outcome.ok) {
      env[v.key] = outcome.value;
      out.push({ ...v, refs: outcome.refs, value: outcome.value, problem: null });
    } else {
      const message = describe(ownerOf(v), outcome.failure);
      problems.push({ key: v.key, source: v.source, message });
      out.push({ ...v, refs: outcome.refs, value: null, problem: message });
    }
  }

  return { vars: out, env, problems };
}

/**
 * The shared variables a set of values depends on, nested ones included — what
 * a change to a group can reach. `values` are raw; `shared` is how to read the
 * raw value of a shared variable. Unreadable or missing ones are simply not
 * followed: this answers "what could this touch", not "does it resolve".
 */
export function sharedClosure(values: readonly string[], shared: (group: string, key: string) => string | null): Set<string> {
  const seen = new Set<string>();
  const queue = [...values];
  while (queue.length > 0) {
    const raw = queue.pop() as string;
    for (const ref of parseValue(raw).refs) {
      if (ref.kind !== "shared") continue;
      const node = nodeOf(ref.group, ref.key);
      if (seen.has(node)) continue;
      seen.add(node);
      const next = shared(ref.group, ref.key);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

/**
 * A loop among shared variables, if there is one: the path, first node
 * repeated at the end. Used when a group is saved, so a loop is refused when it
 * is written rather than discovered at somebody's deploy.
 */
export function findCycle(groups: readonly { name: string; vars: readonly EnvPair[] }[]): string[] | null {
  const raw = new Map<string, string>();
  for (const group of groups) for (const pair of group.vars) raw.set(nodeOf(group.name, pair.key), pair.value);

  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    const mark = state.get(node);
    if (mark === "done") return null;
    if (mark === "open") return [...path.slice(path.indexOf(node)), node];
    const value = raw.get(node);
    if (value === undefined) return null;
    state.set(node, "open");
    path.push(node);
    for (const ref of parseValue(value).refs) {
      if (ref.kind !== "shared") continue;
      const found = visit(nodeOf(ref.group, ref.key));
      if (found) return found;
    }
    path.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of raw.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}
