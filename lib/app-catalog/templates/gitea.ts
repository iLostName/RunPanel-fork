import type { CatalogTemplate } from "../types";
import { urlVariables } from "../render";

/**
 * Gitea on SQLite, which it handles well for a person or a small team.
 *
 * Gitea 28 is what used to be called 1.28; the major tag is `28`. The web
 * installer is skipped (`INSTALL_LOCK`): it would ask a non-technical person
 * for paths and database settings already decided here, and with it skipped
 * the first account to register becomes the administrator. `SECRET_KEY` is
 * generated because Gitea, left without one, falls back to a constant that is
 * the same on every installation in the world. SSH is off: its port would be
 * a second one to publish and keep free, and HTTPS clones need nothing else.
 */
export const gitea: CatalogTemplate = {
  id: "gitea",
  revision: 1,
  name: "Gitea",
  description: "Repository Git tuoi, con issue, pull request e pacchetti, come un piccolo GitHub.",
  about:
    "Ospita il codice tuo o del tuo team: repository privati, revisioni, wiki, rilasci e azioni. Leggero, gira bene anche su un server piccolo.",
  category: "development",
  icon: "solar:code-square-linear",
  website: "https://docs.gitea.com/",
  keywords: ["git", "codice", "repository", "github", "gitlab", "issue", "pull request", "sviluppo"],
  web: { service: "gitea", internalPort: 3000, defaultPort: 3000 },
  healthcheck: { path: "/api/healthz", expectStatus: [200], startPeriodSec: 5, timeoutSec: 180 },
  volumes: [{ name: "gitea_data", service: "gitea", path: "/data", label: "Repository, database e impostazioni" }],
  databases: [],
  questions: [],
  secrets: [{ key: "GITEA_SECRET_KEY", label: "Chiave segreta", length: 64, alphabet: "alnum" }],
  derived: [
    { key: "APP_URL", label: "Indirizzo dell'app" },
    { key: "APP_HOST", label: "Nome dell'host" },
    { key: "GITEA_DISABLE_REGISTRATION", label: "Registrazioni chiuse" },
  ],
  derive: (ctx) => ({ ...urlVariables(ctx), GITEA_DISABLE_REGISTRATION: "false" }),
  address: "recommended",
  addressNote: "Gitea scrive il suo indirizzo negli URL per clonare: con un dominio in HTTPS funzionano da ovunque.",
  notes: [
    "Apri {APP_URL} e registrati: il primo account diventa amministratore. Fallo subito: finché non c'è, chiunque raggiunga l'indirizzo può diventarlo al posto tuo.",
    "Se lo usi solo tu o il tuo team, poi chiudi le registrazioni: in Variabili imposta GITEA_DISABLE_REGISTRATION a true e fai un nuovo deploy.",
    "Il clone via SSH è spento: si clona in HTTPS, con un token di accesso come password.",
  ],
  compose: `
services:
  gitea:
    image: gitea/gitea:28
    restart: unless-stopped
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__server__ROOT_URL: "\${APP_URL:-}/"
      GITEA__server__DOMAIN: "\${APP_HOST:-localhost}"
      GITEA__server__DISABLE_SSH: "true"
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__security__SECRET_KEY: "\${GITEA_SECRET_KEY:-}"
      GITEA__service__DISABLE_REGISTRATION: "\${GITEA_DISABLE_REGISTRATION:-false}"
    volumes:
      - gitea_data:/data

volumes:
  gitea_data:
`,
};
