import { createTransport } from "nodemailer";
import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";
import { getDb } from "@/lib/db";

/**
 * The panel's outgoing mail: one SMTP server, one `sendMail()`.
 *
 * Written for more than notifications. Invitations and password resets will go
 * through the same function, which is why the server is configured once, here,
 * and not inside a notification channel: an email channel only says who
 * receives what. It is also why the configuration is the owner's alone. Whoever
 * controls the mail server would read every password-reset link the panel
 * ever sends.
 *
 * Like the notifier, `sendMail` never throws. It answers with what happened,
 * in Italian, with the two or three things that are actually wrong when SMTP
 * fails — the port and the TLS mode disagree, the password is refused, a
 * provider has closed port 25 — said in words instead of an OpenSSL error.
 */

export const SMTP_SETTING = "smtp_config";
export const SMTP_PASSWORD_SETTING = "smtp_password";

export type SmtpSecurity = "starttls" | "tls" | "none";

export interface SmtpSettings {
  host: string;
  port: number;
  /**
   * `tls` from the first byte (port 465), `starttls` upgraded after the
   * greeting and required (587), `none` for a relay on the local network that
   * offers nothing — where STARTTLS is not even tried, so a broken offer
   * cannot stall the send.
   */
  security: SmtpSecurity;
  /** Empty: the server takes mail without signing in (a local relay). */
  username: string;
  from: string;
  /** For a server on the LAN with a certificate of its own. Off by default, and said so on screen. */
  allowInvalidCert: boolean;
}

export interface SmtpConfig extends SmtpSettings {
  /** Null when there is none, or when it was encrypted under a key this panel no longer has. */
  password: string | null;
  passwordUnreadable: boolean;
}

const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 10_000 };

function parseSettings(raw: string | null): SmtpSettings | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SmtpSettings>;
    if (typeof value.host !== "string" || !value.host || typeof value.port !== "number") return null;
    return {
      host: value.host,
      port: value.port,
      security: value.security === "tls" || value.security === "none" ? value.security : "starttls",
      username: typeof value.username === "string" ? value.username : "",
      from: typeof value.from === "string" ? value.from : "",
      allowInvalidCert: value.allowInvalidCert === true,
    };
  } catch {
    return null;
  }
}

export async function readSmtpConfig(): Promise<SmtpConfig | null> {
  const [raw, stored] = await Promise.all([getSetting(SMTP_SETTING), getSetting(SMTP_PASSWORD_SETTING)]);
  const settings = parseSettings(raw);
  if (!settings) return null;
  const password = stored ? tryDecrypt(stored) : null;
  return { ...settings, password, passwordUnreadable: Boolean(stored) && password === null };
}

/** What the settings screen may know: everything but the password, and whether there is one. */
export async function publicSmtpConfig() {
  const config = await readSmtpConfig();
  return {
    configured: isMailConfigured(config),
    host: config?.host ?? "",
    port: config?.port ?? 587,
    security: config?.security ?? ("starttls" as SmtpSecurity),
    username: config?.username ?? "",
    from: config?.from ?? "",
    allowInvalidCert: config?.allowInvalidCert ?? false,
    passwordSet: Boolean(config?.password),
    passwordUnreadable: config?.passwordUnreadable ?? false,
  };
}

export function isMailConfigured(config: SmtpConfig | null): config is SmtpConfig {
  if (!config || !config.host || !config.from) return false;
  // Signing in needs the password the panel can still read.
  return !config.username || Boolean(config.password);
}

export async function isMailReady(): Promise<boolean> {
  return isMailConfigured(await readSmtpConfig());
}

/**
 * Save the server. A blank or absent password keeps the stored one; clearing
 * the user name is what turns signing in off, and takes the password with it.
 */
export async function writeSmtpConfig(input: SmtpSettings & { password?: string }): Promise<void> {
  const settings: SmtpSettings = {
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username,
    from: input.from,
    allowInvalidCert: input.allowInvalidCert,
  };
  await setSetting(SMTP_SETTING, JSON.stringify(settings));
  if (!settings.username) await setSetting(SMTP_PASSWORD_SETTING, "");
  else if (input.password) await setSetting(SMTP_PASSWORD_SETTING, encrypt(input.password));
}

/** Forget the server entirely. Email channels stay, and say they have no server to send through. */
export async function clearSmtpConfig(): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("settings").where("key", "in", [SMTP_SETTING, SMTP_PASSWORD_SETTING]).execute();
}

export interface MailMessage {
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string;
}

export type MailResult = { ok: true } | { ok: false; error: string; retryable: boolean };

/**
 * Send one message. Never throws, never waits more than about half a minute.
 *
 * A transport per message, closed after it: the panel sends a handful a day,
 * and a pooled connection held open to a provider that drops idle ones is a
 * failure waiting for the night it matters.
 */
export async function sendMail(message: MailMessage, config?: SmtpConfig | null): Promise<MailResult> {
  const smtp = config === undefined ? await readSmtpConfig() : config;
  if (!smtp) return { ok: false, error: "Il server di posta non è configurato.", retryable: false };
  if (smtp.passwordUnreadable) {
    return {
      ok: false,
      error: "La password del server di posta è stata cifrata con un'altra chiave del pannello: inseriscila di nuovo.",
      retryable: false,
    };
  }
  if (!isMailConfigured(smtp)) return { ok: false, error: "Il server di posta non è configurato del tutto.", retryable: false };

  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? "" } : undefined,
    tls: { rejectUnauthorized: !smtp.allowInvalidCert },
    ...TIMEOUTS,
  });

  try {
    const info = await transport.sendMail({
      from: smtp.from,
      to: [message.to].flat().join(", "),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
    });
    const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
    if (rejected > 0 && (!Array.isArray(info.accepted) || info.accepted.length === 0)) {
      return { ok: false, error: "Il server di posta ha rifiutato tutti i destinatari.", retryable: false };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explainMailError(err, smtp), retryable: isTransient(err) };
  } finally {
    transport.close();
  }
}

interface SmtpError {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

function asSmtpError(err: unknown): SmtpError {
  return typeof err === "object" && err !== null ? (err as SmtpError) : { message: String(err) };
}

function isTransient(err: unknown): boolean {
  const e = asSmtpError(err);
  if (e.responseCode !== undefined) return e.responseCode >= 400 && e.responseCode < 500;
  return ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS"].includes(e.code ?? "") && !/certificate|wrong version/i.test(e.message ?? "");
}

/** The server's own reply, one line of it: it usually says exactly what it wants. */
function reply(e: SmtpError): string {
  const text = (e.response ?? e.message ?? "").split("\n")[0].trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * An SMTP failure in words.
 *
 * The three that account for nearly every first setup are the TLS mode that
 * does not match the port (OpenSSL says "wrong version number"), a password or
 * an app password refused, and port 25 or 587 blocked by the provider, which
 * looks like a timeout and nothing more.
 */
export function explainMailError(err: unknown, smtp: Pick<SmtpSettings, "host" | "port" | "security">): string {
  const e = asSmtpError(err);
  const message = e.message ?? "";
  const where = `${smtp.host}:${smtp.port}`;

  if (/wrong version number|ssl3_get_record|tls_validate_record_header|unknown protocol/i.test(message)) {
    return `La connessione cifrata non corrisponde alla porta ${smtp.port}: di solito la 465 vuole «TLS» e la 587 «STARTTLS».`;
  }
  if (/self[- ]signed|unable to verify|certificate has expired|altnames|unable to get local issuer|CERT_/i.test(message)) {
    return `Il certificato di ${smtp.host} non è valido (${reply(e)}). Se è un tuo server interno, puoi accettarlo nelle opzioni avanzate.`;
  }
  switch (e.code) {
    case "EAUTH":
      return `${smtp.host} ha rifiutato utente o password${e.response ? ` (${reply(e)})` : ""}. Con Gmail, Outlook e simili serve una «password per le app», non quella dell'account.`;
    case "EDNS":
      return `Server di posta ${smtp.host} non trovato: controlla il nome.`;
    case "ETIMEDOUT":
      return `Nessuna risposta da ${where} in tempo utile: la porta è chiusa da un firewall? Molti provider bloccano la 25; prova la 587.`;
    case "ECONNECTION":
      return /ECONNREFUSED/.test(message)
        ? `${where} ha rifiutato la connessione: controlla indirizzo e porta.`
        : `Connessione a ${where} non riuscita: ${reply(e)}`;
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
