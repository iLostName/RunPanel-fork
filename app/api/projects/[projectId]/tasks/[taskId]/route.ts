import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectTasksTable } from "@/lib/db/schema";
import { requireHostIfReaching } from "@/lib/host-guard";
import { runsInFor } from "@/lib/tasks-rules";
import { taskUpdateSchema } from "@/lib/validation";
import { HOST_WHAT, loadTaskProject, notFound, readJson, serviceProblem } from "@/services/tasks/access";
import { stopForDelete } from "@/services/tasks/runner";
import { getTask, nextRunFor, runHistory, taskViewOf } from "@/services/tasks/store";

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
    { task: await taskViewOf(task, runsInFor(project.runtime_type)), runs: await runHistory(task.id) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Change a task. Every field is optional.
 *
 * Sending the command — the editor always does — is what confirms where it
 * runs: a task saved for a container on a project that has since moved to the
 * host waits, skipped, until somebody with the right to put a command on the
 * host saves it again. Only a change to what runs needs that right: renaming a
 * task, moving its schedule or switching it off is the project's managers'.
 *
 * A run already going keeps the command it started with.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.task.update", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

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

    const touchesCommand = data.command !== undefined || data.service !== undefined;
    if (touchesCommand) {
      const noHost = await requireHostIfReaching(denied.principal, projectId, HOST_WHAT);
      if (noHost) return noHost;
    }

    const merged: ProjectTasksTable = {
      ...task,
      name: data.name ?? task.name,
      command: data.command ?? task.command,
      cron: data.cron ?? task.cron,
      timezone: data.timezone !== undefined ? data.timezone : task.timezone,
      enabled: data.enabled === undefined ? task.enabled : data.enabled ? 1 : 0,
      timeout_sec: data.timeoutSec ?? task.timeout_sec,
      service: project.runtime_type === "compose" ? (data.service !== undefined ? data.service : task.service) : null,
      runs_in: data.command !== undefined ? runsInFor(project.runtime_type) : task.runs_in,
      updated_at: nowIso(),
    };

    // Asked only when the save is meant to make the task runnable here.
    if (data.command !== undefined || data.service !== undefined) {
      const problem = serviceProblem(project.runtime_type, merged.service);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }

    const scheduleMoved =
      merged.cron !== task.cron || merged.timezone !== task.timezone || merged.enabled !== task.enabled;
    if (scheduleMoved) merged.next_run_at = await nextRunFor(merged);

    const db = await getDb();
    await db
      .updateTable("project_tasks")
      .set({
        name: merged.name,
        command: merged.command,
        cron: merged.cron,
        timezone: merged.timezone,
        enabled: merged.enabled,
        timeout_sec: merged.timeout_sec,
        service: merged.service,
        runs_in: merged.runs_in,
        next_run_at: merged.next_run_at,
        updated_at: merged.updated_at,
      })
      .where("id", "=", task.id)
      .execute();

    const fresh = (await getTask(projectId, taskId)) ?? merged;
    return NextResponse.json({ task: await taskViewOf(fresh, runsInFor(project.runtime_type)) });
  });
}

/** Delete a task and its history. A run in flight is stopped first, with everything it started. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.task.delete", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const task = await getTask(projectId, taskId);
    if (!task) return notFound("Attività");

    stopForDelete(task.id);
    const db = await getDb();
    await db.deleteFrom("project_tasks").where("id", "=", task.id).execute();
    return NextResponse.json({ ok: true });
  });
}
