import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Recognising an app from its files, before anything is cloned.
 *
 * The wizard says "Next.js, porta 3000" from this; getting it wrong would ask
 * the next question on a false premise. Standalone: lib/app-detect.ts has no
 * imports.
 */
export const meta = { name: "app-detect-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("app-detect-unit");
  const { detectApp } = await import(pathToFileURL(join(repoRoot, "lib", "app-detect.ts")).href);
  const pkg = (deps, scripts = {}) => JSON.stringify({ dependencies: deps, scripts });

  const next = detectApp({ files: ["package.json", "package-lock.json", "next.config.js"], contents: { "package.json": pkg({ next: "15", react: "19", "@prisma/client": "5" }, { build: "next build", start: "next start" }) } });
  r.check("Next.js is recognised with its preset and port", next.recognised && next.framework === "Next.js" && next.runtime === "node" && next.presetId === "next-server" && next.port === 3000);
  r.check("npm from the lockfile", next.packageManager === "npm");
  r.check("Prisma suggests PostgreSQL", next.databases[0] === "postgresql");
  r.check("the scripts are carried for the summary", next.scripts.build === "next build" && next.scripts.start === "next start");

  const vite = detectApp({ files: ["package.json", "pnpm-lock.yaml"], contents: { "package.json": pkg({ vite: "6", react: "19" }, { build: "vite build" }) } });
  r.check("Vite is a static site with its preset", vite.runtime === "static" && vite.presetId === "vite-static" && vite.port === null);
  r.check("pnpm from its lockfile", vite.packageManager === "pnpm");

  const compose = detectApp({ files: ["compose.yaml", "Dockerfile", "package.json"], contents: { "package.json": pkg({ next: "15" }) } });
  r.check("a compose file wins over everything, like detectBuilder", compose.runtime === "compose");

  const docker = detectApp({ files: ["Dockerfile", "package.json"], contents: { Dockerfile: "FROM node:22\nEXPOSE 8080\nCMD [\"node\",\"s.js\"]", "package.json": pkg({ express: "4" }) } });
  r.check("a Dockerfile wins over package.json, with its EXPOSE port", docker.runtime === "docker" && docker.presetId === "dockerfile" && docker.port === 8080);

  const bot = detectApp({ files: ["package.json", "bun.lock"], contents: { "package.json": pkg({ telegraf: "4" }, { start: "node bot.js" }) } });
  r.check("a bot is a background service with no port", bot.web === false && bot.port === null && bot.packageManager === "bun");

  const express = detectApp({ files: ["package.json"], contents: { "package.json": pkg({ express: "4", mongoose: "8", ioredis: "5" }) } });
  r.check("Express listens on 3000", express.framework === "Express" && express.port === 3000);
  r.check("every database signal, in order", JSON.stringify(express.databases) === JSON.stringify(["mongodb", "redis"]));

  const fastapi = detectApp({ files: ["requirements.txt", "main.py"], contents: { "requirements.txt": "fastapi==0.115\nuvicorn[standard]\npsycopg2-binary>=2.9\n# a comment\n" } });
  r.check("FastAPI is recognised with the Python preset on 8000", fastapi.framework === "FastAPI" && fastapi.runtime === "custom" && fastapi.presetId === "python" && fastapi.port === 8000);
  r.check("psycopg suggests PostgreSQL", fastapi.databases.includes("postgresql"));

  const flask = detectApp({ files: ["pyproject.toml"], contents: { "pyproject.toml": "[project]\ndependencies = [\"flask>=3\", \"redis\"]\n" } });
  r.check("Flask from pyproject listens on 5000", flask.framework === "Flask" && flask.port === 5000);

  const pyBot = detectApp({ files: ["requirements.txt"], contents: { "requirements.txt": "aiogram==3\n" } });
  r.check("a Python bot is a background service", pyBot.web === false && pyBot.port === null);

  const go = detectApp({ files: ["go.mod", "main.go"], contents: {} });
  r.check("Go on 8080", go.framework === "Go" && go.presetId === "go" && go.port === 8080);

  const html = detectApp({ files: ["index.html", "style.css"], contents: {} });
  r.check("plain HTML is a static site", html.runtime === "static" && html.framework === "Sito statico");

  const nothing = detectApp({ files: ["README.md"], contents: {} });
  r.check("nothing recognisable says so", nothing.recognised === false);

  const broken = detectApp({ files: ["package.json"], contents: { "package.json": "{ not json" } });
  r.check("a broken package.json falls through instead of throwing", broken.recognised === false || broken.runtime !== undefined);

  r.check("every recognised result says why", [next, vite, compose, docker, bot, fastapi, go, html].every((d) => d.evidence.length > 0));

  return r.result();
}
