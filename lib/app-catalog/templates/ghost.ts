import type { CatalogTemplate } from "../types";
import { urlVariables } from "../render";

/**
 * Ghost 6 with MySQL, the only database it supports in production.
 *
 * MySQL 8.4, the LTS line: Ghost asks for "MySQL 8", and 8.0 stopped receiving
 * fixes in 2026. Ghost redirects every request to its configured `url`, so it
 * is the one value here that has to be right from the first start.
 */
export const ghost: CatalogTemplate = {
  id: "ghost",
  revision: 1,
  name: "Ghost",
  description: "Blog e newsletter in un unico posto, veloce e senza distrazioni.",
  about:
    "Scrivi articoli, mandali come newsletter, accetta iscrizioni e abbonamenti. Un editor pulito e un sito veloce, con MySQL compreso.",
  category: "websites",
  icon: "solar:notebook-linear",
  website: "https://ghost.org/docs/",
  keywords: ["blog", "newsletter", "pubblicazione", "articoli", "abbonamenti", "mysql", "substack"],
  web: { service: "ghost", internalPort: 2368, defaultPort: 2368 },
  // Not 503: Ghost answers that while its first migrations are still running.
  healthcheck: { path: "/", expectStatus: [200, 301, 302], startPeriodSec: 10, timeoutSec: 300 },
  volumes: [
    { name: "ghost_content", service: "ghost", path: "/var/lib/ghost/content", label: "Immagini, temi e file caricati" },
    { name: "ghost_db", service: "db", path: "/var/lib/mysql", label: "Il database con articoli e iscritti" },
  ],
  databases: [{ service: "db", engine: "MySQL 8.4" }],
  questions: [],
  secrets: [
    { key: "DB_PASSWORD", label: "Password del database", length: 32, alphabet: "alnum" },
    { key: "DB_ROOT_PASSWORD", label: "Password di amministrazione del database", length: 32, alphabet: "alnum" },
  ],
  derived: [{ key: "APP_URL", label: "Indirizzo del blog" }],
  derive: (ctx) => ({ APP_URL: urlVariables(ctx).APP_URL }),
  address: "recommended",
  addressNote: "Ghost scrive il suo indirizzo in ogni link e nelle newsletter: con un dominio in HTTPS i lettori lo trovano e le email non finiscono nello spam.",
  notes: [
    "Apri {APP_URL}/ghost e crea l'account proprietario. Fallo subito: finché non c'è, chiunque raggiunga l'indirizzo può crearlo al posto tuo.",
    "Per inviare newsletter e inviti serve la posta: configurala seguendo la guida di Ghost sulle email.",
    "Se in futuro cambi indirizzo, aggiorna anche APP_URL nelle variabili e fai un nuovo deploy: Ghost reindirizza tutto lì.",
  ],
  compose: `
services:
  ghost:
    image: ghost:6-alpine
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "\${PORT:-2368}:2368"
    environment:
      url: "\${APP_URL:-}"
      database__client: mysql
      database__connection__host: db
      database__connection__user: ghost
      database__connection__password: "\${DB_PASSWORD:-}"
      database__connection__database: ghost
    volumes:
      - ghost_content:/var/lib/ghost/content

  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD: "\${DB_PASSWORD:-}"
      MYSQL_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD:-}"
    volumes:
      - ghost_db:/var/lib/mysql
    healthcheck:
      # Risponde solo quando il server vero è su: durante la prima
      # inizializzazione ne gira uno temporaneo senza rete.
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
      start_period: 30s
      interval: 10s
      timeout: 5s
      retries: 12

volumes:
  ghost_content:
  ghost_db:
`,
};
