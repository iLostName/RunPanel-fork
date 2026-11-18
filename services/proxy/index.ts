import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import http from "http";
import path from "path";
import { getDb, nowIso } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { PANEL_PUBLIC_URL_SETTING } from "@/lib/panel-url";
import { generateId } from "@/lib/utils";
import { listenPort, readAccess } from "@/lib/access-columns";
import { compileRules } from "@/lib/ip-access";
import { checkDns, routingCouldHelp, unmatchedAddresses, type DnsCheck, type DnsState } from "@/lib/dns-check";
import type { ProjectHostsTable } from "@/lib/db/schema";
import { certificateState, explainCertificateError } from "./certificate";
import { isCloudflareAddress, isPublicAddress, resolvePublicly, serverAddresses, type KnownAddresses } from "./dns";
import {
  PREVIOUS_SITES_DIR,
  STAGED_SITES_DIR,
  certbot,
  nginx,
  proxyProbeCache,
  recoverInterruptedSwap,
  setUpAsRoot,
  type ProxyProbe,
} from "./host";
import {
  CERTBOT_DIR,
  CHECK_PATH,
  CLOUDFLARE_HOOK_PATH,
  CLOUDFLARE_TOKEN_ENV,
  SITES_DIR,
  blamedNames,
  certbotDeleteArgs,
  certbotFailure,
  certbotIssueArgs,
  certbotRenewArgs,
  certificatePaths,
  conflictingNames,
  htpasswdFileName,
  renderCloudflareHook,
  renderHtpasswd,
  renderSite,
  renewalChallenge,
  renewalConfPath,
  siteFileName,
  type Challenge,
  type SiteInput,
} from "./render";
import { cloudflareToken, cloudflareZones, linkDomains, type CloudflareZone } from "./cloudflare";

export { publicAddresses, serverAddresses } from "./dns";

/**
 * Domains, end to end: the store says which names exist, this makes nginx and
 * certbot agree.
 *
 * Every change is applied the same way — render every block from the store,
 * swap the whole directory, `nginx -t`, reload, or put the previous directory
 * back. Nothing is edited in place, so a name that was deleted cannot linger
 * and a half-written file can never be what nginx loads.
 */

export const ACME_EMAIL_SETTING = "proxy_acme_email";

/** The last DNS verdict taken for a name, by the page or by the sweep. */
interface DnsSeen {
  state: DnsState;
  ready: boolean;
  at: number;
}

const globalRef = globalThis as typeof globalThis & {
  __runpanelProxyChain?: Promise<unknown>;
  __runpanelProxyIssuing?: Set<string>;
  __runpanelProxyDnsSeen?: Map<string, DnsSeen>;
  __runpanelProxyDnsChecks?: Map<string, Promise<HostDnsReport>>;
  __runpanelProxyRenewTimer?: NodeJS.Timeout;
  __runpanelProxyRenewFirst?: NodeJS.Timeout;
  __runpanelProxyDnsTimer?: NodeJS.Timeout;
};

/** certbot only renews what is within 30 days of expiry; twice a day is what its own timer does. */
const RENEW_EVERY_MS = 12 * 60 * 60 * 1000;
const RENEW_FIRST_MS = 5 * 60 * 1000;

/**
 * How often a name still waiting for its record is looked up again: often
 * while it is new and someone is probably at their DNS provider, then less, so
 * a name nobody finished setting up costs two queries an hour, not thirty.
 */
const DNS_SWEEP_MS = 2 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function dnsRecheckAfter(ageMs: number): number {
  if (ageMs < 60 * MINUTE_MS) return 2 * MINUTE_MS;
  if (ageMs < 24 * 60 * MINUTE_MS) return 10 * MINUTE_MS;
  return 60 * MINUTE_MS;
}

const issuing = (globalRef.__runpanelProxyIssuing ??= new Set<string>());
const dnsSeen = (globalRef.__runpanelProxyDnsSeen ??= new Map<string, DnsSeen>());
const dnsChecks = (globalRef.__runpanelProxyDnsChecks ??= new Map<string, Promise<HostDnsReport>>());

/**
 * One apply at a time. Two overlapping ones would rename the same directory
 * under each other, and the loser's `nginx -t` would test the winner's files.
 */
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalRef.__runpanelProxyChain ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  globalRef.__runpanelProxyChain = next.catch(() => undefined);
  return next;
}

export function newCheckToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function proxyProbe(fresh = false): Promise<ProxyProbe> {
  return proxyProbeCache.get({ fresh });
}

/** Whether nginx can take a configuration. Without certbot it serves HTTP only. */
export function canApply(found: ProxyProbe): boolean {
  return found.state === "ready" || found.state === "no-certbot";
}

export function isIssuing(hostId: string): boolean {
  return issuing.has(hostId);
}

/** One name as the pages show it. */
export function hostView(row: ProjectHostsTable & { project_name?: string }) {
  // A request in flight in this process outranks whatever the row says.
  const status = issuing.has(row.id) ? "issuing" : row.status;
  const certificate = certificateState(status, row.cert_expires_at);
  const seen = status === "pending" ? dnsSeen.get(row.id) : undefined;
  return {
    id: row.id,
    hostname: row.hostname,
    subdomain: row.subdomain,
    domainId: row.domain_id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    status,
    /** `status` and the expiry read together: what a badge next to the name says. */
    certificate: certificate.state,
    certificateDaysLeft: certificate.daysLeft,
    lastError: row.last_error,
    /** `lastError` in plain words, when Let's Encrypt's own have a better reading. */
    explanation: status === "error" ? explainCertificateError(row.last_error) : null,
    applyError: row.apply_error,
    certExpiresAt: row.cert_expires_at,
    publicAccess: row.public_access === 1,
    // Who the password is for; the hash never leaves the server.
    authUser: row.auth_hash ? row.auth_user : null,
    /** The name it sends its visitors on to — the www twin of another of the project's names — or null. */
    redirectTo: row.redirect_to,
    /** What the last look at its DNS found, while it waits for a certificate. */
    dns: seen ? { state: seen.state, ready: seen.ready } : null,
    createdAt: row.created_at,
  };
}

export type HostView = ReturnType<typeof hostView>;

/**
 * Why a name cannot be given to a project, or null. Which project holds it is
 * not said: it may be one the account cannot see.
 */
export async function addressProblem(hostname: string): Promise<string | null> {
  const db = await getDb();
  if (await db.selectFrom("project_hosts").select("id").where("hostname", "=", hostname).executeTakeFirst()) {
    return `${hostname} è già assegnato.`;
  }
  const panelUrl = await getSetting(PANEL_PUBLIC_URL_SETTING);
  if (panelUrl && URL.canParse(panelUrl) && new URL(panelUrl).hostname.toLowerCase() === hostname) {
    return `${hostname} è l'indirizzo del pannello.`;
  }
  return null;
}

/** A new name as the store keeps it: pending, with its own token, and no password. */
export function newHostRow(input: {
  projectId: string;
  domainId: string;
  subdomain: string;
  hostname: string;
  publicAccess: boolean;
  redirectTo?: string | null;
}): ProjectHostsTable {
  const now = nowIso();
  return {
    id: generateId(),
    project_id: input.projectId,
    domain_id: input.domainId,
    subdomain: input.subdomain,
    hostname: input.hostname,
    public_access: input.publicAccess ? 1 : 0,
    check_token: newCheckToken(),
    status: "pending",
    last_error: null,
    apply_error: null,
    cert_expires_at: null,
    auth_user: null,
    auth_hash: null,
    redirect_to: input.redirectTo ?? null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * After names were added: their certificates once their DNS is right, or —
 * with nginx up but no certbot — at least their blocks, served over HTTP.
 * Without nginx they wait for the Domains page, whose setup asks for them.
 */
export async function serveNewHosts(hostIds: string[]): Promise<ProxyProbe> {
  const found = await proxyProbe();
  if (found.state === "ready") issueWhenReady(hostIds);
  else if (canApply(found)) applyProxySoon();
  return found;
}

function lastLines(output: string, count = 3): string {
  return output.split(/\r?\n/).filter(Boolean).slice(-count).join(" ").slice(0, 400);
}

async function loadHosts() {
  const db = await getDb();
  return db
    .selectFrom("project_hosts")
    .innerJoin("projects", "projects.id", "project_hosts.project_id")
    .innerJoin("domains", "domains.id", "project_hosts.domain_id")
    .select([
      "project_hosts.id",
      "project_hosts.hostname",
      "project_hosts.public_access",
      "project_hosts.auth_user",
      "project_hosts.auth_hash",
      "project_hosts.check_token",
      "project_hosts.status",
      "project_hosts.project_id",
      "project_hosts.redirect_to",
      "projects.port",
      "projects.access_mode",
      "projects.access_allow",
      "projects.access_port",
      "domains.cloudflare",
    ])
    .orderBy("project_hosts.hostname")
    .execute();
}

type HostRow = Awaited<ReturnType<typeof loadHosts>>[number];

/**
 * Who else listens on each port: the panel, every service, every project, by
 * its public port and by the loopback one its gate moved it to.
 *
 * `port` is a number the project's `settings` grant may set to anything, and
 * nginx proxies to it with a valid certificate. Without this a name could
 * publish the panel itself, or another project's real listener past its allow
 * list. The value is the owning project, null for the panel and services.
 */
export async function claimedPorts(): Promise<Map<number, string | null>> {
  const db = await getDb();
  const [projects, services] = await Promise.all([
    db.selectFrom("projects").select(["id", "port", "access_port"]).execute(),
    db.selectFrom("services").select(["port", "access_port"]).execute(),
  ]);
  const claimed = new Map<number, string | null>();
  const claim = (port: number | null, owner: string | null) => {
    if (!port) return;
    // A port two owners share is nobody's to proxy to.
    claimed.set(port, claimed.has(port) && claimed.get(port) !== owner ? null : owner);
  };
  claim(getEnv().port, null);
  for (const service of services) {
    claim(service.port, null);
    claim(service.access_port, null);
  }
  for (const project of projects) {
    claim(project.port, project.id);
    claim(project.access_port, project.id);
  }
  return claimed;
}

/** Why a project may not be proxied to `port`, or null when the port is its own. */
export function upstreamConflict(claimed: Map<number, string | null>, projectId: string, port: number): string | null {
  if (!claimed.has(port) || claimed.get(port) === projectId) return null;
  return port === getEnv().port
    ? "La porta del progetto è quella del pannello: un nome non può pubblicarlo."
    : `La porta ${port} appartiene a un altro progetto o servizio: un nome può servire solo il proprio.`;
}

function certificateOnDisk(hostname: string): { fullchain: string; privkey: string } | null {
  const paths = certificatePaths(hostname);
  return fs.existsSync(paths.fullchain) && fs.existsSync(paths.privkey) ? paths : null;
}

function certificateExpiry(fullchain: string): string | null {
  try {
    return new Date(new crypto.X509Certificate(fs.readFileSync(fullchain)).validTo).toISOString();
  } catch {
    return null;
  }
}

/**
 * The block for one name, or why there is none.
 *
 * The upstream is the app's real listener, not the port the gate holds: nginx
 * talks to it over loopback, which the gate would let through anyway, and
 * going straight there keeps the sites up while the panel restarts. So the
 * allow list has to be nginx's job — otherwise a restricted project would be
 * one domain away from open to everyone.
 *
 * A twin that only redirects gets neither the allow list nor the password:
 * it hands out nothing but the other name, which applies both.
 */
function siteFor(
  found: ProxyProbe,
  row: HostRow,
  withoutCertificate: boolean,
  claimed: Map<number, string | null>,
  redirect: SiteInput["redirect"] = null
): SiteInput | string {
  if (!row.port) return "Il progetto non ha una porta: non c'è niente da servire.";
  const access = readAccess(row);
  const allow =
    access.mode === "restricted" && !row.public_access && !redirect
      ? compileRules(access.allow).map((rule) => rule.text)
      : null;
  const upstreamPort = listenPort(row, row.port);
  const conflict = upstreamConflict(claimed, row.project_id, upstreamPort);
  if (conflict) return conflict;

  return {
    hostname: row.hostname,
    upstreamPort,
    allow,
    certificate: withoutCertificate ? null : certificateOnDisk(row.hostname),
    checkToken: row.check_token,
    ipv6: found.ipv6,
    http2: found.nginx.http2,
    cloudflare: row.cloudflare === 1,
    auth: row.auth_user && row.auth_hash && !redirect ? { user: row.auth_user, hash: row.auth_hash } : null,
    redirect,
  };
}

/** Write the new set beside the live one and swap them; the old one stays until committed. */
function stage(files: Map<string, string>): { commit: () => void; rollback: () => void } {
  // Before anything is removed: after a swap cut short, the previous set is the only copy.
  recoverInterruptedSwap();
  fs.rmSync(STAGED_SITES_DIR, { recursive: true, force: true });
  fs.rmSync(PREVIOUS_SITES_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGED_SITES_DIR, { mode: 0o755 });
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(STAGED_SITES_DIR, name), content, { mode: 0o644 });
  }
  fs.renameSync(SITES_DIR, PREVIOUS_SITES_DIR);
  fs.renameSync(STAGED_SITES_DIR, SITES_DIR);

  return {
    commit() {
      fs.rmSync(PREVIOUS_SITES_DIR, { recursive: true, force: true });
    },
    rollback() {
      fs.rmSync(SITES_DIR, { recursive: true, force: true });
      fs.renameSync(PREVIOUS_SITES_DIR, SITES_DIR);
    },
  };
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

async function writeAndReload(found: ProxyProbe): Promise<ApplyResult> {
  const [rows, claimed] = await Promise.all([loadHosts(), claimedPorts()]);
  const ours = new Set(rows.map((row) => row.hostname));
  const byId = new Map(rows.map((row) => [row.id, row]));
  // The names that serve the app first: a twin's block says where it sends
  // visitors, and over which scheme, so it is written after its target's.
  const ordered = [...rows.filter((row) => !row.redirect_to), ...rows.filter((row) => row.redirect_to)];
  /** Not served at all, and why. */
  const left = new Map<string, string>();
  /** Served over HTTP only, because nginx could not load the certificate. */
  const httpOnly = new Map<string, string>();

  // Each failed test that nginx blames on one of these names sets that name
  // aside and tries again, so one broken name cannot hold back the rest. A
  // refusal it blames on nothing of ours is the operator's nginx being broken,
  // and nothing gets applied over it.
  for (let attempt = 0; attempt <= rows.length; attempt++) {
    const files = new Map<string, string>();
    const written = new Map<string, SiteInput>();
    for (const row of ordered) {
      if (left.has(row.hostname)) continue;
      let redirect: SiteInput["redirect"] = null;
      if (row.redirect_to) {
        const target = byId.get(row.redirect_to);
        const targetSite = target ? written.get(target.id) : undefined;
        if (!target || !targetSite) {
          // Sending visitors to a name nginx does not serve would be a redirect into nothing.
          left.set(
            row.hostname,
            target
              ? `Rimanda a ${target.hostname}, che ora non è servito: si sistema da solo quando torna.`
              : "Rimandava a un indirizzo che non c'è più: rimuovilo."
          );
          continue;
        }
        redirect = { hostname: target.hostname, https: targetSite.certificate !== null };
      }
      const site = siteFor(found, row, httpOnly.has(row.hostname), claimed, redirect);
      if (typeof site === "string") {
        left.set(row.hostname, site);
        continue;
      }
      written.set(row.id, site);
      files.set(siteFileName(row.hostname), renderSite(site));
      if (site.auth) files.set(htpasswdFileName(row.hostname), renderHtpasswd(site.auth));
    }

    const swap = stage(files);
    const test = await nginx(found, "test");
    const fresh = (name: string) => ours.has(name) && !left.has(name);
    const conflicts = conflictingNames(test.output).filter(fresh);

    if (test.ok && conflicts.length === 0) {
      const reload = await nginx(found, "reload");
      if (!reload.ok) {
        swap.rollback();
        return { ok: false, message: `nginx non si è ricaricato: ${lastLines(reload.output)}` };
      }
      swap.commit();
      await recordApplied(rows, left, httpOnly);
      return {
        ok: true,
        message: left.size === 0 ? "Configurazione applicata." : `Applicata, tranne ${[...left.keys()].join(", ")}.`,
      };
    }

    swap.rollback();
    const blamed = test.ok ? { blocks: [], certificates: [] } : blamedNames(test.output);
    const certificates = blamed.certificates.filter((name) => fresh(name) && !httpOnly.has(name));
    const blocks = blamed.blocks.filter(fresh);
    if (conflicts.length === 0 && certificates.length === 0 && blocks.length === 0) {
      return { ok: false, message: `nginx ha rifiutato la configurazione: ${lastLines(test.output)}` };
    }

    for (const name of conflicts) {
      left.set(name, "Questo indirizzo lo serve già un'altra configurazione di nginx: toglilo da lì o scegline un altro.");
    }
    for (const name of certificates) {
      httpOnly.set(
        name,
        "nginx non riesce a caricare il certificato di questo indirizzo, quindi è servito in HTTP. Rimuovi l'indirizzo e aggiungilo di nuovo per averne uno nuovo."
      );
    }
    for (const name of blocks) {
      left.set(name, `nginx rifiuta il blocco di questo indirizzo: ${lastLines(test.output, 1)}`);
    }
  }
  return { ok: false, message: "nginx ha rifiutato la configurazione." };
}

/** What the apply did to each name, and the certificate each one has on disk now. */
async function recordApplied(rows: HostRow[], left: Map<string, string>, httpOnly: Map<string, string>): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  for (const row of rows) {
    const reason = left.get(row.hostname) ?? httpOnly.get(row.hostname) ?? null;
    const certificate = reason ? null : certificateOnDisk(row.hostname);
    const update: Partial<ProjectHostsTable> = { apply_error: reason, updated_at: now };
    if (certificate) {
      Object.assign(update, { status: "active", last_error: null, cert_expires_at: certificateExpiry(certificate.fullchain) });
    } else if (row.status === "active") {
      // It was served over HTTPS and its files are gone: it needs a new one.
      Object.assign(update, { status: "pending", cert_expires_at: null });
    }
    await db.updateTable("project_hosts").set(update).where("id", "=", row.id).execute();
  }
}

/** Make nginx serve exactly what the store says. Safe to call after any change. */
export function applyProxy(): Promise<ApplyResult> {
  return serialised(async () => {
    const found = await proxyProbe();
    if (!canApply(found)) return { ok: false, message: found.detail };
    try {
      return await writeAndReload(found);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Apply after a change elsewhere — a port, an access rule, a deleted project —
 * without making that change wait for, or fail on, nginx.
 */
export function applyProxySoon(): void {
  void applyProxy().then((result) => {
    if (!result.ok) console.warn(`[proxy] ${result.message}`);
  });
}

export interface RoutingCheck {
  reaches: boolean;
  addresses: string[];
  detail: string;
}

/**
 * Does the name reach this nginx? Asked of the name itself, over HTTP, for the
 * token only this server's block answers — which is the one question the
 * operator has, and works the same behind NAT as on a public address.
 *
 * Only advisory: a server that cannot reach its own public address (NAT
 * without hairpinning) fails this and still gets its certificate, because
 * Let's Encrypt asks from outside.
 */
export async function checkRouting(hostname: string, token: string, timeoutMs = 5_000): Promise<RoutingCheck> {
  let addresses: string[] = [];
  try {
    addresses = (await dns.promises.lookup(hostname, { all: true })).map((entry) => entry.address);
  } catch {
    return { reaches: false, addresses, detail: `${hostname} non risolve: manca il record DNS.` };
  }

  try {
    const res = await fetch(`http://${hostname}${CHECK_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      cache: "no-store",
    });
    const body = (await res.text()).trim();
    if (res.ok && body === token) {
      return { reaches: true, addresses, detail: `${hostname} arriva a questo server.` };
    }
    return {
      reaches: false,
      addresses,
      detail: `${hostname} risolve a ${addresses.join(", ")}, ma lì risponde un altro server.`,
    };
  } catch {
    return {
      reaches: false,
      addresses,
      detail: `${hostname} risolve a ${addresses.join(", ")}, ma da qui non risponde. Se il server è dietro NAT può essere normale.`,
    };
  }
}

export interface HostDnsReport {
  hostId: string;
  hostname: string;
  check: DnsCheck;
  server: KnownAddresses;
  /** Who answered: the public resolvers, or this machine's own when those were out of reach. */
  via: "public" | "system";
  resolvers: string[];
  /** The routing check's answer, when it was asked. */
  reaches: boolean | null;
  checkedAt: string;
}

/** What a look at a name's DNS needs to know about it. */
export interface DnsSubject {
  id: string;
  hostname: string;
  check_token: string;
  apply_error: string | null;
  /** 0 | 1, from its domain. */
  cloudflare: number;
}

/**
 * Whether `address`, asked for `hostname` on port 80 the way Let's Encrypt
 * asks, hands back this nginx's token. One address at a time, rather than a
 * fetch of the name: that would go through this machine's resolver — an
 * `/etc/hosts` line, a split-horizon DNS — and over whichever family it
 * likes, and prove nothing about the address the rest of the internet gets.
 */
export function answersToken(address: string, hostname: string, token: string, timeoutMs: number, port = 80): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: address,
        port,
        path: CHECK_PATH,
        method: "GET",
        headers: { Host: hostname },
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 256) body += chunk;
        });
        res.on("end", () => resolve(res.statusCode === 200 && body.trim() === token));
        res.on("error", () => resolve(false));
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Every address the name resolves to that the server does not know as its
 * own, each asked for the token. A private or loopback address never counts:
 * it would answer from here and from nowhere else.
 */
async function everyAddressReaches(addresses: string[], hostname: string, token: string): Promise<boolean> {
  if (addresses.length === 0 || addresses.length > 6) return false;
  if (!addresses.every((address) => isPublicAddress(address, address.includes(":") ? "IPv6" : "IPv4"))) return false;
  const answers = await Promise.all(addresses.map((address) => answersToken(address, hostname, token, 4_000)));
  return answers.every(Boolean);
}

async function takeDnsReport(subject: DnsSubject, found: ProxyProbe, fresh: boolean): Promise<HostDnsReport> {
  const [answers, server] = await Promise.all([resolvePublicly(subject.hostname), serverAddresses(fresh)]);
  const input = {
    a: answers.a,
    aaaa: answers.aaaa,
    server,
    cloudflareLinked: subject.cloudflare === 1,
    isCloudflareAddress,
  };
  let check = checkDns(input);
  let reaches: boolean | null = null;
  // Only a name nginx serves can hand its token back.
  if (routingCouldHelp(check) && canApply(found) && !subject.apply_error) {
    reaches = await everyAddressReaches(unmatchedAddresses(check), subject.hostname, subject.check_token);
    if (reaches) check = checkDns({ ...input, reaches });
  }
  dnsSeen.set(subject.id, { state: check.state, ready: check.ready, at: Date.now() });
  return {
    hostId: subject.id,
    hostname: subject.hostname,
    check,
    server,
    via: answers.via,
    resolvers: answers.servers,
    reaches,
    checkedAt: nowIso(),
  };
}

/**
 * Look a name up now. Two pages polling the same name share one look instead
 * of doubling the queries; nothing is kept once it is answered, so the next
 * question gets a new answer.
 */
export function hostDnsReport(subject: DnsSubject, found: ProxyProbe, fresh = false): Promise<HostDnsReport> {
  const running = dnsChecks.get(subject.id);
  if (running) return running;
  const report = takeDnsReport(subject, found, fresh).finally(() => dnsChecks.delete(subject.id));
  dnsChecks.set(subject.id, report);
  return report;
}

/** These names, or every one still waiting for its first certificate. */
async function loadDnsSubjects(hostIds?: string[]) {
  const db = await getDb();
  let query = db
    .selectFrom("project_hosts")
    .innerJoin("domains", "domains.id", "project_hosts.domain_id")
    .select([
      "project_hosts.id",
      "project_hosts.hostname",
      "project_hosts.check_token",
      "project_hosts.apply_error",
      "project_hosts.status",
      "project_hosts.created_at",
      "domains.cloudflare",
    ]);
  query = hostIds ? query.where("project_hosts.id", "in", hostIds) : query.where("project_hosts.status", "=", "pending");
  return query.execute();
}

/**
 * Ask for these names' certificates once their DNS leads here, in the
 * background. A name that is not ready yet stays pending and the sweep looks
 * again, so adding an address before its record exists no longer spends one
 * of the failed validations Let's Encrypt allows per name and hour.
 */
export function issueWhenReady(hostIds: string[]): void {
  if (hostIds.length === 0) return;
  void (async () => {
    const found = await proxyProbe();
    if (found.state !== "ready") return;
    // The HTTP blocks first: the routing check below needs them live.
    await applyProxy();
    for (const subject of await loadDnsSubjects(hostIds)) {
      if (subject.status !== "pending" || issuing.has(subject.id)) continue;
      const report = await hostDnsReport(subject, found);
      if (report.check.ready) issueCertificate(subject.id);
    }
  })().catch((err) => console.warn(`[proxy] ${err instanceof Error ? err.message : String(err)}`));
}

/** Every name waiting for its first certificate, looked at when it is due. */
async function sweepWaiting(): Promise<void> {
  const found = await proxyProbe();
  if (found.state !== "ready") return;
  const now = Date.now();
  for (const [id, seen] of dnsSeen) {
    if (now - seen.at > 24 * 60 * MINUTE_MS) dnsSeen.delete(id);
  }
  for (const subject of await loadDnsSubjects()) {
    if (subject.status !== "pending" || subject.apply_error || issuing.has(subject.id)) continue;
    const age = now - Date.parse(subject.created_at);
    const seen = dnsSeen.get(subject.id);
    if (seen && now - seen.at < dnsRecheckAfter(Number.isNaN(age) ? 0 : age)) {
      // A page looked a moment ago: its answer is as good as one taken now.
      if (seen.ready) issueCertificate(subject.id);
      continue;
    }
    const report = await hostDnsReport(subject, found);
    if (report.check.ready) issueCertificate(subject.id);
  }
}

async function setHost(hostId: string, values: Partial<ProjectHostsTable>): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("project_hosts")
    .set({ ...values, updated_at: nowIso() })
    .where("id", "=", hostId)
    .execute();
}

/**
 * What certbot needs for a domain on Cloudflare: its hook, written again, and
 * the token for its environment. Null without a token the panel can read.
 */
async function cloudflareEnv(): Promise<Record<string, string> | null> {
  const token = await cloudflareToken();
  if (!token) return null;
  fs.mkdirSync(CERTBOT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CLOUDFLARE_HOOK_PATH, renderCloudflareHook(), { mode: 0o600 });
  return { [CLOUDFLARE_TOKEN_ENV]: token };
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function issue(hostId: string): Promise<void> {
  const found = await proxyProbe();
  if (found.state !== "ready") {
    await setHost(hostId, { status: "error", last_error: found.detail });
    return;
  }

  const db = await getDb();
  const row = await db
    .selectFrom("project_hosts")
    .innerJoin("domains", "domains.id", "project_hosts.domain_id")
    .selectAll("project_hosts")
    .select("domains.cloudflare")
    .where("project_hosts.id", "=", hostId)
    .executeTakeFirst();
  if (!row) return;
  await setHost(hostId, { status: "issuing", last_error: null });

  // The HTTP block has to be live before Let's Encrypt comes for the challenge.
  const applied = await applyProxy();
  const served = await db.selectFrom("project_hosts").select("apply_error").where("id", "=", hostId).executeTakeFirst();
  if (!served) return;
  if (!applied.ok || served.apply_error) {
    await setHost(hostId, { status: "error", last_error: served.apply_error ?? applied.message });
    return;
  }

  // On Cloudflare the proof is a TXT record, so the name does not have to reach
  // this server for it — and behind Cloudflare's proxy it would not.
  const challenge: Challenge = row.cloudflare === 1 ? "cloudflare" : "http";
  const env = challenge === "cloudflare" ? await cloudflareEnv() : null;
  if (challenge === "cloudflare" && !env) {
    await setHost(hostId, {
      status: "error",
      last_error: "Il dominio è su Cloudflare, ma il pannello non ha più il token: ricollegalo dalla pagina Domini.",
    });
    return;
  }
  const routing = challenge === "http" ? await checkRouting(row.hostname, row.check_token) : null;
  const email = (await getSetting(ACME_EMAIL_SETTING))?.trim() || null;
  const result = await certbot(found, certbotIssueArgs(row.hostname, email, challenge), env ?? undefined);

  const still = await db.selectFrom("project_hosts").select("id").where("id", "=", hostId).executeTakeFirst();
  if (!still) {
    // Deleted while certbot was working: nothing is left to use what it issued.
    if (result.ok) await certbot(found, certbotDeleteArgs(row.hostname));
    return;
  }
  if (!result.ok) {
    const why = certbotFailure(result.output);
    await setHost(hostId, { status: "error", last_error: !routing || routing.reaches ? why : `${routing.detail} ${why}` });
    return;
  }

  // Now with the certificate: the same apply writes the HTTPS block and marks it active.
  const withTls = await applyProxy();
  if (!withTls.ok) await setHost(hostId, { status: "error", last_error: withTls.message });
}

/**
 * Ask for a certificate in the background. A request takes seconds to a
 * minute, so the route answers at once and the page follows `status`.
 */
export function issueCertificate(hostId: string): void {
  if (issuing.has(hostId)) return;
  issuing.add(hostId);
  void issue(hostId)
    .catch(async (err) => {
      await setHost(hostId, { status: "error", last_error: err instanceof Error ? err.message : String(err) }).catch(
        () => undefined
      );
    })
    .finally(() => issuing.delete(hostId));
}

/**
 * Every name still waiting for its first certificate — after the proxy is set
 * up, for instance. Each is asked for once its DNS leads here.
 */
export async function issuePending(): Promise<number> {
  if ((await proxyProbe()).state !== "ready") return 0;
  const db = await getDb();
  const rows = await db.selectFrom("project_hosts").select("id").where("status", "=", "pending").execute();
  issueWhenReady(rows.map((row) => row.id));
  return rows.length;
}

export interface CloudflareStatus {
  connected: boolean;
  zones: CloudflareZone[];
  /** Why the zones could not be read: a revoked token, Cloudflare not answering. */
  error: string | null;
}

/**
 * Bring each domain's Cloudflare link in line with what the token sees, apply
 * nginx when one changed, and ask again — now through DNS — for the names of a
 * newly linked domain still waiting for a certificate or refused one on port 80.
 *
 * A token Cloudflare does not answer for leaves the links alone: a network blip
 * must not take the real-IP lines out of every block. A zone still pending on
 * Cloudflare is left out, because its nameservers do not answer for it yet.
 */
export async function syncCloudflare(fresh = false): Promise<CloudflareStatus> {
  const token = await cloudflareToken();
  if (!token) {
    if ((await linkDomains([])).changed) applyProxySoon();
    return { connected: false, zones: [], error: null };
  }

  const outcome = await cloudflareZones(token, fresh);
  if (outcome.error !== null) return { connected: true, zones: [], error: outcome.error };

  const active = outcome.zones.filter((zone) => zone.status === "active").map((zone) => zone.name);
  const { changed, linked } = await linkDomains(active);
  if (changed) applyProxySoon();
  if (linked.length > 0 && (await proxyProbe()).state === "ready") {
    const db = await getDb();
    const waiting = await db
      .selectFrom("project_hosts")
      .select("id")
      .where("domain_id", "in", linked)
      .where("status", "in", ["pending", "error"])
      .execute();
    for (const host of waiting) issueCertificate(host.id);
  }
  return { connected: true, zones: outcome.zones, error: null };
}

/** After a name is deleted: its certificate is of no use to anything else. */
export function forgetCertificate(hostname: string): void {
  void (async () => {
    const found = await proxyProbe();
    if (found.state === "ready" && certificateOnDisk(hostname)) {
      await certbot(found, certbotDeleteArgs(hostname));
    }
  })().catch(() => undefined);
}

export interface SetupResult {
  ok: boolean;
  message: string;
  commands: string[] | null;
}

/** The one-time setup: done here when the panel is root, handed over as commands when not. */
export async function setUpProxy(): Promise<SetupResult> {
  const found = await proxyProbe(true);
  if (found.state === "disabled" || found.state === "unsupported" || found.state === "no-nginx") {
    return { ok: false, message: found.detail, commands: null };
  }
  if (found.state !== "not-configured" && found.state !== "no-reload") {
    return { ok: true, message: "nginx è già configurato.", commands: null };
  }
  if (!found.root) {
    return { ok: false, message: found.detail, commands: found.commands };
  }

  const result = await setUpAsRoot(found);
  await proxyProbe(true);
  if (!result.ok && result.readOnly) {
    return {
      ok: false,
      message: "Il pannello è root ma vede /etc in sola lettura (ProtectSystem nella sua unit): incolla i comandi qui sotto.",
      commands: found.commands,
    };
  }
  if (!result.ok) {
    return { ok: false, message: `nginx ha rifiutato l'include: ${lastLines(result.output)}`, commands: null };
  }
  const applied = await applyProxy();
  return { ok: applied.ok, message: applied.ok ? "nginx è configurato." : applied.message, commands: null };
}

async function renew(): Promise<void> {
  const found = await proxyProbe();
  if (found.state !== "ready") return;
  const db = await getDb();
  const active = await db
    .selectFrom("project_hosts")
    .innerJoin("domains", "domains.id", "project_hosts.domain_id")
    .select(["project_hosts.hostname", "domains.cloudflare"])
    .where("project_hosts.status", "=", "active")
    .execute();
  if (active.length === 0) return;

  // The token only when a name on Cloudflare is among those renewed: one
  // `certbot renew` covers them all, and the HTTP ones have no use for it.
  const needsToken = active.some((host) => host.cloudflare === 1);
  const env = needsToken ? ((await cloudflareEnv().catch(() => null)) ?? undefined) : undefined;
  const email = (await getSetting(ACME_EMAIL_SETTING))?.trim() || null;

  // A domain that joined or left Cloudflare after its names got their
  // certificates: `certbot renew` would repeat the old challenge, so those
  // names renew with the new one — which also becomes how they renew from then
  // on. `--keep-until-expiring` keeps it to the same 30 days as the rest.
  for (const host of active) {
    const conf = readText(renewalConfPath(host.hostname));
    const challenge: Challenge = host.cloudflare === 1 && env ? "cloudflare" : "http";
    if (!conf || renewalChallenge(conf) === challenge) continue;
    const switched = await certbot(found, certbotIssueArgs(host.hostname, email, challenge), env);
    if (!switched.ok) console.warn(`[proxy] Rinnovo di ${host.hostname} non riuscito: ${certbotFailure(switched.output)}`);
  }

  const result = await certbot(found, certbotRenewArgs(), env);
  if (!result.ok) console.warn(`[proxy] Rinnovo dei certificati non riuscito: ${certbotFailure(result.output)}`);
  // Reloads nginx onto whatever was renewed, and reads the new expiries.
  const applied = await applyProxy();
  if (!applied.ok) console.warn(`[proxy] ${applied.message}`);
}

/** The renewals, and the look at names still waiting for their DNS record. */
export function startProxyRenewal(): void {
  if (globalRef.__runpanelProxyRenewTimer) return;
  globalRef.__runpanelProxyRenewTimer = setInterval(() => void renew().catch(() => undefined), RENEW_EVERY_MS);
  globalRef.__runpanelProxyRenewTimer.unref?.();
  globalRef.__runpanelProxyRenewFirst = setTimeout(() => void renew().catch(() => undefined), RENEW_FIRST_MS);
  globalRef.__runpanelProxyRenewFirst.unref?.();
  globalRef.__runpanelProxyDnsTimer = setInterval(() => void sweepWaiting().catch(() => undefined), DNS_SWEEP_MS);
  globalRef.__runpanelProxyDnsTimer.unref?.();
}

/**
 * At boot: a request that was running when the panel stopped did not finish,
 * and nginx is brought back to what the store says — a restored backup or a
 * moved data directory may have changed it.
 */
export async function reconcileProxy(): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("project_hosts")
    .set({ status: "error", last_error: "Interrotto da un riavvio del pannello: riprova.", updated_at: nowIso() })
    .where("status", "=", "issuing")
    .execute();

  const found = await proxyProbe();
  if (!canApply(found)) return;
  const result = await applyProxy();
  if (!result.ok) console.warn(`[proxy] ${result.message}`);
}
