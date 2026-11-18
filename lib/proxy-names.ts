/**
 * What a domain and a subdomain may look like, decided once.
 *
 * Both end up written verbatim into an nginx `server_name` and into a file
 * name under the proxy's directory, so this is the line between operator text
 * and a configuration a root process loads. The rule is therefore narrower than
 * DNS allows: ASCII letters, digits and hyphens only, lowercase, no wildcard, no
 * trailing dot. A name in another script is written in its `xn--` form, which
 * is what nginx and certbot both expect anyway.
 *
 * No imports, so the standalone suite can load it directly — the same reason
 * `lib/access-columns.ts` has none.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One DNS label: `app`, `api-v2`, `xn--bcher-kva`. */
export function isDnsLabel(value: string): boolean {
  return LABEL.test(value);
}

/**
 * A domain as the operator registered it: `esempio.it`, `clienti.esempio.it`.
 *
 * Returns the canonical form, or null. At least two labels, because a bare
 * `localhost` or `it` is not something a certificate can be issued for; and a
 * top-level label that is all digits is an IPv4 address, which is not a domain.
 */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value.length === 0 || value.length > 253) return null;

  const labels = value.split(".");
  if (labels.length < 2) return null;
  if (!labels.every(isDnsLabel)) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return value;
}

/**
 * The part before the domain: one label, so it is covered by `*.domain` — or
 * empty, for the domain itself, which needs a DNS record of its own.
 */
export function normalizeSubdomain(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return value === "" || isDnsLabel(value) ? value : null;
}

/** The full name, or null when the two together exceed what DNS allows. */
export function hostnameFor(subdomain: string, domain: string): string | null {
  const hostname = subdomain === "" ? domain : `${subdomain}.${domain}`;
  return hostname.length <= 253 ? hostname : null;
}

/**
 * The `www.` twin of a name, which can redirect to it: `www.esempio.it` for the
 * domain itself, the domain itself for `www.esempio.it`. Any other subdomain
 * has none — `www.app.esempio.it` is two levels down, which neither one label
 * nor the wildcard record covers — and neither does a twin too long for DNS.
 */
export function wwwTwin(subdomain: string, domain: string): { subdomain: string; hostname: string } | null {
  if (subdomain === "www") return { subdomain: "", hostname: domain };
  if (subdomain !== "") return null;
  const hostname = hostnameFor("www", domain);
  return hostname ? { subdomain: "www", hostname } : null;
}

/**
 * The DNS zone a domain lives in, out of the ones an account holds: the domain
 * itself or its closest parent. `clienti.esempio.it` is in `esempio.it`, and
 * so is `esempio.it`; `altroesempio.it` is not.
 */
export function zoneFor(domain: string, zones: readonly string[]): string | null {
  let best: string | null = null;
  for (const zone of zones) {
    const inside = domain === zone || domain.endsWith(`.${zone}`);
    if (inside && (best === null || zone.length > best.length)) best = zone;
  }
  return best;
}

/** Whether a stored name still passes, for the renderer's own last check. */
export function isHostname(value: string): boolean {
  return normalizeDomain(value) === value;
}

/**
 * Instant addresses: names under a shared service that answers any name with
 * the IP written inside it — `app.203-0-113-7.sslip.io` is 203.0.113.7 — so a
 * project can be opened by name before its owner has a domain.
 *
 * sslip.io, and nip.io run by the same people, are not on the Public Suffix
 * List. Let's Encrypt therefore counts every certificate for every name under
 * them against one weekly limit shared by everyone who uses them, raised by
 * hand more than once and run out again within days in 2026. So such a name is
 * served over HTTP only — a certificate that may or may not come is not a
 * promise the panel makes — and it is never the panel's own address.
 */
export const INSTANT_SUFFIX = "sslip.io";
const INSTANT_SUFFIXES = ["sslip.io", "nip.io"] as const;

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Eight groups of hex, or fewer around a single `::`. */
function isIpv6(value: string): boolean {
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/**
 * The instant domain for one of the server's addresses, in the dashed form the
 * service reads: `203-0-113-7.sslip.io`, `2001-db8--1.sslip.io`. Null for
 * anything that is not an address, or whose dashed form DNS would refuse as a
 * label (an IPv6 starting or ending in `::`).
 */
export function instantDomainFor(address: string): string | null {
  const value = address.trim().toLowerCase();
  const label = IPV4.test(value) ? value.replace(/\./g, "-") : isIpv6(value) ? value.replace(/:/g, "-") : null;
  return label && isDnsLabel(label) ? `${label}.${INSTANT_SUFFIX}` : null;
}

/** The address an instant domain stands for (`203-0-113-7.sslip.io` → `203.0.113.7`), or null when it is not one. */
export function instantDomainAddress(domain: string): string | null {
  const value = domain.toLowerCase();
  for (const suffix of INSTANT_SUFFIXES) {
    if (!value.endsWith(`.${suffix}`)) continue;
    const label = value.slice(0, -(suffix.length + 1));
    if (!isDnsLabel(label)) return null;
    const v4 = label.replace(/-/g, ".");
    if (IPV4.test(v4)) return v4;
    const v6 = label.replace(/-/g, ":");
    return isIpv6(v6) ? v6 : null;
  }
  return null;
}

/**
 * A label made from a project's name or slug, for the address offered first:
 * `Il Mio Sito` → `il-mio-sito`. Accents are dropped rather than refused, and
 * what is left of nothing is `app`.
 */
export function labelFrom(text: string): string {
  const label = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return isDnsLabel(label) ? label : "app";
}

/** Whether a name lives under one of those services, at any depth: such a name never gets a certificate. */
export function isInstantHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return INSTANT_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

/** The panel's own HTTPS name as the address it is opened at. */
export function panelHttpsUrl(hostname: string): string {
  return `https://${hostname}`;
}

/**
 * Whether the panel's public address setting is its HTTPS name: what decides
 * that browsers are told HTTPS only, and what turning the name off puts back.
 * A path, or `:443` spelled out, is still the same address.
 */
export function isPanelAddress(publicUrl: string | null | undefined, hostname: string): boolean {
  const raw = publicUrl?.trim();
  if (!raw || !URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.protocol === "https:" && url.hostname.toLowerCase() === hostname && url.port === "";
}
