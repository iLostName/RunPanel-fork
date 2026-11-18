import { z } from "zod";
import { isValidTimeZone, parseCron } from "./cron";
import { BRANCH_NAME_RULE, COMMIT_SHA_RULE, isBranchName, isCommitSha } from "./git-ref";
import { parseMountString } from "./mount";
import { parseAddress, ruleProblem } from "./ip-access";
import { normalizeDomain, normalizeSubdomain } from "./proxy-names";
import { deployPhases } from "./deploy-phases";
import { MAX_DISPLAY_NAME } from "./service-name";
import { isContractInput } from "./deploy-contract";
import { versionsFor } from "./service-versions";
import {
  COMPOSE_SERVICE_PATTERN,
  EXCLUDE_PATH_RULE,
  MAX_EXCLUDES_PER_VOLUME,
  MAX_PRE_BACKUP_TIMEOUT_SEC,
  VOLUME_NAME_PATTERN,
  normalizeExcludePath,
} from "./backup-settings";
import {
  TASK_COMMAND_MAX,
  TASK_NAME_MAX,
  TASK_TIMEOUT_MAX_SEC,
  TASK_TIMEOUT_MIN_SEC,
} from "./tasks-rules";
import { hasRunnableLine } from "./tasks-shell";
import { MAX_BACKUP_PASSWORD, backupPasswordProblem } from "./backup-password";
import { MAX_COPIES } from "./backup-copies";
import {
  DEFAULT_REMOTE_FOLDER,
  MAX_REMOTE_FOLDER,
  RCLONE_REMOTE_PATTERN,
  SSH_HOST_KEY_PATTERN,
  normalizeRemoteFolder,
  normalizeSshHost,
  remoteFolderProblem,
  sshHostProblem,
  sshUserProblem,
} from "./backup-remote";
import { PEER_MAX_QUOTA_BYTES, isPeerMemberId } from "./backup-peer";
import { RCLONE_PROVIDERS, parseRcloneSections, parseRcloneToken } from "./rclone-config";
import {
  MAX_PAGE_PROJECTS,
  MESSAGE_MAX,
  PUBLIC_NAME_MAX,
  SLUG_MAX,
  SLUG_MIN,
  SLUG_PATTERN,
  SLUG_RULE,
  TITLE_MAX,
  cleanLine,
  cleanText,
  entryKey,
} from "./status-page";



/**
 * `static` belongs here even though the manual runtime picker does not offer
 * it: the "Vite / SPA statica" preset declares it, and picking a preset picks
 * its runtime. Left out, choosing that preset produced a PATCH the schema
 * rejected — the project could not be created at all, with "Dati non validi"
 * and nothing pointing at the runtime. `ProjectsTable.runtime_type` and the
 * builder registry have always known the value.
 */
export const runtimeTypes = ["node", "static", "docker", "compose", "custom"] as const;
export type RuntimeType = (typeof runtimeTypes)[number];

function isBlockedIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * The IPv6 forms that carry an IPv4 address the network delivers as such.
 *
 * `parseAddress` has already folded `::ffff:a.b.c.d`. The rest are the
 * IPv4-compatible `::/96` (which also holds `::` and `::1`), NAT64's
 * `64:ff9b::/96` and 6to4's `2002::/16`, which keeps it in bytes 2 to 5.
 */
function embeddedIpv4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.subarray(0, 12).every((byte) => byte === 0)) return bytes.subarray(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.subarray(2, 6);
  const nat64 = bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  return nat64 && bytes.subarray(4, 12).every((byte) => byte === 0) ? bytes.subarray(12) : null;
}

/**
 * Hosts a clone is never allowed to reach.
 *
 * Cloning happens in a subprocess running as the panel, on the panel's network.
 * An unrestricted URL therefore turns "add a project" into a request the caller
 * gets to make from inside the host — a port scan of the LAN, or a read of a
 * cloud metadata endpoint at 169.254.169.254.
 *
 * Literal addresses only: a public name that resolves to a private address
 * still gets through, because git does the resolving and nothing here can pin
 * the answer it gets. Blocking the literals removes the direct route; the
 * token gating in `git-manager.ts` is what limits the damage of the rest.
 *
 * Exported because the same question — "is this address reachable from outside
 * this machine?" — decides whether GitHub can deliver a webhook to the panel's
 * own URL. Asking it twice, in two spellings, is how the two answers end up
 * disagreeing.
 */
export function isBlockedRepoHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;

  // Bytes, not text: the URL parser rewrites `[::ffff:127.0.0.1]` to
  // `[::ffff:7f00:1]`, which no pattern on the spelling would recognise. A host
  // with a colon that does not parse is refused rather than guessed at.
  if (host.includes(":")) {
    const parsed = parseAddress(host);
    if (!parsed) return true;
    if (parsed.family === 4) return isBlockedIpv4(parsed.bytes[0], parsed.bytes[1]);

    const embedded = embeddedIpv4(parsed.bytes);
    if (embedded) return isBlockedIpv4(embedded[0], embedded[1]);

    const [first, second] = parsed.bytes;
    if ((first & 0xfe) === 0xfc) return true; // unique-local, fc00::/7
    return first === 0xfe && (second & 0xc0) === 0x80; // link-local, fe80::/10
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 ? isBlockedIpv4(Number(v4[1]), Number(v4[2])) : false;
}

/**
 * A repository URL the panel is willing to clone.
 *
 * `z.string().url()` on its own accepts `file:///etc`, `ssh://…`, `javascript:…`
 * and `http://169.254.169.254/…` — it checks shape, not reachability or scheme.
 *
 * Credentials are dropped rather than refused. `gitClone` has never used them,
 * so they do nothing but sit in the row, where read-level users get them back
 * and the deploy log prints them. Refusing would also block the settings form,
 * which sends back whatever URL a project already has.
 */
export const repoUrlSchema = z
  .string()
  .url()
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      return url.protocol === "https:" && !isBlockedRepoHost(url.hostname);
    },
    { message: "L'indirizzo del repository deve essere pubblico e iniziare con https://" }
  )
  .transform((raw) => {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return url.href;
  });

/**
 * Who may reach a published port.
 *
 * The messages are exported for the same reason as the two name rules further
 * down: the form renders the sentence the server would, from the same string.
 * The arithmetic lives in `lib/ip-access.ts`, which has no imports of its own
 * so this file stays loadable from a client component.
 */
export const IP_RULE_HINT = "Un indirizzo IP o una rete CIDR, es. 192.168.1.0/24";

/**
 * `/0` is a legal prefix that means everyone. Accepted quietly it would let the
 * panel report «1 rete consentita» over a port open to the internet — true, and
 * the opposite of what it looks like. So it is refused, and the message says
 * what to press instead of what is wrong.
 */
export const IP_RULE_EVERYTHING = "Una rete /0 consente tutti: usa l'interruttore Aperto";

export const accessRuleSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    const problem = ruleProblem(value);
    if (problem === "everything") {
      ctx.addIssue({ code: "custom", message: IP_RULE_EVERYTHING });
    } else if (problem) {
      ctx.addIssue({ code: "custom", message: IP_RULE_HINT });
    }
  });

export const accessSchema = z.object({
  mode: z.enum(["open", "restricted"]),
  /** An empty list under `restricted` means "only this machine". */
  allow: z.array(accessRuleSchema).max(64),
});

/**
 * The two values that reach `git` as arguments, in zod.
 *
 * The rules themselves live in `lib/git-ref.ts`, which has no imports — both so
 * a standalone suite can load them and because they are git's rules, not this
 * file's. Here they only get a schema and a message.
 */
export const commitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isCommitSha, { message: COMMIT_SHA_RULE });

export const branchNameSchema = z
  .string()
  .trim()
  .refine(isBranchName, { message: BRANCH_NAME_RULE });

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
});

/**
 * A folder id where a project or service should be filed, or `null` for the
 * root. Existence is checked in the route, where the store is.
 */
export const folderIdSchema = z.string().min(1).max(32).nullable();

export const folderNameSchema = z.string().trim().min(1).max(60);

export const createFolderSchema = z.object({
  name: folderNameSchema,
});

export const updateFolderSchema = z.object({
  name: folderNameSchema,
});

/**
 * A restart schedule: empty switches it off, anything else has to parse.
 * Defined here rather than reusing `cronExpressionSchema`, which is declared
 * further down and would not exist yet when this object is built.
 */
export const restartCronSchema = z
  .string()
  .max(120)
  .superRefine((value, ctx) => {
    if (value === "") return;
    const parsed = parseCron(value);
    if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
  });

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  /** Empty means no scheduled restart. Interpreted in the panel's `timezone`. */
  restartCron: restartCronSchema.optional(),
  appName: z.string().max(100).optional().nullable(),
  sourceType: z.enum(["github", "upload"]).optional(),
  sourceUrl: repoUrlSchema.optional().nullable(),
  sourceBranch: branchNameSchema.optional(),
  runtimeType: z.enum(runtimeTypes).optional().nullable(),
  port: z.number().int().min(1).max(65535).optional().nullable(),
  autoDeploy: z.boolean().optional(),
  /**
   * How auto-deploy hears about a push: GitHub calling in, or the panel asking.
   * Polling exists for the installations no inbound connection can reach.
   */
  deployTrigger: z.enum(["webhook", "poll"]).optional(),
  /**
   * A deploy preset chosen by hand, applied UNDER whatever the caller also
   * sends. Detection still runs at deploy time; this is the answer for a
   * repository whose shape cannot be seen from outside — or that has not been
   * cloned yet, which is every project at the moment it is configured.
   */
  presetId: z.string().min(1).max(64).optional().nullable(),
  /**
   * The deploy contract, in either the current shape or the older four-field
   * one. It is accepted loosely here and normalised in the route: a strict
   * schema would silently DROP the legacy keys — Zod strips what it does not
   * know — and a project configured through the old wizard would come back with
   * no commands at all. Loose is not unchecked: what could only be read as an
   * empty contract is refused here, or it would wipe the stored one and answer 200.
   */
  builderConfig: z
    .record(z.string(), z.unknown())
    .refine(isContractInput, "Configurazione di deploy non valida")
    .optional(),
  /** See `accessSchema`. Changing it restarts the app: the port has to move. */
  access: accessSchema.optional(),
  /** Where the Overview files it. See `folderIdSchema`. */
  folderId: folderIdSchema.optional(),
});

/**
 * Bounded like every other list in this file, and for a sharper reason than
 * symmetry: a value here is decrypted into the environment of a spawned
 * process, and an environment block has a size the kernel will refuse. A
 * megabyte pasted into one variable turns every deploy of that project into
 * `E2BIG` from `execve`, which reads as the app being broken.
 */
export const envVarsSchema = z.object({
  vars: z.array(z.object({
    key: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Nome non valido: usa lettere, numeri e _ e non iniziare con un numero"),
    value: z.string().max(65536),
  })).max(500)
    // A name sent twice used to reach the insert and break the unique index:
    // a 500, after the delete that precedes it had already been rolled back.
    // Refused here instead, on the row that repeats it.
    .superRefine((vars, ctx) => {
      const seen = new Set<string>();
      vars.forEach((v, index) => {
        if (seen.has(v.key)) {
          ctx.addIssue({ code: "custom", path: [index, "key"], message: "Nome ripetuto: ogni variabile può comparire una volta sola" });
        }
        seen.add(v.key);
      });
    }),
});

/**
 * What the reader of an app's saved log may be asked for: how many of the last
 * lines, containing which text, from which stream. See `services/app-logs.ts`.
 */
export const appLogQuerySchema = z.object({
  lines: z.coerce
    .number({ error: "Numero di righe non valido" })
    .int("Numero di righe non valido")
    .min(1, "Almeno una riga")
    .max(5000, "Al massimo 5000 righe")
    .default(500),
  q: z.string().max(200, "La ricerca può avere al massimo 200 caratteri").optional(),
  stream: z.enum(["stdout", "stderr"], { error: "stream può essere solo stdout o stderr" }).optional(),
});

export const controlActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

/**
 * What may be asked of a service console.
 *
 * The project terminal it is modelled on reads `body as { action?, input? }`
 * with nothing validating either — the one mutating route in the panel without
 * a schema. This is that route written the way the rest of them are.
 *
 * `confirmed` is checked here rather than only in the dialog for the same
 * reason `restoreRequestSchema` checks its own: the confirmation that counts is
 * the one that cannot be skipped by posting straight at the endpoint. `logs` is
 * exempt because it cannot change anything.
 */
/**
 * What the project terminal accepts.
 *
 * It was the one mutating route with no schema, and it cost two things. An
 * `action` nobody checked meant a `stop` arriving with no live session fell
 * through to the first branch and OPENED a shell in the container instead of
 * closing one. And an `input` nobody typed meant a number reached
 * `stdin.write()`, which throws — a 500 where a 400 was the answer.
 */
export const terminalActionSchema = z
  .object({
    action: z.enum(["start", "stop"]).optional(),
    /** One keystroke to a pasted block; anything larger is not a terminal. */
    input: z.string().max(65536).optional(),
  })
  .strict();

export const consoleModeSchema = z.enum(["engine", "shell", "logs"]);

export const serviceConsoleSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      mode: consoleModeSchema,
      confirmed: z.boolean().optional(),
    })
    .refine((value) => value.mode === "logs" || value.confirmed === true, {
      message: "Serve la conferma prima di aprire una sessione",
      path: ["confirmed"],
    }),
  /** One submitted line. Capped because it reaches a shell's stdin verbatim. */
  z.object({ action: z.literal("input"), input: z.string().max(4096) }),
  z.object({ action: z.literal("stop") }),
]);

/**
 * What the data browser of a database may be asked (`/api/services/[id]/browse`).
 *
 * Names here reach the engine as quoted identifiers or hex literals
 * (`lib/db-browser/sql-build.ts`), so they may contain anything a name can
 * hold except a NUL. A database is stricter, because it is also an argument
 * of the client: `psql -d` reads anything with `=` in it, or a URL, as a whole
 * connection string pointing wherever it likes.
 */
const hasControlChar = (value: string) => [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
const browseNameSchema = z
  .string()
  .min(1, "Manca il nome")
  .max(128, "Nome troppo lungo")
  .refine((value) => !value.includes("\u0000"), "Il nome contiene un carattere non valido");
const browseDatabaseSchema = z
  .string()
  .min(1, "Scegli un database")
  .max(128, "Nome del database troppo lungo")
  .refine((value) => !hasControlChar(value), "Il nome del database contiene un carattere non valido")
  .refine((value) => !value.includes("=") && !value.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), "Nome del database non valido");
const redisDatabaseSchema = z.string().regex(/^\d{1,3}$/, "Il database Redis è un numero, da 0 a 999");
const browseOffsetSchema = z.number().int().min(0).max(10_000_000).default(0);

export const browseRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tables"), database: browseDatabaseSchema }),
  z.object({
    action: z.literal("rows"),
    database: browseDatabaseSchema,
    /** PostgreSQL only; MySQL has no schemas inside a database. */
    schema: browseNameSchema.nullable().optional(),
    table: browseNameSchema,
    offset: browseOffsetSchema,
  }),
  z.object({
    action: z.literal("cell"),
    database: browseDatabaseSchema,
    schema: browseNameSchema.nullable().optional(),
    table: browseNameSchema,
    column: browseNameSchema,
    /** The row's handle from the page that showed it. */
    row: z.string().min(1).max(16_384, "Riga non valida"),
  }),
  z.object({
    action: z.literal("query"),
    database: browseDatabaseSchema,
    sql: z.string().min(1, "Scrivi una query").max(20_000, "La query è troppo lunga: al massimo 20.000 caratteri"),
    offset: browseOffsetSchema,
  }),
  z.object({ action: z.literal("keyspace") }),
  z.object({
    action: z.literal("keys"),
    database: redisDatabaseSchema,
    pattern: z.string().max(512, "Il filtro è troppo lungo").default("*"),
    cursor: z.string().regex(/^\d{1,20}$/, "Cursore non valido").default("0"),
  }),
  z.object({
    action: z.literal("key"),
    database: redisDatabaseSchema,
    /** The key's bytes, base64, as the listing sent them. */
    key: z.string().min(1).max(8_192, "Chiave troppo lunga"),
    full: z.boolean().optional(),
  }),
  z.object({ action: z.literal("collections"), database: browseDatabaseSchema }),
  z.object({
    action: z.literal("documents"),
    database: browseDatabaseSchema,
    collection: browseNameSchema,
    filter: z.string().max(10_000, "Il filtro è troppo lungo").default(""),
    sort: z.enum(["natural", "newest"]).default("natural"),
    offset: browseOffsetSchema,
  }),
  z.object({
    action: z.literal("document"),
    database: browseDatabaseSchema,
    collection: browseNameSchema,
    /** `_id` as canonical Extended JSON, from the listing. */
    id: z.string().min(1).max(2_000, "Identificativo troppo lungo"),
  }),
]);

export type BrowseRequest = z.infer<typeof browseRequestSchema>;

/**
 * A directory **on the host** that RunPanel is willing to bind into a container.
 *
 * POSIX absolute, and deliberately nothing else. A Windows path cannot survive
 * the `source:target` mapping this codebase builds — see `lib/mount.ts` for the
 * drive letter that used to become a volume name — and Postgres refuses to run
 * on one regardless, because it cannot set its data directory to 0700. Saying
 * so here is more honest than failing at `docker run`.
 *
 * Two non-empty segments is one rule that refuses `/`, `/etc`, `/var`, `/home`
 * and `/mnt` at once: every path whose whole purpose is to be somebody's
 * parent. The explicit list below is for the ones that are two levels deep and
 * still must never be handed to a container.
 *
 * The panel's own data directory cannot be checked here — `config.dataDir` is
 * server-only and this module is bundled for the browser — so
 * `services/service-mounts.ts` re-runs this schema and adds that one. It is the
 * entry that matters most: `<dataDir>/.secret` decrypts every credential the
 * panel holds.
 */
export const HOST_PATH_RULE =
  "Un percorso assoluto con almeno due livelli, es. /mnt/dati/postgres — niente \"..\"";

const FORBIDDEN_HOST_PATHS = [
  "/proc", "/sys", "/dev", "/boot", "/etc", "/bin", "/sbin", "/lib", "/lib64",
  "/usr", "/var/lib/docker", "/var/run", "/run",
] as const;

export const hostPathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });

  if (raw.includes("\0") || raw.includes("\\")) return reject(HOST_PATH_RULE);
  if (!raw.startsWith("/")) return reject(HOST_PATH_RULE);

  const segments = raw.split("/").filter(Boolean);
  if (segments.length < 2) return reject(HOST_PATH_RULE);
  if (segments.some((segment) => segment === "." || segment === "..")) return reject(HOST_PATH_RULE);

  const normalised = `/${segments.join("/")}`;

  /*
    Three relationships, not one.

    The list used to reject a path that IS a forbidden entry or sits UNDER one,
    and stopped there — so `/var/lib/docker` was refused while `/var/lib`, its
    parent, sailed through and handed the container the same directory one level
    up. An ancestor of a forbidden path is a superset of it, so it has to go too.
  */
  const forbidden = FORBIDDEN_HOST_PATHS.some(
    (bad) =>
      normalised === bad ||
      normalised.startsWith(`${bad}/`) ||
      bad.startsWith(`${normalised}/`)
  );
  if (forbidden) {
    reject(`${normalised} è o contiene una directory di sistema: non può essere montata in un container`);
  }
});

/**
 * A path **inside the container**, which is a different question and a laxer
 * one: it is the container's own filesystem, and mounting over `/etc` or
 * `/usr/share` there is a legitimate thing to want.
 *
 * One level is allowed, unlike the host side — `/data` is where half the
 * official images keep everything. What is refused is the handful that do not
 * produce a differently-configured service but a container that cannot boot:
 * the root itself, and the three kernel filesystems.
 *
 * A colon would split the `source:target` mapping in the wrong place, so it is
 * refused here rather than discovered as a mangled `docker run`.
 */
export const CONTAINER_PATH_RULE =
  "Un percorso assoluto dentro il container, es. /etc/postgresql — niente \"..\"";

const FORBIDDEN_CONTAINER_PATHS = ["/proc", "/sys", "/dev"] as const;

export const containerPathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });

  if (raw.includes("\0") || raw.includes("\\") || raw.includes(":")) {
    return reject(CONTAINER_PATH_RULE);
  }
  if (!raw.startsWith("/")) return reject(CONTAINER_PATH_RULE);

  const segments = raw.split("/").filter(Boolean);
  if (segments.length < 1) return reject(CONTAINER_PATH_RULE);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return reject(CONTAINER_PATH_RULE);
  }

  const normalised = `/${segments.join("/")}`;
  if (FORBIDDEN_CONTAINER_PATHS.some((bad) => normalised === bad || normalised.startsWith(`${bad}/`))) {
    reject(`${normalised} è un filesystem del kernel: montarci sopra impedisce al container di partire`);
  }
});

/** One bind: a folder on the host appearing at a path inside the container. */
export const serviceMountSchema = z.object({
  /** Stable across edits so a re-ordered list does not look like a new one. */
  id: z.string().min(1).max(32),
  source: hostPathSchema,
  target: containerPathSchema,
  enabled: z.boolean(),
  readOnly: z.boolean(),
});

export const serviceMountsSchema = z.object({
  /** Replace semantics: this is the whole list, not a patch. */
  mounts: z.array(serviceMountSchema).max(32),
  /**
   * The ids whose destination is already non-empty and which the operator has
   * chosen to adopt: mount them as they are and copy nothing. It is them saying
   * "those bytes are the data" — the only way a directory that already holds
   * something is ever used, and why it cannot be the default.
   */
  adopt: z.array(z.string().min(1).max(32)).max(32).optional(),
  /**
   * The ids of data-directory binds the operator agrees to give up. Switching
   * one off puts the engine back on the volume it had before, which is frozen
   * at the moment the bind was made — so the service comes up on an older
   * database while everything written since stays in the host directory.
   */
  releaseData: z.array(z.string().min(1).max(32)).max(32).optional(),
});

/**
 * A mount in the spelling a deploy contract stores: `source:target[:ro]`.
 *
 * Applied by `buildStartOpts`, where these strings become `docker run -v`
 * arguments, and **not** inside `deployContractSchema`.
 * `parseContract` falls back to the whole default contract when parsing fails,
 * so one stale mount string tightened into an error would cost a project its
 * commands, its network and its restart policy at the same time. The contract
 * stays permissive; this is where a mapping that cannot be parsed is dropped
 * before the daemon sees it — including one arriving from a restored backup or a
 * hand-edited column, which no editor ever validated.
 */
export const mountStringSchema = z.string().trim().min(3).max(8192).superRefine((raw, ctx) => {
  const parsed = parseMountString(raw);
  if (!parsed) {
    return ctx.addIssue({ code: "custom", message: "Serve la forma percorso-host:percorso-container" });
  }
  for (const [value, schema] of [
    [parsed.source, hostPathSchema],
    [parsed.target, containerPathSchema],
  ] as const) {
    const result = schema.safeParse(value);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: result.error.issues[0]?.message ?? HOST_PATH_RULE });
    }
  }
});

/** One row of a project's mount editor, before it is written back as a string. */
export const mountEntrySchema = z.object({
  source: hostPathSchema,
  target: containerPathSchema,
  readOnly: z.boolean(),
  enabled: z.boolean(),
});

export const projectMountsSchema = z.object({
  /** Replace semantics: this is the whole list. */
  mounts: z.array(mountEntrySchema).max(32),
  /**
   * Targets whose host directory is already populated and is adopted as it is.
   * Keyed by container path rather than by an id, because a contract's mounts
   * have never had one.
   */
  adopt: z.array(containerPathSchema).max(32).optional(),
});

export const deployPhaseSchema = z.enum(deployPhases);

/**
 * One command to run exactly once, at a chosen point of the next deploy.
 *
 * The 4000-character cap is the same as `shellCommand` in the deploy contract:
 * this is the same kind of value — a shell script somebody typed — and two
 * different limits for it would be two things to keep in step.
 *
 * `id` travels back on an edit so the row keeps its attempt count and the note
 * from the tentativo that failed. Without it a save would look like a delete
 * plus an insert, and a command that had already failed once would come back
 * looking untouched.
 */
export const oneTimeCommandSchema = z.object({
  id: z.string().trim().min(1).max(32).optional(),
  phase: deployPhaseSchema,
  command: z.string().trim().min(1).max(4000),
  label: z.string().trim().max(80).nullable().optional(),
  continueOnError: z.boolean(),
});

export const oneTimeCommandsSchema = z.object({
  /** Replace semantics: this is the whole queue, not a patch. */
  commands: z.array(oneTimeCommandSchema).max(50),
});

/**
 * A directory for a **native** project's checkout.
 *
 * Not `hostPathSchema`, deliberately. That one refuses a Windows path because a
 * `source:target` mapping cannot carry a drive letter — but a PM2 checkout never
 * reaches `docker run -v`. It is a directory the panel's own process reads and
 * writes, on whatever platform it is running, and refusing `D:\dati\progetti`
 * would make the feature unusable on the one the deploy pipeline goes out of its
 * way to support.
 *
 * Two levels for the same reason as the host rule: a path whose whole purpose is
 * to be somebody's parent is not a place to put a checkout.
 */
export const NATIVE_PATH_RULE =
  "Un percorso assoluto con almeno due livelli, es. /mnt/dati/progetti o D:\\dati\\progetti";

export const nativePathSchema = z.string().trim().min(2).max(4096).superRefine((raw, ctx) => {
  const reject = () => ctx.addIssue({ code: "custom", message: NATIVE_PATH_RULE });
  if (raw.includes("\0")) return reject();

  const windows = /^[A-Za-z]:[\\/]/.test(raw);
  if (!windows && !raw.startsWith("/")) return reject();

  const segments = raw.split(/[\\/]/).filter(Boolean);
  // A drive letter is not a level: `C:\dati` is one directory deep.
  const levels = windows ? segments.length - 1 : segments.length;
  if (levels < 2) return reject();
  if (segments.some((segment) => segment === "." || segment === "..")) return reject();
});

export const repoPathSchema = z.object({
  /** `null` puts it back under the panel's own data directory. */
  path: nativePathSchema.nullable(),
});

/**
 * What a deploy request may ask for.
 *
 * `commitSha` is what pins the project to one commit: the route writes it onto
 * the project row, and from then on every deploy rebuilds that commit until the
 * pin is released. It is deliberately not a branch or a tag — see
 * `commitShaSchema` for why the character set is the whole defence.
 */
export const deployRequestSchema = z.object({
  mode: z.enum(["deploy", "rebuild"]).optional(),
  commitSha: commitShaSchema.optional(),
});

/**
 * Releasing the pin, with the redeploy that almost always follows it.
 *
 * One action rather than "clear the pin" plus "now deploy": between the two
 * calls the project sits unpinned while still running the old commit, and a
 * poller tick landing in that gap would be the panel deploying on its own.
 */
export const pinActionSchema = z.object({
  action: z.literal("release"),
  deploy: z.boolean().optional(),
});

/** The commit list behind the version picker. */
export const commitsQuerySchema = z.object({
  branch: branchNameSchema.optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(20).optional(),
});

/**
 * What the panel may ask GitHub to do with a project's webhook.
 *
 * `connect` creates or realigns it, `ping` asks GitHub to send a real delivery,
 * `disconnect` deactivates it without deleting it — so the hook keeps its
 * delivery history on GitHub and turning auto-deploy back on does not have to
 * build a new one.
 */
export const webhookActionSchema = z.object({
  action: z.enum(["connect", "ping", "disconnect"]),
});

/**
 * The panel's own address, as GitHub would have to reach it.
 *
 * Rejects the same private and loopback literals a repository URL is refused
 * for, and for the closer of the two reasons: a hook pointed at `localhost` is
 * accepted by GitHub and then fails every delivery forever, which is exactly
 * the silent failure this whole feature exists to end.
 */
export const PUBLIC_URL_HINT =
  "L'indirizzo pubblico del pannello, es. https://panel.esempio.it — GitHub deve poterlo raggiungere";

export const panelPublicUrlSchema = z
  .string()
  .trim()
  .max(255)
  .superRefine((raw, ctx) => {
    // Empty clears the setting and falls back to the request headers.
    if (raw === "") return;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: PUBLIC_URL_HINT });
      return;
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: PUBLIC_URL_HINT });
      return;
    }

    if (isBlockedRepoHost(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: `GitHub non può raggiungere ${url.hostname}: è un indirizzo privato o locale`,
      });
    }
  });

/**
 * A service name is concatenated into a Docker container name and a Docker
 * volume name, so it has to be legal there. Unvalidated, a name with a space or
 * a slash passed every check here and died as a 500 carrying a raw Docker
 * error. Docker's own rule is `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; lowercase-only
 * keeps the names predictable on case-insensitive hosts.
 *
 * The message is exported so the form can render the sentence the server would.
 *
 * The two name rules here look alike enough to be mistaken for one rule stated
 * inconsistently. They are not: a service name becomes a Docker container name,
 * where hyphens are legal; a database name becomes an SQL identifier, where
 * they are not. Keeping each message next to its own regex is what stops them
 * being "reconciled" into a single wrong one.
 */
export const SERVICE_NAME_RULE = "Solo minuscole, numeri, trattini e underscore";

export const serviceNameSchema = z
  .string()
  .min(1)
  .max(38)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, SERVICE_NAME_RULE);

/**
 * A database name goes into `CREATE DATABASE "<name>"`, and an SQL identifier
 * cannot be parameterised — this regex is the whole defence against injection
 * there, not a convenience.
 */
export const DATABASE_NAME_RULE =
  "Deve iniziare con una lettera minuscola; poi solo minuscole, numeri e underscore";

export const databaseNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]*$/, DATABASE_NAME_RULE);

export const createDatabaseSchema = z.object({
  name: databaseNameSchema,
});

/**
 * Credentials chosen for a NEW service. A stored service is never checked
 * against this: its password goes on working whatever it contains, because
 * `buildConnectionString` encodes it. Empty means "generate one".
 *
 * `database` may start with a digit because the wizard sends `0` for Redis,
 * where the value is a database index and is otherwise unused.
 */
export const serviceCredentialsSchema = z.object({
  user: z
    .string()
    .regex(/^(?:[A-Za-z_][A-Za-z0-9_]{0,62})?$/, "L'utente può contenere lettere, numeri e underscore, al massimo 63 caratteri, e non può iniziare con un numero")
    .optional(),
  password: z
    .string()
    .max(128, "La password può avere al massimo 128 caratteri")
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "La password non può contenere caratteri di controllo")
    .optional(),
  database: z
    .string()
    .regex(/^[A-Za-z0-9_]{0,63}$/, "Il database può contenere lettere, numeri e underscore, al massimo 63 caratteri")
    .optional(),
});

export const createServiceSchema = z
  .object({
    name: serviceNameSchema,
    type: z.enum(["postgresql", "mysql", "redis", "mongodb"]),
    version: z.string().min(1).max(32),
    port: z.number().int().min(1).max(65535),
    projectId: z.string().optional(),
    credentials: serviceCredentialsSchema.optional(),
    /** Absent means open, which is what every service was before this existed. */
    access: accessSchema.optional(),
  })
  // Only here, on the way in. A service created before a version left the
  // catalogue has to keep opening and being recreated on the tag it has, and
  // nothing that reads a row goes through this schema. Outside the list, the
  // tag decides things the panel would have to guess: `latest` is PostgreSQL
  // 18 to the image and "pre-18" to `postgresVolumePath`, and the data goes.
  .superRefine((value, ctx) => {
    if (versionsFor(value.type).includes(value.version)) return;
    ctx.addIssue({
      code: "custom",
      path: ["version"],
      message: `Versione non disponibile. Scegli tra: ${versionsFor(value.type).join(", ")}`,
    });
  });

/**
 * An environment variable name, as a shell and a Dockerfile will accept it.
 *
 * Uppercase because every convention around connection strings is, and because
 * a lowercase twin of an existing key is the kind of difference nobody sees in
 * a list. Rejecting the leading digit is not style: `2_URL` is not a legal
 * identifier for `export`.
 */
export const envKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Solo maiuscole, numeri e underscore, e deve iniziare con una lettera");

/**
 * What can be changed about a service after it exists.
 *
 * There was no PATCH at all, so `project_id` was fixed at creation: detaching a
 * database from a project meant deleting the service, and deleting a service
 * offers to delete its data. Every field here is optional and absent means
 * unchanged — `projectId: null` is the explicit detach.
 */
export const updateServiceSchema = z.object({
  /**
   * What the panel calls it. The technical name stays; the container follows
   * this one at the next deploy of the project it belongs to. Empty or null
   * goes back to showing the technical name.
   */
  displayName: z
    .string()
    .trim()
    .max(MAX_DISPLAY_NAME, `Al massimo ${MAX_DISPLAY_NAME} caratteri`)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Il nome non può contenere caratteri di controllo")
    .nullable()
    .optional(),
  projectId: z.string().min(1).max(32).nullable().optional(),
  injectEnv: z.boolean().optional(),
  /** Empty means no scheduled restart. Interpreted in the panel's `timezone`. */
  restartCron: restartCronSchema.optional(),
  envKey: envKeySchema.nullable().optional(),
  access: accessSchema.optional(),
  /**
   * Where the Overview files it while it belongs to no project. Ignored — and
   * cleared — when the same request links it to one.
   */
  folderId: folderIdSchema.optional(),
});

// --- Backups ---

/**
 * A backup or restore id reaches the filesystem three times: its log, its
 * archive and its download. This is the check that stops `../../etc/passwd`
 * from becoming a path, so it runs *before* anything is joined — not after.
 */
export const backupIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificativo non valido");

/** Which parts of a project an archive should carry. */
export const projectIncludeSchema = z.enum(["config", "volumes", "repo"]);

/**
 * A target is a selector evaluated when the run starts, not a fixed id — which
 * is what lets `all-services` include the database you create tomorrow.
 */
export const backupTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("service"),
    id: z.string().min(1).max(32),
    /** Omitted means every database on that server. */
    databases: z.array(databaseNameSchema).max(100).optional(),
  }),
  z.object({ kind: z.literal("all-services") }),
  z.object({
    kind: z.literal("project"),
    id: z.string().min(1).max(32),
    include: z.array(projectIncludeSchema).min(1),
  }),
  z.object({
    kind: z.literal("all-projects"),
    include: z.array(projectIncludeSchema).min(1),
  }),
  z.object({ kind: z.literal("panel") }),
]);

/**
 * How one project's volumes are backed up. Saved from the project's settings,
 * read by every policy that includes the project with its volumes.
 */
export const projectBackupSettingsSchema = z.object({
  consistency: z.enum(["pause", "live"]),
  preBackup: z
    .object({
      service: z
        .string()
        .min(1)
        .max(64)
        .regex(COMPOSE_SERVICE_PATTERN, "Nome di servizio Compose non valido"),
      command: z.string().trim().min(1, "Scrivi il comando da eseguire").max(4000),
      timeoutSec: z.number().int().min(5).max(MAX_PRE_BACKUP_TIMEOUT_SEC),
    })
    .nullable(),
  /** Per volume, by its Docker name. Stored normalised: `./trades/` arrives, `trades` is kept. */
  excludes: z
    .record(
      z.string().max(255).regex(VOLUME_NAME_PATTERN, "Nome di volume non valido"),
      z
        .array(
          z
            .string()
            .max(255)
            .refine((path) => normalizeExcludePath(path) !== null, { message: EXCLUDE_PATH_RULE })
            .transform((path) => normalizeExcludePath(path) as string)
        )
        .max(MAX_EXCLUDES_PER_VOLUME, `Al massimo ${MAX_EXCLUDES_PER_VOLUME} percorsi per volume`)
    )
    .default({}),
});

/**
 * The expression is checked by the real parser, not by a regex that agrees with
 * it on a good day: the schedule the form accepts and the schedule the tick
 * loop runs have to be the same schedule.
 */
export const cronExpressionSchema = z.string().max(120).superRefine((value, ctx) => {
  const parsed = parseCron(value);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
});

/** A zone the runtime cannot resolve would silently become UTC at tick time. */
export const timeZoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimeZone, "Fuso orario sconosciuto");

/**
 * How many archives one destination of a policy keeps, in place of the
 * policy's rule. Every field null or absent: all of them. The bounds are the
 * policy's own.
 */
export const copyRetentionSchema = z
  .object({
    count: z.number().int().min(1).max(1000).nullable().optional(),
    days: z.number().int().min(1).max(3650).nullable().optional(),
    bytes: z.number().int().min(1024 * 1024).nullable().optional(),
  })
  .strict();

/** One destination of a policy, in order: the first is the primary. */
export const policyDestinationSchema = z
  .object({
    destinationId: z.string().min(1).max(32),
    /** Null or absent: the policy's own rule. */
    retention: copyRetentionSchema.nullable().optional(),
  })
  .strict();

export const backupPolicySchema = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  /** Empty means the policy exists but only ever runs when someone asks. */
  cron: z.union([z.literal(""), cronExpressionSchema]),
  timezone: timeZoneSchema.nullable().optional(),
  /**
   * The primary destination. Required on create unless `destinations` is
   * given (the route checks): with both, it has to be their first.
   */
  destinationId: z.string().min(1).max(32).optional(),
  /** Every destination, in order: each receives a copy of the same archive. */
  destinations: z.array(policyDestinationSchema).min(1).max(MAX_COPIES).optional(),
  targets: z.array(backupTargetSchema).min(1).max(200),
  retentionCount: z.number().int().min(1).max(1000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** A cap below a megabyte would delete every archive as soon as it appeared. */
  retentionBytes: z.number().int().min(1024 * 1024).nullable().optional(),
  includeSecretKey: z.boolean().optional(),
});

export const updateBackupPolicySchema = backupPolicySchema.partial();

export const cronPreviewSchema = z.object({
  cron: cronExpressionSchema,
  timezone: timeZoneSchema.optional(),
  count: z.number().int().min(1).max(10).optional(),
});

/**
 * A project's scheduled task — see `services/tasks/`.
 *
 * The command has the 4000-character cap of every other command field, for
 * the reason `oneTimeCommandSchema` gives. `service` is the Compose service the
 * command runs in, required by the route for a Compose project and refused
 * for any other: a name the stack does not have is caught when the task runs,
 * since a stack can be down while it is being edited.
 */
const TIMEOUT_RANGE = `Il tempo massimo va da ${TASK_TIMEOUT_MIN_SEC} secondi a 24 ore`;

const NO_NUL = (value: string) => !value.includes("\u0000");

export const taskSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Dai un nome all'attività")
    .max(TASK_NAME_MAX, `Il nome può avere al massimo ${TASK_NAME_MAX} caratteri`)
    .refine(NO_NUL, "Il nome contiene un carattere non valido"),
  command: z
    .string()
    .trim()
    .min(1, "Scrivi il comando da eseguire")
    .max(TASK_COMMAND_MAX, `Il comando può avere al massimo ${TASK_COMMAND_MAX} caratteri`)
    .refine(NO_NUL, "Il comando contiene un carattere non valido")
    // Only comments would run nothing, and the run would "succeed".
    .refine(hasRunnableLine, "Il comando contiene solo commenti: scrivi almeno una riga da eseguire"),
  /** '' = only when somebody presses "Esegui ora". */
  cron: z.union([z.literal(""), cronExpressionSchema]),
  timezone: timeZoneSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  timeoutSec: z
    .number(TIMEOUT_RANGE)
    .int(TIMEOUT_RANGE)
    .min(TASK_TIMEOUT_MIN_SEC, TIMEOUT_RANGE)
    .max(TASK_TIMEOUT_MAX_SEC, TIMEOUT_RANGE)
    .optional(),
  service: z
    .string()
    .trim()
    .max(63, "Il nome del servizio può avere al massimo 63 caratteri")
    .regex(COMPOSE_SERVICE_PATTERN, "Il servizio dello stack: lettere, numeri, punti, trattini e underscore")
    .nullable()
    .optional(),
});

export const taskUpdateSchema = taskSchema.partial();

/** Every transport; adding one means adding it here too, and its schemas below. */
export const destinationTypes = ["local", "s3", "telegram", "sftp", "webdav", "rclone", "peer"] as const;

/**
 * An S3-compatible destination's configuration.
 *
 * Validated here rather than trusted from the form, because it is stored
 * encrypted and read back at 03:00 by a scheduler nobody is watching: a typo in
 * the endpoint has to be a 400 now, not a failed backup six hours from now.
 */
export const s3ConfigSchema = z.object({
  /**
   * HTTPS towards the internet; plain HTTP allowed only towards a private
   * address.
   *
   * "Always https" was the first rule here and it was wrong in the most common
   * self-hosted case: a MinIO on the LAN, or on the same host, reached over
   * http. SigV4 never puts the secret key on the wire — but with
   * UNSIGNED-PAYLOAD it is TLS that protects the archive itself, and an archive
   * carries every environment variable the panel holds. Over the internet that
   * is not negotiable; inside a private network it is the operator's own wire.
   *
   * `isBlockedRepoHost` is reused deliberately, for the opposite purpose: the
   * set of hosts a clone must never reach is exactly the set where http is
   * acceptable here, and having one definition of "private" is what stops the
   * two drifting apart.
   */
  endpoint: z
    .string()
    .url()
    .refine(
      (raw) => {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return false;
        }
        if (url.protocol === "https:") return true;
        return url.protocol === "http:" && isBlockedRepoHost(url.hostname);
      },
      { message: "Serve https://, oppure http:// verso un indirizzo privato" }
    ),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(255),
  secretAccessKey: z.string().min(1).max(255),
  prefix: z.string().max(255).optional(),
  forcePathStyle: z.boolean().optional(),
});

// --- The remote destinations: SFTP, WebDAV, rclone ------------------------------
//
// Two schemas each. The *input* is what the form may send — every field
// optional, unknown fields refused — and is merged over the stored config on
// an edit. The *config* is what gets stored, validated whole after the merge
// (services/backup/destinations/kinds.ts does both), so half a configuration
// is a 400 now and never a failed backup at 03:00.

/** A remote folder: no `.` or `..`, no control characters; tidied as it is stored. */
function remoteFolder(allowAbsolute: boolean) {
  return z
    .string()
    .max(MAX_REMOTE_FOLDER)
    .superRefine((value, ctx) => {
      const problem = remoteFolderProblem(value, { allowAbsolute });
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((value) => normalizeRemoteFolder(value, { allowAbsolute }));
}

/**
 * HTTPS, or HTTP towards a private address — the rule and the reasons of
 * `s3ConfigSchema.endpoint` — and without credentials, a query or a fragment
 * in it: the user and the password have their fields, and a `?` would be
 * sent with every request.
 */
const remoteHttpUrl = z
  .string()
  .max(2048)
  .url("Scrivi l'indirizzo per intero, con https:// davanti")
  .superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && isBlockedRepoHost(url.hostname)))) {
      ctx.addIssue({ code: "custom", message: "Serve https://, oppure http:// verso un indirizzo privato" });
    }
    if (url.username || url.password) ctx.addIssue({ code: "custom", message: "Scrivi utente e password nei loro campi, non nell'indirizzo" });
    if (url.search || url.hash) ctx.addIssue({ code: "custom", message: "L'indirizzo non può contenere ? o #" });
  });

const sshHost = z
  .string()
  .max(253)
  .transform(normalizeSshHost)
  .superRefine((value, ctx) => {
    const problem = sshHostProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const sshUser = z
  .string()
  .max(64)
  .transform((value) => value.trim())
  .superRefine((value, ctx) => {
    const problem = sshUserProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const sshPort = z.number("La porta è un numero").int("La porta è un numero").min(1, "Porta da 1 a 65535").max(65535, "Porta da 1 a 65535");

/** An SFTP destination as stored: the key pair is the panel's own (POST …/ssh-key). */
export const sftpConfigSchema = z.object({
  host: sshHost,
  port: sshPort,
  username: sshUser,
  folder: remoteFolder(true).default(DEFAULT_REMOTE_FOLDER),
  privateKey: z
    .string()
    .max(16 * 1024)
    .refine((value) => value.includes("-----BEGIN OPENSSH PRIVATE KEY-----"), "Genera la chiave della destinazione"),
  publicKey: z.string().max(4096).optional(),
  /** Pinned on first use; null until then. */
  hostKey: z.string().regex(SSH_HOST_KEY_PATTERN, "Chiave del server non valida").nullable().optional(),
});

export const sftpConfigInput = z
  .object({
    host: z.string().max(253).optional(),
    port: z.number().int().optional(),
    username: z.string().max(64).optional(),
    folder: z.string().max(MAX_REMOTE_FOLDER).optional(),
    /** The pair from POST /api/backups/destinations/ssh-key, sealed: the private half never travels in clear. */
    keyToken: z.string().max(8192).optional(),
    /** The host key "Verifica" learned; "" forgets the pinned one, so the next check learns it again. */
    hostKey: z.string().max(4096).optional(),
  })
  .strict();

export const webdavConfigSchema = z.object({
  url: remoteHttpUrl,
  username: z.string().trim().min(1, "Scrivi il nome utente").max(256),
  password: z.string().min(1, "Scrivi la password").max(1024),
  folder: remoteFolder(false).default(DEFAULT_REMOTE_FOLDER),
});

export const webdavConfigInput = z
  .object({
    url: z.string().max(2048).optional(),
    username: z.string().max(256).optional(),
    /** Empty or absent: keep the stored one. */
    password: z.string().max(1024).optional(),
    folder: z.string().max(MAX_REMOTE_FOLDER).optional(),
  })
  .strict();

export const rcloneConfigSchema = z
  .object({
    provider: z.enum(RCLONE_PROVIDERS),
    token: z.string().max(16 * 1024).optional(),
    driveId: z.string().max(256).optional(),
    driveType: z.enum(["personal", "business", "documentLibrary"]).optional(),
    sections: z.string().max(64 * 1024).optional(),
    remote: z.string().regex(RCLONE_REMOTE_PATTERN, "Nome di remote non valido").optional(),
    folder: remoteFolder(true).default(DEFAULT_REMOTE_FOLDER),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "expert") {
      const parsed = parseRcloneSections(value.sections ?? "");
      if ("error" in parsed) {
        ctx.addIssue({ code: "custom", message: parsed.error, path: ["sections"] });
      } else if (value.remote && !parsed.sections.some((section) => section.name === value.remote)) {
        ctx.addIssue({ code: "custom", message: `Il remote «${value.remote}» non è tra quelli incollati`, path: ["remote"] });
      }
      return;
    }
    const token = parseRcloneToken(value.token ?? "");
    if ("error" in token) ctx.addIssue({ code: "custom", message: token.error, path: ["token"] });
    if (value.provider === "onedrive" && (!value.driveId || !value.driveType)) {
      ctx.addIssue({ code: "custom", message: "Manca l'unità OneDrive: incolla di nuovo il token", path: ["driveId"] });
    }
  });

export const rcloneConfigInput = z
  .object({
    provider: z.enum(RCLONE_PROVIDERS).optional(),
    /** Empty or absent: keep the stored one. */
    token: z.string().max(16 * 1024).optional(),
    /** Empty or absent: keep the stored one. */
    sections: z.string().max(64 * 1024).optional(),
    remote: z.string().max(64).optional(),
    folder: z.string().max(MAX_REMOTE_FOLDER).optional(),
  })
  .strict();

/**
 * A linked RunPanel server of the cluster as a destination: which one. Its
 * name is kept beside the id — what the messages call it once it is no
 * longer linked — and filled in on the server, never taken from the form.
 * Whether the id is a member, and not this server, is checked there too
 * (kinds.ts): it takes the store.
 */
const peerMemberId = z.string().trim().refine(isPeerMemberId, "Scegli uno dei server collegati");

export const peerConfigSchema = z.object({
  memberId: peerMemberId,
  memberName: z.string().max(120).optional(),
});

export const peerConfigInput = z
  .object({
    memberId: z.string().max(64).optional(),
  })
  .strict();

/**
 * How much room this server gives another one's copies: bytes, null for no
 * limit of its own (the disk keeps its reserve all the same), 0 to refuse
 * new ones. Copies already kept stay, over the limit or not.
 */
export const peerQuotaSchema = z
  .object({
    quotaBytes: z
      .number("Il limite è un numero di byte")
      .int("Il limite è un numero intero di byte")
      .min(0, "Il limite non può essere negativo")
      .max(PEER_MAX_QUOTA_BYTES, "Il limite è troppo grande")
      .nullable(),
  })
  .strict();

/** What the form may send for an S3 destination; merged over the stored config on an edit. */
export const s3ConfigInput = z
  .object({
    endpoint: z.string().max(2048).optional(),
    region: z.string().max(64).optional(),
    bucket: z.string().max(255).optional(),
    accessKeyId: z.string().max(255).optional(),
    /** Empty or absent: keep the stored one. */
    secretAccessKey: z.string().max(255).optional(),
    prefix: z.string().max(255).optional(),
    forcePathStyle: z.boolean().optional(),
  })
  .strict();

/** The input schema of each type that has a configuration. */
export const destinationConfigInputs = {
  s3: s3ConfigInput,
  sftp: sftpConfigInput,
  webdav: webdavConfigInput,
  rclone: rcloneConfigInput,
  peer: peerConfigInput,
} as const;


/**
 * Logging in to Telegram for a backup destination: the account's own api_id
 * and api_hash from my.telegram.org — Telegram's terms want every app to use
 * its own, so the panel ships none — and how: a QR code to scan from the app,
 * or the phone number. Re-linking a destination (owner only) may leave the
 * keys out to keep the stored ones.
 */
export const telegramLoginStartSchema = z
  .object({
    apiId: z.coerce
      .number({ message: "L'api_id è un numero" })
      .int("L'api_id è un numero intero")
      .min(1, "L'api_id è un numero")
      .max(2_147_483_647, "L'api_id non è valido")
      .optional(),
    apiHash: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{32}$/, "L'api_hash è lungo 32 caratteri: cifre e lettere da a a f")
      .optional(),
    method: z.enum(["qr", "phone"]),
    phone: z
      .string()
      .trim()
      .max(32)
      .regex(/^\+?[0-9][0-9 ()-]{5,30}$/, "Scrivi il numero con il prefisso internazionale, per esempio +39 333 123 4567")
      .optional(),
    destinationId: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => value.method !== "phone" || Boolean(value.phone), {
    message: "Scrivi il numero di telefono",
    path: ["phone"],
  })
  .refine((value) => Boolean(value.destinationId) || (value.apiId !== undefined && value.apiHash !== undefined), {
    message: "Servono api_id e api_hash",
    path: ["apiId"],
  });

/** One step of a Telegram login: the code from the phone, or the account's two-step password. */
export const telegramLoginStepSchema = z
  .object({
    code: z.string().trim().regex(/^[0-9]{4,10}$/, "Il codice è fatto di sole cifre").optional(),
    password: z.string().min(1, "Scrivi la password").max(256).optional(),
  })
  .strict()
  .refine((value) => (value.code === undefined) !== (value.password === undefined), {
    message: "Manda il codice oppure la password",
    path: ["code"],
  });

/**
 * A Telegram destination as the form creates it. No session here: `loginId`
 * names a finished login, whose session the server reads from its own memory
 * into the encrypted config, so it never passes through the browser.
 */
export const telegramDestinationConfigSchema = z
  .object({
    loginId: z.string().min(16).max(64),
    /** A private channel the panel creates, or the account's Saved Messages. */
    chat: z.enum(["channel", "saved"]),
    channelTitle: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/**
 * A local destination's configuration: nothing, for the panel's own archive
 * folder, or a folder of its own — a second disk, a mounted NAS — so two local
 * destinations can be two copies. Absolute, since a relative path would be
 * relative to wherever the panel happened to start; whether it is outside the
 * panel's data directory, and writable, is checked on the server.
 */
export const LOCAL_PATH_RULE = "Scrivi il percorso completo di una cartella, per esempio /mnt/backup";

export const localConfigSchema = z
  .object({
    path: z
      .string()
      .trim()
      .max(1024)
      .refine((value) => value === "" || /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value), { message: LOCAL_PATH_RULE })
      .refine((value) => !value.includes("\u0000"), { message: LOCAL_PATH_RULE })
      .optional(),
  })
  .strict();

export const destinationSchema = z
  .object({
    name: z.string().min(1).max(60),
    type: z.enum(destinationTypes),
    config: z.record(z.string(), z.unknown()).optional(),
    isDefault: z.boolean().optional(),
  })
  // `local` needs no configuration beyond an optional folder; `s3` needs all
  // of it, and half a configuration is worse than none — it would be
  // accepted, encrypted, and then fail on first use.
  .refine((value) => value.type !== "s3" || s3ConfigSchema.safeParse(value.config ?? {}).success, {
    message: "Configurazione S3 incompleta o non valida",
    path: ["config"],
  })
  .refine((value) => value.type !== "local" || localConfigSchema.safeParse(value.config ?? {}).success, {
    message: LOCAL_PATH_RULE,
    path: ["config"],
  })
  // Telegram takes a finished login, never a session: see the schema above.
  .refine((value) => value.type !== "telegram" || telegramDestinationConfigSchema.safeParse(value.config ?? {}).success, {
    message: "Collega l'account Telegram e scegli dove salvare",
    path: ["config"],
  })
  // The other remote types: the shape here, the whole once the route has
  // unsealed the key or looked up the drive (kinds.ts).
  .refine(
    (value) => {
      if (value.type === "local" || value.type === "s3" || value.type === "telegram") return true;
      return destinationConfigInputs[value.type].safeParse(value.config ?? {}).success;
    },
    { message: "Configurazione non valida", path: ["config"] }
  );

/**
 * Editing a destination. The type is not here on purpose: an archive's path
 * means one thing on a disk and another in a bucket, so a destination that
 * changed type would point every archive it holds at nothing. `config` is
 * checked against the input schema of the destination's own type, merged over
 * the stored one and validated whole (`s3ConfigSchema` for S3), so an empty
 * secret keeps the stored secret instead of erasing it.
 */
export const destinationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    // Every type's fields, each optional: the route then checks the ones of the
    // destination's own type strictly (`s3ConfigInput`, the remote inputs in
    // kinds.ts), so a field of another type is still a 400.
    config: z
      .object({
        ...s3ConfigInput.shape,
        ...sftpConfigInput.shape,
        ...rcloneConfigInput.shape,
        // After SFTP's: a WebDAV user name may be longer.
        ...webdavConfigInput.shape,
        ...peerConfigInput.shape,
        /** Telegram: a finished login whose account replaces the linked one. */
        loginId: z.string().min(16).max(64).optional(),
        /** Telegram, only to try a destination before creating it: where it would save. */
        chat: z.enum(["channel", "saved"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * A backup now, outside any schedule: what to save, and optionally where and
 * under what name. `destinationIds` asks for a copy on each, in order; with
 * neither field, the one default destination.
 */
export const manualBackupSchema = z
  .object({
    targets: z.array(backupTargetSchema).min(1).max(50),
    destinationId: z.string().min(1).max(32).optional(),
    destinationIds: z.array(z.string().min(1).max(32)).min(1).max(MAX_COPIES).optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** Announcing an archive about to be uploaded in pieces. */
export const backupUploadSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    /** A terabyte: past that a typo, not a backup. Free space is checked too. */
    bytes: z.number().int().positive().max(1024 ** 4),
  })
  .strict();

export const destinationDefaultSchema = z
  .object({
    /** Point every existing policy at it too, not only the ones created from now on. */
    movePolicies: z.boolean().optional(),
  })
  .strict();

/**
 * The backup password, as it is set: the rules of lib/backup-password.ts, so
 * the form and the route refuse the same things with the same sentence.
 */
export const backupEncryptionSchema = z
  .object({
    password: z.string().superRefine((value, ctx) => {
      const problem = backupPasswordProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  })
  .strict();

/**
 * A password typed to be tried, not set: against the one in use, an uploaded
 * archive, or a run whose password this panel does not have. Only bounded —
 * an archive from another server may have been sealed under other rules.
 */
export const backupPasswordAttemptSchema = z
  .object({ password: z.string().min(1, "Scrivi la password").max(MAX_BACKUP_PASSWORD) })
  .strict();

/**
 * A restore request.
 *
 * `confirm` carries what the operator typed. It is checked in the browser too,
 * but the check that counts is the one that cannot be skipped by posting
 * directly, and this is the only operation in the panel that can destroy
 * production data.
 */
export const restoreRequestSchema = z
  .object({
    runId: backupIdSchema.optional(),
    uploadId: backupIdSchema.optional(),
    targets: z
      .array(
        z.object({
          artifactId: z.string().min(1).max(64),
          action: z.enum(["restore", "skip"]),
          targetId: z.string().min(1).max(32).optional(),
          targetDatabase: databaseNameSchema.optional(),
        })
      )
      .min(1)
      .max(200),
    /** Off unless the operator went out of their way. */
    skipSafetyBackup: z.boolean().optional(),
    confirm: z.string().min(1).max(200),
    /** For a run encrypted with a password this panel no longer has. */
    password: z.string().min(1).max(MAX_BACKUP_PASSWORD).optional(),
  })
  .refine((value) => Boolean(value.runId) !== Boolean(value.uploadId), {
    message: "Indica una run del catalogo oppure un archivio caricato, non entrambi",
    path: ["runId"],
  })
  .refine((value) => value.targets.some((target) => target.action === "restore"), {
    message: "Nessun elemento selezionato per il ripristino",
    path: ["targets"],
  });

// --- Autostart ---

export const autostartEntrySchema = z.object({
  kind: z.enum(["project", "service"]),
  id: z.string().min(1).max(32),
  autostart: z.boolean(),
  order: z.number().int().min(0).max(9999).optional(),
  /** Capped low: a boot that pauses for ten minutes reads as a hung boot. */
  delaySeconds: z.number().int().min(0).max(600).optional(),
  waitHealthy: z.boolean().optional(),
});

export const autostartUpdateSchema = z.object({
  entries: z.array(autostartEntrySchema).min(1).max(500),
});

export const autostartInstallSchema = z.object({
  action: z.enum(["install", "uninstall", "preview"]),
  /** Left out means "whatever the probe decided this host should use". */
  method: z.enum(["systemd", "cron"]).optional(),
});

export const autostartFixSchema = z.object({
  fix: z.enum(["docker-enable", "pm2-save", "restart-policy"]),
  /** Only meaningful for `restart-policy`. */
  target: z.object({ kind: z.enum(["project", "service"]), id: z.string().min(1).max(32) }).optional(),
});

// --- Domains ---

export const DOMAIN_RULE = "Un dominio come esempio.it: lettere, numeri e trattini, senza http:// né *";
export const SUBDOMAIN_RULE = "Una sola parola: minuscole, numeri e trattini, es. app. Vuoto per il dominio intero";

/** Canonicalised on the way in, so `Esempio.IT.` and `esempio.it` are the same row. */
export const domainNameSchema = z
  .string()
  .max(260)
  .transform((raw, ctx) => {
    const name = normalizeDomain(raw);
    if (name === null) {
      ctx.addIssue({ code: "custom", message: DOMAIN_RULE });
      return z.NEVER;
    }
    return name;
  });

export const subdomainSchema = z
  .string()
  .max(70)
  .transform((raw, ctx) => {
    const label = normalizeSubdomain(raw);
    if (label === null) {
      ctx.addIssue({ code: "custom", message: SUBDOMAIN_RULE });
      return z.NEVER;
    }
    return label;
  });

export const createDomainSchema = z.object({ name: domainNameSchema });

export const createHostSchema = z.object({
  domainId: z.string().min(1).max(32),
  subdomain: subdomainSchema,
  publicAccess: z.boolean().optional(),
  /** Also the `www.` twin (or, for `www`, the domain itself), redirecting to this name. */
  www: z.boolean().optional(),
});

export const HOST_USER_RULE = "Lettere, numeri e . _ @ -, fino a 64 caratteri";
export const HOST_PASSWORD_MIN = 8;

/** The password nginx asks for in front of a name. The user lands in an htpasswd line: no colon, no newline. */
export const hostAuthSchema = z.object({
  user: z.string().trim().regex(/^[A-Za-z0-9._@-]{1,64}$/, HOST_USER_RULE),
  password: z.string().min(HOST_PASSWORD_MIN, `Almeno ${HOST_PASSWORD_MIN} caratteri`).max(128, "Al massimo 128 caratteri"),
});

/** Any of them; `auth: null` takes the password away, `www: false` the twin that redirects here. */
export const updateHostSchema = z
  .object({ publicAccess: z.boolean().optional(), auth: hostAuthSchema.nullable().optional(), www: z.boolean().optional() })
  .refine((body) => body.publicAccess !== undefined || body.auth !== undefined || body.www !== undefined, {
    message: "Niente da cambiare",
  });

export const hostActionSchema = z.object({ action: z.literal("retry") });

export const proxyActionSchema = z.object({ action: z.enum(["setup", "apply"]) });

/**
 * The panel's own HTTPS name: a domain of the panel and the label under it, or
 * a name typed whole for a domain the panel does not manage. Both canonical
 * on the way in, like a project's name.
 */
export const panelHostnameSchema = z
  .object({
    domainId: z.string().min(1).max(32).optional(),
    subdomain: subdomainSchema.optional(),
    hostname: domainNameSchema.optional(),
  })
  .strict()
  .refine((body) => (body.hostname !== undefined) !== (body.domainId !== undefined && body.subdomain !== undefined), {
    message: "Scegli un dominio e il nome sotto di esso, oppure scrivi l'indirizzo intero",
  });

/** The one word in front of an instant address: `app` in `app.203-0-113-7.sslip.io`. */
export const instantHostSchema = z.object({
  label: subdomainSchema.refine((label) => label !== "", { message: "Scegli un nome, per esempio app" }),
});

/**
 * A Cloudflare API token, as pasted. It only ever travels as a bearer header and
 * through the environment of certbot's hook — never a command line — but it is
 * kept to printable ASCII so a stray newline cannot split either.
 */
export const cloudflareTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "Il token sembra troncato: copialo intero")
    .max(512)
    .regex(/^[\x21-\x7e]+$/, "Incolla solo il token, senza spazi"),
});

/**
 * The Let's Encrypt account's contact. Optional — it no longer sends expiry
 * emails — and handed to certbot as one argv entry: the leading-dash rule is so
 * it can never read as a flag.
 */
export const acmeEmailSchema = z.object({
  acmeEmail: z
    .string()
    .trim()
    .max(254)
    .refine((value) => value === "" || /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/.test(value), {
      message: "Un indirizzo email valido, o vuoto",
    }),
});

/**
 * The first problem with a variables body, as a sentence that names the variable.
 *
 * "Dati non validi" left the operator to find which of forty rows was wrong;
 * this says `«1API»: Nome non valido…`, or which value is too long.
 */
export function envVarsIssueText(body: unknown, issues: readonly { path: PropertyKey[]; message: string; code?: string }[]): string {
  const issue = issues[0];
  if (!issue) return "Dati non validi";
  const [root, index, field] = issue.path;
  if (root === "vars" && typeof index === "number") {
    const rows = (body as { vars?: { key?: unknown }[] } | null)?.vars;
    const key = Array.isArray(rows) && typeof rows[index]?.key === "string" ? rows[index].key : null;
    const name = key ? `«${key}»` : `La variabile ${index + 1}`;
    if (field === "value") return `${name}: il valore è troppo lungo (massimo 64 KB)`;
    if (field === "key" && issue.code === "too_small") return `La variabile ${index + 1} non ha un nome`;
    if (field === "key" && issue.code === "too_big") return `${name}: il nome è troppo lungo (massimo 64 caratteri)`;
    return `${name}: ${issue.message}`;
  }
  if (root === "vars" && issue.code === "too_big") return "Troppe variabili: il massimo è 500";
  return issue.message || "Dati non validi";
}

// --- App catalogue ---

/**
 * Installing an app of the catalogue.
 *
 * Only the shape is bounded here. What each answer may be depends on the
 * template that asks it, so `validateAnswers` in lib/app-catalog checks them
 * once this lets them through; this is what keeps a megabyte, or a nested
 * object, from ever reaching it.
 */
export const catalogInstallSchema = z.object({
  templateId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "Modello non valido"),
  name: z.string().trim().min(1, "Serve un nome").max(100, "Il nome può avere al massimo 100 caratteri"),
  /** Left out: the server picks a free one. */
  port: z.number().int().min(1024, "Una porta tra 1024 e 65535").max(65535, "Una porta tra 1024 e 65535").optional(),
  answers: z
    .record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]))
    .refine((answers) => Object.keys(answers).length <= 50, "Troppe risposte")
    .optional(),
  address: z.object({ domainId: z.string().min(1).max(32), subdomain: subdomainSchema }).nullable().optional(),
  /** The server's name as the person reaches it; checked again where it is used. */
  publicHost: z.string().trim().max(253).optional(),
});

/**
 * The public status page — see `lib/status-page.ts`.
 *
 * Every field optional: what is sent replaces what is stored and the rest
 * stays, so an API client switches the page on with `{ enabled: true }`.
 * `projects`, when sent, is the whole list in the order the page shows it.
 * Text is normalised here (one line for names and the title, no invisible
 * characters anywhere) so what is stored is what was checked. Whether each
 * project exists is the route's question: it needs the store.
 */
const statusPageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Identificativo non valido");

const statusPageNameSchema = z
  .string()
  .max(PUBLIC_NAME_MAX * 4)
  .transform((raw, ctx) => {
    const name = cleanLine(raw, Number.MAX_SAFE_INTEGER);
    if (!name) ctx.addIssue({ code: "custom", message: "Ogni progetto sulla pagina ha bisogno di un nome" });
    else if (name.length > PUBLIC_NAME_MAX) ctx.addIssue({ code: "custom", message: `Un nome può avere al massimo ${PUBLIC_NAME_MAX} caratteri` });
    return name;
  });

export const statusPageSchema = z
  .object({
    enabled: z.boolean().optional(),
    slug: z.string().trim().toLowerCase().min(SLUG_MIN, SLUG_RULE).max(SLUG_MAX, SLUG_RULE).regex(SLUG_PATTERN, SLUG_RULE).optional(),
    title: z
      .string()
      .max(TITLE_MAX * 4)
      .transform((raw, ctx) => {
        const title = cleanLine(raw, Number.MAX_SAFE_INTEGER);
        if (!title) ctx.addIssue({ code: "custom", message: "Dai un titolo alla pagina" });
        else if (title.length > TITLE_MAX) ctx.addIssue({ code: "custom", message: `Il titolo può avere al massimo ${TITLE_MAX} caratteri` });
        return title;
      })
      .optional(),
    message: z
      .string()
      .max(MESSAGE_MAX * 4)
      .transform((raw, ctx) => {
        const message = cleanText(raw, Number.MAX_SAFE_INTEGER);
        if (message.length > MESSAGE_MAX) ctx.addIssue({ code: "custom", message: `Il messaggio può avere al massimo ${MESSAGE_MAX} caratteri` });
        return message;
      })
      .optional(),
    allowIndexing: z.boolean().optional(),
    projects: z
      .array(
        z
          .object({
            /** The member of the cluster holding it; null or absent for this server. */
            server: statusPageIdSchema.nullable().optional(),
            projectId: statusPageIdSchema,
            name: statusPageNameSchema,
          })
          .strict()
      )
      .max(MAX_PAGE_PROJECTS, `Al massimo ${MAX_PAGE_PROJECTS} progetti sulla pagina`)
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          const key = entryKey({ server: entry.server ?? null, projectId: entry.projectId });
          if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "projectId"], message: "Lo stesso progetto compare due volte" });
          seen.add(key);
        });
      })
      .optional(),
  })
  .strict();

export type StatusPageInput = z.infer<typeof statusPageSchema>;
