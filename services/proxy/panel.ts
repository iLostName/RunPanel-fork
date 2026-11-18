import http from "http";
import https from "https";
import tls from "tls";
import { getDb, nowIso } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/settings";
import { PANEL_PUBLIC_URL_SETTING } from "@/lib/panel-url";
import { generateId } from "@/lib/utils";
import { isInstantHostname, isPanelAddress, panelHttpsUrl } from "@/lib/proxy-names";
import { isBlockedRepoHost, panelPublicUrlSchema } from "@/lib/validation";
import type { PanelHostsTable } from "@/lib/db/schema";
import { clusterState, getMember } from "@/services/cluster/state";
import { CHECK_PATH, SITES_DIR, panelHstsMaxAge, siteFileName } from "./render";
import { loadPanelHost, panelDomain, setPanelHost } from "./panel-store";
import { explainProxiedAnswer, explainTlsFailure, isPanelCheckAnswer } from "./panel-checks";
import {
  applyProxy,
  applyProxySoon,
  forgetCertificate,
  hostDnsReport,
  issuePanelWhenReady,
  newCheckToken,
  panelAddressProblem,
  panelDnsSubject,
  panelHostView,
  panelListenPort,
  proxyProbe,
  serverAddresses,
} from "./index";

/**
 * The panel on HTTPS: `https://pannello.esempio.it` in front of its own port,
 * through the nginx and certbot the projects' names already use.
 *
 * Built so that it cannot take the owner's way in away:
 *
 *   - The panel keeps listening on its port, and nothing here touches that
 *     port, its address or its sessions. The name is a second way in.
 *   - The block goes in through the same apply as every name — written beside
 *     the live set, `nginx -t`, reload, or the previous set back — and nginx
 *     is told to proxy only once the panel was seen answering on loopback.
 *   - The public address changes only when the owner asks, and only after the
 *     HTTPS address was seen answering as this panel with a valid certificate.
 *     Turning the name off puts back what the setting held before.
 *   - HSTS only once it is the public address: trying the name out and turning
 *     it off leaves every browser as it was.
 *
 * Owner only, at the routes: the name decides how everyone reaches the panel.
 */

const globalRef = globalThis as typeof globalThis & { __runpanelPanelHttpsChain?: Promise<unknown> };

/**
 * Choosing and removing the name one at a time: two presses of "Continua"
 * must not leave two rows, and a removal must not cross a choice.
 */
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalRef.__runpanelPanelHttpsChain ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  globalRef.__runpanelPanelHttpsChain = next.catch(() => undefined);
  return next;
}

export type PanelOutcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

/**
 * Whether the other servers of the cluster reach this one through the name:
 * the address stored for this server in the cluster's directory, set when it
 * was linked — from the public address, if that was the name by then. Turning
 * the name off would then cut them off until that address is changed, so the
 * page says so before it is done.
 */
async function clusterReachesThroughName(hostname: string): Promise<boolean> {
  const state = await clusterState().catch(() => null);
  if (!state) return false;
  const self = await getMember(state.selfId).catch(() => null);
  return self !== null && URL.canParse(self.url) && new URL(self.url).hostname.toLowerCase() === hostname;
}

/** Everything the settings section shows, in one answer. */
export async function panelHttpsState(fresh = false) {
  const db = await getDb();
  const [proxy, row, domains, publicUrl, server] = await Promise.all([
    proxyProbe(fresh),
    loadPanelHost(),
    db.selectFrom("domains").select(["id", "name", "cloudflare"]).orderBy("name", "asc").execute(),
    getSetting(PANEL_PUBLIC_URL_SETTING),
    serverAddresses(fresh),
  ]);
  const port = panelListenPort();
  const [domain, clusterUsesName] = row
    ? await Promise.all([panelDomain(row.hostname), clusterReachesThroughName(row.hostname)])
    : [null, false];
  const adopted = row ? isPanelAddress(publicUrl, row.hostname) : false;
  return {
    proxy,
    panelHost: row ? panelHostView(row) : null,
    /** The domain of the panel the name sits on, when it is on one: its DNS record is relative to it. */
    domain,
    // An instant domain cannot hold the panel's name, so it is not offered.
    domains: domains
      .filter((candidate) => !isInstantHostname(candidate.name))
      .map((candidate) => ({ id: candidate.id, name: candidate.name, cloudflare: candidate.cloudflare === 1 })),
    addresses: [...server.v4, ...server.v6],
    addressesDetected: server.detected,
    port,
    /** The panel's own port on each public address: the way in that never goes away. */
    direct: [...server.v4.map((address) => `http://${address}:${port}`), ...server.v6.map((address) => `http://[${address}]:${port}`)],
    publicUrl: publicUrl?.trim() || null,
    adopted,
    previousPublicUrl: row?.previous_public_url ?? null,
    /** The HSTS the name's block sends once it has its certificate, in seconds; null for none. */
    hstsMaxAge: row ? panelHstsMaxAge(adopted, row.adopted_at) : null,
    /** Whether the panel reads the visitor's address from `X-Forwarded-For` — never from nginx alone. */
    trustedProxyHops: getEnv().trustedProxyHops,
    blockFile: row ? `${SITES_DIR}/${siteFileName(row.hostname)}` : null,
    /** Where the browser asks the name for `panelHost.checkToken`, over HTTPS. */
    checkPath: CHECK_PATH,
    /** The other servers of the cluster reach this one through the name: turning it off cuts them off. */
    clusterUsesName,
  };
}

export type PanelHttpsState = Awaited<ReturnType<typeof panelHttpsState>>;

/** The DNS record the name needs, looked up now — the same check, and the same answer, as a project's. */
export async function panelDnsReport(fresh = false) {
  const row = await loadPanelHost();
  if (!row) return null;
  const [found, domain, subject] = await Promise.all([proxyProbe(), panelDomain(row.hostname), panelDnsSubject(row)]);
  const report = await hostDnsReport(subject, found, fresh);
  const subdomain = !domain ? row.hostname : row.hostname === domain.name ? "" : row.hostname.slice(0, -(domain.name.length + 1));
  return {
    proxy: { state: found.state, detail: found.detail },
    names: [
      {
        ...report,
        subdomain,
        domain: domain?.name ?? row.hostname,
        cloudflare: domain?.cloudflare ?? false,
        redirectTo: null,
        // Typed whole, on a domain the panel does not know: the record's name relative to its zone is not ours to guess.
        zoneKnown: domain !== null,
      },
    ],
  };
}

interface Answer {
  status: number;
  body: string;
}

/** One GET, with a hard timeout, that never throws: a failure is the error's code. */
function request(
  options: https.RequestOptions,
  secure: boolean,
  timeoutMs: number
): Promise<(Answer & { certificate: tls.PeerCertificate | null }) | { failed: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: (Answer & { certificate: tls.PeerCertificate | null }) | { failed: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const codeOf = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));
    const onAnswer = (res: http.IncomingMessage) => {
      const certificate = secure ? ((res.socket as tls.TLSSocket).getPeerCertificate?.() ?? null) : null;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 8192) body += chunk;
      });
      res.on("end", () => finish({ status: res.statusCode ?? 0, body, certificate }));
      res.on("error", (err) => finish({ failed: codeOf(err) }));
    };
    const req = secure ? https.request(options, onAnswer) : http.request(options, onAnswer);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (err) => finish({ failed: codeOf(err) }));
    req.end();
  });
}

/**
 * Whether the panel answers on loopback at its port — where nginx will send
 * the name's visitors. Asked before the block is written, so a panel bound to
 * one interface only, or started on another port than it believes, is told so
 * instead of getting a name that answers 502.
 */
export async function panelAnswersOnLoopback(port = panelListenPort()): Promise<boolean> {
  const answer = await request(
    { host: "127.0.0.1", port, path: "/api/auth/check", method: "GET", headers: { Accept: "application/json" }, agent: false },
    false,
    5_000
  );
  return "status" in answer && isPanelCheckAnswer(answer.status, answer.body);
}

export interface PanelCheck {
  id: "certificate" | "nginx" | "panel";
  ok: boolean;
  detail: string;
}

export interface PanelVerdict {
  ok: boolean;
  checks: PanelCheck[];
  certificate: { validTo: string | null; issuer: string | null };
  checkedAt: string;
}

/**
 * The HTTPS name as a browser would see it, asked of nginx on this machine:
 * the certificate checks out for the name, this block is the one answering,
 * and what is behind it is the panel.
 *
 * Over loopback, with the name given to TLS and to HTTP, rather than through
 * the name's DNS: a server behind NAT often cannot reach its own public
 * address, and the question here is nginx's half. Whether the internet gets to
 * nginx on 443 — a firewall, a router — is the browser's half, asked from the
 * page.
 */
export async function verifyPanelHttps(row: Pick<PanelHostsTable, "hostname" | "check_token">): Promise<PanelVerdict> {
  const { hostname } = row;
  const options = (path: string): https.RequestOptions => ({
    host: "127.0.0.1",
    port: 443,
    servername: hostname,
    path,
    method: "GET",
    headers: { Host: hostname, Accept: "application/json, text/plain" },
    agent: false,
    // What a visitor gets: a certificate that does not check out for the name is the finding, not something to skip.
    rejectUnauthorized: true,
    checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(hostname, certificate),
  });

  const checks: PanelCheck[] = [];
  const token = await request(options(CHECK_PATH), true, 6_000);
  let certificate: PanelVerdict["certificate"] = { validTo: null, issuer: null };
  if ("failed" in token) {
    checks.push({ id: "certificate", ok: false, detail: explainTlsFailure(token.failed, hostname) });
  } else {
    const peer = token.certificate;
    const validTo = peer?.valid_to ? new Date(peer.valid_to) : null;
    // A field of a certificate's name can repeat, and Node hands those back as an array.
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
    certificate = {
      validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
      issuer: first(peer?.issuer?.O) ?? first(peer?.issuer?.CN),
    };
    checks.push({ id: "certificate", ok: true, detail: `Il certificato è valido per ${hostname}.` });
    const ours = token.status === 200 && token.body.trim() === row.check_token;
    checks.push({
      id: "nginx",
      ok: ours,
      detail: ours
        ? "nginx serve questo nome con il blocco del pannello."
        : "Sulla porta 443 risponde un'altra configurazione per questo nome: riapplica nginx dalla pagina Domini.",
    });
    if (ours) {
      const panel = await request(options("/api/auth/check"), true, 8_000);
      const reached = "status" in panel && isPanelCheckAnswer(panel.status, panel.body);
      checks.push({
        id: "panel",
        ok: reached,
        detail: reached
          ? "Le richieste arrivano al pannello."
          : "status" in panel
            ? explainProxiedAnswer(panel.status, panelListenPort())
            : explainTlsFailure(panel.failed, hostname),
      });
    }
  }
  return { ok: checks.length === 3 && checks.every((check) => check.ok), checks, certificate, checkedAt: nowIso() };
}

/** Why the name cannot be the panel's, before anything is written; null when it can. */
async function chooseProblem(hostname: string): Promise<{ status: number; error: string } | null> {
  if (isBlockedRepoHost(hostname)) {
    return { status: 400, error: "È un nome locale: Let's Encrypt non rilascia certificati per nomi che non esistono su internet." };
  }
  const problem = await panelAddressProblem(hostname);
  if (problem) return { status: 409, error: problem };
  const found = await proxyProbe(true);
  if (found.state !== "ready") return { status: 409, error: found.detail };
  const port = panelListenPort();
  if (port === 80 || port === 443) {
    // nginx needs both for every name, this one included: they cannot be the panel's too.
    return { status: 409, error: `Il pannello ascolta sulla porta ${port}, che serve a nginx: avvialo su un'altra porta, per esempio 3000.` };
  }
  if (!(await panelAnswersOnLoopback(port))) {
    return {
      status: 409,
      error: `Il pannello non risponde su 127.0.0.1:${port}, dove nginx gli passerebbe le visite: se l'hai avviato su un'interfaccia sola (per esempio con -H), avvialo su tutte.`,
    };
  }
  return null;
}

/**
 * Give the panel its name. Its block goes in at once (port 80 only: the
 * challenge, the check, and "on its way" for anyone else), its certificate as
 * soon as its DNS record leads here. The same name again is not an error.
 */
export function choosePanelHostname(hostname: string): Promise<PanelOutcome<PanelHostsTable>> {
  return serialised(async () => {
    const current = await loadPanelHost();
    if (current) {
      if (current.hostname === hostname) return { ok: true, value: current };
      return refuse(409, `Il pannello ha già un indirizzo HTTPS, ${current.hostname}: disattivalo prima di sceglierne un altro.`);
    }
    const problem = await chooseProblem(hostname);
    if (problem) return refuse(problem.status, problem.error);

    const now = nowIso();
    const row: PanelHostsTable = {
      id: generateId(),
      hostname,
      check_token: newCheckToken(),
      status: "pending",
      last_error: null,
      apply_error: null,
      cert_expires_at: null,
      previous_public_url: null,
      adopted_at: null,
      created_at: now,
      updated_at: now,
    };
    const db = await getDb();
    await db.insertInto("panel_hosts").values(row).execute();
    issuePanelWhenReady();
    return { ok: true, value: row };
  });
}

/**
 * Make the HTTPS name the panel's public address — webhooks, links in
 * notifications, the address shown to a server joining the cluster — after
 * checking again, now, that it answers as this panel.
 *
 * Remembers what the setting held, so turning the name off can put it back,
 * and applies nginx again: HSTS goes on with it.
 */
export function adoptPanelHttps(): Promise<PanelOutcome<{ publicUrl: string; previousPublicUrl: string }>> {
  return serialised(async () => {
    const row = await loadPanelHost();
    if (!row) return refuse(404, "Il pannello non ha un indirizzo HTTPS.");
    if (row.status !== "active") return refuse(409, "Prima serve il certificato: l'indirizzo non è ancora in HTTPS.");
    const verdict = await verifyPanelHttps(row);
    const failed = verdict.checks.find((check) => !check.ok);
    if (!verdict.ok) return refuse(409, failed?.detail ?? "L'indirizzo HTTPS non risponde come dovrebbe.");

    const url = panelHttpsUrl(row.hostname);
    // The same rule the settings form applies to whatever is typed there.
    if (!panelPublicUrlSchema.safeParse(url).success) return refuse(400, `${url} non può essere l'indirizzo pubblico del pannello.`);

    const current = ((await getSetting(PANEL_PUBLIC_URL_SETTING)) ?? "").trim();
    let previous = row.previous_public_url ?? "";
    if (!isPanelAddress(current, row.hostname)) {
      previous = current;
      // From now: HSTS starts at a day and steps up a week later.
      await setPanelHost(row.id, { previous_public_url: current, adopted_at: nowIso() });
      await setSetting(PANEL_PUBLIC_URL_SETTING, url);
    } else if (!row.adopted_at) {
      // Typed into the setting by hand earlier: the ramp starts with this press.
      await setPanelHost(row.id, { adopted_at: nowIso() });
    }
    applyProxySoon();
    return { ok: true, value: { publicUrl: url, previousPublicUrl: previous } };
  });
}

/**
 * Turn the name off: its block goes, then its certificate. If it was the
 * public address, the setting goes back to what it held before. The panel's
 * own port was never touched, so it is the way in from here on.
 */
export function turnOffPanelHttps(): Promise<PanelOutcome<{ removed: string; publicUrl: string | null }>> {
  return serialised(async () => {
    const row = await loadPanelHost();
    if (!row) return refuse(404, "Il pannello non ha un indirizzo HTTPS.");
    const db = await getDb();
    const current = ((await getSetting(PANEL_PUBLIC_URL_SETTING)) ?? "").trim();
    let publicUrl = current;
    if (isPanelAddress(current, row.hostname)) {
      publicUrl = row.previous_public_url ?? "";
      await setSetting(PANEL_PUBLIC_URL_SETTING, publicUrl);
    }
    await db.deleteFrom("panel_hosts").where("id", "=", row.id).execute();
    // The block first, the certificate only once nothing refers to it — and
    // not at all if nginx refused the apply and still serves the block. In the
    // background: the request that asked may have come through this very name,
    // and its answer has to leave before nginx lets the name go.
    void applyProxy().then((result) => {
      if (result.ok) forgetCertificate(row.hostname);
      else console.warn(`[proxy] ${result.message}`);
    });
    return { ok: true, value: { removed: row.hostname, publicUrl: publicUrl || null } };
  });
}
