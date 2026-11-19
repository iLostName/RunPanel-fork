import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * Domains and the names projects are served on, through the API.
 *
 * A test instance runs with `RUNPANEL_DISABLE_SCHEDULERS`, so its proxy reports
 * itself disabled and never touches an nginx — which is the first thing
 * checked, because the opposite would rewrite the configuration of whatever
 * nginx serves the machine running the suite. Everything else is the store's
 * contract: canonical names, uniqueness, who may do what, and what a deleted
 * project or domain takes with it. The configuration nginx gets is
 * `proxy-unit`'s business.
 */
export const meta = { name: "domains", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("domains");
  const owner = client(base);
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  const show = (res) => `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;

  await owner.call(
    "/api/auth/login",
    json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "domains-suite-pw" })
  );

  // --- the proxy, as a test instance sees it -------------------------------------
  let res = await owner.call("/api/domains");
  r.check("the page answers with no domains", res.status === 200 && Array.isArray(res.body.domains) && res.body.domains.length === 0, show(res));
  r.check("a test instance never touches nginx", res.body.proxy?.state === "disabled", show(res));

  res = await owner.call("/api/domains/proxy", json("POST", { action: "apply" }));
  r.check("applying is refused while the proxy is disabled", res.status === 409 && res.body.ok === false, show(res));
  res = await owner.call("/api/domains/proxy", json("POST", { action: "setup" }));
  r.check("so is setting it up", res.status === 409 && res.body.ok === false, show(res));
  res = await owner.call("/api/domains/proxy", json("POST", { action: "reboot" }));
  r.check("an unknown proxy action is a 400", res.status === 400, show(res));

  // --- domains ------------------------------------------------------------------
  res = await owner.call("/api/domains", json("POST", { name: " Esempio.IT. " }));
  r.check("a domain is stored canonical", res.status === 201 && res.body.name === "esempio.it", show(res));
  const domainId = res.body.id;

  res = await owner.call("/api/domains", json("POST", { name: "esempio.it" }));
  r.check("the same domain twice is a 409", res.status === 409, show(res));

  for (const bad of ["*.esempio.it", "https://esempio.it", "localhost", "10.0.0.1", "es_empio.it", "esempio.it; x"]) {
    res = await owner.call("/api/domains", json("POST", { name: bad }));
    r.check(`the domain ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call("/api/domains", { method: "POST", body: "{" });
  r.check("a body that is not JSON is a 400", res.status === 400, show(res));

  // --- a project and its names --------------------------------------------------------
  res = await owner.call("/api/projects", json("POST", { name: "Sito" }));
  const projectId = res.body.id;

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("a project without a port gets no name", res.status === 409, show(res));

  res = await owner.call(`/api/projects/${projectId}`, json("PATCH", { port: 3456 }));
  r.check("the project gets a port", res.status === 200 && res.body.port === 3456, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: " App " }));
  r.check(
    "a name is assigned, canonical, waiting for nginx",
    res.status === 201 && res.body.host?.hostname === "app.esempio.it" && res.body.host.status === "pending",
    show(res)
  );
  const hostId = res.body.host?.id;
  r.check("the answer says why it waits", res.body.proxy?.state === "disabled", show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("the same name twice is a 409", res.status === 409, show(res));
  for (const bad of ["a.b", "-x", "x y", "*"]) {
    res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: bad }));
    r.check(`the subdomain ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId: "nope", subdomain: "x" }));
  r.check("an unknown domain is a 404", res.status === 404, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`);
  r.check(
    "the project lists its name and the domains it could use",
    res.status === 200 && res.body.hosts?.length === 1 && res.body.domains?.length === 1 && res.body.hasPort === true,
    show(res)
  );
  r.check("the owner may manage domains", res.body.canManageDomains === true && res.body.restricted === false, show(res));
  r.check(
    "a name waiting for nginx reads as without a certificate, serving the app",
    res.body.hosts?.[0]?.certificate === "missing" && res.body.hosts[0].redirectTo === null,
    show(res)
  );
  r.check("the owner gets what the setup needs", typeof res.body.proxy?.state === "string" && "commands" in (res.body.proxy ?? {}), show(res));

  // --- its DNS, as public resolvers see it ----------------------------------------------
  // Only the contract: whether esempio.it resolves from the machine running the
  // suite is not this suite's business, and offline the verdict is an error.
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}/dns`);
  const verdict = res.body.names?.[0];
  r.check(
    "the DNS check answers for the name",
    res.status === 200 && verdict?.hostname === "app.esempio.it" && verdict.hostId === hostId && verdict.subdomain === "app",
    show(res)
  );
  r.check(
    "with a verdict the page knows",
    ["ok", "missing", "elsewhere", "cloudflare", "unknown", "error"].includes(verdict?.check?.state) && typeof verdict.check.ready === "boolean",
    show(res)
  );
  r.check(
    "and what the records should hold",
    Array.isArray(verdict?.check?.families?.A?.expected) && Array.isArray(verdict.server?.v4) && Array.isArray(verdict.resolvers),
    show(res)
  );
  res = await owner.call(`/api/projects/${projectId}/hosts/nope/dns`);
  r.check("the DNS check of an unknown name is a 404", res.status === 404, show(res));

  res = await owner.call("/api/domains");
  r.check(
    "the Domains page lists the name with its project",
    res.body.hosts?.length === 1 && res.body.hosts[0].projectName === "Sito" && res.body.domains[0].hostCount === 1,
    show(res)
  );

  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("a domain in use is not removed", res.status === 409, show(res));

  // --- a name's own settings -------------------------------------------------------------
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", { publicAccess: true }));
  r.check("a name can be opened to everyone", res.status === 200 && res.body.host?.publicAccess === true, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", { auth: { user: "admin", password: "una-password" } }));
  r.check("a name can ask for a password", res.status === 200 && res.body.host?.authUser === "admin", show(res));
  r.check("the hash never leaves the server", !JSON.stringify(res.body).includes("$6$") && !("authHash" in (res.body.host ?? {})), show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts`);
  r.check("the project's names say so", res.body.hosts?.[0]?.authUser === "admin" && res.body.hosts[0].publicAccess === true, show(res));
  res = await owner.call(`/api/projects/${projectId}`);
  r.check(
    "the header gets the name to open, marked as locked",
    res.body.hosts?.length === 1 && res.body.hosts[0].url === "http://app.esempio.it" && res.body.hosts[0].locked === true,
    show(res)
  );
  // Deploys without downtime: what the settings read, and the switch saved through the contract.
  r.check(
    "the project says it has no live port and that this nginx cannot take a switch",
    res.body.live_port === null && res.body.zeroDowntime?.proxyReady === false,
    show(res)
  );
  res = await owner.call(`/api/projects/${projectId}`, json("PATCH", { builderConfig: { zeroDowntime: { enabled: true, drainSec: 30 } } }));
  r.check(
    "the switch for deploys without downtime is saved from the panel",
    res.status === 200 && JSON.parse(res.body.builder_config ?? "{}").zeroDowntime?.drainSec === 30,
    show(res)
  );
  res = await owner.call(`/api/projects/${projectId}`, json("PATCH", { builderConfig: { zeroDowntime: { drainSec: 900 } } }));
  r.check("a drain past nginx's 300 seconds is a 400", res.status === 400, show(res));
  for (const [label, auth] of [
    ["a user with a colon", { user: "ad:min", password: "una-password" }],
    ["a user with a newline", { user: "admin\nroot", password: "una-password" }],
    ["a short password", { user: "admin", password: "corta" }],
    ["a missing password", { user: "admin" }],
  ]) {
    res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", { auth }));
    r.check(`${label} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", {}));
  r.check("a change of nothing is a 400", res.status === 400, show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", { auth: null }));
  r.check("the password can be taken away", res.status === 200 && res.body.host?.authUser === null && res.body.host.publicAccess === true, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("POST", { action: "retry" }));
  r.check("a certificate is not asked for while the proxy is disabled", res.status === 409 && typeof res.body.error === "string", show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("POST", { action: "renew-all" }));
  r.check("an unknown action is a 400", res.status === 400, show(res));

  res = await owner.call("/api/projects", json("POST", { name: "Altro" }));
  const otherId = res.body.id;
  res = await owner.call(`/api/projects/${otherId}/hosts/${hostId}`, { method: "DELETE" });
  r.check("another project's name cannot be removed through this one", res.status === 404, show(res));

  // --- the panel's own address -------------------------------------------------------------
  res = await owner.call("/api/settings", json("PUT", { preferences: { panel_public_url: "https://panel.esempio.it" } }));
  r.check("the panel's address is set", res.status === 200, show(res));
  await owner.call(`/api/projects/${otherId}`, json("PATCH", { port: 3457 }));
  res = await owner.call(`/api/projects/${otherId}/hosts`, json("POST", { domainId, subdomain: "panel" }));
  r.check("a project cannot take the panel's address", res.status === 409, show(res));

  // --- the panel's own name over HTTPS ---------------------------------------------------------
  // Like the rest, only the contract: a test instance never writes nginx.
  res = await owner.call("/api/panel-https");
  r.check("the panel starts with no HTTPS name", res.status === 200 && res.body.panelHost === null && res.body.adopted === false, show(res));
  r.check("and says where it stays reachable", Array.isArray(res.body.direct) && typeof res.body.port === "number" && res.body.proxy?.state === "disabled", show(res));
  r.check("its own domains are offered for the name", res.body.domains?.some((domain) => domain.id === domainId), show(res));
  res = await owner.call("/api/panel-https", json("PUT", { domainId, subdomain: "pannello" }));
  r.check("a name is refused while the proxy is disabled", res.status === 409 && typeof res.body.error === "string", show(res));
  res = await owner.call("/api/panel-https", json("PUT", { hostname: "app.203-0-113-7.sslip.io" }));
  r.check("a test address is never the panel's name", res.status === 409 && /sslip/.test(res.body.error ?? ""), show(res));
  res = await owner.call("/api/panel-https", json("PUT", { hostname: "app.esempio.it" }));
  r.check("nor a project's name", res.status === 409, show(res));
  for (const [label, body] of [
    ["no name at all", {}],
    ["a name that is no domain", { hostname: "localhost" }],
    ["both a domain and a whole name", { domainId, subdomain: "pannello", hostname: "pannello.esempio.it" }],
    ["an unknown field", { hostname: "pannello.esempio.it", port: 80 }],
  ]) {
    res = await owner.call("/api/panel-https", json("PUT", body));
    r.check(`${label} is a 400`, res.status === 400, show(res));
  }
  for (const [method, path] of [
    ["GET", "/api/panel-https/dns"],
    ["GET", "/api/panel-https/verify"],
    ["POST", "/api/panel-https/certificate"],
    ["POST", "/api/panel-https/public-url"],
    ["DELETE", "/api/panel-https"],
  ]) {
    res = await owner.call(path, { method });
    r.check(`${method} ${path} without a name is a 404`, res.status === 404, show(res));
  }

  // --- a test address without a domain ----------------------------------------------------------
  res = await owner.call(`/api/projects/${otherId}/hosts/instant`);
  r.check(
    "a test address says why it is not offered while the proxy is disabled",
    res.status === 200 && res.body.available === false && typeof res.body.reason === "string" && res.body.provider === "sslip.io",
    show(res)
  );
  r.check("with a label to start from", typeof res.body.suggestedLabel === "string" && res.body.suggestedLabel.length > 0, show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts/instant`, json("POST", { label: "altro" }));
  r.check("and is not created", res.status === 409, show(res));
  for (const bad of ["", "a.b", "-x"]) {
    res = await owner.call(`/api/projects/${otherId}/hosts/instant`, json("POST", { label: bad }));
    r.check(`the test label ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }

  // --- the domain itself ---------------------------------------------------------------------
  res = await owner.call(`/api/projects/${otherId}/hosts`, json("POST", { domainId, subdomain: "" }));
  r.check("an empty subdomain assigns the domain itself", res.status === 201 && res.body.host?.hostname === "esempio.it", show(res));
  const apexId = res.body.host?.id;
  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: " " }));
  r.check("the domain itself is assigned once", res.status === 409, show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts/${apexId}`, { method: "DELETE" });
  r.check("and is removed like any name", res.status === 200, show(res));

  // --- the www twin ------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${otherId}/hosts`, json("POST", { domainId, subdomain: "", www: true }));
  const withTwin = res.body;
  r.check(
    "the domain itself can come with its www, redirecting to it",
    res.status === 201 && withTwin.host?.hostname === "esempio.it" && withTwin.twin?.hostname === "www.esempio.it" && withTwin.twin.redirectTo === withTwin.host.id,
    show(res)
  );
  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "www" }));
  r.check("the twin's name is taken like any other", res.status === 409, show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "shop", www: true }));
  r.check("a www twin for any other subdomain is a 400", res.status === 400, show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts/${withTwin.twin?.id}`, json("PATCH", { publicAccess: true }));
  r.check("a twin's own access is refused: it only redirects", res.status === 400, show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts/${withTwin.host?.id}/dns`);
  r.check(
    "the DNS check covers the twin too",
    res.status === 200 && res.body.names?.length === 2 && res.body.names[1].hostname === "www.esempio.it",
    show(res)
  );

  res = await owner.call(`/api/projects/${otherId}/hosts/${withTwin.host?.id}`, json("PATCH", { www: false }));
  r.check("the twin can be taken away", res.status === 200 && res.body.twin === null, show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts`);
  r.check("and is gone", res.body.hosts?.length === 1 && res.body.hosts[0].hostname === "esempio.it", show(res));
  res = await owner.call(`/api/projects/${otherId}/hosts/${withTwin.host?.id}`, json("PATCH", { www: true }));
  r.check("and given back", res.status === 200 && res.body.twin?.hostname === "www.esempio.it", show(res));

  res = await owner.call(`/api/projects/${otherId}/hosts/${withTwin.host?.id}`, { method: "DELETE" });
  r.check(
    "removing the name takes its twin with it",
    res.status === 200 && res.body.removed?.includes("www.esempio.it") && res.body.removed.includes("esempio.it"),
    show(res)
  );
  res = await owner.call(`/api/projects/${otherId}/hosts`);
  r.check("so nothing is left redirecting into nothing", res.body.hosts?.length === 0, show(res));

  // --- the Let's Encrypt email ------------------------------------------------------------------
  res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: "op@esempio.it" }));
  r.check("the email is saved", res.status === 200, show(res));
  res = await owner.call("/api/domains");
  r.check("and read back", res.body.acmeEmail === "op@esempio.it", show(res));
  for (const bad of ["not-an-email", "-x@esempio.it", "a b@esempio.it"]) {
    res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: bad }));
    r.check(`the email ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: "" }));
  r.check("an empty email clears it", res.status === 200, show(res));

  // --- Cloudflare ---------------------------------------------------------------------------------
  // Only what never reaches Cloudflare: a well-formed token would be tried against the real API.
  res = await owner.call("/api/domains");
  r.check(
    "Cloudflare starts disconnected, with no domain on it",
    res.body.cloudflare?.connected === false && res.body.domains?.every((domain) => domain.cloudflare === false),
    show(res)
  );
  for (const bad of ["", "too-short", "a token with spaces in the middle of it", "line-one-of-a-token\nline-two"]) {
    res = await owner.call("/api/domains/cloudflare", json("PUT", { token: bad }));
    r.check(`the token ${JSON.stringify(bad.slice(0, 16))} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call("/api/domains/cloudflare", { method: "PUT", body: "{" });
  r.check("a token body that is not JSON is a 400", res.status === 400, show(res));
  res = await owner.call("/api/domains/cloudflare", { method: "DELETE" });
  r.check("disconnecting with nothing connected is fine", res.status === 200 && res.body.cloudflare?.connected === false, show(res));

  // --- who may do what ----------------------------------------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "dev@example.test", hours: 1 }));
  const devId = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const dev = client(base);
  await dev.call("/api/auth/invite", json("POST", { token, password: "dev-password-1" }));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } })
  );
  res = await dev.call("/api/domains");
  r.check("without the host permission the Domains page is refused", res.status === 403, show(res));
  res = await dev.call("/api/domains", json("POST", { name: "altro.it" }));
  r.check("and so is adding a domain", res.status === 403, show(res));
  res = await dev.call("/api/domains/cloudflare", json("PUT", { token: "x".repeat(40) }));
  r.check("and connecting Cloudflare", res.status === 403, show(res));
  res = await dev.call("/api/domains/cloudflare", { method: "DELETE" });
  r.check("and disconnecting it", res.status === 403, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts`);
  r.check("reading a project shows its names", res.status === 200 && res.body.canManageDomains === false, show(res));
  r.check("but not the commands of the setup", res.body.proxy && !("commands" in res.body.proxy) && res.body.panelHostname === null, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts/${hostId}/dns`);
  r.check("reading a project can check its names' DNS", res.status === 200 && res.body.names?.[0]?.hostname === "app.esempio.it", show(res));
  res = await dev.call(`/api/projects/${otherId}/hosts/${hostId}/dns`);
  r.check("not through a project it cannot see", res.status === 404, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "dev" }));
  r.check("read access cannot assign a name", res.status === 403, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts/instant`, json("POST", { label: "dev" }));
  r.check("nor a test address", res.status === 403, show(res));
  res = await dev.call("/api/panel-https");
  r.check("the panel's HTTPS name is the owner's alone", res.status === 403, show(res));
  res = await dev.call("/api/panel-https", json("PUT", { hostname: "pannello.esempio.it" }));
  r.check("and so is choosing it", res.status === 403, show(res));
  res = await dev.call(`/api/projects/${otherId}/hosts`);
  r.check("a project the account cannot see answers 404", res.status === 404, show(res));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "manage", terminal: false }] } })
  );
  res = await dev.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "dev" }));
  r.check("managing the project is not enough to assign a name", res.status === 403, show(res));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: ["host"], grants: [{ scope: "project", scopeId: projectId, level: "manage", terminal: false }] } })
  );
  res = await dev.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "dev" }));
  r.check("with the host permission too it can", res.status === 201, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts/${res.body.host?.id}`, { method: "DELETE" });
  r.check("and remove it", res.status === 200, show(res));

  // --- removal ---------------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, { method: "DELETE" });
  r.check("a name is removed", res.status === 200, show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts`);
  r.check("and is gone", res.body.hosts?.length === 0, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("a removed name can be assigned again", res.status === 201, show(res));
  res = await owner.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("the project is deleted", res.status === 200, show(res));
  res = await owner.call("/api/domains");
  r.check(
    "its names went with it",
    res.body.hosts?.length === 0 && res.body.domains?.find((d) => d.id === domainId)?.hostCount === 0,
    show(res)
  );

  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("an unused domain is removed", res.status === 200, show(res));
  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("removing it again is a 404", res.status === 404, show(res));

  return r.result();
}
