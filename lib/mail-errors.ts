/**
 * An SMTP failure, in words, and whether it is worth trying again.
 *
 * The three that account for nearly every first setup are the TLS mode that
 * does not match the port (OpenSSL says "wrong version number"), a password or
 * an app password refused, and port 25 or 587 blocked by the provider, which
 * looks like a timeout and nothing more. Each gets a sentence that says what to
 * change, instead of the library's error.
 *
 * Zero imports: `services/mail` uses it, and the unit suite loads it directly.
 */

export interface SmtpErrorLike {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

export interface SmtpTarget {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
}

function asSmtpError(err: unknown): SmtpErrorLike {
  return typeof err === "object" && err !== null ? (err as SmtpErrorLike) : { message: String(err) };
}

/** A 4xx from the server, or a connection that never got that far: one more try may work. */
export function isTransientMailError(err: unknown): boolean {
  const e = asSmtpError(err);
  if (e.responseCode !== undefined) return e.responseCode >= 400 && e.responseCode < 500;
  return ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS"].includes(e.code ?? "") && !/certificate|wrong version/i.test(e.message ?? "");
}

/** The server's own reply, one line of it: it usually says exactly what it wants. */
function reply(e: SmtpErrorLike): string {
  const text = (e.response ?? e.message ?? "").split("\n")[0].trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export function explainMailError(err: unknown, smtp: SmtpTarget): string {
  const e = asSmtpError(err);
  const message = e.message ?? "";
  const where = `${smtp.host}:${smtp.port}`;

  if (/wrong version number|ssl3_get_record|tls_validate_record_header|unknown protocol/i.test(message)) {
    return `La connessione cifrata non corrisponde alla porta ${smtp.port}: di solito la 465 vuole «TLS» e la 587 «STARTTLS».`;
  }
  if (/self[- ]signed|unable to verify|certificate has expired|altnames|unable to get local issuer|CERT_/i.test(message)) {
    return `Il certificato di ${smtp.host} non è valido (${reply(e)}). Se è un tuo server interno, puoi accettarlo nelle opzioni avanzate.`;
  }
  if (e.code === "EAUTH") {
    return `${smtp.host} ha rifiutato utente o password${e.response ? ` (${reply(e)})` : ""}. Con Gmail, Outlook e simili serve una «password per le app», non quella dell'account.`;
  }
  // The socket's own failures arrive under more than one code (`ESOCKET` as
  // often as `ECONNECTION`), so they are recognised by what they say.
  if (/ECONNREFUSED/.test(message)) return `${where} ha rifiutato la connessione: controlla indirizzo e porta.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(message) || e.code === "EDNS") return `Server di posta ${smtp.host} non trovato: controlla il nome.`;
  if (/ETIMEDOUT|timeout|greeting never received/i.test(message) || e.code === "ETIMEDOUT") {
    return `Nessuna risposta da ${where} in tempo utile: la porta è chiusa da un firewall? Molti provider bloccano la 25; prova la 587.`;
  }
  switch (e.code) {
    case "ECONNECTION":
      return `Connessione a ${where} non riuscita: ${reply(e)}`;
    case "ESOCKET":
      return `Connessione a ${where} interrotta: ${reply(e)}`;
    case "EENVELOPE":
      return `Il server di posta ha rifiutato il mittente o i destinatari: ${reply(e)}`;
    case "EMESSAGE":
      return `Il server di posta ha rifiutato il messaggio: ${reply(e)}`;
    case "ETLS":
      return smtp.security === "starttls"
        ? `${smtp.host} non offre STARTTLS su questa porta: prova «TLS» con la 465.`
        : `Connessione cifrata con ${smtp.host} non riuscita: ${reply(e)}`;
  }
  if (e.responseCode && e.responseCode >= 500) return `Il server di posta ha risposto con un errore: ${reply(e)}`;
  return reply(e) || "Invio non riuscito per un motivo sconosciuto.";
}
