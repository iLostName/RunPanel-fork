import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { notFound } from "@/services/tasks/access";
import { cancelRun, startRun } from "@/services/tasks/runner";
import { getTask } from "@/services/tasks/store";

type Params = { params: Promise<{ projectId: string; taskId: string }> };

/**
 * "Esegui ora": the task's command, now, under the same rules as a scheduled
 * occurrence — never beside a run already going, never during a deploy — but
 * whether the task is switched on or not, since a person asked.
 *
 * `operate`, like a deploy: it runs the command that is saved, which whoever
 * saved it had the right to put there. Answers 202 with the run's id; the run
 * goes on in the background and the history shows it. When it cannot start
 * the answer is 409 with the reason, and the history keeps that too.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "deploy", action: "project.task.run", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "control");
    if (isDenied(denied)) return denied;

    const task = await getTask(projectId, taskId);
    if (!task) return notFound("Attività");

    const outcome = await startRun(task.id, { trigger: "manual", userId: denied.session.user.id });
    if (outcome.status === "not-found") return notFound("Attività");
    if (outcome.status === "skipped") {
      return NextResponse.json({ error: `Non è partita: ${outcome.reason}`, code: outcome.code }, { status: 409 });
    }
    return NextResponse.json({ runId: outcome.runId, status: "running" }, { status: 202 });
  });
}

/** Stop the run in flight, and everything it started. The run is recorded as stopped. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "deploy", action: "project.task.cancel", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, taskId } = await params;
    const denied = await requireProject(projectId, "control");
    if (isDenied(denied)) return denied;

    const task = await getTask(projectId, taskId);
    if (!task) return notFound("Attività");

    if (!cancelRun(task.id)) {
      return NextResponse.json({ error: "Questa attività non sta girando", code: "not-running" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status: "stopping" }, { status: 202 });
  });
}
