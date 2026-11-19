/**
 * What a return from GitHub says, in the panel's words. The URL carries only
 * a code (`?github=expired`), and a code nothing here names says nothing: a
 * sentence in a URL would be a sentence anyone could put on the panel's own
 * sign-in page.
 *
 * Zero imports: the sign-in, invitation and account pages share it.
 */

const MESSAGES: Record<string, string> = {
  unlinked:
    "Questo account GitHub non è collegato a nessun utente attivo del pannello. Per entrare chiedi un invito al proprietario.",
  taken: "Questo account GitHub è già collegato a un altro utente del pannello. Usa un altro account GitHub.",
  already: "Al tuo utente è già collegato un altro account GitHub: scollegalo prima di collegarne uno nuovo.",
  denied: "Hai annullato su GitHub: non è cambiato niente.",
  expired:
    "L'accesso con GitHub è scaduto, era già stato usato o era partito da un altro browser. Riprova da qui.",
  github: "GitHub non ha completato l'accesso: riprova tra poco. Se si ripete, il proprietario può verificare l'app OAuth in Impostazioni.",
  off: "L'accesso con GitHub non è attivo su questo pannello.",
  session: "Nel frattempo è cambiato l'utente collegato in questo browser: riprova dalla pagina Account.",
  invite: "Questo invito non è più valido. Chiedi a chi ti ha invitato di generarne uno nuovo.",
  managed: "Questo server è gestito da un altro RunPanel: accedi da lì.",
};

/** The sentence for a result code, or null for one that is not an error (or not known). */
export function githubResultMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : null;
}
