import type { CatalogTemplate } from "../types";

/**
 * Uptime Kuma 2 on its embedded SQLite.
 *
 * `latest` still points at 1.x for the people upgrading in place, so the major
 * is named. `UPTIME_KUMA_DB_TYPE` answers the database question 2.0 otherwise
 * asks on the first visit, before the admin account.
 */
export const uptimeKuma: CatalogTemplate = {
  id: "uptime-kuma",
  revision: 1,
  name: "Uptime Kuma",
  description: "Controlla che siti e servizi rispondano e ti avvisa quando si fermano.",
  about:
    "Siti, API, porte, certificati in scadenza: li controlla ogni minuto, tiene lo storico e manda un avviso su Telegram, email, Discord e decine di altri canali. Ha anche le pagine di stato pubbliche.",
  category: "monitoring",
  icon: "solar:pulse-2-linear",
  website: "https://github.com/louislam/uptime-kuma/wiki",
  keywords: ["monitoraggio", "uptime", "stato", "status page", "avvisi", "ping", "notifiche"],
  web: { service: "uptime-kuma", internalPort: 3001, defaultPort: 3001 },
  healthcheck: { path: "/", expectStatus: [200, 302], startPeriodSec: 5, timeoutSec: 180 },
  volumes: [{ name: "uptime_kuma_data", service: "uptime-kuma", path: "/app/data", label: "Controlli, storico e impostazioni" }],
  databases: [],
  questions: [],
  secrets: [],
  derived: [],
  derive: () => ({}),
  address: "optional",
  notes: [
    "Apri {APP_URL} e crea l'account amministratore. Fallo subito: finché non c'è, chiunque raggiunga l'indirizzo può crearlo al posto tuo.",
    "Nelle impostazioni di Uptime Kuma indica l'indirizzo principale: serve ai link negli avvisi.",
  ],
  compose: `
services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    restart: unless-stopped
    ports:
      - "\${PORT:-3001}:3001"
    environment:
      UPTIME_KUMA_DB_TYPE: sqlite
    volumes:
      - uptime_kuma_data:/app/data

volumes:
  uptime_kuma_data:
`,
};
