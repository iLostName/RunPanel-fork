/**
 * Where a name's certificate stands, as the pages show it, and a failed
 * request's reason in words that say what to do about it.
 *
 * The store already knows everything needed — `status`, `cert_expires_at`
 * read from the file, `last_error` from certbot — but as an engineer's facts:
 * "pending" does not say that nothing is wrong yet, and Let's Encrypt's own
 * "DNS problem: NXDOMAIN looking up A for…" does not say "create the record".
 * The raw text stays in the store and in the API for whoever wants it.
 *
 * No imports, so the standalone suite loads it directly.
 */

export type CertificateState = "active" | "expiring" | "expired" | "issuing" | "missing" | "error";

/**
 * certbot renews 30 days ahead and the panel asks twice a day, so a
 * certificate this close to its end has been failing to renew for two weeks.
 */
export const EXPIRING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CertificateView {
  state: CertificateState;
  /** Whole days until it expires, when there is one and its expiry is known. */
  daysLeft: number | null;
}

export function certificateState(status: string, expiresAt: string | null, now = Date.now()): CertificateView {
  if (status === "issuing") return { state: "issuing", daysLeft: null };
  if (status === "error") return { state: "error", daysLeft: null };
  if (status !== "active") return { state: "missing", daysLeft: null };

  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(expiry)) return { state: "active", daysLeft: null };
  const daysLeft = Math.floor((expiry - now) / DAY_MS);
  if (expiry <= now) return { state: "expired", daysLeft };
  return { state: daysLeft < EXPIRING_DAYS ? "expiring" : "active", daysLeft };
}

/**
 * What certbot and Let's Encrypt say, matched to what to do. In order: a rate
 * limit first, because it is the reason whatever else the output mentions.
 * The panel's own reasons are already Italian and already say what to do, so
 * they match nothing here and are shown as they are.
 */
const EXPLAINED: [RegExp, string][] = [
  [
    /too many (certificates|failed authorizations|new orders|requests)|rateLimited|rate limit/i,
    "Let's Encrypt ha ricevuto troppe richieste per questo indirizzo: aspetta un'ora prima di riprovare.",
  ],
  [
    /NXDOMAIN|no valid A records found/i,
    "Il record DNS di questo indirizzo non c'è ancora: crealo, poi il certificato arriva da solo.",
  ],
  [/CAA record/i, "Un record CAA del dominio non autorizza Let's Encrypt: aggiungi letsencrypt.org ai record CAA, oppure toglili."],
  [
    /DNS problem: (SERVFAIL|query timed out|networking error)/i,
    "Il DNS del dominio non risponde a Let's Encrypt: controlla il provider DNS, poi riprova.",
  ],
  [
    /No TXT record found|Incorrect TXT record/i,
    "Il record di verifica su Cloudflare non è arrivato a Let's Encrypt in tempo: riprova tra qualche minuto.",
  ],
  [
    /Timeout during connect|Connection refused|likely firewall problem|Connection reset/i,
    "Let's Encrypt non riesce a raggiungere il server sulla porta 80: aprila nel firewall, e sul router se il server è dietro NAT.",
  ],
  [
    /Invalid response from|Type:\s*unauthorized/i,
    "Let's Encrypt è arrivato a un altro server, o a un altro programma sulla porta 80: controlla che il record DNS punti a questo server.",
  ],
];

/** A failed request's reason in plain words, or null when the text has no better reading than itself. */
export function explainCertificateError(lastError: string | null): string | null {
  if (!lastError) return null;
  for (const [pattern, explanation] of EXPLAINED) {
    if (pattern.test(lastError)) return explanation;
  }
  return null;
}
