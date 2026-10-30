import type { PanelMethod } from "./panel-api";

/**
 * Every REST endpoint an MCP client may call, with what it does and what it
 * takes — the map the `list_endpoints` tool hands the assistant, so that
 * `api_get` and `api_request` can reach all of the panel and not just the
 * handful of operations with a tool of their own.
 *
 * Written by hand, from the handlers. `mcp-catalog-unit` walks `app/api` and
 * fails when a handler is missing here or an entry names one that no longer
 * exists, so a new route cannot ship without the assistant learning of it.
 *
 * Notation: `?` optional, `A|B` an enum, `T[]` an array. Bodies are JSON.
 * Errors are always `{ error: string, details? }` with a 4xx/5xx status, in
 * Italian. `kind` says when an answer is not JSON: a `stream` never ends on
 * its own and a `binary` is a file; neither can be read through MCP.
 */

export type RouteKind = "json" | "stream" | "binary";

export interface RouteEntry {
  method: PanelMethod;
  path: string;
  summary: string;
  query: string;
  body: string;
  kind: RouteKind;
}

export const ROUTES: RouteEntry[] = [
  // --- account ---
  { method: "GET", path: "/api/account", summary: "Current user's account: returns { id, email, isOwner, createdAt }.", query: "", body: "", kind: "json" },
  { method: "PATCH", path: "/api/account", summary: "Change own email and/or password (both need the current password); a password change signs out other devices.", query: "", body: "{ currentPassword: string, email?: string, newPassword?: string /* 8-128 chars */ }", kind: "json" },

  // --- audit ---
  { method: "GET", path: "/api/audit", summary: "Page of the activity log (needs audit.view); returns the filtered entries plus paging info.", query: "category ('security'|'deploy'|'config'|'terminal'|'backup'|'system'|'delete'), scope ('project'|'service'|'folder'|'user'|'permission'), scopeId, userId, action, from (ISO date), to (ISO date), before (ISO date, cursor), limit (1-200, default 50)", body: "", kind: "json" },
  { method: "GET", path: "/api/audit/settings", summary: "Owner only: which audit categories are recorded and the retention; returns { categories, retentionDays, alwaysOn }.", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/audit/settings", summary: "Owner only: set recorded audit categories and/or retention (security is always on).", query: "", body: "{ categories?: ('security'|'deploy'|'config'|'terminal'|'backup'|'system'|'delete')[], retentionDays?: number /* int 1-3650 */ }", kind: "json" },

  // --- autostart ---
  { method: "POST", path: "/api/autostart/fix", summary: "Apply a one-click autostart repair (docker-enable, pm2-save, or align a container's restart policy).", query: "", body: "{ fix: 'docker-enable'|'pm2-save'|'restart-policy', target?: { kind: 'project'|'service', id: string } /* required for restart-policy */ }", kind: "json" },
  { method: "POST", path: "/api/autostart/host", summary: "Install, remove, or preview the host boot hook that starts the panel.", query: "", body: "{ action: 'install'|'uninstall'|'preview', method?: 'systemd'|'cron' }", kind: "json" },
  { method: "POST", path: "/api/autostart/reconcile", summary: "Run the boot reconciliation now (starts what is down), or only report with dryRun.", query: "", body: "{ dryRun?: boolean } /* body optional */", kind: "json" },
  { method: "GET", path: "/api/autostart", summary: "Whole autostart picture: returns { probe, stored, report, entries[], reconcilerEnabled } with per-project/service autostart settings and restart-policy match.", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/autostart", summary: "Save autostart flag/order/delay for projects and services in one transaction.", query: "", body: "{ entries: { kind: 'project'|'service', id: string, autostart: boolean, order?: number /* int 0-9999 */, delaySeconds?: number /* int 0-600 */, waitHealthy?: boolean }[] /* 1-500 */ }", kind: "json" },

  // --- backups ---
  { method: "POST", path: "/api/backups/cron-preview", summary: "Describe a cron expression and list its next run times; returns { description, timezone, occurrences[] }.", query: "", body: "{ cron: string, timezone?: string /* IANA */, count?: number /* int 1-10, default 3 */ }", kind: "json" },
  { method: "POST", path: "/api/backups/destinations/{destinationId}", summary: "Test a backup destination by writing a real file; returns { ok, message }.", query: "", body: "", kind: "json" },
  { method: "DELETE", path: "/api/backups/destinations/{destinationId}", summary: "Delete a backup destination (409 if any policy uses it).", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/backups/destinations", summary: "List backup destinations (config never returned); returns { destinations: [{ id, name, type, isDefault, createdAt }] }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/backups/destinations", summary: "Create a backup destination (local or S3-compatible); returns 201 { id, name, type, isDefault }.", query: "", body: "{ name: string /* 1-60 */, type: 'local'|'s3', config?: { endpoint: string /* https, or http to a private host */, region: string, bucket: string, accessKeyId: string, secretAccessKey: string, prefix?: string, forcePathStyle?: boolean } /* required for s3 */, isDefault?: boolean }", kind: "json" },
  { method: "GET", path: "/api/backups/policies/{policyId}", summary: "Get one backup policy.", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/backups/policies/{policyId}", summary: "Partially update a backup policy (same fields as create, all optional); returns the policy.", query: "", body: "{ name?: string, enabled?: boolean, cron?: string /* '' = manual only */, timezone?: string|null, destinationId?: string, targets?: BackupTarget[], retentionCount?: number|null, retentionDays?: number|null, retentionBytes?: number|null /* >= 1048576 */, includeSecretKey?: boolean } /* BackupTarget = { kind: 'service', id: string, databases?: string[] } | { kind: 'all-services' } | { kind: 'project', id: string, include: ('config'|'volumes'|'repo')[] } | { kind: 'all-projects', include: ('config'|'volumes'|'repo')[] } | { kind: 'panel' } */", kind: "json" },
  { method: "DELETE", path: "/api/backups/policies/{policyId}", summary: "Delete a backup policy.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/backups/policies/{policyId}/run", summary: "Start a manual backup run of a policy; 202 { runId } (409 if one is already running).", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/backups/policies", summary: "List backup policies visible to the user; returns { policies: [...] }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/backups/policies", summary: "Create a backup policy; returns 201 the policy.", query: "", body: "{ name: string /* 1-80 */, enabled?: boolean, cron: string /* 5-field cron or '' for manual only */, timezone?: string|null, destinationId: string, targets: BackupTarget[] /* 1-200; see PUT /api/backups/policies/{policyId} */, retentionCount?: number|null /* 1-1000 */, retentionDays?: number|null /* 1-3650 */, retentionBytes?: number|null /* >= 1048576 */, includeSecretKey?: boolean }", kind: "json" },
  { method: "GET", path: "/api/backups/restore/{restoreId}", summary: "Status and log of a restore; returns { id, runId, source, status, safetyRunId, errorMessage, startedAt, finishedAt, durationMs, log }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/backups/restore/{restoreId}/stream", summary: "SSE stream of a restore's log lines and status events until it finishes.", query: "", body: "", kind: "stream" },
  { method: "POST", path: "/api/backups/restore", summary: "Start a restore from a catalog run (or an uploaded archive); 202 { restoreId }. `confirm` must equal the first selected artifact's refName (runId) or the uploadId.", query: "", body: "{ runId?: string, uploadId?: string /* exactly one of runId/uploadId */, targets: { artifactId: string, action: 'restore'|'skip', targetId?: string, targetDatabase?: string }[] /* 1-200, at least one 'restore' */, skipSafetyBackup?: boolean, confirm: string }", kind: "json" },
  { method: "GET", path: "/api/backups/runs/{runId}/download", summary: "Download a backup run's archive (application/zip, X-Checksum-Sha256 header).", query: "", body: "", kind: "binary" },
  { method: "GET", path: "/api/backups/runs/{runId}", summary: "Detail of a backup run (artifacts, status, log).", query: "", body: "", kind: "json" },
  { method: "DELETE", path: "/api/backups/runs/{runId}", summary: "Delete a finished backup run and its archive (409 while running).", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/backups/runs/{runId}/stream", summary: "SSE stream of a backup run's log lines and status events until it finishes.", query: "", body: "", kind: "stream" },
  { method: "GET", path: "/api/backups/runs", summary: "Recent backup runs; returns { runs[], overview, activeRunId }.", query: "policyId (filter), limit (number, default 50, max 200)", body: "", kind: "json" },
  { method: "GET", path: "/api/backups/targets", summary: "Catalog of things that can be backed up (projects, services, ...) the user may manage.", query: "", body: "", kind: "json" },

  // --- cluster (multi-server) ---
  { method: "GET", path: "/api/cluster/backups", summary: "Backup policies, runs, destinations and catalogs fanned out across all servers.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/diagnostics", summary: "Diagnostics of every server; returns { servers: [...] }.", query: "fresh (1 = bypass cache, slower)", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/folders", summary: "Folders aggregated from all servers.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/cluster/link-tokens", summary: "Issue a one-hour token for linking another server (needs nodes permission); returns { token, expiresAt, panelUrl }.", query: "", body: "{ name?: string /* 1-60, this server's name */, url?: string /* http(s) origin of this panel */ } /* body optional */", kind: "json" },
  { method: "GET", path: "/api/cluster/locate", summary: "Find which server holds a project/service; returns { memberId, memberName } (null if none).", query: "kind ('project'|'service'), id", body: "", kind: "json" },
  { method: "POST", path: "/api/cluster/members/{memberId}/diagnose", summary: "Probe a cluster member: reachability, signature, version, clock skew; returns a MemberDiagnosis.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/cluster/members/{memberId}/resend-secret", summary: "Re-push the cluster secret to a member after a rotation.", query: "", body: "", kind: "json" },
  { method: "PATCH", path: "/api/cluster/members/{memberId}", summary: "Rename a member, change its URL or role.", query: "", body: "{ name?: string /* 1-60 */, url?: string /* http(s) origin */, role?: 'panel'|'node' } /* at least one field */", kind: "json" },
  { method: "DELETE", path: "/api/cluster/members/{memberId}", summary: "Revoke a member from the cluster; returns { success, told }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/monitor", summary: "Monitor data of every server; returns { servers: [...] }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/projects", summary: "Projects aggregated from all servers.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/cluster/rotate-secret", summary: "Rotate the shared cluster secret and push it to members.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster", summary: "Cluster overview; returns { solo, selfId, role, selfVersion, members[] }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/servers", summary: "One card per server with summary and warnings; returns { servers[], panelVersion }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/services", summary: "Services aggregated from all servers.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/cluster/sync", summary: "Broadcast the user/member directory to all members; returns { members: [...] }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/targets", summary: "Folders/projects/services across servers, to build access grants (needs users.manage).", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/cluster/updates", summary: "Panel update status of every server; returns { servers: [...] }.", query: "", body: "", kind: "json" },

  // --- deployments / diagnostics ---
  { method: "GET", path: "/api/deployments/{deploymentId}", summary: "A deployment record with its build log (build_log).", query: "tail (number of log lines, 1-10000)", body: "", kind: "json" },
  { method: "GET", path: "/api/diagnostics", summary: "Host health checks; returns { checks[], tone, problems, checkedAt }.", query: "fresh (1 = re-run checks)", body: "", kind: "json" },

  // --- domains (public names via reverse proxy + Cloudflare) ---
  { method: "DELETE", path: "/api/domains/{domainId}", summary: "Delete a domain (409 while projects still use a subdomain of it).", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/domains/cloudflare", summary: "Connect a Cloudflare API token; returns { cloudflare } with the zones found.", query: "", body: "{ token: string /* 20-512 printable chars */ }", kind: "json" },
  { method: "DELETE", path: "/api/domains/cloudflare", summary: "Disconnect Cloudflare (forget the token); returns { cloudflare }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/domains/proxy", summary: "Set up or apply the reverse proxy config for named hosts; returns { ok, message?, commands?, requested }.", query: "", body: "{ action: 'setup'|'apply' }", kind: "json" },
  { method: "GET", path: "/api/domains", summary: "Domains page data; returns { proxy, acmeEmail, addresses, cloudflare, domains[], hosts[] }.", query: "fresh (1 = bypass cache)", body: "", kind: "json" },
  { method: "POST", path: "/api/domains", summary: "Add a domain (e.g. example.it); returns 201 { id, name, cloudflare, hostCount, ... }.", query: "", body: "{ name: string /* bare domain, no scheme or wildcard */ }", kind: "json" },
  { method: "PUT", path: "/api/domains/settings", summary: "Set the ACME (Let's Encrypt) contact email; '' clears it.", query: "", body: "{ acmeEmail: string }", kind: "json" },

  // --- folders ---
  { method: "PATCH", path: "/api/folders/{folderId}", summary: "Rename a folder.", query: "", body: "{ name: string /* 1-60 */ }", kind: "json" },
  { method: "DELETE", path: "/api/folders/{folderId}", summary: "Delete a folder; its projects/services move to the root.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/folders", summary: "List visible folders (array of { id, name, created_at, updated_at }).", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/folders", summary: "Create a folder (needs projects.create); returns 201 the folder.", query: "", body: "{ name: string /* 1-60 */ }", kind: "json" },

  // --- github ---
  { method: "GET", path: "/api/github/branches", summary: "Branches of a GitHub repo via the connected token; returns { connected, branches: [{ name, protected }] }.", query: "repo (required, 'owner/name')", body: "", kind: "json" },
  { method: "GET", path: "/api/github/repos", summary: "Repos reachable with the connected GitHub token; returns { connected, repos[] }.", query: "", body: "", kind: "json" },

  // --- monitoring ---
  { method: "GET", path: "/api/metrics", summary: "Host CPU, memory, disk, uptime, platform and hostname.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/monitor", summary: "Host metrics plus per-project and per-service status/cpu/memory; returns { server, projects[], services[] }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/network/suggestions", summary: "Detected local networks and the caller's IP, for IP allowlists; returns { networks, clientIp }.", query: "", body: "", kind: "json" },

  // --- notifications (Telegram) ---
  { method: "GET", path: "/api/notifications", summary: "Telegram notification config (token never returned); returns { tokenSet, chatId, events, configured }.", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/notifications", summary: "Update Telegram bot token / chat id / enabled events ('' clears token or chat).", query: "", body: "{ token?: string /* '' to clear, else 'digits:secret' */, chatId?: string /* '' to clear, '-?digits' or '@name' */, events?: ('project.crashed'|'service.crashed'|'restart.scheduled'|'docker.down'|'disk.low'|'deploy.finished'|'backup.finished'|'panel.update'|'panel.restarted')[] }", kind: "json" },
  { method: "POST", path: "/api/notifications", summary: "Send a test Telegram message, or discover chats that wrote to the bot.", query: "", body: "{ action: 'test'|'chats' }", kind: "json" },

  // --- presets ---
  { method: "GET", path: "/api/presets", summary: "Deploy presets; returns { presets: [{ id, label, description, runtime, commands, ... }] }.", query: "", body: "", kind: "json" },

  // --- projects ---
  { method: "DELETE", path: "/api/projects/{projectId}/app", summary: "Remove the deployed app only (process, images, checkout, deployments); keeps the project, env vars and queued one-time commands.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/backup", summary: "Project backup settings (consistency, pre-backup command, volume excludes).", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/projects/{projectId}/backup", summary: "Set project backup settings; returns { settings }.", query: "", body: "{ consistency: 'pause'|'live', preBackup: { service: string /* compose service */, command: string, timeoutSec: number /* int 5-3600 */ } | null, excludes?: Record<volumeName, string[] /* paths */> }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/commits", summary: "Commits of the project's GitHub branch for the version picker; returns { available, branch, page, hasMore, commits: [{ sha, shortSha, message, author, date, url }] } (available:false with a reason when unavailable).", query: "branch (default project's branch), perPage (1-100, default 20), page (1-20, default 1)", body: "", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/control", summary: "Start, stop or restart the project's app.", query: "", body: "{ action: 'start'|'stop'|'restart' }", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/deploy", summary: "Queue a deploy or re-build; 202 { deploymentId, status:'pending', mode } or { status:'queued' }. commitSha pins the project to that commit.", query: "", body: "{ mode?: 'deploy'|'rebuild', commitSha?: string /* 7-40 hex, deploy mode + GitHub source only */ } /* body optional */", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/env", summary: "Project env vars as [{ id, key, value }]; values are masked unless reveal is allowed.", query: "reveal ('true' to show real values; needs env.reveal right)", body: "", kind: "json" },
  { method: "PUT", path: "/api/projects/{projectId}/env", summary: "Replace ALL env vars of the project; returns { success, count }.", query: "", body: "{ vars: { key: string /* [A-Za-z_][A-Za-z0-9_]* , max 64 */, value: string /* max 65536 */ }[] /* max 500 */ }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/files/content", summary: "Read a text file (<=1MB) from the project checkout or docker container; returns { content, path }.", query: "path (required)", body: "", kind: "json" },
  { method: "PUT", path: "/api/projects/{projectId}/files/content", summary: "Write a text file (<=1MB) in the project checkout or docker container.", query: "", body: "{ path: string, content: string }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/files", summary: "List a directory of the project checkout or docker container; returns { entries: [{ name, type: 'dir'|'file', size }], path }.", query: "path (default '/')", body: "", kind: "json" },
  { method: "PATCH", path: "/api/projects/{projectId}/hosts/{hostId}", summary: "Toggle public access of a named host and/or set/clear its basic-auth login; returns { host }.", query: "", body: "{ publicAccess?: boolean, auth?: { user: string /* [A-Za-z0-9._@-]{1,64} */, password: string /* 8-128 */ } | null } /* at least one field */", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/hosts/{hostId}", summary: "Retry certificate issuing for a host; 202 { host }.", query: "", body: "{ action: 'retry' }", kind: "json" },
  { method: "DELETE", path: "/api/projects/{projectId}/hosts/{hostId}", summary: "Remove a named host from the project.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/hosts", summary: "Named hosts of the project; returns { hosts[], domains[], proxy, hasPort, restricted, canManageDomains }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/hosts", summary: "Give the project a public name (subdomain on a configured domain); 201 { host, proxy }. Project needs a port.", query: "", body: "{ domainId: string, subdomain: string /* single label, e.g. 'app' */, publicAccess?: boolean }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/logs", summary: "Deployment history (last 50) by default, or the running process's recent logs with source=process (returns { logs }).", query: "source ('process' for live process logs; omit for deployments)", body: "", kind: "json" },
  { method: "PUT", path: "/api/projects/{projectId}/mounts", summary: "Replace the project's host-folder bind mounts and apply them (async); 202 { status:'started', apply }.", query: "", body: "{ mounts: { source: string /* abs host path, >=2 levels */, target: string /* abs container path */, readOnly: boolean, enabled: boolean }[] /* max 32 */, adopt?: string[] /* container paths whose current content is copied into the host dir, max 32 */ }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/one-time-commands", summary: "Queued one-time deploy commands; returns { queued[], history[] }.", query: "include ('history' to also return finished commands)", body: "", kind: "json" },
  { method: "PUT", path: "/api/projects/{projectId}/one-time-commands", summary: "Replace the queue of one-time deploy commands (the full list); returns { queued }.", query: "", body: "{ commands: { id?: string, phase: 'pre-deploy'|'post-source'|'pre-install'|'post-install'|'post-build'|'pre-start'|'post-start'|'post-deploy', command: string /* 1-4000 */, label?: string|null /* max 80 */, continueOnError: boolean }[] /* max 50 */ }", kind: "json" },
  { method: "DELETE", path: "/api/projects/{projectId}/one-time-commands", summary: "Clear the history of finished one-time commands; returns { removed }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/pin", summary: "Release a commit pin (re-enables auto-deploy), optionally deploying the branch head right away.", query: "", body: "{ action: 'release', deploy?: boolean }", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/repo-path", summary: "Move the project's checkout to another host folder (async); 202 { status:'started', move }.", query: "", body: "{ path: string|null /* abs path, >=2 levels; null = back to default */ }", kind: "json" },
  { method: "DELETE", path: "/api/projects/{projectId}/repo-path", summary: "Delete the previous checkout left after a repo move.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}", summary: "Full project: settings (redacted for non-managers), deploy_count, last_deploy_at, access, gate, repo, mounts, repoMove, oneTimeCommands, hosts[], permission.", query: "", body: "", kind: "json" },
  { method: "PATCH", path: "/api/projects/{projectId}", summary: "Update project settings (all fields optional); returns the updated project (+ accessWarning, webhookWarning).", query: "", body: "{ name?: string, restartCron?: string /* cron, '' = off */, appName?: string|null, sourceType?: 'github'|'upload', sourceUrl?: string|null /* public https URL */, sourceBranch?: string, runtimeType?: 'node'|'static'|'docker'|'compose'|'custom'|null, port?: number|null /* 1-65535 */, autoDeploy?: boolean, deployTrigger?: 'webhook'|'poll', presetId?: string|null, builderConfig?: { commands?: { install?, build?, start?, release? }, packageManager?: 'auto'|'npm'|'bun'|'pnpm'|'yarn', buildEnv?: Record<string,string>, docker?: { image?, dockerfile?, context?, target?, network?: 'project'|'bridge'|'host', mounts?: string[], capAdd?: string[], extraHosts?: string[] }, runtime?: { restartPolicy?: 'no'|'on-failure'|'unless-stopped'|'always', memory?, cpus?, shmSize?, singleInstance? }, build?: { nodeOptions?, timeoutSec? }, healthcheck?: { enabled?, path?, port?, expectStatus?: number[], startPeriodSec?, timeoutSec?, intervalSec? } } /* deploy contract, version:1 */, access?: { mode: 'open'|'restricted', allow: string[] /* IPs or CIDRs */ }, folderId?: string|null }", kind: "json" },
  { method: "DELETE", path: "/api/projects/{projectId}", summary: "Delete the project (app, images, repo, volumes); linked services are kept or deleted per the query. Returns { success, volumesRemoved, servicesKept }.", query: "services ('keep' default = detach linked services | 'delete' = remove them with their data)", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/status", summary: "Light status poll; returns { status, port, runtimeType, process }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/stream", summary: "SSE stream of project events: deploy logs, status changes, process logs, own terminal output.", query: "", body: "", kind: "stream" },
  { method: "POST", path: "/api/projects/{projectId}/terminal", summary: "Container shell session (docker runtimes only): start/stop it or send input; returns { status: 'started'|'stopped'|'ok'|'dead' }.", query: "", body: "{ action?: 'start'|'stop', input?: string /* max 65536, written to stdin */ }", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/terminal", summary: "Poll and drain the buffered shell output; returns { active, output }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/projects/{projectId}/webhook", summary: "GitHub webhook status for the project.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/projects/{projectId}/webhook", summary: "Connect, ping or disconnect the project's GitHub webhook (needs github permission); returns { ok, message, status }.", query: "", body: "{ action: 'connect'|'ping'|'disconnect' }", kind: "json" },
  { method: "GET", path: "/api/projects", summary: "List visible projects with deploy_count, last_deploy_at and linked services[].", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/projects", summary: "Create an empty project (needs projects.create); 201 the project row.", query: "", body: "{ name: string /* 1-100 */ }", kind: "json" },

  // --- registries ---
  { method: "GET", path: "/api/registries", summary: "Configured Docker registries (no passwords); returns { registries: [{ registry, username }], dockerHub }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/registries", summary: "Save (add/replace) credentials for a Docker registry.", query: "", body: "{ registry: string, username: string, password: string }", kind: "json" },
  { method: "DELETE", path: "/api/registries", summary: "Remove credentials of a registry.", query: "registry (required)", body: "", kind: "json" },

  // --- server summary ---
  { method: "GET", path: "/api/server-summary", summary: "Compact summary of this server for the user: version, docker, metrics, project/service counts, problems, update.", query: "", body: "", kind: "json" },

  // --- services ---
  { method: "POST", path: "/api/services/{serviceId}/console", summary: "Database service console session: start (engine CLI, shell, or logs), send input, or stop; returns { status, mode?, container? }.", query: "", body: "{ action: 'start', mode: 'engine'|'shell'|'logs', confirmed?: boolean /* must be true unless mode='logs' */ } | { action: 'input', input: string /* max 4096 */ } | { action: 'stop' }", kind: "json" },
  { method: "POST", path: "/api/services/{serviceId}/control", summary: "Start, stop or restart the service container.", query: "", body: "{ action: 'start'|'stop'|'restart' }", kind: "json" },
  { method: "DELETE", path: "/api/services/{serviceId}/databases/{name}", summary: "Drop a named database inside a running service (not the primary or system ones).", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/services/{serviceId}/databases", summary: "Databases inside a service; returns { supported, running, databases: [{ name, primary, managed, present }] }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/services/{serviceId}/databases", summary: "Create a named database in a running service; 201 { name }.", query: "", body: "{ name: string /* ^[a-z][a-z0-9_]*$, max 63 */ }", kind: "json" },
  { method: "PUT", path: "/api/services/{serviceId}/mounts", summary: "Replace the service's host-folder bind mounts and apply them (async); 202 { status:'started', apply }.", query: "", body: "{ mounts: { id: string, source: string /* abs host path */, target: string /* abs container path */, enabled: boolean, readOnly: boolean }[] /* max 32 */, adopt?: string[] /* mount ids */, releaseData?: string[] /* mount ids */ }", kind: "json" },
  { method: "GET", path: "/api/services/{serviceId}", summary: "Full service detail (status, ports, injection, access, mounts, containerMounts, credentials 'hidden' unless revealed).", query: "reveal ('true' to include decrypted credentials; needs credentials right)", body: "", kind: "json" },
  { method: "PATCH", path: "/api/services/{serviceId}", summary: "Update a service: display name, attach/detach to a project, env injection, restart cron, access, folder; returns the updated service.", query: "", body: "{ displayName?: string|null, projectId?: string|null /* attach/detach */, injectEnv?: boolean, restartCron?: string /* '' = off */, envKey?: string|null /* [A-Z][A-Z0-9_]* */, access?: { mode: 'open'|'restricted', allow: string[] }, folderId?: string|null }", kind: "json" },
  { method: "DELETE", path: "/api/services/{serviceId}", summary: "Delete a service container; returns { success, volumesRemoved }.", query: "deleteData ('true' to also delete its data volumes)", body: "", kind: "json" },
  { method: "GET", path: "/api/services/{serviceId}/stream", summary: "SSE stream of service events: status, own console output, mount-apply log.", query: "", body: "", kind: "stream" },
  { method: "GET", path: "/api/services", summary: "List visible services (credentials only where permitted) with their env injection info.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/services", summary: "Create and start a database/cache service (needs projects.create); 201 the service.", query: "", body: "{ name: string /* ^[a-z0-9][a-z0-9_-]*$, max 38 */, type: 'postgresql'|'mysql'|'redis'|'mongodb', version: string, port: number /* 1-65535 */, projectId?: string, credentials?: { user?: string, password?: string, database?: string }, access?: { mode: 'open'|'restricted', allow: string[] } }", kind: "json" },

  // --- sessions ---
  { method: "GET", path: "/api/sessions", summary: "Active login sessions of a user; returns { sessions: [{ ..., current }] }.", query: "userId (default: self; others need rights over that user)", body: "", kind: "json" },
  { method: "DELETE", path: "/api/sessions", summary: "Revoke a login session; returns { success, sessions }.", query: "id (required, session id)", body: "", kind: "json" },

  // --- settings ---
  { method: "GET", path: "/api/settings", summary: "Panel settings as a flat { key: string } map (github_token shows 'configured' or ''); includes timezone_effective.", query: "", body: "", kind: "json" },
  { method: "PUT", path: "/api/settings", summary: "Update settings; send exactly one of preferences (owner), panel_update_allowed_signers (owner) or github_token (github permission).", query: "", body: "{ preferences: { polling_interval?: '2'|'5'|'10', timezone?: string /* IANA */, accent_preset?: 'blue'|'mono'|'teal'|'amber'|'violet', panel_public_url?: string /* http(s) URL or '' */, deploy_poll_interval?: '30'|'60'|'120'|'300'|'600'|'900'|'1800', panel_update_interval?: '3600'|'21600'|'86400', panel_update_require_signature?: '0'|'1' } } | { panel_update_allowed_signers: string /* max 8192 */ } | { github_token: string /* '' disconnects */ }", kind: "json" },

  // --- storage ---
  { method: "GET", path: "/api/storage", summary: "Docker disk usage: usage, owned images, volumes, orphans, retention (20s cached snapshot).", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/storage", summary: "Clean up Docker storage (orphans, build cache, unused images) and return the sweep result.", query: "", body: "{ removeOrphans?: boolean, deep?: boolean, unusedImages?: boolean, retention?: { imagesPerProject: number /* int 1-50 */, buildCacheHours: number /* int 0-8760 */ } } /* body optional */", kind: "json" },

  // --- panel updates ---
  { method: "POST", path: "/api/updates/apply", summary: "Start a self-update of the panel; 202 { runId } (409 if blocked or busy).", query: "", body: "{ expectedSha?: string /* commit the check reported */ } /* body optional */", kind: "json" },
  { method: "POST", path: "/api/updates/check", summary: "Check the git remote for a newer panel version; returns the check result.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/updates/log", summary: "Log tail of the current update run; returns { runId, lines[] }.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/updates", summary: "Panel update state: version, checkout, last check, current run, canUpdate, blocker, interval.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/updates/stream", summary: "SSE stream of the panel update run (log lines and phase changes).", query: "", body: "", kind: "stream" },

  // --- users ---
  { method: "POST", path: "/api/users/{userId}/invite", summary: "Issue a new invite/password-reset link for a user (needs users.manage); returns { kind: 'invite'|'reset', invitePath, expiresAt }.", query: "", body: "{ hours: number /* positive int, 1 hour to 30 days */ }", kind: "json" },
  { method: "GET", path: "/api/users/{userId}", summary: "One user with their permissions/grants; returns { user, access, editable }.", query: "", body: "", kind: "json" },
  { method: "PATCH", path: "/api/users/{userId}", summary: "Change a user's access (global permissions + grants) and/or disable/enable the account.", query: "", body: "{ access?: { permissions: ('projects.create'|'github'|'registries'|'monitor'|'storage'|'backup'|'restore'|'autostart'|'diagnostics'|'notifications'|'updates'|'users.manage'|'audit.view'|'host'|'nodes')[], grants: { scope: 'all'|'folder'|'project'|'service', scopeId: string|null /* null iff scope='all' */, level: 'read'|'operate'|'manage', terminal: boolean }[] /* max 500 */ }, disabled?: boolean }", kind: "json" },
  { method: "DELETE", path: "/api/users/{userId}", summary: "Delete a user account.", query: "", body: "", kind: "json" },
  { method: "GET", path: "/api/users/access", summary: "Who can reach a given project/service and at what level; returns { users: [{ id, email, isOwner, disabled, level, terminal, direct, editable }] }.", query: "kind ('project'|'service', required), id (required)", body: "", kind: "json" },
  { method: "GET", path: "/api/users", summary: "List users; returns { users: [...] }.", query: "", body: "", kind: "json" },
  { method: "POST", path: "/api/users", summary: "Invite a new user by email (needs users.manage); 201 { user: { id, email }, invitePath, expiresAt }.", query: "", body: "{ email: string, hours: number /* positive int, 1 hour to 30 days */ }", kind: "json" },
];
