import { createReporter } from "../harness.mjs";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Where the first-run screen says the setup token is.
 *
 * "Il pannello lo stampa nel proprio log" left a newcomer to find which log;
 * the screen now names the command for how this panel was started.
 * lib/setup-hint.ts imports only node:fs.
 */
export const meta = { name: "setup-hint-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("setup-hint-unit");
  const { setupTokenHint } = await import(pathToFileURL(join(repoRoot, "lib", "setup-hint.ts")).href);
  const inContainer = existsSync("/.dockerenv");

  r.check("a pinned token says so and shows no command", JSON.stringify(setupTokenHint({ RUNPANEL_SETUP_TOKEN: "x" })) === JSON.stringify({ runner: "pinned", command: null }));
  const systemd = setupTokenHint({ INVOCATION_ID: "abc" });
  r.check("under systemd, the journal of the unit", systemd.runner === "systemd" && systemd.command.startsWith("journalctl -u runpanel.service"));
  if (!inContainer) {
    const pm2 = setupTokenHint({ pm_id: "0", name: "panel" });
    r.check("under PM2, its logs for that app", pm2.runner === "pm2" && pm2.command.includes("pm2 logs panel"));
    r.check("otherwise, the terminal it was started in", JSON.stringify(setupTokenHint({})) === JSON.stringify({ runner: "console", command: null }));
  }
  r.check("a pinned token wins over everything", setupTokenHint({ RUNPANEL_SETUP_TOKEN: "x", INVOCATION_ID: "abc" }).runner === "pinned");

  return r.result();
}
