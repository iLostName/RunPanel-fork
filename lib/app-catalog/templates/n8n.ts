import type { CatalogTemplate } from "../types";
import { urlVariables } from "../render";

/**
 * n8n on its own SQLite database, which lives in the data volume next to the
 * encryption key. Pinned to a full version because n8n publishes no major tag;
 * `stable` would move to the next major on the first pull.
 */
export const n8n: CatalogTemplate = {
  id: "n8n",
  revision: 1,
  name: "n8n",
  description: "Automazioni e flussi di lavoro tra le tue app, con un editor visuale.",
  about:
    "Collega servizi e API trascinando dei blocchi: email, fogli di calcolo, chat, webhook. I flussi girano sul tuo server, con i tuoi dati.",
  category: "automation",
  icon: "solar:routing-2-linear",
  website: "https://docs.n8n.io/hosting/",
  keywords: ["automazione", "workflow", "flussi", "zapier", "make", "webhook", "integrazioni", "api"],
  web: { service: "n8n", internalPort: 5678, defaultPort: 5678 },
  // The first start runs the database migrations, which takes a while on a small server.
  healthcheck: { path: "/healthz", expectStatus: [200], startPeriodSec: 5, timeoutSec: 240 },
  volumes: [{ name: "n8n_data", service: "n8n", path: "/home/node/.n8n", label: "Flussi, credenziali e impostazioni" }],
  databases: [],
  questions: [
    {
      key: "TIMEZONE",
      label: "Fuso orario",
      type: "text",
      format: "timezone",
      required: true,
      defaultFrom: "timezone",
      maxLength: 64,
      placeholder: "Europe/Rome",
      help: "Gli orari delle automazioni pianificate seguono questo fuso.",
    },
  ],
  secrets: [
    {
      key: "N8N_ENCRYPTION_KEY",
      label: "Chiave di cifratura",
      length: 64,
      alphabet: "hex",
      important: true,
      help: "Cifra le credenziali salvate in n8n. Conservala: senza, un backup dei dati non le riapre.",
    },
  ],
  derived: [
    { key: "APP_URL", label: "Indirizzo dell'app" },
    { key: "APP_HOST", label: "Nome dell'host" },
    { key: "N8N_PROTOCOL", label: "Protocollo" },
    { key: "N8N_SECURE_COOKIE", label: "Cookie solo su HTTPS" },
    { key: "N8N_PROXY_HOPS", label: "Proxy davanti all'app" },
  ],
  derive: (ctx) => ({
    ...urlVariables(ctx),
    N8N_PROTOCOL: ctx.https ? "https" : "http",
    // Over plain http the browser drops a Secure cookie and n8n refuses every
    // login with a page about insecure URLs, so it is only on with HTTPS.
    N8N_SECURE_COOKIE: ctx.https ? "true" : "false",
    // Behind the panel's nginx there is one proxy to trust; without saying so,
    // n8n warns on every request and rate-limits the proxy's own address.
    N8N_PROXY_HOPS: ctx.https ? "1" : "0",
  }),
  address: "recommended",
  addressNote: "Con un indirizzo i webhook hanno un URL pubblico in HTTPS, che i servizi esterni possono chiamare.",
  notes: [
    "Apri {APP_URL} e crea l'account proprietario. Fallo subito: finché non c'è, chiunque raggiunga l'indirizzo può crearlo al posto tuo.",
    "Conserva la chiave di cifratura insieme ai backup: senza, le credenziali salvate nei flussi non si possono riaprire.",
  ],
  compose: `
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:2.48.5
    restart: unless-stopped
    ports:
      - "\${PORT:-5678}:5678"
    environment:
      N8N_HOST: "\${APP_HOST:-localhost}"
      N8N_PROTOCOL: "\${N8N_PROTOCOL:-http}"
      N8N_EDITOR_BASE_URL: "\${APP_URL:-}"
      # Il nome nuovo e quello di prima del 2.30, con lo stesso valore.
      N8N_WEBHOOK_URL: "\${APP_URL:-}/"
      WEBHOOK_URL: "\${APP_URL:-}/"
      N8N_SECURE_COOKIE: "\${N8N_SECURE_COOKIE:-true}"
      N8N_PROXY_HOPS: "\${N8N_PROXY_HOPS:-0}"
      GENERIC_TIMEZONE: "\${TIMEZONE:-UTC}"
      TZ: "\${TIMEZONE:-UTC}"
      N8N_ENCRYPTION_KEY: "\${N8N_ENCRYPTION_KEY:-}"
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:
`,
};
