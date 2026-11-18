import { IBuilder, BuildContext, BuildResult } from "./types";
import { resolveInside } from "@/lib/fs-safe";
import { docker, DockerError, lines } from "../docker/cli";
import { labelArgs } from "../docker/labels";
import { imageTag, pullImage } from "../docker/images";
import fs from "fs";
import path from "path";

export const dockerBuilder: IBuilder = {
  name: "docker",

  async detect(projectDir: string): Promise<boolean> {
    // Compose is deliberately NOT detected here: nothing in RunPanel runs
    // `docker compose`, so claiming it would route a compose-only repo into
    // `docker build` and fail with a confusing "Dockerfile not found".
    return fs.existsSync(path.join(projectDir, "Dockerfile"));
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, onLog } = ctx;
    const slug = ctx.slug ?? path.basename(projectDir);
    const deploymentId = ctx.deploymentId ?? "manual";

    // Template mode: a prebuilt image, nothing to build.
    if (ctx.dockerImage) {
      try {
        await pullImage(ctx.dockerImage, onLog);
        onLog(`Image pulled: ${ctx.dockerImage}`);
        return { success: true, artifactDir: projectDir, startCmd: `docker:${ctx.dockerImage}` };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Docker pull failed";
        onLog(`ERROR: ${message}`);
        return { success: false, artifactDir: projectDir, startCmd: "", error: message };
      }
    }

    const versioned = imageTag(slug, deploymentId);
    const buildArgs = ctx.buildArgs ?? {};

    // An immutable tag per deployment, and that is the tag the deployment
    // records and starts from. The moving `:current` alias is not touched here:
    // it follows success, in the pipeline. When the build itself moved it, a
    // deploy that failed afterwards (a release command, say) left every restart
    // starting the failed image instead of the last good one.
    const args = [
      "build",
      "-t", versioned,
      ...labelArgs({ project: slug, kind: "app", deployment: deploymentId }),
      // On argv: `docker build` has no file for them, and passing them by name
      // would let names a repository chooses into the client's environment (see
      // `lib/docker-env.ts`). A build argument is no place for a secret anyway:
      // Docker records it in the image's history.
      ...Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
    ];

    /*
      The context and the Dockerfile are resolved against the checkout and
      refused if they leave it.

      Both are panel-only in the contract, so a repository cannot set them any
      more — but the operator can, and the value that reaches `docker build`
      decides which directory is handed to the daemon. `../..` from a checkout
      is the panel's data directory: `.secret`, the store, and every other
      project. This is the check that makes the deny-list a boundary rather
      than an intention.
    */
    const context = resolveInside(projectDir, ctx.buildContext ?? ".");
    if (!context) {
      const message = `Il contesto di build esce dalla cartella del progetto: ${ctx.buildContext}`;
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }

    if (ctx.dockerfile) {
      const dockerfile = resolveInside(projectDir, ctx.dockerfile);
      if (!dockerfile) {
        const message = `Il Dockerfile esce dalla cartella del progetto: ${ctx.dockerfile}`;
        onLog(`ERROR: ${message}`);
        return { success: false, artifactDir: projectDir, startCmd: "", error: message };
      }
      args.push("-f", dockerfile);
    }
    if (ctx.target) args.push("--target", ctx.target);
    args.push(context);

    const argNames = Object.keys(buildArgs);
    if (argNames.length > 0) {
      // Names only — a build arg is frequently a secret.
      onLog(`Build args: ${argNames.join(", ")}`);
    }
    onLog(`> docker build -t ${versioned} ${ctx.buildContext ?? "."}`);

    try {
      const result = await docker(args, {
        cwd: projectDir,
        timeout: ctx.buildTimeout ?? 900_000,
        signal: ctx.signal,
      });
      for (const line of lines(result.stderr)) onLog(line);
      onLog(`Docker image built: ${versioned}`);

      return { success: true, artifactDir: projectDir, startCmd: `docker:${versioned}` };
    } catch (err: unknown) {
      const message =
        err instanceof DockerError
          ? err.stderr || err.message
          : err instanceof Error
            ? err.message
            : "Docker build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
