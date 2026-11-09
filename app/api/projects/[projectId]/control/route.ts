import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { controlActionSchema } from "@/lib/validation";
import { cancelDeploy } from "@/services/deploy-queue";
import { processManager } from "@/services/process-manager";
import { busyMessage, tryLock } from "@/services/project-lock";
import { DEPLOYING_MESSAGE, restartFromLastDeployment } from "@/services/project-restart";

type Params = { params: Promise<{ projectId: string }> };

/** How long a stop waits for a cancelled deploy before answering anyway. */
const CANCEL_WAIT_MS = 15_000;

async function endsWithin(run: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const ended = await Promise.race([run.then(() => true), expired]);
  clearTimeout(timer);
  return ended;
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "deploy", action: "project.control", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "control");
    if (isDenied(denied)) return denied;
    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = controlActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
    }

    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    // The deploy owns the process until it finishes: a stop or restart in the
    // middle would race its own stop and start.
    // Stop stays allowed: it is the way out of a deploy that hangs or crash-loops,
    // and it cancels that deploy rather than racing it.
    if (project.status === "deploying" && parsed.data.action !== "stop") {
      return NextResponse.json({ error: DEPLOYING_MESSAGE }, { status: 409 });
    }

    const { action } = parsed.data;
    const { slug, runtime_type: runtimeType } = project;

    /** Null when the project is taken by something else. */
    const stopApp = async (): Promise<true | null> => {
      const release = tryLock(projectId, "stop");
      if (!release) return null;
      try {
        await processManager.stop(slug, runtimeType);
        await db
          .updateTable("projects")
          // A stop that was asked for: not a crash, so the scheduled restart
          // leaves the project alone.
          .set({ status: "stopped", crashed_at: null, updated_at: nowIso() })
          .where("id", "=", projectId)
          .execute();
        return true;
      } finally {
        release();
      }
    };

    try {
      switch (action) {
        case "start":
        case "restart": {
          // Shared with the access change, which needs the same operation. It
          // also replays the deploy contract, which the copy that used to live
          // here did not: restarting a project used to quietly move it off
          // `network: host`, drop its bind mounts and reset its restart policy.
          const result = await restartFromLastDeployment(projectId);
          if ("error" in result) {
            return NextResponse.json({ error: result.error }, { status: 400 });
          }
          break;
        }
        case "stop": {
          // The row used to be overwritten while the pipeline kept going, which
          // released the deploy's claim: a second deploy could then run over
          // the same checkout, and the first one still restarted the app.
          const deploy = cancelDeploy(projectId);
          if (deploy && !(await endsWithin(deploy, CANCEL_WAIT_MS))) {
            // Some step is taking its time to notice. The pipeline stops the app
            // on the way out, but only if it notices: past its last checkpoint it
            // finishes as a success with the app up. Stopping again costs nothing
            // and keeps the promise this answer makes.
            void deploy
              .then(stopApp)
              .catch((err) => console.error(`[control] Stop after cancel failed for ${slug}:`, err));
            return NextResponse.json({ success: true, action, stopping: true }, { status: 202 });
          }

          if (!(await stopApp())) {
            return NextResponse.json({ error: busyMessage(projectId) }, { status: 409 });
          }
          break;
        }
      }

      return NextResponse.json({ success: true, action });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `${action} failed`;
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
