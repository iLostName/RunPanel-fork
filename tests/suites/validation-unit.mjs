import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The request schemas themselves, not copies of their rules.
 *
 * `lib/validation.ts` imports its neighbours without an extension, as the
 * bundler wants, and the strip-only loader cannot resolve that. The hook adds
 * the extension for relative imports made from a `.ts` file and nothing else.
 */
export const meta = { name: "validation-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("validation-unit");

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      const fromTs = context.parentURL?.endsWith(".ts");
      return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
    },
  });

  const { isBlockedRepoHost, repoUrlSchema, updateProjectSchema, createServiceSchema, envVarsSchema, envVarsIssueText, appLogQuerySchema } = await import(
    pathToFileURL(join(repoRoot, "lib", "validation.ts")).href
  );
  const { SERVICE_VERSIONS } = await import(pathToFileURL(join(repoRoot, "lib", "service-versions.ts")).href);

  // --- hosts a clone may not reach -------------------------------------------
  for (const host of [
    "localhost",
    "db.internal",
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[febf::1]",
    // What the URL parser turns `[::ffff:127.0.0.1]` into.
    "[::ffff:7f00:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:a9fe:a9fe]",
    "[::ffff:a00:1]",
    "[::7f00:1]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
    "[2002:a9fe:a9fe::1]",
  ]) {
    r.check(`${host} is blocked`, isBlockedRepoHost(host) === true);
  }

  for (const host of [
    "github.com",
    "8.8.8.8",
    "[2001:4860:4860::8888]",
    "[::ffff:808:808]",
    "[::808:808]",
    "[64:ff9b::808:808]",
    "[2002:808:808::]",
  ]) {
    r.check(`${host} is not blocked`, isBlockedRepoHost(host) === false);
  }

  r.check("a host with a colon that is not an address is blocked", isBlockedRepoHost("[not:an:address]") === true);

  const accepts = (url) => repoUrlSchema.safeParse(url).success;
  r.check("a mapped loopback URL is refused", !accepts("https://[::ffff:127.0.0.1]:5432/x.git"));
  r.check("a mapped metadata URL is refused", !accepts("https://[::ffff:169.254.169.254]/x.git"));
  r.check("a public IPv6 URL is accepted", accepts("https://[2001:4860:4860::8888]/x.git"));
  r.check("http stays refused", !accepts("http://github.com/a/b.git"));

  // --- credentials in a repository URL ---------------------------------------
  const cleaned = (url) => repoUrlSchema.parse(url);
  r.check("user and token are dropped", cleaned("https://oauth2:glpat-x@gitlab.example.com/org/app.git") === "https://gitlab.example.com/org/app.git");
  r.check("a bare token is dropped", cleaned("https://ghp_x@github.com/a/b.git") === "https://github.com/a/b.git");
  r.check("a second @ in the userinfo cannot leave half of it", cleaned("https://a@b@github.com/a/b.git") === "https://github.com/a/b.git");
  r.check("an @ in the path stays", cleaned("https://github.com/a@b/c.git") === "https://github.com/a@b/c.git");
  r.check("a clean URL comes back byte for byte", cleaned("https://GitHub.com/A/R") === "https://GitHub.com/A/R");
  r.check(
    "a project saved with credentials can still be saved, and loses them",
    updateProjectSchema.parse({ sourceUrl: "https://u:p@github.com/a/b.git" }).sourceUrl === "https://github.com/a/b.git"
  );
  r.check("a null source URL still clears it", updateProjectSchema.parse({ sourceUrl: null }).sourceUrl === null);

  // --- builderConfig ---------------------------------------------------------
  const contractAccepted = (builderConfig) => updateProjectSchema.safeParse({ builderConfig }).success;
  r.check("a null contract is refused", !contractAccepted(null));
  r.check("an array contract is refused", !contractAccepted([]));
  r.check("a string contract is refused", !contractAccepted("{}"));
  r.check("legacy keys with bad values are refused", !contractAccepted({ startCmd: 5 }));
  r.check("a contract of unknown keys is refused", !contractAccepted({ comands: { start: "x" } }));
  r.check("an absent contract stays absent", updateProjectSchema.parse({}).builderConfig === undefined);
  r.check("an empty contract is accepted", contractAccepted({}));
  r.check("the legacy shape is accepted", contractAccepted({ installCmd: "npm ci" }));
  r.check("the current shape is accepted", contractAccepted({ version: 1, commands: { start: "x" } }));
  r.check("a stored template row can be sent back", contractAccepted({ version: 1, dockerTemplate: "nginx", dockerFields: {} }));

  // --- new services ----------------------------------------------------------
  const service = (extra) => ({ name: "db", type: "postgresql", version: "18", port: 5432, ...extra });
  const serviceAccepted = (extra) => createServiceSchema.safeParse(service(extra)).success;

  for (const [type, versions] of Object.entries(SERVICE_VERSIONS)) {
    for (const version of versions.available) {
      r.check(`${type} ${version} is accepted`, serviceAccepted({ type, version }));
    }
  }
  r.check("a floating tag is refused", !serviceAccepted({ version: "latest" }));
  r.check("a variant tag is refused", !serviceAccepted({ version: "18-alpine" }));
  r.check("a version of another engine is refused", !serviceAccepted({ type: "redis", version: "18" }));
  r.check("a version that left the catalogue is refused for a new service", !serviceAccepted({ version: "13" }));
  r.check(
    "the refusal points at the version",
    createServiceSchema.safeParse(service({ version: "latest" })).error?.issues[0]?.path.join() === "version"
  );

  const credentialsAccepted = (credentials) => serviceAccepted({ credentials });
  r.check("a password with reserved characters is accepted", credentialsAccepted({ password: "Pa#ss@1/x" }));
  r.check("a password with a newline is refused", !credentialsAccepted({ password: "a\nb" }));
  r.check("a password over the limit is refused", !credentialsAccepted({ password: "x".repeat(129) }));
  r.check("a user with a space is refused", !credentialsAccepted({ user: "a b" }));
  r.check("a user over the limit is refused", !credentialsAccepted({ user: "a".repeat(64) }));
  r.check("a database with a slash is refused", !credentialsAccepted({ database: "a/b" }));
  r.check("empty credentials still mean generated ones", credentialsAccepted({ user: "", password: "", database: "" }));
  r.check("the wizard's redis credentials are accepted", serviceAccepted({ type: "redis", version: "8", credentials: { database: "0" } }));

  // --- variables: the error names the variable, in Italian ---------------------
  const envIssue = (vars) => {
    const body = { vars };
    const parsed = envVarsSchema.safeParse(body);
    return parsed.success ? null : envVarsIssueText(body, parsed.error.issues);
  };
  r.check("valid variables pass", envIssue([{ key: "API_URL", value: "x" }]) === null);
  const badName = envIssue([{ key: "OK", value: "1" }, { key: "1API", value: "2" }]);
  r.check("a bad name is named, with the rule in Italian", badName?.startsWith("«1API»: Nome non valido") === true, String(badName));
  r.check("an empty name says which row", envIssue([{ key: "", value: "1" }]) === "La variabile 1 non ha un nome");
  r.check("a long value says so", envIssue([{ key: "BIG", value: "x".repeat(70000) }])?.includes("troppo lungo") === true);
  r.check("too many variables says the limit", envIssue(Array.from({ length: 501 }, (_, i) => ({ key: `K${i}`, value: "" }))) === "Troppe variabili: il massimo è 500");
  const repeated = envIssue([{ key: "A", value: "1" }, { key: "B", value: "2" }, { key: "A", value: "3" }]);
  r.check("a repeated name is refused, and named", repeated?.startsWith("«A»: Nome ripetuto") === true, String(repeated));

  // --- the saved app log's query ---------------------------------------------
  const logQuery = (query) => appLogQuerySchema.safeParse(query);
  r.check("no query means the last 500 lines", logQuery({}).data?.lines === 500);
  r.check("lines arrive as text and are read as a number", logQuery({ lines: "2000" }).data?.lines === 2000);
  r.check("too many lines are refused in Italian", logQuery({ lines: "9999" }).error?.issues[0]?.message === "Al massimo 5000 righe");
  r.check("lines that are not a number are refused", !logQuery({ lines: "tante" }).success);
  r.check("an unknown stream is refused", !logQuery({ stream: "stdlog" }).success && logQuery({ stream: "stderr" }).success);
  r.check("a long search is refused", !logQuery({ q: "x".repeat(201) }).success);
  const repoMessage = repoUrlSchema.safeParse("http://github.com/a/b").error?.issues[0]?.message ?? "";
  r.check("a repository address that is not https is refused in Italian", repoMessage.startsWith("L'indirizzo del repository"), repoMessage);

  // --- signing in with GitHub: the OAuth App and the start of a sign-in ----------
  const { githubLoginSettingsSchema, githubLoginActionSchema, githubStartSchema } = await import(
    pathToFileURL(join(repoRoot, "lib", "validation.ts")).href
  );
  const app = (body) => githubLoginSettingsSchema.safeParse(body);
  r.check("a Client ID and a secret as GitHub issues them pass", app({ clientId: "Ov23liAbCdEf0123456", clientSecret: "0123456789abcdef0123456789abcdef01234567" }).success);
  r.check("the pasted values are trimmed", app({ clientId: "  Ov23liAbCdEf0123456 " }).data?.clientId === "Ov23liAbCdEf0123456");
  r.check("an empty secret keeps the stored one", app({ clientId: "Ov23liAbCdEf0123456", clientSecret: "" }).success);
  r.check(
    "a Client ID with a space, a URL or a line of the page is refused in Italian",
    ["Client ID Ov23li", "https://github.com/settings/applications/1", "Ov23"].every((clientId) => app({ clientId }).error?.issues[0]?.message.startsWith("Il Client ID"))
  );
  r.check("a secret that is too short or has spaces is refused", !app({ clientId: "Ov23liAbCdEf0123456", clientSecret: "short" }).success && !app({ clientId: "Ov23liAbCdEf0123456", clientSecret: "0123456789 abcdef0123456789" }).success);
  r.check("switching it on or off alone is a save", app({ enabled: false, force: true }).success && app({ enabled: true }).success);
  r.check("an empty body is not", !app({}).success && !app({ force: true }).success);
  r.check("an unknown field is refused", !app({ enabled: true, scope: "repo" }).success);
  r.check("the actions are verify and clear", githubLoginActionSchema.safeParse({ action: "verify" }).success && githubLoginActionSchema.safeParse({ action: "clear", force: true }).success && !githubLoginActionSchema.safeParse({ action: "rotate" }).success);
  const start = (body) => githubStartSchema.safeParse(body).success;
  r.check("a sign-in starts with or without a next page", start({ intent: "login" }) && start({ intent: "login", next: "/projects" }));
  r.check("a link needs the password", start({ intent: "link", password: "x" }) && !start({ intent: "link" }) && !start({ intent: "link", password: "" }));
  r.check("an invitation needs its token", start({ intent: "invite", token: "A".repeat(43) }) && !start({ intent: "invite" }) && !start({ intent: "invite", token: "short" }));
  r.check("nothing else starts, and nothing extra rides along", !start({ intent: "signup" }) && !start({ intent: "login", userId: "u1" }) && !start({ intent: "link", password: "x", userId: "u1" }));

  return r.result();
}
