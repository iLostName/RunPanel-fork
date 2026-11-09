import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { isPathShapeSafe, resolveInside } from "@/lib/fs-safe";
import { LIST_DIRECTORY_NOT_FOUND, LIST_DIRECTORY_SCRIPT, parseDirectoryListing } from "@/lib/container-listing";
import { getRepoPath } from "@/services/git-manager";
import { appContainerName } from "@/services/docker/labels";
import { assertOwnAppContainer, ForeignContainerError } from "@/services/process-drivers/docker-driver";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "files");
  if (isDenied(denied)) return denied;
  const dirPath = request.nextUrl.searchParams.get("path") || "/";

  if (!isPathShapeSafe(dirPath)) {
    return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type", "status"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  try {
    if (project.runtime_type === "docker") {
      await assertOwnAppContainer(project.slug);

      // The path travels as an argument of the script, never inside its text.
      const { stdout } = await exec("docker", [
        "exec", appContainerName(project.slug), "sh", "-c", LIST_DIRECTORY_SCRIPT, "sh", dirPath,
      ], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });

      return NextResponse.json({ entries: parseDirectoryListing(stdout), path: dirPath });
    }

    // Local: read from repos directory
    const repoDir = getRepoPath(project.slug);

    // A project whose source was never checked out has no repo directory at
    // all. Reporting that as "Path not found" sends you looking for a missing
    // folder inside a project that has no code in the first place — the same
    // confusion the deploy pipeline already words properly.
    if (!fs.existsSync(repoDir)) {
      return NextResponse.json(
        {
          error:
            "The project has no source yet — configure a GitHub repository or upload a ZIP, then deploy.",
        },
        { status: 404 }
      );
    }

    // Resolved through any symlinks, so a link in the repository cannot be used
    // to list a directory outside it.
    const fullPath = resolveInside(repoDir, dirPath === "/" ? "." : dirPath);
    if (!fullPath) {
      return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "Percorso inesistente" }, { status: 404 });
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    const entries = items
      .filter((item) => item.name !== "node_modules" && item.name !== ".git")
      .map((item) => {
        const itemPath = path.join(fullPath, item.name);
        let size = 0;
        try { if (item.isFile()) size = fs.statSync(itemPath).size; } catch {}
        return {
          name: item.name,
          type: item.isDirectory() ? "dir" : "file",
          size,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: dirPath });
  } catch (err: unknown) {
    if (err instanceof ForeignContainerError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const { code, stderr } = err as { code?: unknown; stderr?: unknown };
    if (code === LIST_DIRECTORY_NOT_FOUND) {
      return NextResponse.json({ error: "Percorso inesistente" }, { status: 404 });
    }
    // Never the message of a failed exec: it quotes the whole command line.
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    const message = detail || (err instanceof Error && code === undefined ? err.message : "Lettura non riuscita");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
