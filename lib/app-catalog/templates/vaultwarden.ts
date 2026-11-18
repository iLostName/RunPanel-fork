import type { CatalogTemplate } from "../types";
import { urlVariables } from "../render";

/**
 * Vaultwarden, the Bitwarden-compatible server, on SQLite.
 *
 * An address is required, not suggested: the web vault encrypts in the
 * browser with WebCrypto, which browsers only expose over HTTPS, so on a plain
 * `http://ip:port` it does not open at all. Registrations start open, because
 * the first account has to be created somehow; the notes say to close them.
 * Without the admin page by default: its token would sit in a variable in
 * clear, and Vaultwarden itself warns against that.
 */
export const vaultwarden: CatalogTemplate = {
  id: "vaultwarden",
  revision: 1,
  name: "Vaultwarden",
  description: "Gestore di password compatibile con le app e le estensioni di Bitwarden.",
  about:
    "Le tue password in una cassaforte cifrata sul tuo server, sincronizzate su telefono, computer e browser con le app ufficiali di Bitwarden.",
  category: "security",
  icon: "solar:lock-password-linear",
  website: "https://github.com/dani-garcia/vaultwarden/wiki",
  keywords: ["password", "bitwarden", "cassaforte", "credenziali", "sicurezza", "2fa"],
  web: { service: "vaultwarden", internalPort: 80, defaultPort: 8080 },
  healthcheck: { path: "/alive", expectStatus: [200], startPeriodSec: 3, timeoutSec: 120 },
  volumes: [{ name: "vaultwarden_data", service: "vaultwarden", path: "/data", label: "La cassaforte cifrata e gli allegati" }],
  databases: [],
  questions: [],
  secrets: [],
  derived: [
    { key: "APP_URL", label: "Indirizzo della cassaforte" },
    { key: "SIGNUPS_ALLOWED", label: "Registrazioni aperte" },
  ],
  derive: (ctx) => ({ APP_URL: urlVariables(ctx).APP_URL, SIGNUPS_ALLOWED: "true" }),
  address: "required",
  addressNote: "La cassaforte si apre solo in HTTPS: i browser non permettono la cifratura su un indirizzo senza certificato.",
  notes: [
    "Apri {APP_URL} e crea il tuo account. La password principale non si può recuperare: conservala bene.",
    "Poi chiudi le registrazioni: in Variabili imposta SIGNUPS_ALLOWED a false e fai un nuovo deploy. Finché restano aperte, chiunque raggiunga l'indirizzo può crearsi un account.",
    "Sulle app di Bitwarden scegli «self-hosted» e indica {APP_URL} come server.",
  ],
  compose: `
services:
  vaultwarden:
    image: vaultwarden/server:1.37.5
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:80"
    environment:
      DOMAIN: "\${APP_URL:-}"
      SIGNUPS_ALLOWED: "\${SIGNUPS_ALLOWED:-false}"
    volumes:
      - vaultwarden_data:/data

volumes:
  vaultwarden_data:
`,
};
