import fs from "fs";
import path from "path";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { hasPermission } from "@/lib/authz";
import { requireHostFor } from "@/lib/host-guard";
import { getDb, nowIso } from "@/lib/db";
import { grantCreator } from "@/lib/users";
import { generateId, slugify } from "@/lib/utils";
import { isReservedSlug } from "@/lib/project-slug";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { repoLocation } from "@/services/project-repo";
import { getRepoPath } from "@/services/git-manager";
import { isPanelEnvFile } from "@/services/env-file";

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  name: z.string().trim().min(1, "Serve un nome").max(100, "Al massimo 100 caratteri"),
  includeEnv: z.boolean().default(true),
});

/** Build output at the top of the checkout: the copy's first deploy makes its own. */
const SKIPPED_TOP = new Set([".next", "dist", "build", ".turbo", ".cache", "venv", ".venv"]);

/**
 * What is not copied from an uploaded project's folder: dependencies anywhere,
 * build output at the top (a nested `src/build` can be code), and the .env the
 * panel writes there — it holds every variable in clear, and the copy may have
 * been asked for without them.
 */
function copied(root: string, src: string): boolean {
  const name = path.basename(src);
  if (src === root) return true;
  if (name === "node_modules" || name === "__pycache__") return false;
  if (path.dirname(src) === root && SKIPPED_TOP.has(name)) return false;
  return !isPanelEnvFile(src);
}

/**
 * A copy of a project: same code, same way of building it, its own everything
 * else.
 *
 * For a staging copy or a second instance. Copied: the source (repository and
 * branch, or the uploaded files), the runtime and the deploy contract, and the
 * variables when asked. Not copied, because two projects must not share them:
 * linked databases, addresses, the webhook, bind mounts (two containers
 * writing to one host folder), and the port, which is the first free one.
 * Auto-deploy starts off: turning it on registers the copy's own webhook.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.duplicate", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    if (!hasPermission(denied.principal, "projects.create")) {
      return NextResponse.json({ error: "Per duplicare un progetto serve il permesso «Creare progetti»" }, { status: 403 });
    }
    // The copy runs the same code: the same guard as changing a project's source.
    const noHost = requireHostFor(denied.principal, "duplicare il codice di un progetto");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }
    const { name, includeEnv } = parsed.data;

    const slug = slugify(name);
    if (isReservedSlug(slug)) {
      return NextResponse.json({ error: `Il nome diventa "${slug}", che il pannello riserva ai propri container: scegline un altro` }, { status: 400 });
    }

    const db = await getDb();
    const source = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
    if (!source) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    if (await db.selectFrom("projects").select("id").where("slug", "=", slug).executeTakeFirst()) {
      return NextResponse.json({ error: `Esiste già un progetto con il nome interno "${slug}": scegline un altro` }, { status: 409 });
    }

    const [projectPorts, servicePorts] = await Promise.all([
      db.selectFrom("projects").select(["port", "access_port"]).execute(),
      db.selectFrom("services").select(["port", "access_port"]).execute(),
    ]);
    const port = source.port ? firstFreePort(source.port, portsInUse([...projectPorts, ...servicePorts])) : null;

    // Bind mounts point at host folders: two projects must not write to one.
    let builderConfig = source.builder_config;
    try {
      const contract = JSON.parse(source.builder_config || "{}") as { docker?: { mounts?: unknown } };
      if (contract.docker && "mounts" in contract.docker) {
        delete contract.docker.mounts;
        builderConfig = JSON.stringify(contract);
      }
    } catch {
      /* an unreadable contract is copied as it is, like the original keeps it */
    }

    const id = generateId();
    const now = nowIso();
    await db
      .insertInto("projects")
      .values({
        id,
        name,
        slug,
        app_name: null,
        source_type: source.source_type,
        source_url: source.source_url,
        source_branch: source.source_branch,
        runtime_type: source.runtime_type,
        builder_config: builderConfig,
        port,
        status: "stopped",
        auto_deploy: 0,
        webhook_secret: crypto.randomBytes(20).toString("hex"),
        folder_id: source.folder_id,
        backup_settings: source.backup_settings,
        created_at: now,
        updated_at: now,
      })
      .execute();

    try {
      if (includeEnv) {
        // Ciphertext copied as it is: same panel, same key.
        const rows = await db.selectFrom("env_vars").select(["key", "value"]).where("project_id", "=", projectId).execute();
        if (rows.length > 0) {
          await db
            .insertInto("env_vars")
            .values(rows.map((row) => ({ id: generateId(), project_id: id, key: row.key, value: row.value, created_at: now })))
            .execute();
        }
        // The shared groups too, in the same order: without them the copy
        // would deploy with fewer variables than it shows it was copied with.
        // Whoever duplicates holds the host permission, which reads them anyway.
        const groups = await db
          .selectFrom("project_env_groups")
          .select(["group_id", "position"])
          .where("project_id", "=", projectId)
          .execute();
        if (groups.length > 0) {
          await db
            .insertInto("project_env_groups")
            .values(groups.map((row) => ({ project_id: id, group_id: row.group_id, position: row.position, created_at: now })))
            .execute();
        }
      }

      // An uploaded project has no repository to clone from: its files are copied.
      if (source.source_type === "upload") {
        const from = repoLocation(source.slug).real;
        if (from && fs.existsSync(from)) {
          fs.cpSync(from, getRepoPath(slug), { recursive: true, filter: (src) => copied(from, src) });
        }
      }
    } catch (err) {
      // Nothing half-made: the copy goes away with its rows.
      await db.deleteFrom("env_vars").where("project_id", "=", id).execute();
      await db.deleteFrom("project_env_groups").where("project_id", "=", id).execute();
      await db.deleteFrom("projects").where("id", "=", id).execute();
      fs.rmSync(getRepoPath(slug), { recursive: true, force: true });
      const message = err instanceof Error ? err.message : "Copia non riuscita";
      return NextResponse.json({ error: `Copia non riuscita: ${message}` }, { status: 500 });
    }

    await grantCreator(denied.session.user.id, "project", id);
    const created = await db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
    return NextResponse.json(created, { status: 201 });
  });
}
