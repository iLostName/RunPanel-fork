import fs from "node:fs";

/**
 * Where to find the setup token, for the first-run screen.
 *
 * The token is printed in the panel's own log, and the screen used to say only
 * that: "lo stampa nel proprio log", to someone who may not know where a
 * service's log lives. The panel knows how it was started, so it can say which
 * command shows that log.
 *
 * Only facts a first visitor learns anyway by reading the screen (the token is
 * in a log), and only while nobody has claimed the panel.
 */
export interface SetupTokenHint {
  /** How the panel runs, as far as it can tell. */
  runner: "pinned" | "systemd" | "docker" | "pm2" | "console";
  /** The command that shows the log, when there is one to copy. */
  command: string | null;
}

/** The unit name `services/autostart/render.ts` installs; repeated to keep this file free of that import. */
const UNIT = "runpanel.service";

export function setupTokenHint(env: NodeJS.ProcessEnv = process.env): SetupTokenHint {
  if (env.RUNPANEL_SETUP_TOKEN) return { runner: "pinned", command: null };
  // systemd sets INVOCATION_ID for every unit it starts.
  if (env.INVOCATION_ID) return { runner: "systemd", command: `journalctl -u ${UNIT} -n 50 --no-pager` };
  if (fs.existsSync("/.dockerenv")) return { runner: "docker", command: "docker logs --tail 50 <nome-del-container>" };
  if (env.pm_id !== undefined) return { runner: "pm2", command: `pm2 logs ${env.name ?? "runpanel"} --lines 50 --nostream` };
  return { runner: "console", command: null };
}
