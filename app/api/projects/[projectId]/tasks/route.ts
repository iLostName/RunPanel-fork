import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectTasksTable } from "@/lib/db/schema";
import { hasPermission } from "@/lib/authz";
import { requireHostIfReaching } from "@/lib/host-guard";
import { MAX_TASKS_PER_PROJECT, TASK_TIMEOUT_DEFAULT_SEC, type TasksResponse } from "@/lib/tasks-rules";
import { generateId } from "@/lib/utils";
import { taskSchema } from "@/lib/validation";
import { HOST_WHAT, loadTaskProject, notFound, readJson, serviceProblem, taskContext, taskRights } from "@/services/tasks/access";
import { countTasks, listTasks, panelTimeZone, scheduleFor, taskViewOf } from "@/services/tasks/store";
import { composeServiceNames } from "@/services/tasks/target";

type Params = { params: Promise<{ projectId: string }> };

/**
 * A project's scheduled tasks: commands it runs on its own, at set times, in
 * its own context. The runner is `services/tasks/`.
 *
 * Reading them is `logs`: the list is a record of what ran and how it went,
 * like the deploy history. `?include=services` adds the services of a Compose
 * stack, which asks Docker and is only worth it while the editor is open.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "logs");
  if (isDenied(denied)) return denied;

  const project = await loadTaskProject(projectId);
  if (!project) return notFound("Progetto");

  const ctx = taskContext(project);
  const body: TasksResponse = {
    tasks: await listTasks(projectId, ctx),
    panelTimeZone: await panelTimeZone(),
    runsIn: ctx.runsIn,
    runtimeType: project.runtime_type,
    ...taskRights(denied.principal, denied.access, project),
  };
  if (project.runtime_type === "compose" && request.nextUrl.searchParams.get("include") === "services") {
    body.composeServices = await composeServiceNames(project);
  }

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** A new task. It is scheduled at once — `next_run_at` is computed here — and never run by being saved. */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.task.create", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, HOST_WHAT);
    if (noHost) return noHost;

    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = taskSchema.safeParse(read.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }
    const data = parsed.data;

    const project = await loadTaskProject(projectId);
    if (!project) return notFound("Progetto");

    const problem = serviceProblem(project.runtime_type, data.service);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    if ((await countTasks(projectId)) >= MAX_TASKS_PER_PROJECT) {
      return NextResponse.json(
        { error: `Un progetto può avere al massimo ${MAX_TASKS_PER_PROJECT} attività pianificate` },
        { status: 409 }
      );
    }

    const now = nowIso();
    const ctx = taskContext(project);
    const row: ProjectTasksTable = {
      id: generateId(),
      project_id: projectId,
      name: data.name,
      command: data.command,
      cron: data.cron,
      timezone: data.timezone ?? null,
      enabled: data.enabled === false ? 0 : 1,
      timeout_sec: data.timeoutSec ?? TASK_TIMEOUT_DEFAULT_SEC,
      service: project.runtime_type === "compose" ? (data.service ?? null) : null,
      runs_in: ctx.runsIn,
      // Who wrote the command decides where it may run later: see `reviewCode`.
      host_approved: hasPermission(denied.principal, "host") ? 1 : 0,
      next_run_at: null,
      schedule_zone: null,
      last_run_id: null,
      consecutive_failures: 0,
      failure_notified_at: null,
      created_by: denied.session.user.id,
      created_at: now,
      updated_at: now,
    };
    Object.assign(row, await scheduleFor(row));

    const db = await getDb();
    await db.insertInto("project_tasks").values(row).execute();

    return NextResponse.json({ task: await taskViewOf(row, ctx) }, { status: 201 });
  });
}
