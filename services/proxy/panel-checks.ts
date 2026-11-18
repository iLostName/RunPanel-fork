/**
 * What the checks of the panel's own HTTPS name found, in the words of someone
 * who wants the padlock and not a TLS error code.
 *
 * The checks themselves are in `./panel.ts`: a request to nginx on this
 * machine, over TLS, for the name, as a browser would make it. These only read
 * what came back. No imports, so the standalone suite loads this directly.
 */

/** A failed TLS connection to port 443, as something the owner can act on. */
export function explainTlsFailure(code: string, hostname: string): string {
  switch (code) {
    case "CERT_HAS_EXPIRED":
      return `Il certificato di ${hostname} è scaduto: i browser lo rifiutano.`;
    case "CERT_NOT_YET_VALID":
      return "Il certificato risulta non ancora valido: controlla l'orologio del server.";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `Sulla porta 443 nginx presenta il certificato di un altro nome, non di ${hostname}.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "Sulla porta 443 c'è un certificato fatto in casa, che i browser rifiutano.";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return "Il certificato non risale a un'autorità che i browser conoscono: manca la catena intermedia.";
    case "ECONNREFUSED":
      return "Sulla porta 443 di questo server non risponde nessuno: nginx non ha ancora il blocco HTTPS.";
    case "ETIMEDOUT":
      return "nginx non ha risposto sulla porta 443 entro pochi secondi.";
    case "ECONNRESET":
    case "EPROTO":
      return `La connessione HTTPS si è chiusa subito: nginx non ha un certificato per ${hostname}.`;
    default:
      return `La connessione HTTPS non è riuscita (${code}).`;
  }
}

/**
 * Whether an answer of `/api/auth/check` is a RunPanel's: the shape, not the
 * values, which depend on who asks. Asked over loopback before nginx is pointed
 * at the port, and through nginx once it is, it says the requests do reach the
 * panel and not some other program on that port, or nginx's error page.
 */
export function isPanelCheckAnswer(status: number, body: string): boolean {
  if (status !== 200) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.authenticated === "boolean" && typeof parsed.firstRun === "boolean";
  } catch {
    return false;
  }
}

/** What a request through nginx to the panel answered, when it was not the panel. */
export function explainProxiedAnswer(status: number, port: number): string {
  if (status === 502 || status === 504) {
    return `nginx non raggiunge il pannello su 127.0.0.1:${port}: il pannello è in ascolto su un'altra porta o un'altra interfaccia?`;
  }
  return `Attraverso nginx risponde qualcos'altro invece del pannello (HTTP ${status}).`;
}
