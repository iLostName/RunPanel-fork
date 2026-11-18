import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { appLogDownload } from "@/services/app-logs";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Everything the panel has kept of the app's output, as one text file.
 *
 * The whole archive and not the lines on screen: the point of downloading a
 * log is usually to hand it to whoever will read it properly, and the screen
 * holds the last two thousand lines of the current run. Streamed one stored
 * file at a time, so twenty megabytes never sit in memory at once.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "logs");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "slug", "name", "runtime_type", "status"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const body = await appLogDownload(project);
  // The slug is `[a-z0-9-]`, so it goes into the header as it is.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${project.slug}-log-${stamp}.txt"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
