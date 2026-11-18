import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { appLogQuerySchema } from "@/lib/validation";
import { readAppLog } from "@/services/app-logs";

type Params = { params: Promise<{ projectId: string }> };

/**
 * The app's saved output: the last `lines` lines, optionally only those that
 * contain `q` or come from one `stream`.
 *
 * Not the live tail (`../logs?source=process`, which is the current run as the
 * runtime has it): this is the panel's own copy, which survives restarts and
 * deploys. Searched here rather than in the browser because the browser holds
 * the last two thousand lines, and the line somebody is looking for is the one
 * from before the restart.
 *
 * The same right as the live output: whoever may read the logs may read these.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "logs");
  if (isDenied(denied)) return denied;

  const parsed = appLogQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Richiesta non valida", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "slug", "runtime_type", "status"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const page = await readAppLog(project, { limit: parsed.data.lines, query: parsed.data.q, stream: parsed.data.stream });
  // What an app prints can be anything it was handed, secrets included.
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
