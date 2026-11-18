/**
 * How a value reaches a process inside a container without appearing on a
 * command line.
 *
 * `/proc/<pid>/cmdline` is readable by every local user, with no privilege at
 * all, so anything on the docker client's argv is public for as long as the call
 * lasts: a dump can take minutes. So `-e` carries the name alone and the value
 * travels in the environment of the docker process, whose `/proc/<pid>/environ`
 * only its owner can read; Docker copies it from there.
 *
 * **Whatever is given to `execArgs` or `envFlags` has to be passed as `env` to
 * the docker call too.** Without it the variable arrives unset, and the engine
 * answers with an authentication error. Hence the shape every caller uses:
 *
 *   const env = { PGPASSWORD: password };
 *   await docker([...execArgs(target, env), "psql"], { env });
 *
 * Pure on purpose: `backup-secrets-unit` reads the argv built here.
 */

export interface ServiceTarget {
  containerName: string;
  credentials: { user: string; password: string; database: string };
}

/** `-e NAME` for each key. Never the value: see the module header. */
export function envFlags(env: Record<string, string>): string[] {
  return Object.keys(env).flatMap((key) => ["-e", key]);
}

export function execArgs(
  target: Pick<ServiceTarget, "containerName">,
  env: Record<string, string>,
  opts: { interactive?: boolean } = {}
): string[] {
  const args = ["exec"];
  // Only for a session that keeps reading: every one-shot caller here runs a
  // command and wants its stdin closed. Never `-t` — with piped stdio Docker
  // refuses to allocate a TTY at all, which is why the console has to pass the
  // flags each client would otherwise infer from one.
  if (opts.interactive) args.push("-i");
  args.push(...envFlags(env), target.containerName);
  return args;
}

/**
 * A `sed` program that keeps a `pg_dumpall` script from touching the role it is
 * being restored as.
 *
 * `--clean` writes `DROP ROLE IF EXISTS <user>`, and Postgres refuses to drop the
 * current user. Under `ON_ERROR_STOP` that ends the script, and it ends it right
 * after the `DROP DATABASE` lines: the service is left empty and nothing has been
 * restored. The `CREATE ROLE` would fail the same way, and the `ALTER ROLE` would
 * replace the password with the archive's, behind the back of the credentials
 * the panel holds and hands to every linked app.
 *
 * Limited to the part before `-- Databases`: past that line it is table data,
 * which is not to be read as statements whatever it looks like. A `pg_dump` has
 * no such line, and no roles either: `postgresRestoreCommand` keeps it away.
 */
export function postgresOwnRoleFilter(user: string): string {
  const name = user.replace(/"/g, '""').replace(/[\\/.*[\]^$]/g, "\\$&");
  const role = `"\\{0,1\\}${name}"\\{0,1\\}`;
  return [
    "1,/^-- Databases$/{",
    `/^DROP ROLE IF EXISTS ${role};$/d`,
    `/^CREATE ROLE ${role};$/d`,
    `/^ALTER ROLE ${role} WITH /d`,
    "}",
  ].join("\n");
}

/**
 * What reads a Postgres dump, after `execArgs`.
 *
 * Through `sh` for the filter, with both values as arguments: the pipeline's
 * status is the last command's, which is psql's. Only `pg_dump` is told apart, so
 * that an archive saying nothing about its tool gets the filter it may need.
 */
export function postgresRestoreCommand(user: string, tool: unknown): string[] {
  if (tool === "pg_dump") return ["psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"];
  return [
    "sh", "-c",
    'sed -e "$1" | psql -v ON_ERROR_STOP=1 -U "$2" -d postgres',
    "sh",
    postgresOwnRoleFilter(user),
    user,
  ];
}

export interface MongoCall {
  env: Record<string, string>;
  /** What follows `execArgs(target, env)`. */
  argv: string[];
}

const MONGO_CONFIG_VAR = "RP_MONGO_CONFIG";
const MONGO_PASSWORD_VAR = "RP_MONGO_PASSWORD";

/** What a Redis container reads its password from, at start: see `service-provisioner`. */
export const REDIS_PASSWORD_VAR = "RP_REDIS_PASSWORD";

/**
 * A file rather than a pipe, because nothing promises the tools read their
 * config only once; `mktemp` makes it 0600 and the trap removes it. Not `exec`,
 * or the trap would never run. The tool inherits stdin and stdout untouched,
 * since both carry the archive, and `set -e` hands its exit code back.
 */
const MONGO_TOOL_SCRIPT = [
  "set -e",
  "f=$(mktemp)",
  `trap 'rm -f "$f"' EXIT`,
  `printf '%s\\n' "$${MONGO_CONFIG_VAR}" > "$f"`,
  `"$@" --config="$f"`,
].join("; ");

/**
 * `mongodump` and `mongorestore`, which have no password variable but take one
 * from a YAML file (`--config`, since the 100.3.0 tools of 2021). That keeps it
 * off the command line inside the container too, which matters more than it
 * sounds: a process in a container is a process on the host, and `ps` lists it.
 * JSON is valid YAML, so `JSON.stringify` is the quoting.
 */
export function mongoToolCall(target: ServiceTarget, argv: string[]): MongoCall {
  const { user, password } = target.credentials;
  return {
    env: { [MONGO_CONFIG_VAR]: `password: ${yamlString(password)}` },
    argv: [
      "sh", "-c", MONGO_TOOL_SCRIPT, "sh",
      ...argv,
      "-u", user,
      "--authenticationDatabase", "admin",
    ],
  };
}

/**
 * A YAML double-quoted string that reads back as exactly this.
 *
 * `JSON.stringify` alone is not quite it: it leaves U+0085, U+2028 and U+2029 as
 * they are, which YAML reads as line breaks, and the C1 controls, which it
 * refuses. Everything past printable ASCII is written as an escape, a whole code
 * point at a time so that an emoji does not become two halves.
 */
export function yamlString(value: string): string {
  let out = "";
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x7f) out += char;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out;
}

export interface MongoShellOptions {
  database?: string;
  /** Evaluated after connecting; its last value is printed. */
  script?: string;
  /** Interactive: a console session. */
  shell?: boolean;
}

/** Where the engine listens inside its own container. */
const MONGO_PORT = 27017;

/**
 * `mongosh` and the older `mongo`, neither of which takes a password from a
 * variable or a file.
 *
 * `mongosh` reads it itself: it starts without a connection and the first thing
 * it evaluates connects and authenticates with `process.env`, so the password is
 * on no command line at all, the docker client's or the one inside the
 * container, which the host lists as any other process. A console session stays
 * open for as long as someone types, which is why this matters.
 *
 * `mongo`, from 5 and earlier, has no `process.env`: the shell in the container
 * expands the value onto its argv, which is as far as that client allows.
 */
export function mongoShellCall(target: ServiceTarget, binary: string, opts: MongoShellOptions = {}): MongoCall {
  const { user, password } = target.credentials;
  const tail = [
    ...(opts.shell ? ["--shell"] : []),
    ...(opts.script !== undefined ? ["--eval", opts.script] : []),
  ];
  const positional = opts.database ? [opts.database] : [];

  if (!user) return { env: {}, argv: [binary, "--quiet", ...positional, ...tail] };

  if (binary === "mongosh") {
    const connect = [
      `db = connect(${JSON.stringify(`mongodb://127.0.0.1:${MONGO_PORT}/admin?directConnection=true`)});`,
      `db.auth(${JSON.stringify(user)}, process.env.${MONGO_PASSWORD_VAR});`,
      `db = db.getSiblingDB(${JSON.stringify(opts.database || "test")});`,
    ].join(" ");
    return {
      env: { [MONGO_PASSWORD_VAR]: password },
      argv: [
        "mongosh", "--nodb", "--quiet",
        ...(opts.shell ? ["--shell"] : []),
        // `void 0` so a console opens on a prompt, not on the database just chosen.
        "--eval", opts.script !== undefined ? `${connect}\n${opts.script}` : `${connect}\nvoid 0`,
      ],
    };
  }

  return {
    env: { [MONGO_PASSWORD_VAR]: password },
    argv: [
      "sh", "-c", `b=$1; shift; exec "$b" -p "$${MONGO_PASSWORD_VAR}" "$@"`, "sh",
      binary,
      "-u", user,
      "--authenticationDatabase", "admin",
      "--quiet",
      ...positional,
      ...tail,
    ],
  };
}
