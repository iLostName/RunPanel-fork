import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The app catalogue, without Docker: every template is a stack the panel can
 * stand behind.
 *
 * What a template may do is checked here rather than trusted: each compose file
 * parses, publishes its web port on the project's PORT, keeps its data in the
 * named volumes it declares, reaches nothing on the host (no bind mounts, no
 * host network, no privileges), pins its images, and substitutes only the
 * variables the install writes — each with a fallback, so `compose ps` and
 * `compose logs`, which run without them, never warn. Then the answers: what is
 * refused, and that what is accepted reaches the variables exactly as typed.
 *
 * The YAML is parsed with js-yaml when it is installed, which it is wherever
 * ESLint is; without it the structural checks that need a parser are skipped
 * and said so, the rest still run.
 */
export const meta = { name: "app-catalog-unit", needsDocker: false, drivers: [], standalone: true };

/** What a template must never set: each one reaches past the container. */
const FORBIDDEN_SERVICE_KEYS = [
  "privileged",
  "network_mode",
  "cap_add",
  "devices",
  "pid",
  "ipc",
  "userns_mode",
  "security_opt",
  "volumes_from",
  "env_file",
  "build",
  "container_name",
  "extra_hosts",
];

/** Set by the panel itself, or injected for linked services: a template variable under one of these would be overwritten. */
const RESERVED_KEYS = ["PORT", "NODE_ENV", "PATH", "HOME", "DATABASE_URL", "REDIS_URL", "MONGODB_URL"];

export async function run({ repoRoot }) {
  const r = createReporter("app-catalog-unit");

  // lib/app-catalog imports its own files without an extension, as the
  // bundler wants; the strip-only loader needs one. Same hook as validation-unit.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      const fromTs = context.parentURL?.endsWith(".ts");
      return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
    },
  });

  const catalog = await import(pathToFileURL(join(repoRoot, "lib", "app-catalog", "index.ts")).href);
  const { generateSecret } = await import(pathToFileURL(join(repoRoot, "services", "catalog", "secrets.ts")).href);
  const {
    CATALOG,
    CATEGORY_LABEL,
    getTemplate,
    catalogCategories,
    composeFile,
    composeVariables,
    composeServiceNames,
    validateAnswers,
    defaultAnswers,
    buildEnvironment,
    locateApp,
    isPublicHost,
    filterCatalog,
    suggestProjectName,
    slugPreview,
    fillNote,
    noteValues,
    catalogEntry,
    stackLeftovers,
  } = catalog;

  let yaml = null;
  try {
    yaml = (await import("js-yaml")).default;
  } catch {
    r.note("js-yaml not installed: the checks that need a YAML parser are skipped");
  }
  const solar = JSON.parse(readFileSync(join(repoRoot, "node_modules", "@iconify-json", "solar", "icons.json"), "utf8"));

  r.check("eight apps in the catalogue", CATALOG.length === 8, String(CATALOG.length));
  r.check("ids are unique", new Set(CATALOG.map((t) => t.id)).size === CATALOG.length);
  r.check(
    "the first apps of the plan are all there",
    ["n8n", "wordpress", "uptime-kuma", "umami", "minio", "vaultwarden", "gitea", "ghost"].every((id) => getTemplate(id))
  );
  r.check("an unknown id is null", getTemplate("nope") === null && getTemplate("__proto__") === null);

  const https = { url: "https://app.esempio.it", host: "app.esempio.it", https: true, port: 41000, answers: {} };
  const http = { url: "http://192.168.1.10:41000", host: "192.168.1.10", https: false, port: 41000, answers: {} };

  for (const t of CATALOG) {
    const tag = `${t.id}:`;
    const text = composeFile(t);

    // --- the description ------------------------------------------------------
    r.check(`${tag} id is a URL segment`, /^[a-z0-9-]+$/.test(t.id));
    r.check(`${tag} name, description and notes are there`, Boolean(t.name && t.description && t.about) && t.notes.length > 0);
    r.check(`${tag} a known category`, Object.hasOwn(CATEGORY_LABEL, t.category));
    r.check(`${tag} the icon exists in Solar`, t.icon.startsWith("solar:") && Boolean(solar.icons[t.icon.slice(6)] ?? solar.aliases?.[t.icon.slice(6)]), t.icon);
    r.check(`${tag} the default port is not a system one`, t.web.defaultPort >= 1024 && t.web.defaultPort <= 65535);
    r.check(`${tag} the health check path is a path`, t.healthcheck.path.startsWith("/") && t.healthcheck.timeoutSec <= 900 && t.healthcheck.startPeriodSec <= 600);
    r.check(`${tag} a required or recommended address says why`, t.address === "optional" || Boolean(t.addressNote));

    // --- the variables ----------------------------------------------------------
    const keys = [...t.questions.map((q) => q.key), ...t.secrets.map((s) => s.key), ...t.derived.map((d) => d.key)];
    r.check(`${tag} variable names are unique`, new Set(keys).size === keys.length, keys.join(","));
    r.check(`${tag} variable names are valid and not the panel's`, keys.every((k) => /^[A-Z][A-Z0-9_]*$/.test(k) && !RESERVED_KEYS.includes(k)), keys.join(","));
    for (const ctx of [https, http]) {
      const derived = t.derive(ctx);
      r.check(
        `${tag} derive gives exactly its keys (${ctx.https ? "https" : "http"})`,
        JSON.stringify(Object.keys(derived).sort()) === JSON.stringify(t.derived.map((d) => d.key).sort()),
        Object.keys(derived).join(",")
      );
      r.check(`${tag} derived values are single-line`, Object.values(derived).every((v) => typeof v === "string" && !/[\u0000-\u001f]/.test(v)));
    }
    r.check(`${tag} secrets are long enough`, t.secrets.every((s) => s.length >= 16 && (s.alphabet === "hex" || s.alphabet === "alnum")));

    // --- the compose file, as text ------------------------------------------------
    const refs = composeVariables(text);
    const allowed = new Set(["PORT", ...keys]);
    r.check(`${tag} every $ is a substitution`, refs.strays === 0, String(refs.strays));
    r.check(`${tag} every substitution has a fallback`, refs.variables.every((v) => v.fallback !== null), refs.variables.filter((v) => v.fallback === null).map((v) => v.name).join(","));
    r.check(`${tag} it substitutes only what the install writes`, refs.variables.every((v) => allowed.has(v.name)), refs.variables.filter((v) => !allowed.has(v.name)).map((v) => v.name).join(","));
    const used = new Set(refs.variables.map((v) => v.name));
    r.check(`${tag} every variable is used`, keys.every((k) => used.has(k)), keys.filter((k) => !used.has(k)).join(","));
    r.check(`${tag} the web port comes from PORT`, text.includes(`"\${PORT:-${t.web.defaultPort}}:${t.web.internalPort}"`));
    r.check(`${tag} port fallbacks are numbers`, refs.variables.filter((v) => v.name === "PORT" || t.questions.some((q) => q.port && q.key === v.name)).every((v) => /^\d+$/.test(v.fallback ?? "")));
    r.check(`${tag} the header substitutes nothing`, !text.split("services:")[0].includes("${"));
    r.check(`${tag} no tabs`, !text.includes("\t"));

    // --- the compose file, parsed ---------------------------------------------------
    if (!yaml) continue;
    let doc = null;
    try {
      doc = yaml.load(text);
    } catch (err) {
      r.check(`${tag} the compose file parses`, false, err.message);
      continue;
    }
    r.check(`${tag} the compose file parses`, doc && typeof doc === "object" && doc.services && typeof doc.services === "object");
    const services = doc.services ?? {};
    const names = Object.keys(services);
    r.check(`${tag} the layout reader finds the same services`, JSON.stringify(composeServiceNames(t.compose)) === JSON.stringify(names), composeServiceNames(t.compose).join(","));
    r.check(`${tag} the web service exists`, Object.hasOwn(services, t.web.service));
    r.check(`${tag} databases run in the stack`, t.databases.every((d) => Object.hasOwn(services, d.service)));
    r.check(`${tag} only top-level services and volumes`, Object.keys(doc).every((k) => k === "services" || k === "volumes"), Object.keys(doc).join(","));

    const declared = Object.keys(doc.volumes ?? {});
    r.check(`${tag} the volumes it declares are the ones it describes`, JSON.stringify(declared.sort()) === JSON.stringify(t.volumes.map((v) => v.name).sort()), declared.join(","));
    for (const volume of t.volumes) {
      const mounts = services[volume.service]?.volumes ?? [];
      r.check(`${tag} ${volume.name} is mounted at ${volume.path}`, mounts.includes(`${volume.name}:${volume.path}`));
    }

    for (const [name, service] of Object.entries(services)) {
      const at = `${tag} ${name}`;
      const image = String(service.image ?? "");
      const tagPart = image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "";
      r.check(`${at} pins its image`, Boolean(tagPart) && !image.slice(image.lastIndexOf("/") + 1).startsWith(":") && !["latest", "stable", "next", "beta", "nightly"].includes(tagPart), image);
      r.check(`${at} restarts on its own`, service.restart === "unless-stopped");
      const forbidden = FORBIDDEN_SERVICE_KEYS.filter((k) => Object.hasOwn(service, k));
      r.check(`${at} reaches nothing outside its container`, forbidden.length === 0, forbidden.join(","));
      const mounts = service.volumes ?? [];
      r.check(
        `${at} mounts named volumes only`,
        mounts.every((m) => typeof m === "string" && declared.includes(m.split(":")[0]) && !/^[./~]/.test(m)),
        JSON.stringify(mounts)
      );
      const env = service.environment ?? {};
      r.check(`${at} environment is a mapping of strings and numbers`, !Array.isArray(env) && Object.values(env).every((v) => typeof v === "string" || typeof v === "number"), JSON.stringify(env));
      const ports = service.ports ?? [];
      r.check(`${at} publishes only substituted ports`, ports.every((p) => typeof p === "string" && /^\$\{[A-Z_]+:-\d+\}:\d+$/.test(p)), JSON.stringify(ports));
      if (name !== t.web.service) {
        r.check(`${at} publishes nothing unless it is the web service`, ports.length === 0 || t.questions.some((q) => q.port), JSON.stringify(ports));
      }
      for (const dependency of Object.keys(service.depends_on ?? {})) {
        r.check(`${at} waits for a service that exists and has a health check`, Boolean(services[dependency]?.healthcheck), dependency);
      }
    }
    r.check(
      `${tag} the web service publishes the project port`,
      (services[t.web.service]?.ports ?? []).includes(`\${PORT:-${t.web.defaultPort}}:${t.web.internalPort}`)
    );

    // --- the API's view of it --------------------------------------------------------
    const entry = catalogEntry(t);
    r.check(`${tag} the API entry is plain JSON`, JSON.stringify(JSON.parse(JSON.stringify(entry))) === JSON.stringify(entry) && !("derive" in entry));
    r.check(`${tag} the API entry carries no secret value`, entry.secrets.every((s) => Object.keys(s).sort().join(",") === "important,key,label"));
  }

  // --- answers -------------------------------------------------------------------
  const n8n = getTemplate("n8n");
  const minio = getTemplate("minio");

  const tz = validateAnswers(n8n, {}, { timezone: "Europe/Rome" });
  r.check("a missing answer takes its default", tz.issues.length === 0 && tz.values.TIMEZONE === "Europe/Rome");
  r.check("an invalid context zone falls back to UTC", defaultAnswers(n8n, { timezone: "Mars/Olympus" }).TIMEZONE === "UTC");
  r.check("an unknown zone is refused", validateAnswers(n8n, { TIMEZONE: "Europe/Atlantide" }, { timezone: "UTC" }).issues.length === 1);
  r.check("a question the template does not ask is refused", validateAnswers(n8n, { N8N_HOST: "x" }, { timezone: "UTC" }).issues.some((i) => i.key === "N8N_HOST"));
  r.check("a prototype key is refused, not followed", validateAnswers(n8n, JSON.parse('{"__proto__": "x"}'), { timezone: "UTC" }).issues.length === 1);
  r.check("a newline is refused", validateAnswers(minio, { MINIO_ROOT_USER: "ad\nmin" }, { timezone: "UTC" }).issues.length === 1);
  r.check("a NUL is refused", validateAnswers(minio, { MINIO_ROOT_USER: "ad\u0000min" }, { timezone: "UTC" }).issues.length === 1);
  r.check("a username with a space is refused", validateAnswers(minio, { MINIO_ROOT_USER: "ad min" }, { timezone: "UTC" }).issues.length === 1);
  r.check("a too short username is refused", validateAnswers(minio, { MINIO_ROOT_USER: "ab" }, { timezone: "UTC" }).issues.length === 1);
  r.check("text is trimmed", validateAnswers(minio, { MINIO_ROOT_USER: "  root  " }, { timezone: "UTC" }).values.MINIO_ROOT_USER === "root");
  r.check("a port question left out stays out, for the server to fill", !("MINIO_API_PORT" in validateAnswers(minio, {}, { timezone: "UTC" }).values));
  r.check("a port below 1024 is refused", validateAnswers(minio, { MINIO_API_PORT: 80 }, { timezone: "UTC" }).issues.length === 1);
  r.check("a port above 65535 is refused", validateAnswers(minio, { MINIO_API_PORT: 70000 }, { timezone: "UTC" }).issues.length === 1);
  r.check("a port as a string is read", validateAnswers(minio, { MINIO_API_PORT: " 9100 " }, { timezone: "UTC" }).values.MINIO_API_PORT === "9100");
  r.check("a fractional port is refused", validateAnswers(minio, { MINIO_API_PORT: 9100.5 }, { timezone: "UTC" }).issues.length === 1);
  r.check("a number of the wrong type is refused", validateAnswers(minio, { MINIO_API_PORT: true }, { timezone: "UTC" }).issues.length === 1);

  // Every type, on a template written for the test.
  const probe = {
    ...n8n,
    questions: [
      { key: "T", label: "Testo", type: "text", required: false },
      { key: "E", label: "Email", type: "email", required: true },
      { key: "P", label: "Password", type: "password", required: true },
      { key: "N", label: "Numero", type: "number", required: false, min: 1, max: 10 },
      { key: "B", label: "Sì o no", type: "boolean", required: false, values: { on: "1", off: "0" } },
    ],
  };
  const tricky = "pa$$w0rd \"quoted\" 'single' `tick` \\back ${NOT_A_VAR} #hash";
  const ok = validateAnswers(probe, { E: "me@esempio.it", P: tricky, N: 3, B: true }, { timezone: "UTC" });
  r.check("every type accepts a good value", ok.issues.length === 0, JSON.stringify(ok.issues));
  r.check("a password keeps every character as typed", ok.values.P === tricky);
  r.check("a boolean writes the template's own values", ok.values.B === "1" && validateAnswers(probe, { E: "a@b.it", P: "12345678", B: false }, { timezone: "UTC" }).values.B === "0");
  r.check("an optional text left out is empty", ok.values.T === "");
  r.check("a required email left out is refused", validateAnswers(probe, { P: "12345678" }, { timezone: "UTC" }).issues.some((i) => i.key === "E"));
  r.check("a malformed email is refused", validateAnswers(probe, { E: "me@", P: "12345678" }, { timezone: "UTC" }).issues.some((i) => i.key === "E"));
  r.check("a short password is refused", validateAnswers(probe, { E: "a@b.it", P: "1234567" }, { timezone: "UTC" }).issues.some((i) => i.key === "P"));
  r.check("a password with a newline is refused", validateAnswers(probe, { E: "a@b.it", P: "12345678\n" }, { timezone: "UTC" }).issues.some((i) => i.key === "P"));
  r.check("a number out of bounds is refused", validateAnswers(probe, { E: "a@b.it", P: "12345678", N: 11 }, { timezone: "UTC" }).issues.some((i) => i.key === "N"));
  r.check("a boolean of the wrong kind is refused", validateAnswers(probe, { E: "a@b.it", P: "12345678", B: "maybe" }, { timezone: "UTC" }).issues.some((i) => i.key === "B"));

  // --- what reaches the variables ------------------------------------------------------
  const location = locateApp({ hostname: null, publicHost: "192.168.1.10", port: 41000 });
  const secrets = { MINIO_ROOT_PASSWORD: "s3cret$value'\"" };
  const env = buildEnvironment(minio, { answers: { MINIO_ROOT_USER: "a$b'c\"d", MINIO_API_PORT: "41001" }, secrets, location, port: 41000 });
  const byKey = Object.fromEntries(env.map((e) => [e.key, e]));
  r.check("answers become variables unchanged", byKey.MINIO_ROOT_USER.value === "a$b'c\"d" && byKey.MINIO_API_PORT.value === "41001");
  r.check("secrets are marked sensitive", byKey.MINIO_ROOT_PASSWORD.sensitive && byKey.MINIO_ROOT_PASSWORD.value === secrets.MINIO_ROOT_PASSWORD);
  r.check("a derived value follows the address", byKey.APP_URL.value === "http://192.168.1.10:41000" && !byKey.APP_URL.sensitive);
  r.check("the compose file does not depend on the answers", composeFile(minio) === composeFile(getTemplate("minio")) && !composeFile(minio).includes("a$b"));

  const n8nHttps = Object.fromEntries(buildEnvironment(n8n, { answers: { TIMEZONE: "Europe/Rome" }, secrets: { N8N_ENCRYPTION_KEY: "k" }, location: locateApp({ hostname: "n8n.esempio.it", publicHost: "x", port: 41000 }), port: 41000 }).map((e) => [e.key, e.value]));
  r.check("n8n over HTTPS: secure cookie and one proxy", n8nHttps.N8N_SECURE_COOKIE === "true" && n8nHttps.N8N_PROXY_HOPS === "1" && n8nHttps.APP_URL === "https://n8n.esempio.it");
  const n8nHttp = Object.fromEntries(buildEnvironment(n8n, { answers: { TIMEZONE: "UTC" }, secrets: { N8N_ENCRYPTION_KEY: "k" }, location, port: 41000 }).map((e) => [e.key, e.value]));
  r.check("n8n over plain http: no secure cookie, or nobody could log in", n8nHttp.N8N_SECURE_COOKIE === "false" && n8nHttp.N8N_PROTOCOL === "http");

  // --- where the app answers ---------------------------------------------------------------
  r.check("an address is HTTPS on its own name", JSON.stringify(locateApp({ hostname: "a.esempio.it", publicHost: "1.2.3.4", port: 9 })) === JSON.stringify({ url: "https://a.esempio.it", host: "a.esempio.it", https: true }));
  r.check("without one, the server and the port", locateApp({ hostname: null, publicHost: "Server.Lan", port: 8080 }).url === "http://server.lan:8080");
  r.check("port 80 is left out of the URL", locateApp({ hostname: null, publicHost: "x.lan", port: 80 }).url === "http://x.lan");
  r.check("an IPv6 literal goes in brackets", locateApp({ hostname: null, publicHost: "fd00::1", port: 8080 }).url === "http://[fd00::1]:8080");
  r.check("host names and IPs are accepted", ["localhost", "192.168.1.10", "server.lan", "fd00::1", "srv-1.esempio.it"].every(isPublicHost));
  r.check("anything else is refused", ["", "a b", "x/y", "http://x", "a:b", "-x", "x-", "a..b", "x".repeat(254), "user@host"].every((v) => !isPublicHost(v)));

  // --- the compose reader on crafted text -------------------------------------------------------
  r.check("a bare $VAR is a stray", composeVariables("a: $HOME").strays === 1);
  r.check("an escaped $$ is two strays", composeVariables("a: $$x").strays === 2);
  r.check("a reference without fallback is reported", composeVariables('a: "${A}"').variables[0]?.fallback === null);
  r.check("a reference with fallback is read", JSON.stringify(composeVariables('a: "${A:-x}/${B:-}"').variables) === JSON.stringify([{ name: "A", fallback: "x" }, { name: "B", fallback: "" }]));
  r.check("comments are not read", composeVariables("# ${A}\n  # $B\nx: 1").variables.length === 0 && composeVariables("# $B").strays === 0);

  // --- what an earlier install left behind ----------------------------------------------------------
  const wordpress = getTemplate("wordpress");
  const inventory = {
    volumes: [
      { name: "runpanel-wp_wordpress_db", project: "runpanel-wp" },
      { name: "runpanel-wp2_wordpress_db", project: "runpanel-wp2" },
      { name: "runpanel-x_wordpress_files", project: "" },
      { name: "pgdata", project: "" },
    ],
    containers: [
      { name: "runpanel-x-db-1", project: "" },
      { name: "shop-web-1", project: "shop" },
    ],
  };
  r.check("the volumes a deleted install left are found", JSON.stringify(stackLeftovers(inventory, "runpanel-wp", wordpress)) === JSON.stringify(["volume runpanel-wp_wordpress_db"]));
  r.check("a longer name with the same start is someone else", !stackLeftovers(inventory, "runpanel-wp", wordpress).some((x) => x.includes("wp2")));
  r.check("names Compose would give count without the label", JSON.stringify(stackLeftovers(inventory, "runpanel-x", wordpress)) === JSON.stringify(["volume runpanel-x_wordpress_files", "container runpanel-x-db-1"]));
  r.check("a fresh name finds nothing", stackLeftovers(inventory, "runpanel-new", wordpress).length === 0);

  // --- secrets -----------------------------------------------------------------------------------
  const hex = generateSecret({ length: 64, alphabet: "hex" });
  const alnum = generateSecret({ length: 32, alphabet: "alnum" });
  r.check("hex secrets are hex of the right length", /^[0-9a-f]{64}$/.test(hex));
  r.check("alnum secrets are letters and digits of the right length", /^[A-Za-z0-9]{32}$/.test(alnum));
  r.check("an odd hex length is honoured", /^[0-9a-f]{33}$/.test(generateSecret({ length: 33, alphabet: "hex" })));
  const many = new Set(Array.from({ length: 200 }, () => generateSecret({ length: 24, alphabet: "alnum" })));
  r.check("two secrets are never the same", many.size === 200);
  const letters = new Set([...Array.from({ length: 50 }, () => generateSecret({ length: 40, alphabet: "alnum" })).join("")]);
  r.check("the whole alphabet is used", letters.size > 55, String(letters.size));

  // --- notes -----------------------------------------------------------------------------------------
  for (const t of CATALOG) {
    const answers = { ...defaultAnswers(t, { timezone: "UTC" }) };
    for (const q of t.questions) if (q.port) answers[q.key] = "41001";
    const loc = locateApp({ hostname: "app.esempio.it", publicHost: "x", port: 41000 });
    const entries = buildEnvironment(t, { answers, secrets: Object.fromEntries(t.secrets.map((s) => [s.key, "SEGRETO"])), location: loc, port: 41000 });
    const filled = t.notes.map((note) => fillNote(note, noteValues(entries, loc)));
    r.check(`${t.id}: every note placeholder is filled`, filled.every((note) => !/\{[A-Z][A-Z0-9_]*\}/.test(note)), filled.join(" | "));
    r.check(`${t.id}: no note shows a secret`, filled.every((note) => !note.includes("SEGRETO")));
  }
  r.check("an unknown placeholder stays as written", fillNote("x {NOPE} y", {}) === "x {NOPE} y");

  // --- names and search ------------------------------------------------------------------------------
  r.check("the app's own name when free", suggestProjectName("n8n", new Set()) === "n8n");
  r.check("a number after it when taken", suggestProjectName("Uptime Kuma", new Set(["uptime-kuma", "uptime-kuma-2"])) === "Uptime Kuma 3");
  const { slugify } = await import(pathToFileURL(join(repoRoot, "lib", "utils.ts")).href);
  r.check(
    "the page's slug is the server's slug",
    ["n8n", "WordPress", "Uptime Kuma", "Il mio blog", "Ghost 2", "  spazi  ", "ä-umlaut", "a__b"].every((name) => slugPreview(name) === slugify(name)),
    ["Uptime Kuma", "ä-umlaut"].map((n) => `${slugPreview(n)}/${slugify(n)}`).join(" ")
  );
  r.check("search by what people call it", filterCatalog(CATALOG, { query: "blog" }).map((t) => t.id).sort().join(",") === "ghost,wordpress");
  r.check("search ignores accents and case", filterCatalog(CATALOG, { query: "STATÌSTICHE" }).some((t) => t.id === "umami"));
  r.check("every word has to match", filterCatalog(CATALOG, { query: "password bitwarden" }).map((t) => t.id).join(",") === "vaultwarden");
  r.check("a category narrows it", filterCatalog(CATALOG, { category: "websites" }).every((t) => t.category === "websites") && filterCatalog(CATALOG, { category: "websites" }).length === 2);
  r.check("nothing matches nonsense", filterCatalog(CATALOG, { query: "zzzz" }).length === 0);
  r.check("categories with no app are not offered", catalogCategories().every((c) => CATALOG.some((t) => t.category === c)));

  return r.result();
}
