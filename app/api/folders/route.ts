import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission, requireUser } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { folderAccess, seesEverything } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { createFolderSchema } from "@/lib/validation";
import { broadcastDirectory } from "@/services/cluster/sync";
import { findFolderByName } from "@/services/folders";
import { isVisible, visibleFolderIds } from "@/lib/principal";

/**
 * Folders for the Overview: flat, named, and nothing else. What each one holds
 * is not answered here — the projects and services lists carry `folder_id`,
 * and the page groups them itself, so one folder list serves every poll.
 *
 * In a cluster a folder is the same row on every server (lib/cluster-directory.ts),
 * so a project of any server can be filed in it.
 *
 * `permission` is the account's access to the folder itself: a null level is a
 * folder it sees only for what sits in it, which it can neither rename nor delete.
 */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const canSee = await visibleFolderIds(denied.principal);
  const folders = await db.selectFrom("folders").selectAll().orderBy("name", "asc").execute();
  return NextResponse.json(
    folders.filter((f) => isVisible(canSee, f.id)).map((f) => ({ ...f, permission: folderAccess(denied.principal, f.id) }))
  );
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "config", action: "folder.create", scope: "permission", scopeId: "projects.create" }, async () => {
    const denied = await requirePermission("projects.create");
    if (isDenied(denied)) return denied;
    // A folder is shared by the whole panel, and a grant on one reaches everything
    // filed in it, by anyone. Handing its creator that grant let someone with a
    // few projects collect access to whatever others put there: folders are for
    // the accounts that see everything already.
    if (!seesEverything(denied.principal)) {
      return NextResponse.json(
        { error: "Le cartelle sono di tutto il pannello: crearle richiede un accesso a tutti i progetti." },
        { status: 403 }
      );
    }

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = createFolderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { name } = parsed.data;
    const db = await getDb();

    if (await findFolderByName(db, name)) {
      return NextResponse.json({ error: `Esiste già una cartella "${name}".` }, { status: 409 });
    }

    const now = nowIso();
    const folder = { id: generateId(), name, created_at: now, updated_at: now };
    await db.insertInto("folders").values(folder).execute();
    void broadcastDirectory();

    return NextResponse.json(folder, { status: 201 });
  });
}
