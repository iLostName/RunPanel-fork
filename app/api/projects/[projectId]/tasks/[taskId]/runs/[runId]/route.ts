import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { notFound } from "@/services/tasks/access";
import { liveOutput } from "@/services/tasks/runner";
import { getRun, getTask, runDetail } from "@/services/tasks/store";

type Params = { params: Promise<{ projectId: string; taskId: string; runId: string }> };

/**
 * One run, with its output. While it is still going the output comes from the
 * process rather than the store — it is written there once, at the end — so a
 * page polling this sees it grow.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, taskId, runId } = await params;
  const denied = await requireProject(projectId, "logs");
  if (isDenied(denied)) return denied;

  const task = await getTask(projectId, taskId);
  if (!task) return notFound("Attività");
  const run = await getRun(task.id, runId);
  if (!run) return notFound("Esecuzione");

  const live = run.status === "running" ? liveOutput(run.id) : null;
  return NextResponse.json({ run: runDetail(run, live) }, { headers: { "Cache-Control": "no-store" } });
}
