import dns from "dns";
import os from "os";
import { compileRules, isAllowed, isLoopback, normalizeAddress, parseAddress } from "@/lib/ip-access";
import { staleWhileRevalidate } from "@/lib/stale-cache";
import type { DnsAnswer, ServerAddresses } from "@/lib/dns-check";
import { CLOUDFLARE_RANGES } from "./render";

/**
 * The DNS side of an address, as the rest of the internet sees it.
 *
 * Asked of public resolvers rather than the machine's own: the server's
 * resolver is often a cache (systemd-resolved, a provider's), and it may hold
 * the "no such name" it got before the record existed for as long as the zone
 * says — exactly the minutes during which someone is watching the page and
 * wondering whether they got the record right. A new resolver per question
 * carries nothing over from the last one either.
 *
 * What the answers mean is `lib/dns-check.ts`; this only fetches them.
 */

/** Cloudflare's and Google's, the two any provider propagates to first. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const PUBLIC_RESOLVERS_V6 = ["2606:4700:4700::1111", "2001:4860:4860::8888"];

/**
 * Per resolver, one try: with two of them the slowest answer is about four
 * seconds, not the half minute c-ares would spend retrying with doubled waits.
 */
const RESOLVER_OPTIONS = { timeout: 2000, tries: 1 };

export interface PublicAnswers {
  a: DnsAnswer;
  aaaa: DnsAnswer;
  /** Who answered: the public resolvers, or — when those could not be reached — this machine's own. */
  via: "public" | "system";
  servers: string[];
}

async function ask(resolver: dns.promises.Resolver, type: "A" | "AAAA", hostname: string): Promise<DnsAnswer> {
  try {
    const raw = type === "A" ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname);
    const addresses = raw.map((address) => normalizeAddress(address)).filter((address): address is string => address !== null);
    return { kind: "found", addresses };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    // NXDOMAIN and NODATA: the resolver answered, and there is no such record.
    if (code === dns.NOTFOUND || code === dns.NODATA) return { kind: "none" };
    return { kind: "failed", code: code || "EUNKNOWN" };
  }
}

async function askAll(hostname: string, servers: string[]): Promise<{ a: DnsAnswer; aaaa: DnsAnswer }> {
  const resolver = new dns.promises.Resolver(RESOLVER_OPTIONS);
  resolver.setServers(servers);
  const [a, aaaa] = await Promise.all([ask(resolver, "A", hostname), ask(resolver, "AAAA", hostname)]);
  return { a, aaaa };
}

/**
 * A and AAAA for `hostname`, from 1.1.1.1 and then 8.8.8.8.
 *
 * Some networks only let DNS out through their own resolver. There, both
 * public ones time out, and the machine's own answer — cached, perhaps, but an
 * answer — beats telling the operator nothing; `via` says which it was. Their
 * IPv6 addresses come last, and only on a server with public IPv6 to reach them.
 */
export async function resolvePublicly(hostname: string): Promise<PublicAnswers> {
  const ipv6 = publicAddresses().some((address) => address.includes(":"));
  const servers = ipv6 ? [...PUBLIC_RESOLVERS, ...PUBLIC_RESOLVERS_V6] : PUBLIC_RESOLVERS;
  const publicAnswers = await askAll(hostname, servers);
  if (publicAnswers.a.kind !== "failed" || publicAnswers.aaaa.kind !== "failed") {
    return { ...publicAnswers, via: "public", servers };
  }
  const system = dns.getServers();
  if (system.length === 0) return { ...publicAnswers, via: "public", servers };
  return { ...(await askAll(hostname, system)), via: "system", servers: system };
}

function isPublicAddress(address: string, family: "IPv4" | "IPv6"): boolean {
  const a = address.toLowerCase();
  return family === "IPv4"
    ? !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)
    : !/^(fe[89ab]|f[cd]|::1$|::$|::ffff:)/.test(a);
}

/**
 * The addresses a record could point at: this machine's own, minus loopback,
 * private ranges, CGNAT/Tailscale and link-local. Empty behind NAT, where the
 * public address belongs to the router — see `serverAddresses`.
 */
export function publicAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const family = entry.family === "IPv4" ? "IPv4" : "IPv6";
      const address = normalizeAddress(entry.address);
      if (address && isPublicAddress(address, family) && !out.includes(address)) out.push(address);
    }
  }
  return out;
}

/**
 * This server's IPv4 as the outside sees it, when no interface has a public
 * one: behind NAT, and on the clouds that hand out public addresses by 1:1 NAT
 * (EC2, GCP, Oracle), which is a large share of the servers this panel runs on.
 *
 * OpenDNS answers `myip.opendns.com` with whoever asked, over DNS — no HTTP
 * service to trust, nothing but the query itself leaving the machine. Kept for
 * five minutes: the address of a server changes about never, and the page
 * that shows it polls.
 */
async function discoverOutsideV4(): Promise<string | null> {
  const resolver = new dns.promises.Resolver(RESOLVER_OPTIONS);
  resolver.setServers(["208.67.222.222", "208.67.220.220"]);
  try {
    const [answer] = await resolver.resolve4("myip.opendns.com");
    const address = answer ? normalizeAddress(answer) : null;
    return address && !address.includes(":") && isPublicAddress(address, "IPv4") ? address : null;
  } catch {
    return null;
  }
}

const outsideV4 = staleWhileRevalidate(discoverOutsideV4, 5 * 60_000);

export interface KnownAddresses extends ServerAddresses {
  /** The IPv4 came from asking outside, not from an interface. */
  detected: boolean;
}

export async function serverAddresses(fresh = false): Promise<KnownAddresses> {
  const local = publicAddresses();
  const v4 = local.filter((address) => !address.includes(":"));
  const v6 = local.filter((address) => address.includes(":"));
  if (v4.length > 0) return { v4, v6, detected: false };
  const outside = await outsideV4.get({ fresh }).catch(() => null);
  return outside ? { v4: [outside], v6, detected: true } : { v4, v6, detected: false };
}

const cloudflareRules = compileRules(CLOUDFLARE_RANGES);

/** One of Cloudflare's proxies — what an orange-cloud record resolves to instead of the server. */
export function isCloudflareAddress(address: string): boolean {
  const parsed = parseAddress(address);
  // `isAllowed` lets loopback through, as the gate must; a record is another matter.
  return parsed !== null && !isLoopback(parsed) && isAllowed(address, cloudflareRules);
}
