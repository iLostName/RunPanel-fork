import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Whether an address's DNS leads to this server, and where its certificate
 * stands, as the pages say it.
 *
 * The verdict decides more than a badge: a name is only handed to Let's
 * Encrypt once it says `ready`, so a check that read a resolver timeout as
 * "missing" would hold certificates back forever, and one that read a stale
 * AAAA as fine would spend the name's failed validations. Most cases here are
 * those edges.
 *
 * Standalone: `lib/dns-check.ts`, `services/proxy/certificate.ts`,
 * `lib/ip-access.ts` and `services/proxy/render.ts` have no imports.
 */
export const meta = { name: "dns-check-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("dns-check-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const { checkDns, routingCouldHelp, unmatchedAddresses } = await load("lib", "dns-check.ts");
  const { certificateState, explainCertificateError, EXPIRING_DAYS } = await load("services", "proxy", "certificate.ts");
  const { compileRules, isAllowed, isLoopback, parseAddress } = await load("lib", "ip-access.ts");
  const { CLOUDFLARE_RANGES } = await load("services", "proxy", "render.ts");

  // The same predicate `services/proxy/dns.ts` builds.
  const rules = compileRules(CLOUDFLARE_RANGES);
  const isCloudflareAddress = (address) => {
    const parsed = parseAddress(address);
    return parsed !== null && !isLoopback(parsed) && isAllowed(address, rules);
  };

  const found = (...addresses) => ({ kind: "found", addresses });
  const none = { kind: "none" };
  const failed = { kind: "failed", code: "ETIMEOUT" };
  const server = { v4: ["203.0.113.7"], v6: ["2001:db8::7"] };
  const check = (a, aaaa, extra = {}) =>
    checkDns({ a, aaaa, server, cloudflareLinked: false, isCloudflareAddress, reaches: null, ...extra });

  // --- Cloudflare's ranges, as the predicate reads them ----------------------------
  r.check("every Cloudflare range compiles", rules.length === CLOUDFLARE_RANGES.length, String(rules.length));
  r.check("a Cloudflare IPv4 proxy is recognised", isCloudflareAddress("104.16.132.229") && isCloudflareAddress("172.67.1.1"));
  r.check("a Cloudflare IPv6 proxy is recognised", isCloudflareAddress("2606:4700:3030::6815:1"));
  r.check("an ordinary address is not Cloudflare's", !isCloudflareAddress("203.0.113.7") && !isCloudflareAddress("2001:db8::7"));
  r.check("loopback is not Cloudflare's, whatever the gate lets through", !isCloudflareAddress("127.0.0.1") && !isCloudflareAddress("::1"));
  r.check("garbage is not Cloudflare's", !isCloudflareAddress("not-an-ip"));

  // --- the plain cases ------------------------------------------------------------------
  let c = check(found("203.0.113.7"), found("2001:db8::7"));
  r.check("both records on this server: ok and ready", c.state === "ok" && c.ready && c.notes.length === 0, JSON.stringify(c));
  r.check("each family says so", c.families.A.status === "ok" && c.families.AAAA.status === "ok");

  c = check(found("203.0.113.7"), none);
  r.check("A right and no AAAA is ok", c.state === "ok" && c.ready && c.families.AAAA.status === "missing");
  r.check("with a note that AAAA is optional", c.notes.some((note) => note.includes("Facoltativo") && note.includes("2001:db8::7")), JSON.stringify(c.notes));

  c = check(found("203.0.113.7"), none, { server: { v4: ["203.0.113.7"], v6: [] } });
  r.check("a server without IPv6 needs no AAAA", c.state === "ok" && c.families.AAAA.status === "unneeded" && c.notes.length === 0);

  c = check(none, none);
  r.check("nothing yet is missing, and not ready", c.state === "missing" && !c.ready, JSON.stringify(c));
  r.check("missing says to wait for propagation", c.summary.includes("qualche minuto"));

  c = check(none, found("2001:db8::7"));
  r.check("only AAAA, right, is ok but says A is missing", c.state === "ok" && c.ready && c.notes.some((note) => note.includes("record A")));

  // --- elsewhere --------------------------------------------------------------------------
  c = check(found("198.51.100.9"), none);
  r.check("an A to another machine is elsewhere, not ready", c.state === "elsewhere" && !c.ready && c.foreign.join() === "198.51.100.9", JSON.stringify(c));
  r.check("and the sentence names where it goes", c.summary.includes("198.51.100.9"));

  c = check(found("203.0.113.7", "198.51.100.9"), none);
  r.check("one record of two elsewhere is elsewhere", c.state === "elsewhere" && c.foreign.join() === "198.51.100.9");

  c = check(found("203.0.113.7"), found("2001:db8::99"));
  r.check("a stale AAAA makes it elsewhere though A is right", c.state === "elsewhere" && !c.ready && c.families.A.status === "ok" && c.families.AAAA.status === "wrong");

  c = check(found("203.0.113.7"), found("2001:db8::99"), { server: { v4: ["203.0.113.7"], v6: [] } });
  r.check("an AAAA on a server with no IPv6 is wrong", c.state === "elsewhere" && c.families.AAAA.foreign.join() === "2001:db8::99");
  r.check("and the sentence says to delete it", c.summary.includes("cancellalo"), c.summary);

  // --- the routing check ---------------------------------------------------------------------
  c = check(found("198.51.100.9"), none);
  r.check("an A that matches nothing known is worth a routing check", routingCouldHelp(c));
  r.check("which asks that address", unmatchedAddresses(c).join() === "198.51.100.9");
  c = check(found("198.51.100.9"), none, { reaches: true });
  r.check("its answering the token overrides what the server knows of itself", c.state === "ok" && c.ready && c.notes.some((note) => note.includes("NAT")), JSON.stringify(c));
  c = check(found("198.51.100.9"), none, { reaches: false });
  r.check("not answering keeps it elsewhere", c.state === "elsewhere" && !c.ready);
  c = check(found("203.0.113.7"), found("2001:db8::99"));
  r.check("with A right, only the stale AAAA is asked about", routingCouldHelp(c) && unmatchedAddresses(c).join() === "2001:db8::99");
  c = check(found("203.0.113.7"), found("2001:db8::99"), { reaches: false });
  r.check("a stale AAAA that does not answer stays wrong", c.state === "elsewhere" && !c.ready);
  c = check(found("203.0.113.7"), found("2001:db8::99"), { reaches: true });
  r.check("one that answers the token itself is this server after all", c.state === "ok" && c.ready);
  c = check(found("203.0.113.7"), none);
  r.check("an ok verdict needs no routing check", !routingCouldHelp(c) && unmatchedAddresses(c).length === 0);

  // --- behind NAT ----------------------------------------------------------------------------
  const behindNat = { server: { v4: [], v6: [] } };
  c = check(found("198.51.100.9"), none, behindNat);
  r.check("with no known public IPv4 the record is unverified, not wrong", c.state === "unknown" && c.families.A.status === "unverified" && c.foreign.length === 0);
  r.check("unknown is still ready: Let's Encrypt decides", c.ready);
  r.check("and worth a routing check, of the addresses found", routingCouldHelp(c) && unmatchedAddresses(c).join() === "198.51.100.9");
  c = check(found("198.51.100.9"), none, { ...behindNat, reaches: true });
  r.check("reaching turns unknown into ok", c.state === "ok" && c.ready);
  c = check(none, none, behindNat);
  r.check("no record behind NAT is still missing", c.state === "missing" && !c.ready && c.families.A.status === "missing");

  // --- Cloudflare's proxy ----------------------------------------------------------------------
  c = check(found("104.16.132.229", "104.16.133.229"), found("2606:4700::6810:84e5"));
  r.check("orange-cloud addresses read as Cloudflare, not elsewhere", c.state === "cloudflare" && c.foreign.length === 0, JSON.stringify(c));
  r.check("unlinked, it waits and says what to do", !c.ready && c.summary.includes("collega Cloudflare"), c.summary);
  r.check("unlinked, a routing check through Cloudflare could show it reaches", routingCouldHelp(c) && unmatchedAddresses(c).length === 3);
  c = check(found("104.16.132.229"), none, { reaches: true });
  r.check("unlinked but reaching this nginx is ready", c.state === "cloudflare" && c.ready);
  c = check(found("104.16.132.229"), none, { cloudflareLinked: true });
  r.check("linked, it is ready: the proof is a TXT record", c.state === "cloudflare" && c.ready && !routingCouldHelp(c));
  c = check(none, none, { cloudflareLinked: true });
  r.check("linked, even a missing record does not hold the certificate", c.state === "missing" && c.ready);
  c = check(found("104.16.132.229", "198.51.100.9"), none);
  r.check("Cloudflare mixed with another machine is elsewhere", c.state === "elsewhere");

  // --- the resolvers not answering --------------------------------------------------------------
  c = check(failed, failed);
  r.check("no answer at all is an error, not missing", c.state === "error" && c.families.A.status === "error");
  r.check("and does not hold the certificate back", c.ready);
  c = check(failed, none);
  r.check("an A that timed out is an error whatever AAAA said", c.state === "error");
  c = check(none, failed);
  r.check("a missing A with an AAAA timeout is missing", c.state === "missing" && !c.ready);
  c = check(found("203.0.113.7"), failed);
  r.check("a right A with an AAAA timeout is ok", c.state === "ok" && c.ready);

  // --- spelling -----------------------------------------------------------------------------------
  c = check(found("203.0.113.7", "203.0.113.7"), none);
  r.check("a repeated address counts once", c.families.A.found.length === 1);
  c = check(found("2001:DB8::7"), none, { a: found("203.0.113.7"), aaaa: found("2001:DB8::7") });
  r.check("IPv6 is compared without regard to case", c.families.AAAA.status === "ok");
  c = check(found(), found());
  r.check("an empty answer is no answer", c.state === "missing");

  // --- certificates -------------------------------------------------------------------------------
  const now = Date.parse("2026-11-18T12:00:00Z");
  const inDays = (days) => new Date(now + days * 86_400_000).toISOString();
  r.check("an active certificate far from expiry is active", JSON.stringify(certificateState("active", inDays(60), now)) === JSON.stringify({ state: "active", daysLeft: 60 }));
  r.check(`under ${EXPIRING_DAYS} days it is expiring`, certificateState("active", inDays(EXPIRING_DAYS - 1), now).state === "expiring");
  r.check(`at ${EXPIRING_DAYS} days it is still active`, certificateState("active", inDays(EXPIRING_DAYS), now).state === "active");
  r.check("past its date it is expired", certificateState("active", inDays(-1), now).state === "expired");
  r.check("an unreadable expiry is active without a count", JSON.stringify(certificateState("active", null, now)) === JSON.stringify({ state: "active", daysLeft: null }));
  r.check("pending is missing", certificateState("pending", null, now).state === "missing");
  r.check("issuing and error pass through", certificateState("issuing", null, now).state === "issuing" && certificateState("error", inDays(30), now).state === "error");

  const explained = (text) => explainCertificateError(text) ?? "";
  r.check("NXDOMAIN says to create the record", explained("Domain: app.esempio.it Type: dns Detail: DNS problem: NXDOMAIN looking up A for app.esempio.it").includes("non c'è ancora"));
  r.check("a firewall says port 80", explained("Detail: 203.0.113.7: Fetching http://app.esempio.it/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)").includes("porta 80"));
  r.check("an invalid response says another server", explained("Detail: 198.51.100.9: Invalid response from http://app.esempio.it/.well-known/acme-challenge/x: 404").includes("altro server"));
  r.check("a rate limit wins over everything else in the text", explained("Error creating new order :: too many failed authorizations recently: see https://letsencrypt.org/docs/rate-limits/ Type: unauthorized").includes("un'ora"));
  r.check("a CAA refusal is named", explained("Detail: CAA record for esempio.it prevents issuance").includes("CAA"));
  r.check("a missing TXT record points at Cloudflare's propagation", explained("Type: unauthorized Detail: No TXT record found at _acme-challenge.app.esempio.it").includes("Cloudflare"));
  r.check("the panel's own Italian reasons are left as they are", explainCertificateError("Interrotto da un riavvio del pannello: riprova.") === null);
  r.check("nothing to explain is null", explainCertificateError(null) === null && explainCertificateError("") === null);

  return r.result();
}
