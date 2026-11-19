import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { AUTH_FILE, REPO_ROOT } from "./paths";
import { startPanel } from "./server";

/**
 * Starts the panel the run is against, and stops it after the last test.
 *
 * The address reaches the workers through the environment, which they inherit
 * from this process: the config reads it into `baseURL`.
 */
export default async function globalSetup() {
  // A cookie left by an earlier run belongs to a panel that no longer exists.
  rmSync(dirname(AUTH_FILE), { recursive: true, force: true });

  const server = await startPanel({ root: REPO_ROOT });
  process.env.RUNPANEL_E2E_BASE_URL = server.base;
  process.env.RUNPANEL_E2E_DATA_DIR = server.dataDir;
  console.log(`RunPanel e2e: ${server.base} on ${server.dataDir}`);

  return async () => {
    if (process.env.RUNPANEL_E2E_SERVER_LOG) console.log(server.log());
    await server.stop();
  };
}
