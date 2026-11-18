/**
 * Whether an address's DNS records lead to this server, decided once.
 *
 * Someone who has just created `app.esempio.it → 203.0.113.7` at their DNS
 * provider has one question — did I get it right? — and the honest answer has
 * more than two values. Not there yet: the record is missing, or the resolvers
 * still hold the answer from before it existed. There, but pointing at another
 * machine, and which one. There, behind Cloudflare's proxy, which by design
 * hides where it leads. Or the resolvers did not answer at all, which says
 * nothing about the record and must never read as "missing".
 *
 * The verdict also decides whether a certificate is worth asking for yet.
 * Let's Encrypt counts every failed validation against a limit per name, so a
 * request made while the record is missing is a request wasted — which is why
 * the panel no longer asks the moment an address is added, but once this says
 * the name leads here.
 *
 * Zero imports, so the standalone suite loads it directly. Resolving is the
 * caller's job (`services/proxy/dns.ts`), and so is knowing Cloudflare's
 * ranges: answers come in canonical, with a predicate for those.
 */

export type RecordType = "A" | "AAAA";

/** What the resolvers said for one record type. */
export type DnsAnswer =
  | { kind: "found"; addresses: readonly string[] }
  /** NXDOMAIN or NODATA: what a record not created yet — or not propagated yet — looks like. */
  | { kind: "none" }
  /** No answer at all: a timeout, SERVFAIL, a refused query. It says nothing about the record. */
  | { kind: "failed"; code: string };

/**
 * One record type, held against this server.
 *
 * `ok`          every address is this server's
 * `missing`     none, and one is needed
 * `unneeded`    none, and none needed: no IPv6 record for a server without IPv6
 * `wrong`       at least one address belongs to another machine
 * `proxied`     every address is one of Cloudflare's proxies
 * `unverified`  there are addresses, but this server's own of that family is unknown
 * `error`       the resolvers did not answer
 */
export type FamilyStatus = "ok" | "missing" | "unneeded" | "wrong" | "proxied" | "unverified" | "error";

/**
 * The address as a whole.
 *
 * `ok`          it leads here
 * `missing`     no record yet
 * `elsewhere`   it leads, at least in part, to another machine
 * `cloudflare`  behind Cloudflare's proxy: the addresses are Cloudflare's
 * `unknown`     it resolves, and this server's public address is not known
 * `error`       the resolvers did not answer
 */
export type DnsState = "ok" | "missing" | "elsewhere" | "cloudflare" | "unknown" | "error";

/** This server's public addresses: what the records should hold. */
export interface ServerAddresses {
  v4: readonly string[];
  /** From the interfaces only, so empty means the server has no public IPv6 — not that it is unknown. */
  v6: readonly string[];
}

export interface DnsCheckInput {
  a: DnsAnswer;
  aaaa: DnsAnswer;
  server: ServerAddresses;
  /**
   * The domain is on the panel's Cloudflare account: its certificates are
   * proved with a TXT record, so where the name points does not hold them up.
   */
  cloudflareLinked: boolean;
  isCloudflareAddress: (address: string) => boolean;
  /**
   * The routing check: asked over HTTP from here, the name answered this
   * nginx's own token. Null or absent when it was not tried.
   */
  reaches?: boolean | null;
}

export interface FamilyCheck {
  type: RecordType;
  /** What the record should hold: this server's addresses of that family. */
  expected: string[];
  /** What the resolvers returned. */
  found: string[];
  /** Of `found`, what is not this server's. */
  foreign: string[];
  status: FamilyStatus;
}

export interface DnsCheck {
  state: DnsState;
  /** One sentence, for whoever is looking at it. */
  summary: string;
  /** What else is worth knowing, in the same plain words: an optional record missing, for instance. */
  notes: string[];
  families: { A: FamilyCheck; AAAA: FamilyCheck };
  /** Every address the name resolves to that is not this server's. */
  foreign: string[];
  /** Whether a certificate is worth asking for now. */
  ready: boolean;
}

function list(addresses: readonly string[]): string {
  return addresses.length <= 1 ? (addresses[0] ?? "") : `${addresses.slice(0, -1).join(", ")} e ${addresses[addresses.length - 1]}`;
}

function checkFamily(
  type: RecordType,
  answer: DnsAnswer,
  expected: readonly string[],
  isCloudflareAddress: (address: string) => boolean
): FamilyCheck {
  const base = { type, expected: [...expected], found: [] as string[], foreign: [] as string[] };
  if (answer.kind === "failed") return { ...base, status: "error" };

  const found = answer.kind === "found" ? [...new Set(answer.addresses.map((a) => a.toLowerCase()))] : [];
  if (found.length === 0) {
    // An A record is always needed, even while this server's IPv4 is unknown.
    // An AAAA one only when the server has IPv6 to receive it.
    return { ...base, status: type === "A" || expected.length > 0 ? "missing" : "unneeded" };
  }
  if (found.every(isCloudflareAddress)) return { ...base, found, status: "proxied" };

  if (expected.length === 0) {
    // No public IPv6 on any interface means none at all, so every AAAA record
    // sends IPv6 visitors — and Let's Encrypt, which tries IPv6 first — somewhere
    // else. No IPv4 found is different: behind NAT the public one is the
    // router's, and not knowing it is not the record's fault.
    return type === "AAAA" ? { ...base, found, foreign: found, status: "wrong" } : { ...base, found, status: "unverified" };
  }

  const ours = new Set(expected.map((a) => a.toLowerCase()));
  const foreign = found.filter((address) => !ours.has(address));
  return { ...base, found, foreign, status: foreign.length === 0 ? "ok" : "wrong" };
}

export function checkDns(input: DnsCheckInput): DnsCheck {
  const A = checkFamily("A", input.a, input.server.v4, input.isCloudflareAddress);
  const AAAA = checkFamily("AAAA", input.aaaa, input.server.v6, input.isCloudflareAddress);
  const statuses = [A.status, AAAA.status];
  const has = (status: FamilyStatus) => statuses.includes(status);
  const reaches = input.reaches === true;
  const foreign = [...A.foreign, ...AAAA.foreign];
  const notes: string[] = [];

  let state: DnsState;
  let summary: string;

  if (has("wrong")) {
    // Nothing matched an address this server knows as its own, and yet the
    // name answered its token: what was incomplete is that knowledge (a 1:1
    // NAT, a floating address), not the record. With one family right and the
    // other wrong it is the record — a stale AAAA most often — and the routing
    // check may simply have gone out over the family that works.
    if (reaches && !has("ok")) {
      state = "ok";
      summary = "L'indirizzo arriva a questo server.";
      notes.push(
        `Passa da ${list(foreign)}, che il server non vede come suo: succede dietro NAT o con un IP assegnato dal provider, e va bene così.`
      );
    } else {
      state = "elsewhere";
      summary =
        A.status !== "wrong" && AAAA.status === "wrong" && AAAA.expected.length === 0
          ? `C'è anche un record AAAA (IPv6) verso ${list(AAAA.foreign)}, ma questo server non ha un indirizzo IPv6 pubblico: cancellalo, o chi usa IPv6 (e Let's Encrypt) finisce altrove.`
          : `Il record punta a ${list(foreign)}, che non è questo server.`;
    }
  } else if (has("proxied")) {
    state = "cloudflare";
    summary = input.cloudflareLinked
      ? "L'indirizzo passa dal proxy di Cloudflare: il certificato arriva tramite il DNS di Cloudflare."
      : reaches
        ? "L'indirizzo passa dal proxy di Cloudflare e arriva a questo server."
        : "L'indirizzo passa dal proxy di Cloudflare (nuvola arancione), che nasconde dove porta: collega Cloudflare dalla pagina Domini, oppure metti la nuvola grigia finché il certificato non arriva.";
  } else if (has("ok")) {
    state = "ok";
    summary = "Il record DNS punta a questo server.";
  } else if (has("unverified")) {
    state = reaches ? "ok" : "unknown";
    summary = reaches
      ? "L'indirizzo arriva a questo server."
      : `Il record punta a ${list(A.found)}. Non conosco l'indirizzo pubblico di questo server, quindi non posso confermare che sia il suo.`;
  } else if (A.status === "error") {
    state = "error";
    summary = "I server DNS pubblici non hanno risposto: riprovo tra poco.";
  } else {
    state = "missing";
    summary = "Il record DNS non c'è ancora. Se l'hai appena creato può volerci qualche minuto: il pannello ricontrolla da solo.";
  }

  if (state === "ok") {
    if (A.status === "missing") {
      notes.push("Manca il record A: chi non ha IPv6 non arriva a questo indirizzo.");
    }
    if (AAAA.status === "missing") {
      notes.push(`Facoltativo: un record AAAA verso ${list(AAAA.expected)} fa arrivare anche chi usa IPv6.`);
    }
  }

  // An answer that could not be had is not a reason to hold the certificate
  // back: that is how it worked before this check existed, and Let's Encrypt
  // has the final word anyway.
  const ready =
    input.cloudflareLinked ||
    state === "ok" ||
    state === "unknown" ||
    state === "error" ||
    (state === "cloudflare" && reaches);

  return { state, summary, notes, families: { A, AAAA }, foreign, ready };
}

/**
 * Whether the routing check could change a verdict taken without it — the
 * only time it is worth its HTTP request. Behind a linked Cloudflare domain it
 * cannot: the certificate does not depend on where the name leads.
 */
export function routingCouldHelp(check: DnsCheck): boolean {
  return (
    (check.state === "elsewhere" && check.families.A.status !== "ok" && check.families.AAAA.status !== "ok") ||
    check.state === "unknown" ||
    (check.state === "cloudflare" && !check.ready)
  );
}
