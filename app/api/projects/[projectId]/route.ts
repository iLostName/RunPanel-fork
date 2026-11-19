import { NextRequest, NextResponse } from "next/server";
import { explainDeployError } from "@/lib/deploy-explain";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostFor, requireHostIfReaching } from "@/lib/host-guard";
import { audit, withAudit } from "@/lib/audit";
import { accessChangedForEveryone } from "@/lib/users";
import { environmentKindOf, productionDeleteProblem, stagingBranchProblem } from "@/lib/environments";
import { isVisible, visibleFolderIds } from "@/lib/principal";
import { PROJECT_ACTIONS, hasPermission, satisfies } from "@/lib/authz";
import { redactProject } from "@/lib/project-redact";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { updateProjectSchema } from "@/lib/validation";
import { parseRepoSlug } from "@/lib/github";
import { deployContractSchema, normalizeContractInput, parseContractJson } from "@/lib/deploy-contract";
import {
  parseApplyJournal as parseProjectApply,
  projectMounts,
} from "@/services/project-mounts";
import { parseRepoMove, repoLocation } from "@/services/project-repo";
import { readAccess, reportGate, syncGate } from "@/services/access";
import { allocateLoopbackPort } from "@/services/access-gate";
import { restartFromLastDeployment } from "@/services/project-restart";
import { currentRelease } from "@/services/project-releases";
import { releasesSupported } from "@/lib/releases";
import { getPreset } from "@/services/deploy-presets";
import { queuedForProject } from "@/services/one-time-commands";
import { folderExists } from "@/services/folders";
import { restartScheduleColumns } from "@/services/restart-scheduler";
import { sealContract } from "@/services/build-env";
import { syncAutoDeploy } from "@/services/webhook-manage";
import { applyProxySoon, canApply, proxyProbe } from "@/services/proxy";
import { deleteProject } from "@/services/project-delete";
import { deleteEnvironments, environmentsOf } from "@/services/environments";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const [stats, lastDeployment, lastSuccess] = await Promise.all([
    db
      .selectFrom("deployments")
      .select((eb) => [eb.fn.count("id").as("deploy_count"), eb.fn.max("started_at").as("last_deploy_at")])
      .where("project_id", "=", projectId)
      .executeTakeFirst(),
    // The overview leads with the last deploy, and the header only offers
    // "Avvia" once one has worked: restarting needs a successful one to go back to.
    db
      .selectFrom("deployments")
      .select(["id", "status", "trigger_type", "commit_sha", "commit_message", "started_at", "finished_at", "error_message"])
      .where("project_id", "=", projectId)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom("deployments")
      .select((eb) => eb.fn.max("finished_at").as("at"))
      .where("project_id", "=", projectId)
      // A deploy that worked is "running" while it is the live one and
      // "superseded" once a newer one took over; there is no "success".
      .where("status", "in", ["running", "superseded"])
      .executeTakeFirst(),
  ]);

  return NextResponse.json({
    ...redactProject(project, satisfies(denied.access, PROJECT_ACTIONS.settings)),
    // What the signed-in account may do here, so the page offers only that.
    // Not `access`: that name is the published port's allowlist, below.
    permission: denied.access,
    deploy_count: Number(stats?.deploy_count ?? 0),
    last_deploy_at: stats?.last_deploy_at ?? null,
    last_deployment: lastDeployment
      ? {
          ...lastDeployment,
          explanation: lastDeployment.status === "failed" ? explainDeployError(lastDeployment.error_message) : null,
        }
      : null,
    last_success_at: lastSuccess?.at ?? null,
    // The row says what was asked for; the gate says what is actually holding
    // the port. They differ whenever the panel restarted and could not bind.
    access: readAccess(project),
    gate: reportGate("project", projectId),
    // `owner/name`, worked out here because `parseRepoSlug` sits next to
    // `getSetting` and cannot travel to a client component. Null for an
    // uploaded ZIP or a URL on some other host, which is what the version
    // picker keys off to know there is no commit history to browse.
    repo: parseRepoSlug(project.source_url)?.full ?? null,
    // The bind list as rows, so the editor never has to split a `-v` string —
    // there is one place that knows how a mapping splits, and it is not the
    // browser.
    mounts: projectMounts(parseContractJson(project.builder_config)),
    mountApply: parseProjectApply(project.mount_apply),
    // Where the checkout really is, asked of the filesystem rather than read off
    // the column: they differ exactly when something went wrong.
    repo_location: repoLocation(project.slug),
    // Whether this server can give a native project a folder per version
    // (not on Windows), and which one runs now: the settings say what the
    // automatic return can do here before anyone turns it on.
    releases: { supported: releasesSupported(process.platform), current: currentRelease(project.slug)?.id ?? null },
    repoMove: parseRepoMove(project.repo_move),
    // The queue only. It is small, and the header needs it on every poll to
    // say that the next deploy will not be an ordinary one. The history is
    // fetched by the section that shows it, so a project with two years of
    // chores does not widen a payload re-read on every deploy status change.
    oneTimeCommands: await queuedForProject(projectId, project.runtime_type),
    // The names it answers on, so the header can open one without a trip to
    // Settings. HTTPS once the certificate is there, as the Domain section links.
    hosts: (
      await db
        .selectFrom("project_hosts")
        .select(["hostname", "status", "auth_hash"])
        .where("project_id", "=", projectId)
        .where("apply_error", "is", null)
        // A www twin only redirects to its main name: the header opens the app.
        .where("redirect_to", "is", null)
        .orderBy("hostname", "asc")
        .execute()
    ).map((host) => ({
      hostname: host.hostname,
      url: `${host.status === "active" ? "https" : "http"}://${host.hostname}`,
      locked: host.auth_hash !== null,
    })),
    // Whether nginx can take the switch of a deploy without downtime, for the
    // settings to say before anyone turns it on. Docker only, the one runtime
    // it is for, so no other project pays for the probe.
    zeroDowntime: { proxyReady: project.runtime_type === "docker" ? canApply(await proxyProbe()) : false },
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.update", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
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

    const { name, appName, sourceType, sourceUrl, sourceBranch, runtimeType, port, autoDeploy, deployTrigger, builderConfig, presetId, access, folderId, restartCron } =
      parsed.data;

    // What code runs, and how, is where `manage` would reach the machine —
    // see lib/host-guard.ts.
    if (sourceType !== undefined || sourceUrl !== undefined || sourceBranch !== undefined) {
      const noHost = requireHostFor(denied.principal, "cambiare il codice che il progetto esegue");
      if (noHost) return noHost;
    }
    // Staging on production's branch would deploy every push twice, and a
    // promote would deploy what production already has.
    if (sourceBranch !== undefined && project.environment_of && environmentKindOf(project) === "staging") {
      const production = await db.selectFrom("projects").select("source_branch").where("id", "=", project.environment_of).executeTakeFirst();
      const problem = production ? stagingBranchProblem(sourceBranch, production.source_branch) : null;
      if (problem) return NextResponse.json({ error: problem, details: [{ path: ["sourceBranch"], message: problem }] }, { status: 400 });
    }
    if (runtimeType !== undefined || builderConfig !== undefined || presetId !== undefined) {
      const preset = presetId ? getPreset(presetId) : null;
      const nextContract =
        builderConfig !== undefined || preset
          ? JSON.stringify({ ...(preset?.contract ?? {}), ...normalizeContractInput(builderConfig ?? {}) })
          : undefined;
      const noHost = await requireHostIfReaching(denied.principal, projectId, "configurare un progetto che raggiunge l'host", {
        runtimeType,
        builderConfig: nextContract,
      });
      if (noHost) return noHost;
    }

    // Checked before anything is written, so a move to a folder that is not
    // there changes nothing else in the same request either.
    // The repository is cloned with the panel's GitHub token, so pointing a
    // project at one is using that token: it needs the `github` permission.
    if (sourceUrl !== undefined && !hasPermission(denied.principal, "github")) {
      return NextResponse.json({ error: "Per cambiare il repository serve il permesso GitHub" }, { status: 403 });
    }

    // A folder this account cannot see answers like one that does not exist.
    if (
      folderId !== undefined &&
      (!(await folderExists(db, folderId)) || (folderId !== null && !isVisible(await visibleFolderIds(denied.principal), folderId)))
    ) {
      return NextResponse.json({ error: "Cartella non trovata" }, { status: 404 });
    }

    const updates: Partial<ProjectsTable> = {};
    if (name !== undefined) updates.name = name;
    if (folderId !== undefined) updates.folder_id = folderId;
    if (appName !== undefined) updates.app_name = appName || null;
    if (sourceType !== undefined) updates.source_type = sourceType;
    if (sourceUrl !== undefined) updates.source_url = sourceUrl;
    if (sourceBranch !== undefined) {
      updates.source_branch = sourceBranch;
      /*
        A different branch is a different timeline, and two columns describe the
        old one.

        `poll_sha` is the commit the poller last saw on the branch it was
        watching. Left in place, the first tick after the switch compares the new
        branch's head against a SHA that came from somewhere else, finds them
        different, and deploys on the spot — and the guard written for exactly
        this ("the first look records and does not deploy") never fires, because
        it tests `poll_sha === null`. Same column, same reason and same care as
        the `deployTrigger` guard below.

        A pin is a commit *of a branch*, so it cannot survive one either: held
        against a branch it does not belong to, every deploy would try to fetch it
        from a history that may not reach it.
      */
      if (sourceBranch !== project.source_branch) {
        updates.poll_sha = null;
        updates.pinned_sha = null;
        updates.pinned_at = null;
      }
    }
    if (runtimeType !== undefined && runtimeType !== null) updates.runtime_type = runtimeType;
    if (port !== undefined) updates.port = port;
    if (autoDeploy !== undefined) updates.auto_deploy = autoDeploy ? 1 : 0;
    if (restartCron !== undefined) {
      // The next occurrence is computed on save, so the page can show it at
      // once and the first tick cannot mistake a fresh schedule for a missed one.
      Object.assign(updates, await restartScheduleColumns(restartCron));
    }

    if (deployTrigger !== undefined) {
      updates.deploy_trigger = deployTrigger;
      /*
        Switching away from polling forgets the commit it had seen.

        Otherwise a project polled last month, moved to webhooks and moved back
        would compare today's branch against a month-old SHA and deploy on the
        spot — which is not what "switch this back to polling" asks for. Cleared
        here so the first tick after the switch re-establishes a baseline.
      */
      if (deployTrigger !== "poll") updates.poll_sha = null;
    }

    if (builderConfig !== undefined) {
      // Normalise first: callers may still send the pre-contract shape
      // (installCmd/buildCmd/startCmd/dockerImage). Validating before that would
      // discard those keys and leave the project with no commands.
      const normalized = normalizeContractInput(builderConfig);

      // A hand-picked preset sits UNDER what the caller sent, never over it: the
      // operator typing a start command has said something more specific than the
      // preset's default, and the preset must not take it back.
      const preset = presetId ? getPreset(presetId) : null;
      if (preset) {
        Object.assign(normalized, {
          ...preset.contract,
          ...normalized,
        });
      }

      // Validate for shape, but persist the NORMALISED INPUT rather than the
      // parsed result. Parsing fills in every default, and a stored config full
      // of defaults is indistinguishable from one the operator chose — which
      // would stop a repository's runpanel.json from ever contributing a value.
      const parsed = deployContractSchema.safeParse(normalized);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Configurazione di deploy non valida", details: parsed.error.issues },
          { status: 400 }
        );
      }
      /*
        `docker.mounts` is deliberately still writable from here.

        `PUT /api/projects/:id/mounts` is the way that seeds — it copies what the
        container has at that path into the host directory before the bind covers
        it — and it is what the settings tab uses. But this handler has always
        been the low-level way to set the whole contract, and a mount set through
        it is a legitimate thing to want: an empty directory the app is meant to
        write into needs no seeding, and `deploy-contract` relies on exactly that.

        Stripping the field here was tried and was wrong twice over: it silently
        dropped a value the caller had sent, and it broke a capability that works.
        What the settings form actually needed was to re-read the contract when
        the row changes, which is where the staleness lived — see `SettingsTab`.
      */
      // Build arguments are sealed on the way in: see `lib/build-env-seal.ts`.
      updates.builder_config = sealContract(JSON.stringify({ version: 1, ...normalized }), projectId);
    }

    // --- who may reach the app -------------------------------------------------
    const currentAccess = readAccess(project);
    let restartNeeded = false;

    // Checked against the state this request leaves behind, not only when
    // `access` is in the body: switching a restricted project to compose or to
    // network: host in a later PATCH must be refused just the same.
    // Only when the body touches one of them, so a row already in an
    // inconsistent state can still be renamed.
    const wantsRestriction = (access?.mode ?? currentAccess.mode) === "restricted";
    const shapeTouched =
      access !== undefined || runtimeType !== undefined || port !== undefined || updates.builder_config !== undefined;
    if (wantsRestriction && shapeTouched) {
      const runtime = runtimeType ?? project.runtime_type;
      const effectiveConfig =
        typeof updates.builder_config === "string" ? updates.builder_config : project.builder_config;

      // Two shapes the panel cannot honestly restrict, refused up front rather
      // than accepted and quietly not enforced.
      if (runtime === "compose") {
        return NextResponse.json(
          {
            error:
              "Le porte di un progetto Compose le pubblica il tuo compose file. RunPanel non lo riscrive: metti il binding su 127.0.0.1 lì.",
          },
          { status: 409 }
        );
      }

      if (parseContractJson(effectiveConfig).docker.network === "host") {
        return NextResponse.json(
          {
            error:
              "Con network: host il container condivide la rete dell'host e non c'è una porta da spostare. Passa a bridge o project per limitare l'accesso.",
          },
          { status: 409 }
        );
      }

      if (!(port !== undefined ? port : project.port)) {
        return NextResponse.json(
          { error: "Senza una porta configurata non c'è niente da limitare." },
          { status: 409 }
        );
      }
    }

    if (access) {
      updates.access_mode = access.mode;
      updates.access_allow = JSON.stringify(access.allow);
      // Allocated once and kept for as long as the target stays restricted, so
      // editing the list does not move the app.
      updates.access_port = wantsRestriction
        ? (project.access_port ?? (await allocateLoopbackPort()))
        : null;

      restartNeeded =
        updates.access_mode !== currentAccess.mode || updates.access_port !== currentAccess.port;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = nowIso();
      await db.updateTable("projects").set(updates).where("id", "=", projectId).execute();
      // A new folder changes who reaches the project through a folder grant.
      if (folderId !== undefined) await accessChangedForEveryone();
    }

    let restartError: string | null = null;

    if (restartNeeded && project.status === "running") {
      // The listener has to move, and only a restart moves it. Done after the
      // columns are written so the restart reads the state it is meant to apply.
      const result = await restartFromLastDeployment(projectId);
      if ("error" in result) restartError = result.error;
    } else if (access) {
      // No restart to do: either the list alone changed, and the gate has to
      // start judging by it now rather than at the next restart, or nothing is
      // running and the binding applies at the next start, which reads these
      // columns. The gate goes up in that case too, for the same reason the boot
      // reconciliation puts it up — a container with a restart policy can come
      // back without the panel starting it, and it comes back on the loopback
      // port. It also keeps the page from saying "gate non attivo" about a
      // restriction that is in force.
      const row = await db
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", projectId)
        .executeTakeFirst();

      if (row) {
        await syncGate("project", projectId, row, { publicPort: row.port, label: row.name }).catch(
          (err: Error) => {
            restartError = err.message;
          }
        );
      }
    }

    /*
      Follow the switch onto GitHub.

      Turning auto-deploy on used to change a column and nothing else: the
      operator was then expected to copy a URL and a secret into GitHub's webhook
      form by hand, and every way of getting that wrong failed silently. There is
      no decision in any of those four fields — they all follow from the project —
      so when an account is connected the panel writes them itself.

      Deliberately after the column is written, and unable to undo it. This is a
      network call to a third party; a token that has not been authorised for an
      organisation must not be able to make the switch refuse to move. What it can
      do is say so, next to a switch that did.
    */
    let webhookWarning: string | null = null;

    if (autoDeploy !== undefined || deployTrigger !== undefined) {
      const row = await db
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", projectId)
        .executeTakeFirst();

      if (row) {
        const sync = await syncAutoDeploy(row, request);
        if (sync && !sync.ok) webhookWarning = sync.message;
      }
    }

    // nginx proxies to the port the app really listens on, behind the allow
    // list: moving either means a different block for every name it has.
    if (port !== undefined || access !== undefined) {
      const named = await db.selectFrom("project_hosts").select("id").where("project_id", "=", projectId).executeTakeFirst();
      if (named) applyProxySoon();
    }

    const updated = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    return NextResponse.json({
      ...updated,
      // Same shape as GET: the page replaces its project with this, and without
      // the queue the one-time editor resynced to empty and its next save
      // deleted every stored command.
      oneTimeCommands: updated ? await queuedForProject(projectId, updated.runtime_type) : [],
      access: updated ? readAccess(updated) : currentAccess,
      gate: reportGate("project", projectId),
      // Saved either way — the columns describe what was asked for — but the app
      // is still on its old port until it comes back, and that has to be said.
      accessWarning: restartError,
      // Same contract for the webhook: the flag is saved, GitHub may not agree.
      webhookWarning,
    });
  });
}

/**
 * Delete a project.
 *
 * What happens to its services is the caller's call, made explicit in the
 * query string. `?services=keep` — the default — detaches them: they live on as
 * standalone services, container and data untouched, filed in the folder the
 * project was in. `?services=delete` takes them down with the project, volumes
 * included. Previously there was only the second, and the dialog could warn
 * about it but not offer anything else — so removing a project you no longer
 * needed meant losing a database you still did.
 *
 * A production project with environments (a staging copy, previews) is
 * refused with 409 `has_environments` unless `?environments=delete` says they
 * go with it: they run its code with its variables and its permissions, and
 * left behind they would follow nothing. They are deleted first, each like a
 * project of its own, with the same choice about databases; deleting an
 * environment itself never touches production.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "delete", action: "project.delete", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "delete");
    if (isDenied(denied)) return denied;

    const servicesParam = request.nextUrl.searchParams.get("services") ?? "keep";
    if (servicesParam !== "keep" && servicesParam !== "delete") {
      return NextResponse.json(
        { error: "Il parametro services può essere solo keep o delete" },
        { status: 400 }
      );
    }
    const environmentsParam = request.nextUrl.searchParams.get("environments");
    if (environmentsParam !== null && environmentsParam !== "delete") {
      return NextResponse.json({ error: "Il parametro environments può essere solo delete" }, { status: 400 });
    }
    const deleteServices = servicesParam === "delete";
    const db = await getDb();

    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    const environments = project.environment_of ? [] : await environmentsOf(projectId);
    const problem = productionDeleteProblem(environments.length, environmentsParam === "delete");
    if (problem) {
      return NextResponse.json(
        {
          error: problem,
          code: "has_environments",
          environments: environments.map((row) => ({ id: row.id, name: row.name, environment: environmentKindOf(row) })),
        },
        { status: 409 }
      );
    }

    let environmentsDeleted = 0;
    if (environments.length > 0) {
      const removed = await deleteEnvironments(projectId, { deleteServices });
      // Each one in the activity log, under its own id, like any project deleted.
      for (const gone of removed.deleted) {
        await audit({
          userId: denied.session.user.id,
          category: "delete",
          action: "project.delete",
          scope: "project",
          scopeId: gone.id,
          detail: `Ambiente di «${project.name}», eliminato insieme al progetto`,
          request,
        });
      }
      environmentsDeleted = removed.deleted.length;
      if (!removed.ok) return NextResponse.json({ error: removed.error, environmentsDeleted }, { status: 409 });
    }

    const outcome = await deleteProject(project, { deleteServices });
    if (!outcome.ok) return NextResponse.json({ error: outcome.error, environmentsDeleted }, { status: outcome.status });

    return NextResponse.json({
      success: true,
      volumesRemoved: outcome.volumesRemoved,
      servicesKept: outcome.servicesKept,
      environmentsDeleted,
    });
  });
}
