/**
 * What kind of app a repository is, from its file list and a few small files.
 *
 * The deploy pipeline already recognises an app at build time, from the
 * checkout (`services/builder-registry.ts`, `services/deploy-presets`). The new
 * project wizard needs the same answer before anything is cloned, so it can say
 * "Next.js, porta 3000" and ask nothing. This is that recognition over a
 * virtual tree: the root's file names, plus the contents of `package.json`, a
 * Dockerfile and the Python manifests when they are there.
 *
 * Kept in step with the build-time detectors on purpose: compose files, then a
 * Dockerfile, then package.json, then index.html, exactly the order
 * `detectBuilder` walks; and the preset ids are the ones `DEPLOY_PRESETS` uses.
 * The pipeline still decides at deploy time; this is the preview.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export type DetectedRuntime = "node" | "static" | "docker" | "compose" | "custom";

export type DatabaseKind = "postgresql" | "mysql" | "mongodb" | "redis";

export interface Detection {
  /** False when nothing recognisable was found: the wizard then lets the operator choose. */
  recognised: boolean;
  runtime: DetectedRuntime;
  /** A `DEPLOY_PRESETS` id, when one fits. */
  presetId: string | null;
  /** What to call it on screen: "Next.js", "Sito statico", "FastAPI"… */
  framework: string;
  /** The port the app most likely listens on, null when it is not knowable from outside. */
  port: number | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  /** The scripts that will run, for the summary; the pipeline resolves the real commands. */
  scripts: { build: string | null; start: string | null };
  /** Databases the code seems to use, strongest signal first. */
  databases: DatabaseKind[];
  /** False for bots, workers and queues: nothing answers HTTP, so no startup check. */
  web: boolean;
  /** One line per thing that was recognised, for the "what we found" list. */
  evidence: string[];
}

export interface DetectInput {
  /** File and directory names at the root of the repository. */
  files: readonly string[];
  /** Contents of the files this module reads, when they exist. */
  contents: Partial<Record<"package.json" | "Dockerfile" | "requirements.txt" | "pyproject.toml", string>>;
}

/** The files `detectApp` may want to read, for a caller fetching them remotely. */
export const DETECT_FILES = ["package.json", "Dockerfile", "requirements.txt", "pyproject.toml"] as const;

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function parsePackage(raw: string | undefined): PackageJson | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

/** Which Node frameworks are recognised, in the order they win. */
const NODE_FRAMEWORKS: { dep: string; name: string; port: number | null; presetId: string | null; static?: boolean }[] = [
  { dep: "next", name: "Next.js", port: 3000, presetId: "next-server" },
  { dep: "nuxt", name: "Nuxt", port: 3000, presetId: null },
  { dep: "@remix-run/node", name: "Remix", port: 3000, presetId: null },
  { dep: "@sveltejs/kit", name: "SvelteKit", port: 3000, presetId: null },
  { dep: "astro", name: "Astro", port: 4321, presetId: null },
  { dep: "@nestjs/core", name: "NestJS", port: 3000, presetId: null },
  { dep: "express", name: "Express", port: 3000, presetId: null },
  { dep: "fastify", name: "Fastify", port: 3000, presetId: null },
  { dep: "hono", name: "Hono", port: 3000, presetId: null },
  { dep: "vite", name: "Vite", port: null, presetId: "vite-static", static: true },
  { dep: "react-scripts", name: "Create React App", port: null, presetId: null, static: true },
];

/** Libraries that mean a process with no web page: a bot, a worker, a queue. */
const NODE_WORKERS = ["telegraf", "node-telegram-bot-api", "grammy", "discord.js", "bullmq", "agenda", "@slack/bolt"];
const PYTHON_WORKERS = ["aiogram", "python-telegram-bot", "discord.py", "celery", "rq"];

const NODE_DATABASES: [string, DatabaseKind][] = [
  ["prisma", "postgresql"],
  ["@prisma/client", "postgresql"],
  ["pg", "postgresql"],
  ["postgres", "postgresql"],
  ["@neondatabase/serverless", "postgresql"],
  ["mysql2", "mysql"],
  ["mysql", "mysql"],
  ["mongoose", "mongodb"],
  ["mongodb", "mongodb"],
  ["ioredis", "redis"],
  ["redis", "redis"],
  ["bullmq", "redis"],
];

const PYTHON_DATABASES: [string, DatabaseKind][] = [
  ["psycopg", "postgresql"],
  ["psycopg2", "postgresql"],
  ["psycopg2-binary", "postgresql"],
  ["asyncpg", "postgresql"],
  ["mysqlclient", "mysql"],
  ["pymysql", "mysql"],
  ["pymongo", "mongodb"],
  ["motor", "mongodb"],
  ["redis", "redis"],
];

/** Python package names from requirements.txt or pyproject.toml, lower-cased. */
function pythonPackages(contents: DetectInput["contents"]): Set<string> {
  const names = new Set<string>();
  const add = (raw: string) => {
    const name = raw.trim().toLowerCase().split(/[\s<>=!~;[\]]/)[0];
    if (name) names.add(name);
  };
  for (const line of (contents["requirements.txt"] ?? "").split(/\r?\n/)) {
    if (line.trim() && !line.trim().startsWith("#") && !line.trim().startsWith("-")) add(line);
  }
  // Good enough for a preview: dependency strings inside quotes in pyproject.
  for (const match of (contents["pyproject.toml"] ?? "").matchAll(/["']([A-Za-z0-9_.-]+)\s*[<>=!~\[;"']/g)) add(match[1]);
  return names;
}

/** The first `EXPOSE` of a Dockerfile, which is the port most images serve on. */
function exposedPort(dockerfile: string | undefined): number | null {
  const match = dockerfile?.match(/^\s*EXPOSE\s+(\d{1,5})/im);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

function packageManagerOf(files: ReadonlySet<string>): Detection["packageManager"] {
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json") || files.has("package.json")) return "npm";
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function detectApp(input: DetectInput): Detection {
  const files = new Set(input.files);
  const evidence: string[] = [];
  const pkg = parsePackage(input.contents["package.json"]);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const python = pythonPackages(input.contents);

  const databases = unique([
    ...NODE_DATABASES.filter(([dep]) => dep in deps).map(([, kind]) => kind),
    ...PYTHON_DATABASES.filter(([name]) => python.has(name)).map(([, kind]) => kind),
  ]);

  const base: Omit<Detection, "recognised" | "runtime" | "presetId" | "framework" | "port" | "web"> = {
    packageManager: packageManagerOf(files),
    scripts: { build: pkg?.scripts?.build ?? null, start: pkg?.scripts?.start ?? null },
    databases,
    evidence,
  };

  // --- compose, then a Dockerfile: the repository says how to run itself ------
  const compose = COMPOSE_FILES.find((name) => files.has(name));
  if (compose) {
    evidence.push(`${compose}: lo stack si avvia come descritto lì`);
    return { ...base, recognised: true, runtime: "compose", presetId: null, framework: "Docker Compose", port: null, web: true };
  }
  if (files.has("Dockerfile")) {
    const port = exposedPort(input.contents.Dockerfile);
    evidence.push(port ? `Dockerfile, che espone la porta ${port}` : "Dockerfile: l'immagine viene costruita da lì");
    return { ...base, recognised: true, runtime: "docker", presetId: "dockerfile", framework: "Docker", port, web: true };
  }

  // --- Node -------------------------------------------------------------------
  if (pkg) {
    const framework = NODE_FRAMEWORKS.find((f) => f.dep in deps);
    const worker = !framework && NODE_WORKERS.some((dep) => dep in deps);
    evidence.push(
      framework
        ? `package.json con ${framework.name}${pkg.scripts?.build ? " e uno script di build" : ""}`
        : `package.json${pkg.scripts?.start ? ` con lo script start: ${pkg.scripts.start}` : ""}`
    );
    if (base.packageManager) evidence.push(`Le dipendenze si installano con ${base.packageManager}`);
    if (framework?.static) {
      return { ...base, recognised: true, runtime: "static", presetId: framework.presetId, framework: `${framework.name} (sito statico)`, port: null, web: true };
    }
    return {
      ...base,
      recognised: true,
      runtime: "node",
      presetId: framework?.presetId ?? null,
      framework: framework?.name ?? (worker ? "Node.js (servizio in background)" : "Node.js"),
      port: worker ? null : (framework?.port ?? 3000),
      web: !worker,
    };
  }

  // --- Python and Go: a custom runtime with a preset ----------------------------
  if (files.has("requirements.txt") || files.has("pyproject.toml")) {
    const name = python.has("django") ? "Django" : python.has("fastapi") ? "FastAPI" : python.has("flask") ? "Flask" : "Python";
    const worker = name === "Python" && PYTHON_WORKERS.some((p) => python.has(p));
    evidence.push(`${files.has("requirements.txt") ? "requirements.txt" : "pyproject.toml"}: un'app ${name}`);
    return {
      ...base,
      recognised: true,
      runtime: "custom",
      presetId: "python",
      framework: worker ? "Python (servizio in background)" : name,
      port: worker ? null : name === "Flask" ? 5000 : 8000,
      web: !worker,
    };
  }
  if (files.has("go.mod")) {
    evidence.push("go.mod: un programma Go");
    return { ...base, recognised: true, runtime: "custom", presetId: "go", framework: "Go", port: 8080, web: true };
  }

  // --- plain files ------------------------------------------------------------------
  if (files.has("index.html")) {
    evidence.push("index.html: un sito fatto di file, pubblicato così com'è");
    return { ...base, recognised: true, runtime: "static", presetId: null, framework: "Sito statico", port: null, web: true };
  }

  return { ...base, recognised: false, runtime: "node", presetId: null, framework: "Non riconosciuto", port: null, web: true };
}
