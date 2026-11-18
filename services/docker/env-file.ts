import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { planDockerEnv } from "@/lib/docker-env";

const PREFIX = "docker-env-";

/** At boot, where nothing can be running yet: what a killed process never removed. */
export function removeStaleEnvFiles(): void {
  try {
    for (const name of fs.readdirSync(config.tmpDir)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(config.tmpDir, name), { force: true });
    }
  } catch {
    /* no tmp yet */
  }
}

/**
 * Run a docker command with a project's environment, its values off argv: see
 * `lib/docker-env.ts`.
 *
 * `run` gets the arguments to add. The file is 0600, created where only the panel
 * reads, and gone when `run` settles, whatever the outcome, a failed write
 * included; a crash leaves it to `removeStaleEnvFiles` at the next boot.
 */
export async function withDockerEnv<T>(env: Record<string, string>, run: (args: string[]) => Promise<T>): Promise<T> {
  const plan = planDockerEnv(env);
  const args: string[] = [];
  let file: string | null = null;

  try {
    if (plan.file) {
      fs.mkdirSync(config.tmpDir, { recursive: true });
      file = path.join(config.tmpDir, `${PREFIX}${crypto.randomBytes(8).toString("hex")}`);
      fs.writeFileSync(file, plan.file, { mode: 0o600, flag: "wx" });
      args.push("--env-file", file);
    }
    for (const [key, value] of Object.entries(plan.inline)) args.push("-e", `${key}=${value}`);

    return await run(args);
  } finally {
    if (file) fs.rmSync(file, { force: true });
  }
}
