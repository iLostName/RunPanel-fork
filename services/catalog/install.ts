import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { encrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import { firstFreePort } from "@/lib/ports";
import { isReservedSlug } from "@/lib/project-slug";
import { hostnameFor } from "@/lib/proxy-names";
import { getSetting } from "@/lib/settings";
import { deleteGrantsFor, grantCreator } from "@/lib/users";
import { generateId, slugify } from "@/lib/utils";
import {
  MIN_APP_PORT,
  buildEnvironment,
  composeFile,
  fillNote,
  getTemplate,
  isPublicHost,
  isTimeZone,
  locateApp,
  noteValues,
  suggestProjectName,
  validateAnswers,
  type CatalogInstallResponse,
  type DockerInventory,
} from "@/lib/app-catalog";
import { enqueueDeploy } from "../deploy-queue";
import { getRepoPath } from "../git-manager";
import { PANEL_CLOSING_MESSAGE } from "../project-lock";
import { addressProblem, claimedPorts, newHostRow, serveNewHosts } from "../proxy";
import { dockerInventory, dockerProblem, leftoversIn, portFreeOnHost } from "./checks";
import { generateSecret } from "./secrets";

/**
 * Installing an app of the catalogue: one call, all or nothing.
 *
 * Everything that can refuse does so before anything exists — the answers, the
 * name, Docker, what an earlier install left behind, the ports, the address —
 * so the common failures cost nothing to undo. Then, in this order: the
 * project's directory is claimed (`mkdir` without `recursive`, which fails if
 * it is there), the compose file written, and the project, its variables and
 * its address inserted in one transaction. A failure anywhere in that stretch
 * removes all of it again. Only once the project is complete is its first
 * deploy queued; a deploy that then fails is something to fix on a project that
 * exists, as with the new project wizard, not a reason to throw the
 * configuration away.
 *
 * The result is an ordinary Compose project: the source is "upload" (files on
 * disk, nothing to fetch), the answers are project variables encrypted like
 * any other, and the compose file is the one under `repos/<slug>`, editable.
 *
 * Installs run one at a time. Two at once would each pick the same free port,
 * and both would be told it was free.
 */

export class CatalogInstallError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Where the form should show it, and anything it can offer instead. */
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CatalogInstallError";
  }
}

export interface CatalogInstallInput {
  templateId: string;
  name: string;
  /** Left out: a free one is picked. */
  port?: number;
  answers?: Record<string, string | number | boolean>;
  address?: { domainId: string; subdomain: string } | null;
  /** The server's name as the person reaches it, for apps that write their own links. */
  publicHost?: string;
}

type CatalogInstallResult = CatalogInstallResponse;

const QUEUE = Symbol.for("runpanel.catalog-install");
const store = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const previous = store[QUEUE] ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  store[QUEUE] = next.catch(() => undefined);
  return next;
}

export function installCatalogApp(
  input: CatalogInstallInput,
  ctx: { userId: string; requestHost: string | null }
): Promise<CatalogInstallResult> {
  return serialised(() => install(input, ctx));
}

async function install(input: CatalogInstallInput, ctx: { userId: string; requestHost: string | null }): Promise<CatalogInstallResult> {
  const template = getTemplate(input.templateId);
  if (!template) throw new CatalogInstallError(404, "Questa app non è nel catalogo di questo server");

  // --- the answers --------------------------------------------------------------
  const stored = await getSetting("timezone");
  const { values: answers, issues } = validateAnswers(template, input.answers ?? {}, {
    timezone: stored && isTimeZone(stored) ? stored : "UTC",
  });
  if (issues.length > 0) {
    throw new CatalogInstallError(400, issues[0].message, { field: `answers.${issues[0].key}`, issues });
  }
  if (template.address === "required" && !input.address) {
    throw new CatalogInstallError(400, `${template.name} ha bisogno di un indirizzo. ${template.addressNote ?? ""}`.trim(), {
      field: "address",
    });
  }

  // --- the name -------------------------------------------------------------------
  const db = await getDb();
  const name = input.name.trim();
  const slug = slugify(name);
  const takenSlugs = new Set((await db.selectFrom("projects").select("slug").execute()).map((row) => row.slug));
  // Once Docker has been asked, a suggestion also has to be free of leftovers:
  // offering "n8n 2" to someone whose "n8n 2" left its volumes behind too would
  // only move the same refusal one click further.
  let inventory: DockerInventory | null = null;
  const usable = (candidate: string) =>
    !takenSlugs.has(candidate) &&
    !isReservedSlug(candidate) &&
    !pathExists(getRepoPath(candidate)) &&
    (inventory === null || leftoversIn(inventory, candidate, template).length === 0);
  const alternative = () => {
    for (let n = 2; n < 100; n++) {
      if (usable(slugify(`${name} ${n}`))) return `${name} ${n}`;
    }
    return suggestProjectName(name, new Set([...takenSlugs, slug]));
  };

  if (isReservedSlug(slug)) {
    throw new CatalogInstallError(
      400,
      `Il nome diventa "${slug}", che il pannello riserva ai propri container: scegline un altro`,
      { field: "name", suggestedName: alternative() }
    );
  }
  if (takenSlugs.has(slug)) {
    throw new CatalogInstallError(409, `Esiste già un progetto con il nome interno "${slug}": scegline un altro`, {
      field: "name",
      suggestedName: alternative(),
    });
  }

  // --- the machine ------------------------------------------------------------------
  const docker = await dockerProblem();
  if (docker) throw new CatalogInstallError(503, docker);

  const dir = getRepoPath(slug);
  if (pathExists(dir)) {
    throw new CatalogInstallError(
      409,
      `Sul server c'è già una cartella per "${slug}", lasciata da qualcos'altro: scegli un altro nome.`,
      { field: "name", suggestedName: alternative() }
    );
  }
  inventory = await dockerInventory();
  if (inventory === null) {
    throw new CatalogInstallError(503, "Non riesco a chiedere a Docker che volumi e container ci sono: riprova tra poco.");
  }
  const leftovers = leftoversIn(inventory, slug, template);
  if (leftovers.length > 0) {
    throw new CatalogInstallError(
      409,
      `Restano i dati di una vecchia installazione con questo nome (${leftovers.slice(0, 4).join(", ")}${leftovers.length > 4 ? "…" : ""}). ` +
        "Con un altro nome parti da zero; per riusare questo, eliminali prima dal server, sapendo che quei dati andranno persi.",
      { field: "name", code: "leftover_data", suggestedName: alternative(), leftovers }
    );
  }

  // --- the ports --------------------------------------------------------------------
  const claimed = new Set((await claimedPorts()).keys());
  const port = await settlePort(input.port ?? null, template.web.defaultPort, claimed, { field: "port" });
  claimed.add(port);
  for (const question of template.questions) {
    if (!question.port) continue;
    const typed = answers[question.key] !== undefined ? Number(answers[question.key]) : null;
    const base = Number.parseInt(question.default ?? "", 10) || port + 1;
    const chosen = await settlePort(typed, base, claimed, { field: `answers.${question.key}`, label: question.label });
    claimed.add(chosen);
    answers[question.key] = String(chosen);
  }

  // --- the address ------------------------------------------------------------------
  let host: { domainId: string; subdomain: string; hostname: string } | null = null;
  if (input.address) {
    const domain = await db
      .selectFrom("domains")
      .select(["id", "name"])
      .where("id", "=", input.address.domainId)
      .executeTakeFirst();
    if (!domain) throw new CatalogInstallError(404, "Dominio non trovato", { field: "address" });
    const hostname = hostnameFor(input.address.subdomain, domain.name);
    if (!hostname) {
      throw new CatalogInstallError(400, "L'indirizzo completo supera la lunghezza che il DNS consente.", { field: "address" });
    }
    const problem = await addressProblem(hostname);
    if (problem) throw new CatalogInstallError(409, problem, { field: "address" });
    host = { domainId: domain.id, subdomain: input.address.subdomain, hostname };
  }

  // --- what gets written --------------------------------------------------------------
  const location = locateApp({ hostname: host?.hostname ?? null, publicHost: publicHostFor(input.publicHost, ctx.requestHost), port });
  const secrets = Object.fromEntries(template.secrets.map((secret) => [secret.key, generateSecret(secret)]));
  const entries = buildEnvironment(template, { answers, secrets, location, port });
  const contract = {
    version: 1,
    healthcheck: {
      enabled: true,
      path: template.healthcheck.path,
      expectStatus: [...template.healthcheck.expectStatus],
      startPeriodSec: template.healthcheck.startPeriodSec,
      timeoutSec: template.healthcheck.timeoutSec,
    },
  };

  // --- created together, or not at all --------------------------------------------------
  const id = generateId();
  const now = nowIso();
  const hostRow = host
    ? newHostRow({ projectId: id, domainId: host.domainId, subdomain: host.subdomain, hostname: host.hostname, publicAccess: false })
    : null;
  let claimedDir = false;
  let inserted = false;

  try {
    fs.mkdirSync(config.reposDir, { recursive: true });
    fs.mkdirSync(dir);
    claimedDir = true;
    fs.writeFileSync(path.join(dir, "compose.yaml"), composeFile(template), { flag: "wx" });

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("projects")
        .values({
          id,
          name,
          slug,
          app_name: null,
          source_type: "upload",
          source_url: null,
          source_branch: "main",
          runtime_type: "compose",
          builder_config: JSON.stringify(contract),
          port,
          status: "stopped",
          auto_deploy: 0,
          webhook_secret: crypto.randomBytes(20).toString("hex"),
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (entries.length > 0) {
        await trx
          .insertInto("env_vars")
          .values(entries.map((entry) => ({ id: generateId(), project_id: id, key: entry.key, value: encrypt(entry.value), created_at: now })))
          .execute();
      }
      if (hostRow) await trx.insertInto("project_hosts").values(hostRow).execute();
    });
    inserted = true;

    // Allowed to create, so allowed to open what was created.
    await grantCreator(ctx.userId, "project", id);
  } catch (err) {
    // The variables and the address go with the row: the schema cascades them.
    let leftBehind = false;
    if (inserted) {
      try {
        await db.deleteFrom("projects").where("id", "=", id).execute();
        await deleteGrantsFor("project", id);
      } catch {
        leftBehind = true;
      }
    }
    if (claimedDir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        leftBehind = true;
      }
    }
    if (leftBehind) {
      console.error("[catalog] Install failed and could not be undone:", err instanceof Error ? err.message : err);
      throw new CatalogInstallError(
        500,
        `L'installazione non è riuscita e non sono riuscito a togliere tutto quello che avevo creato: controlla il progetto «${name}» ed eliminalo.`,
        { projectId: inserted ? id : null }
      );
    }

    if (!claimedDir && (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CatalogInstallError(409, `La cartella di "${slug}" è comparsa proprio ora: scegli un altro nome.`, {
        field: "name",
        suggestedName: alternative(),
      });
    }
    if (isUniqueViolation(err)) {
      throw new CatalogInstallError(409, "Il nome o l'indirizzo è stato preso da un'altra operazione proprio ora: riprova.", {
        field: host ? "address" : "name",
      });
    }
    throw err;
  }

  // --- the project exists and is complete -------------------------------------------------
  let proxy: CatalogInstallResult["proxy"] = null;
  if (hostRow) {
    try {
      const found = await serveNewHosts([hostRow.id]);
      proxy = { state: found.state, detail: found.detail };
    } catch {
      // The name is saved; the Domains page applies it whenever the proxy is ready.
    }
  }

  return {
    project: { id, slug, name },
    templateId: template.id,
    port,
    url: location.url,
    hostname: host?.hostname ?? null,
    proxy,
    deployment: await firstDeploy(id),
    secrets: template.secrets.map((secret) => ({
      key: secret.key,
      label: secret.label,
      value: secrets[secret.key],
      important: secret.important === true,
      help: secret.help ?? null,
    })),
    values: Object.fromEntries(entries.filter((entry) => !entry.sensitive).map((entry) => [entry.key, entry.value])),
    notes: template.notes.map((note) => fillNote(note, noteValues(entries, location))),
  };
}

async function firstDeploy(projectId: string): Promise<CatalogInstallResult["deployment"]> {
  try {
    const queued = await enqueueDeploy(projectId, { mode: "deploy", trigger: "manual", commitSha: null, commitMessage: null });
    if (queued.status === "started" && queued.deploymentId) return { status: "started", deploymentId: queued.deploymentId };
    if (queued.status === "queued") return { status: "queued", message: "Il deploy parte appena finisce l'operazione in corso sul progetto." };
    return {
      status: "not-started",
      message: queued.status === "unavailable" ? PANEL_CLOSING_MESSAGE : "Il deploy non è partito: avvialo dalla pagina del progetto.",
    };
  } catch (err) {
    console.error("[catalog] First deploy not queued:", err instanceof Error ? err.message : err);
    return { status: "not-started", message: "Il deploy non è partito: avvialo dalla pagina del progetto." };
  }
}

/**
 * A port the install may publish: the one asked for, if nothing holds it, or
 * the first free one from `base`. A port someone typed is never swapped
 * silently — the refusal names a free one instead.
 */
async function settlePort(
  typed: number | null,
  base: number,
  claimed: Set<number>,
  where: { field: string; label?: string }
): Promise<number> {
  if (typed !== null) {
    if (typed >= MIN_APP_PORT && typed <= 65535 && !claimed.has(typed) && (await portFreeOnHost(typed))) return typed;
    const free = await freePort(base, claimed);
    throw new CatalogInstallError(
      409,
      `La porta ${typed}${where.label ? ` (${where.label})` : ""} è già usata su questo server: scegline un'altra, per esempio ${free}.`,
      { field: where.field, code: "port_taken", suggestedPort: free }
    );
  }
  return freePort(base, claimed);
}

async function freePort(base: number, claimed: ReadonlySet<number>): Promise<number> {
  const tried = new Set(claimed);
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = firstFreePort(Math.max(base, MIN_APP_PORT), tried);
    if (candidate >= MIN_APP_PORT && (await portFreeOnHost(candidate))) return candidate;
    tried.add(candidate);
  }
  throw new CatalogInstallError(503, "Non trovo una porta libera su questo server: indicane una in «Avanzate».", { field: "port" });
}

/**
 * The server's name for links, when no address is chosen: what the page sent
 * if it is a plain host name or IP, otherwise the request's own Host.
 */
function publicHostFor(sent: string | undefined, requestHost: string | null): string {
  const candidate = sent?.trim().toLowerCase();
  if (candidate && isPublicHost(candidate)) return candidate;
  if (requestHost) {
    try {
      const hostname = new URL(`http://${requestHost}`).hostname.replace(/^\[|\]$/g, "");
      if (isPublicHost(hostname)) return hostname;
    } catch {
      /* a Host header that is not a host */
    }
  }
  return "localhost";
}

/** Anything at the path, a dangling link included: `existsSync` follows links and would miss one. */
function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}
