import {
  SERVICE_ACTIONS,
  hasPermission,
  projectAccess,
  satisfies,
  serviceAccess,
  type Principal,
} from "@/lib/authz";
import { projectRefs, serviceRefs } from "@/lib/principal";
import {
  mergeLayers,
  parseValue,
  refPath,
  refResource,
  refText,
  resolveEffective,
  type EnvPair,
  type RefTarget,
} from "@/lib/env-refs";
import { findProject, findService, lookupFor, type EnvSnapshot } from "./project-env";

/**
 * Who may write a reference.
 *
 * A reference is a way to have the panel copy a value somewhere else. Whoever
 * manages a project can make its app print what it receives — a start command
 * that echoes it, a log they can read — so writing `${{ db.cache.password }}`
 * into a project is reading that password. The rule is therefore the plain
 * one: you may only point at what you could read yourself.
 *
 *   shared.G.K      the Variabili condivise permission, which reads every group
 *   db.…            the database's credentials (manage on it, or on the project
 *                   it is linked to)
 *   project.SLUG    seeing that project
 *
 * Checked when a value is saved, and only for what is new in it. The targets
 * of a reference are fixed (`lib/env-refs.ts`), so a check made when it was
 * written still holds at every deploy; and a reference somebody else wrote,
 * left as it was, is not this writer's to answer for — otherwise nobody below
 * them could save the project's variables again.
 *
 * A target the writer cannot see at all is reported as missing, in the same
 * words as one that does not exist: the refusal must not tell them it does.
 */

export interface RefIssue {
  /** Position in the list that was sent. */
  index: number;
  key: string;
  message: string;
  /** A permission, as opposed to a mistake: the route answers 403 rather than 400. */
  forbidden: boolean;
}

export interface RefCheck {
  principal: Principal;
  /** The list as it will be stored. */
  values: readonly EnvPair[];
  /** The raw values stored before this save, to tell new references from old. */
  before: readonly string[];
  /** What the references resolve against — the state after the save. */
  snap: EnvSnapshot;
  /** Values that are always resolved, new references or not: a group's own names it may be removing. */
  alwaysResolve?: (value: string) => boolean;
  /** For a variable of a group, the group's name: the messages say whose variable it is. */
  groupName?: string;
}

export async function checkReferences(check: RefCheck): Promise<RefIssue[]> {
  const beforePaths = new Set<string>();
  const beforeResources = new Set<string>();
  for (const raw of check.before) {
    for (const ref of parseValue(raw).refs) {
      beforePaths.add(refPath(ref));
      beforeResources.add(refResource(ref));
    }
  }

  const [projects, services] = await Promise.all([projectRefs(), serviceRefs()]);
  const lookup = lookupFor(check.snap, "host");
  const issues: RefIssue[] = [];

  const visible = (ref: RefTarget): "ok" | "hidden" | "forbidden" => {
    if (ref.kind === "shared") return hasPermission(check.principal, "variables") ? "ok" : "forbidden";
    if (ref.kind === "project") {
      const found = findProject(check.snap, ref);
      if ("problem" in found) return "ok"; // missing: the resolution below says so
      const target = projects.get(found.project.id);
      return target && projectAccess(check.principal, target).level !== null ? "ok" : "hidden";
    }
    const found = findService(check.snap, ref);
    if ("problem" in found) return "ok";
    const target = services.get(found.service.id);
    const access = target ? serviceAccess(check.principal, target) : { level: null, terminal: false };
    if (access.level === null) return "hidden";
    return satisfies(access, SERVICE_ACTIONS.credentials) ? "ok" : "forbidden";
  };

  check.values.forEach((pair, index) => {
    const parsed = parseValue(pair.value);
    if (parsed.error) {
      issues.push({ index, key: pair.key, message: `Riferimento scritto male: ${parsed.error}`, forbidden: false });
      return;
    }

    let newPath = false;
    for (const ref of parsed.refs) {
      if (!beforePaths.has(refPath(ref))) newPath = true;
      if (beforeResources.has(refResource(ref))) continue;
      const seen = visible(ref);
      if (seen === "forbidden") {
        issues.push({
          index,
          key: pair.key,
          forbidden: true,
          message:
            ref.kind === "db"
              ? `Per usare ${refText(ref)} devi poter vedere le credenziali del database «${ref.service}»`
              : `Per usare ${refText(ref)} serve il permesso «Variabili condivise»`,
        });
        return;
      }
      if (seen === "hidden") {
        issues.push({
          index,
          key: pair.key,
          forbidden: false,
          message:
            ref.kind === "project"
              ? `${refText(ref)} non porta a niente: non c'è un progetto «${ref.slug}» su questo server`
              : `${refText(ref)} non porta a niente: non c'è un database «${ref.kind === "db" ? ref.service : ref.group}» su questo server`,
        });
        return;
      }
    }

    if (!newPath && !check.alwaysResolve?.(pair.value)) return;
    // Resolved as a whole, the way a deploy will: a new reference is refused
    // here rather than left to stop somebody's deploy later.
    const source = check.groupName ? { kind: "group" as const, id: "", name: check.groupName } : { kind: "own" as const };
    const [single] = mergeLayers([], [pair]).map((v) => ({ ...v, source }));
    const outcome = resolveEffective([single], lookup);
    const problem = outcome.problems[0];
    if (problem) issues.push({ index, key: pair.key, message: problem.message, forbidden: false });
  });

  return issues;
}

/** The issues as the variables API reports them: on their rows, with the first one as the error. */
export function issuesResponse(issues: readonly RefIssue[]): { status: 400 | 403; body: { error: string; details: unknown[] } } {
  const first = issues[0];
  return {
    status: issues.some((issue) => issue.forbidden) ? 403 : 400,
    body: {
      error: first.message.startsWith("La variabile") ? first.message : `«${first.key}»: ${first.message}`,
      details: issues.map((issue) => ({ code: "custom", path: ["vars", issue.index, "value"], message: issue.message })),
    },
  };
}
