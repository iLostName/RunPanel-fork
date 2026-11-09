/**
 * How a project's environment reaches `docker run` without its values on argv.
 * Zero imports: the unit suite loads this file directly.
 *
 * `-e KEY=value` put every variable, database passwords included, on the command
 * line of the docker client, which any local account can read in `/proc` for as
 * long as the command runs: a release command runs as long as its migration.
 *
 * Values go in an `--env-file`, which the client reads and the panel deletes.
 * That format is one line per variable, read as written, so it cannot carry a
 * line break, nor a line past the client's 64 KiB limit: those few stay on argv.
 *
 * Never by name (`-e KEY` with the value in the client's own environment): the
 * names are the project's to choose, the client is a process of the panel, and no
 * list of names could cover everything it, its plugins, git and the credential
 * helpers it starts read from their environment. `LD_PRELOAD` alone runs code.
 */

export interface DockerEnvPlan {
  /** The `--env-file` content, one `KEY=value` per line. */
  file: string;
  /** What the file cannot carry, left on argv as `-e KEY=value`. */
  inline: Record<string, string>;
}

/** The client reads its env file with a scanner that stops at 64 KiB a line. */
const MAX_FILE_LINE_BYTES = 60_000;

export function planDockerEnv(env: Record<string, string>): DockerEnvPlan {
  const lines: string[] = [];
  const inline: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const line = `${key}=${value}`;
    const fits = !/[\r\n]/.test(value) && new TextEncoder().encode(line).length <= MAX_FILE_LINE_BYTES;
    if (fits) lines.push(line);
    else inline[key] = value;
  }

  return { file: lines.length > 0 ? `${lines.join("\n")}\n` : "", inline };
}
