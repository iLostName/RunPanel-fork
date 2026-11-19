import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { previewProjectEnv } from "@/services/env-preview";

type Params = { params: Promise<{ projectId: string }> };

/**
 * What the app will receive at its next deploy or restart: every variable,
 * where it comes from, what it replaces, and whether it resolves.
 *
 * Anyone who may read the project's variables sees the names, the sources and
 * the problems. `?reveal=true` opens the values each account may read, and
 * only those (services/env-preview.ts). Never cached, like the variables.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "env.read");
  if (isDenied(denied)) return denied;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true";

  const preview = await previewProjectEnv(projectId, denied.principal, denied.access, reveal);
  return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
}
