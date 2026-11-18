import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReporter } from "../harness.mjs";

/**
 * One operation at a time on a project.
 *
 * The rules every caller relies on: a second operation is refused and told why,
 * a release is safe to repeat, the queue hears about every release, and once the
 * panel is closing nothing new starts.
 */
export const meta = { name: "project-lock-unit", needsDocker: false, standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("project-lock-unit");
  const lock = await import(pathToFileURL(join(repoRoot, "services", "project-lock.ts")).href);

  const first = lock.tryLock("a", "restart");
  r.check("a free project can be taken", typeof first === "function");
  r.check("the holder can be read back", lock.lockHolder("a") === "restart");
  r.check("a second operation is refused", lock.tryLock("a", "deploy") === null);
  r.check("another project is not affected", typeof lock.tryLock("b", "deploy") === "function");
  r.check(
    "the refusal names what is running",
    lock.busyMessage("a").includes("riavviando"),
    lock.busyMessage("a")
  );

  r.check("what is under way can be listed", lock.heldOperations().includes("restart"));

  const heard = [];
  const stop = lock.onLockReleased((id) => heard.push(id));
  first();
  first();
  r.check("a release is heard exactly once, even when repeated", heard.length === 1, heard.join());
  r.check("a released project can be taken again", lock.lockHolder("a") === null);

  const reentrant = lock.tryLock("a", "deploy");
  first();
  r.check("a stale release does not free the next holder", lock.lockHolder("a") === "deploy");
  reentrant();
  stop();

  lock.onLockReleased(() => {
    throw new Error("a listener that throws");
  });
  const survivor = lock.tryLock("c", "stop");
  let threw = false;
  try {
    survivor();
  } catch {
    threw = true;
  }
  r.check("a failing listener does not break the release", !threw && lock.lockHolder("c") === null);

  lock.setPanelClosing(true);
  r.check("nothing starts while the panel is closing", lock.tryLock("d", "deploy") === null);
  r.check("and the refusal says so", lock.busyMessage("d") === lock.PANEL_CLOSING_MESSAGE);
  lock.setPanelClosing(false);
  r.check("a cancelled restart reopens the panel", typeof lock.tryLock("d", "deploy") === "function");

  // --- the wiring ------------------------------------------------------------------
  // Read from the source because proving these for real takes Docker and PM2 and
  // two operations racing. What a guard like this catches is the next caller that
  // goes straight to the driver.
  const source = (...path) => readFileSync(join(repoRoot, ...path), "utf8");

  const restart = source("services", "project-restart.ts");
  r.check("a restart takes the lock", /tryLock\(projectId, "restart"\)/.test(restart));

  for (const [file, operation] of [
    ["project-repo.ts", "repo-move"],
    ["project-mounts.ts", "mount-apply"],
  ]) {
    const text = source("services", file);
    r.check(`${file} holds the lock for the whole operation`, text.includes(`tryLock(project.id, "${operation}")`));
    r.check(`${file} restarts under it`, text.includes("underLock: true"));
    r.check(
      `${file} does not ignore a failed restart`,
      !/await restartFromLastDeployment\(project\.id\);/.test(text) && text.includes('"error" in result')
    );
  }

  r.check(
    "the autostart reconciler takes the lock",
    /tryLock\(candidate\.id, "autostart"\)/.test(source("services", "autostart", "reconcile.ts"))
  );
  r.check("a deploy claim takes the lock", /tryLock\(projectId, "deploy"\)/.test(source("services", "deploy-queue.ts")));

  const control = source("app", "api", "projects", "[projectId]", "control", "route.ts");
  r.check("a stop cancels the running deploy", control.includes("cancelDeploy(projectId)"));
  r.check("and only then takes the project", control.indexOf("cancelDeploy(projectId)") < control.indexOf("await stopApp()"));

  const update = source("services", "panel-update", "run.ts");
  const blockers = update.slice(update.indexOf("export async function updateBlockers"));
  r.check("a held project blocks the panel's restart", blockers.includes("heldOperations()"));
  r.check(
    "new work is refused before the late check",
    update.indexOf("setPanelClosing(true)") < update.indexOf("const lateBlocker = await updateBlockers()")
  );

  const projectDir = ["app", "api", "projects", "[projectId]"];
  r.check("removing the app takes the project", source(...projectDir, "app", "route.ts").includes('tryLock(projectId, "reset")'));
  r.check("an upload takes the project", source("app", "api", "upload", "route.ts").includes('tryLock(project.id, "upload")'));

  const restore = source("services", "backup", "restore.ts");
  for (const name of ["restoreDatabase", "restoreRepo", "restoreProjectConfig", "restoreVolume"]) {
    const start = restore.indexOf(`async function ${name}(`);
    const body = restore.slice(start, restore.indexOf("\n}\n", start));
    r.check(`${name} takes the project`, /holdProject\(|takeDown\(/.test(body));
  }
  r.check("Postgres is asked about open sessions first", restore.indexOf("refuseOpenSessions(target, env);") < restore.indexOf("postgresRestoreCommand(target.credentials.user"));
  r.check("only what was up comes back", /if \(wasUp\) stopped\.projects\.push/.test(restore) && restore.includes("await appIsUp(project)"));
  r.check(
    "every project is taken before the safety copy",
    restore.indexOf("await holdTargets(planned") !== -1 &&
      restore.indexOf("await holdTargets(planned") < restore.indexOf("await takeSafetyBackup(planned")
  );

  r.check("the sweep leaves a held project alone", source("services", "status-reconcile.ts").includes("if (lockHolder(project.id)) continue;"));

  const boot = source("instrumentation.ts");
  r.check("journals left open are closed at boot", boot.includes("reconcileProjectApplies()") && boot.includes("reconcileRepoMoves()"));

  const mounts = source("services", "project-mounts.ts");
  r.check("a project never deployed has nothing to restart", mounts.includes("await restart(await write(next));") && mounts.includes("if (!deployed)"));
  r.check("a stopped project stays stopped", mounts.includes("if (!wasUp)"));
  r.check("a failed seed undoes nothing", mounts.includes("if (recreating) await restart(await write(previous));"));

  const queue = source("services", "deploy-queue.ts");
  const cancel = queue.slice(queue.indexOf("export function cancelDeploy"));
  r.check("a refused stop keeps what was queued", cancel.indexOf("lockHolder(projectId)") < cancel.indexOf("state.pending.delete"));

  r.check("the shell's exit does not cancel the SIGKILL", source("services", "builders", "run-shell.ts").includes("if (!interrupted) settle(outcome(code))"));

  const builder = source("services", "builders", "docker-builder.ts");
  r.check(
    "a docker deployment records its own immutable image",
    builder.includes("startCmd: `docker:${versioned}`") && !builder.includes("currentImageTag")
  );

  return r.result();
}
