import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The exported project configuration: no secrets out, nothing dangerous back in.
 * Standalone: lib/project-config-file.ts has no imports.
 */
export const meta = { name: "project-config-file-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("project-config-file-unit");
  const { buildConfigFile, readConfigFile, shareableContract, CONFIG_SCHEMA } = await import(
    pathToFileURL(join(repoRoot, "lib", "project-config-file.ts")).href
  );

  const stored = JSON.stringify({
    version: 1,
    commands: { start: "node s.js" },
    buildEnv: { NPM_TOKEN: "secret" },
    docker: { network: "host", mounts: ["/srv/data:/data"] },
  });
  const file = buildConfigFile(
    {
      name: "app",
      source_type: "github",
      source_url: "https://github.com/me/app.git",
      source_branch: "main",
      runtime_type: "docker",
      port: 8080,
      auto_deploy: 1,
      restart_cron: "",
      builder_config: stored,
      hosts: [{ hostname: "app.example.com" }],
    },
    new Date("2026-01-01T00:00:00Z")
  );

  r.check("the schema is stamped", file.$schema === CONFIG_SCHEMA);
  r.check("build values travel by name only", file.contract.buildEnv.NPM_TOKEN === "");
  r.check("bind mounts are dropped", !("mounts" in file.contract.docker) && file.contract.docker.network === "host");
  r.check("the stored contract stays sparse", !("healthcheck" in file.contract) && file.contract.commands.start === "node s.js");
  const upload = buildConfigFile({
    name: "z",
    source_type: "upload",
    source_url: "x",
    source_branch: "main",
    runtime_type: "node",
    port: null,
    auto_deploy: 0,
    restart_cron: "",
    builder_config: "{}",
  });
  r.check("an uploaded project exports no URL", upload.source.url === null);

  const round = readConfigFile(JSON.stringify(file));
  r.check(
    "an export reads back",
    round.ok && round.config.runtime === "docker" && round.config.port === 8080 && round.config.source.url === "https://github.com/me/app.git"
  );

  r.check("not JSON", readConfigFile("{nope").ok === false);
  r.check("not ours", readConfigFile(JSON.stringify({ name: "x" })).ok === false);
  r.check("a bad runtime", readConfigFile(JSON.stringify({ ...file, runtime: "php" })).ok === false);
  r.check("a bad port", readConfigFile(JSON.stringify({ ...file, port: 99999 })).ok === false);
  r.check(
    "a GitHub source without URL",
    readConfigFile(JSON.stringify({ ...file, source: { type: "github", url: "", branch: "main" } })).ok === false
  );
  const sneaky = readConfigFile(JSON.stringify({ ...file, contract: { docker: { mounts: ["/:/host"] } } }));
  r.check("mounts slipped back into a file are dropped on import", sneaky.ok && !("mounts" in sneaky.config.contract.docker));
  r.check("an unreadable stored contract exports as empty", JSON.stringify(shareableContract("{oops")) === "{}");

  return r.result();
}
