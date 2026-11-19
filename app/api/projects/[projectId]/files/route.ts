import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { isPathShapeSafe, resolveInside } from "@/lib/fs-safe";
import { LIST_DIRECTORY_NOT_FOUND, LIST_DIRECTORY_SCRIPT, parseDirectoryListing } from "@/lib/container-listing";
import { NO_FILES_YET } from "@/lib/project-files";
import { projectFileRoots } from "@/services/project-releases";
import { appContainerName } from "@/services/docker/labels";
import { assertOwnAppContainer, ForeignContainerError } from "@/services/process-drivers/docker-driver";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

/**
 * Nothing to list yet. The code is what the File tab reads to show its empty
 * state; the sentence is for any other client of the API.
 */
function noFilesYet() {
  return NextResponse.json(
    { error: "Il progetto non ha ancora file: arriveranno con il primo deploy.", code: NO_FILES_YET },
    { status: 404 }
  );
}

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
      // No container at all is a project never deployed: nothing to list yet,
      // rather than the daemon's "No such container" as an error.
      if (!(await assertOwnAppContainer(project.slug))) return noFilesYet();

      // The path travels as an argument of the script, never inside its text.
      const { stdout } = await exec("docker", [
        "exec", appContainerName(project.slug), "sh", "-c", LIST_DIRECTORY_SCRIPT, "sh", dirPath,
      ], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });

      return NextResponse.json({ entries: parseDirectoryListing(stdout), path: dirPath });
    }

    // Local: the folder of the version that runs — its release folder when the
    // project has one, the project folder otherwise.
    const { root: repoDir, also } = projectFileRoots(project.slug);

    // A project whose source was never checked out has no repo directory at
    // all. Reporting that as "Path not found" sends you looking for a missing
    // folder inside a project that has no code in the first place.
    if (!fs.existsSync(repoDir)) return noFilesYet();

    // Resolved through any symlinks, so a link in the repository cannot be used
    // to list a directory outside it — only into the project folder, where a
    // release folder's data links lead.
    const fullPath = resolveInside(repoDir, dirPath === "/" ? "." : dirPath, also);
    if (!fullPath) {
      return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "Percorso inesistente" }, { status: 404 });
    }

    // Where a link may lead and still be described: anywhere else it stays a
    // plain entry, so a link committed to the repository says nothing about
    // the file it points at.
    const allowed = [repoDir, ...also].map((dir) => {
      try {
        return fs.realpathSync(dir);
      } catch {
        return dir;
      }
    });
    const within = (target: string) => allowed.some((dir) => target === dir || target.startsWith(dir + path.sep));

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    const entries = items
      .filter((item) => item.name !== "node_modules" && item.name !== ".git")
      .map((item) => {
        const itemPath = path.join(fullPath, item.name);
        // A link is listed as what it leads to: in a release folder the
        // uploads and the database are links, and showing a folder as a file
        // would open it in the editor.
        let stat: fs.Stats | null = null;
        if (item.isSymbolicLink()) {
          try {
            const real = fs.realpathSync(itemPath);
            if (within(real)) stat = fs.statSync(real);
          } catch {}
        }
        const isDir = stat ? stat.isDirectory() : item.isDirectory();
        let size = 0;
        try { if (!isDir && (stat ? stat.isFile() : item.isFile())) size = (stat ?? fs.statSync(itemPath)).size; } catch {}
        return {
          name: item.name,
          type: isDir ? "dir" : "file",
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
