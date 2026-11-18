import { NextResponse } from "next/server";
import { hasPermission, PROJECT_ACTIONS, satisfies, type Access, type Principal } from "@/lib/authz";
import { getDb } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { projectReachesHost } from "@/lib/host-guard";
import { runsInFor } from "@/lib/tasks-rules";
import type { TaskContext } from "./store";

/**
 * Who may change a project's tasks, and the bits of the project every route reads.
 *
 * A task is a command the panel runs unattended, so changing one follows
 * `lib/host-guard.ts` the way the one-time commands do: `manage` on the
 * project, plus the `host` permission whenever the project reaches the host —
 * a native runtime runs it as the panel's own user, Compose and a container
 * with host networking, capabilities or bind mounts reach past their
 * container. That covers every change, not only the command's text: when,
 * how long, on or off, and deleting it are decisions about a command on the
 * host too. A plain container stays fully its managers' to automate, the way
 * it stays theirs to configure and deploy. Running and stopping a task that
 * exists is `operate`, like a deploy: whoever saved it had the right.
 */

export const HOST_WHAT = "modificare le attività pianificate di questo progetto";

export type TaskProject = Pick<ProjectsTable, "id" | "name" | "slug" | "runtime_type" | "builder_config">;

/** Where the project's tasks run now, and whether that reaches the host: what a view and a start compare against. */
export function taskContext(project: Pick<ProjectsTable, "runtime_type" | "builder_config">): TaskContext {
  return { runsIn: runsInFor(project.runtime_type), reachesHost: projectReachesHost(project) };
}

export async function loadTaskProject(projectId: string): Promise<TaskProject | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("projects")
    .select(["id", "name", "slug", "runtime_type", "builder_config"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  return row ?? null;
}

export function taskRights(
  principal: Principal,
  access: Access,
  project: TaskProject
): { canEdit: boolean; editBlockedReason: string | null; canRun: boolean } {
  const manages = satisfies(access, PROJECT_ACTIONS.settings);
  const reachesHost = projectReachesHost(project);
  const hostOk = !reachesHost || hasPermission(principal, "host");
  const where =
    runsInFor(project.runtime_type) === "host"
      ? "qui i comandi girano sull'host, con l'utente del pannello"
      : "il container di questo progetto raggiunge l'host";
  return {
    canEdit: manages && hostOk,
    editBlockedReason: manages && !hostOk ? `Serve il permesso «Accesso all'host»: ${where}.` : null,
    canRun: satisfies(access, PROJECT_ACTIONS.control),
  };
}

export const notFound = (what: "Progetto" | "Attività" | "Esecuzione") =>
  NextResponse.json({ error: `${what} non trovat${what === "Progetto" ? "o" : "a"}` }, { status: 404 });

/** A body that is not JSON is a bad request, not a 500. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Richiesta non valida" }, { status: 400 }) };
  }
}

/**
 * The Compose rule, said once for create and edit: a Compose project's task
 * names the service it runs in, any other project's names none.
 */
export function serviceProblem(runtimeType: string, service: string | null | undefined): string | null {
  if (runtimeType === "compose") return service ? null : "Scegli in quale servizio dello stack far girare il comando";
  return service ? "Il servizio si sceglie solo per i progetti Compose" : null;
}
