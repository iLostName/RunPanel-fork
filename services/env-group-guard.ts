import { NextResponse } from "next/server";
import { hasPermission, projectAccess, type Principal } from "@/lib/authz";
import { projectReachesHost } from "@/lib/host-guard";
import { projectRefs } from "@/lib/principal";
import type { GroupUsage, ProjectBrief, Reader } from "./env-groups";

/**
 * The rules that hold a group to the projects it reaches.
 *
 * Changing the variables of a project that runs on the host takes the
 * "Accesso all'host" permission (`lib/host-guard.ts`): a `NODE_OPTIONS` or an
 * `LD_PRELOAD` is code, and a native app runs it as the panel's own user. A
 * group is a way to change many projects' variables at once, so the same rule
 * follows it there — otherwise the Variabili condivise permission would be a
 * way around it.
 */
export async function hostGuardForGroup(principal: Principal, usage: GroupUsage): Promise<NextResponse | null> {
  if (hasPermission(principal, "host")) return null;
  const reaching = [...usage.attached.map((a) => a.project), ...usage.referencing].find((p) => projectReachesHost(p));
  if (!reaching) return null;
  const ref = (await projectRefs()).get(reaching.id);
  const named = ref && projectAccess(principal, ref).level !== null ? `al progetto «${reaching.name}»` : "a un progetto";
  return NextResponse.json(
    { error: `Serve il permesso "Accesso all'host": il gruppo arriva ${named}, che gira sull'host`, code: "host_required" },
    { status: 403 }
  );
}

export interface UsageView {
  attached: { id: string; name: string; slug: string; status: string; position: number }[];
  referencing: { id: string; name: string; slug: string; status: string }[];
  groups: string[];
  /** Projects reached that this account may not see: counted, never named. */
  hidden: number;
}

/** The usage as one account may see it. */
export async function usageFor(principal: Principal, usage: GroupUsage): Promise<UsageView> {
  const refs = await projectRefs();
  const sees = (project: ProjectBrief) => {
    const ref = refs.get(project.id);
    return ref ? projectAccess(principal, ref).level !== null : false;
  };
  const brief = (p: ProjectBrief) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status });
  const attached = usage.attached.filter((a) => sees(a.project)).map((a) => ({ ...brief(a.project), position: a.position }));
  const referencing = usage.referencing.filter(sees).map(brief);
  const total = usage.attached.length + usage.referencing.length;
  return { attached, referencing, groups: usage.groups, hidden: total - attached.length - referencing.length };
}

/**
 * "il progetto «blog», il gruppo «base»" — who reads a name, for a refusal.
 * A project this account may not see is not named.
 */
export async function readersText(principal: Principal, readers: readonly Reader[]): Promise<string> {
  const refs = await projectRefs();
  const words = readers.map((reader) => {
    if (reader.kind === "group") return `il gruppo «${reader.name}»`;
    const ref = refs.get(reader.id);
    return ref && projectAccess(principal, ref).level !== null ? `il progetto «${reader.name}»` : "un progetto che non puoi vedere";
  });
  const unique = [...new Set(words)];
  return unique.length <= 3 ? unique.join(", ") : `${unique.slice(0, 3).join(", ")} e altri ${unique.length - 3}`;
}
