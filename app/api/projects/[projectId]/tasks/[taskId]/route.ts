import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { hasPermission } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectTasksTable } from "@/lib/db/schema";
import { requireHostIfReaching } from "@/lib/host-guard";
import { taskUpdateSchema } from "@/lib/validation";
import { HOST_WHAT, loadTaskProject, notFound, readJson, serviceProblem, taskContext } from "@/services/tasks/access";
import { stopForDelete } from "@/services/tasks/runner";
import { getTask, runHistory, scheduleFor, taskViewOf } from "@/services/tasks/store";

type Params = { params: Promise<{ projectId: string; taskId: string }> };

/** One task and its history, newest first, without the output — that is one run at a time. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, taskId } = await params;
  const denied = await requireProject(projectId, "logs");
  if (isDenied(denied)) return denied;

  const project = await loadTaskProject(projectId);
  if (!project) return notFound("Progetto");
  const task = await getTask(projectId, taskId);
  if (!task) return notFound("Attività");

  return NextResponse.json(
    { task: await taskViewOf(task, taskContext(project)), runs: await runHistory(task.id) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Change a task. Every field is optional, and only what is sent is written:
 * a field written back as it was read could undo what the scheduler did in
 * between — `next_run_at` above all, whose claim would be reverted and the
 * occurrence run twice.
 *
 * Sending the command — the editor always does — is what confirms it: where it
 * runs (a task saved for a container on a project since moved to the host
 * waits, skipped, until it is saved again) and who vouched for it (saved by
 * someone with the host permission, it may go on running if the project later
 * starts reaching the host). A run already going keeps the command it started
 * with.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.task.update", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, HOST_WHAT);
    if (noHost) return noHost;

    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = taskUpdateSchema.safeParse(read.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }
    const data = parsed.data;

    const project = await loadTaskProject(projectId);
    if (!project) return notFound("Progetto");
    const task = await getTask(projectId, taskId);
    if (!task) return notFound("Attività");
    const ctx = taskContext(project);

    const patch: Partial<ProjectTasksTable> = { updated_at: nowIso() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.timeoutSec !== undefined) patch.timeout_sec = data.timeoutSec;
    if (data.command !== undefined) {
      patch.command = data.command;
      patch.runs_in = ctx.runsIn;
      patch.host_approved = hasPermission(denied.principal, "host") ? 1 : 0;
    }
    if (data.service !== undefined || data.command !== undefined) {
      const service = project.runtime_type === "compose" ? (data.service !== undefined ? data.service : task.service) : null;
      const problem = serviceProblem(project.runtime_type, service);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      patch.service = service;
    }

    const schedule = {
      cron: data.cron ?? task.cron,
      timezone: data.timezone !== undefined ? data.timezone : task.timezone,
      enabled: data.enabled === undefined ? task.enabled : data.enabled ? 1 : 0,
    };
    if (schedule.cron !== task.cron || schedule.timezone !== task.timezone || schedule.enabled !== task.enabled) {
      Object.assign(patch, schedule, await scheduleFor(schedule));
    }

    const db = await getDb();
    await db.updateTable("project_tasks").set(patch).where("id", "=", task.id).execute();

    const fresh = (await getTask(projectId, taskId)) ?? { ...task, ...patch };
    return NextResponse.json({ task: await taskViewOf(fresh, ctx) });
  });
}

/** Delete a task and its history. A run in flight is stopped first, with everything it started. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.task.delete", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, HOST_WHAT);
    if (noHost) return noHost;

    const task = await getTask(projectId, taskId);
    if (!task) return notFound("Attività");

    stopForDelete(task.id);
    const db = await getDb();
    await db.deleteFrom("project_tasks").where("id", "=", task.id).execute();
    return NextResponse.json({ ok: true });
  });
}
