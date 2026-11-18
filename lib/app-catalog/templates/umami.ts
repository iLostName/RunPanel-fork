import type { CatalogTemplate } from "../types";

/**
 * Umami 3 with PostgreSQL in the stack: 3 dropped MySQL.
 *
 * PostgreSQL 18 keeps its data one level up from where 17 did, so the volume is
 * mounted at `/var/lib/postgresql` — at the old path an 18 writes into an
 * anonymous volume and comes back empty the first time the container is
 * recreated (see `postgresVolumePath` in lib/service-versions.ts). The health
 * check goes over TCP on purpose: during its first initialisation the image
 * runs a temporary server on the socket only, which `pg_isready` without `-h`
 * would call ready.
 */
export const umami: CatalogTemplate = {
  id: "umami",
  revision: 1,
  name: "Umami",
  description: "Statistiche delle visite ai tuoi siti, senza cookie e senza cedere i dati a nessuno.",
  about:
    "Un'alternativa leggera a Google Analytics: visite, pagine, provenienza, dispositivi. Rispetta la privacy dei visitatori e i dati restano sul tuo server. PostgreSQL è compreso.",
  category: "analytics",
  icon: "solar:chart-2-linear",
  website: "https://umami.is/docs",
  keywords: ["statistiche", "analytics", "visite", "google analytics", "privacy", "gdpr", "postgresql"],
  web: { service: "umami", internalPort: 3000, defaultPort: 3000 },
  healthcheck: { path: "/api/heartbeat", expectStatus: [200], startPeriodSec: 5, timeoutSec: 240 },
  volumes: [{ name: "umami_db", service: "db", path: "/var/lib/postgresql", label: "Il database con le statistiche" }],
  databases: [{ service: "db", engine: "PostgreSQL 18" }],
  questions: [],
  secrets: [
    {
      key: "DB_PASSWORD",
      label: "Password del database",
      length: 32,
      alphabet: "alnum",
      help: "Se la cambi, usa solo lettere e numeri: finisce dentro l'indirizzo del database.",
    },
    { key: "APP_SECRET", label: "Chiave delle sessioni", length: 64, alphabet: "hex" },
    { key: "TWO_FACTOR_ENCRYPTION_KEY", label: "Chiave dell'accesso in due passaggi", length: 64, alphabet: "hex" },
  ],
  derived: [],
  derive: () => ({}),
  address: "recommended",
  addressNote: "Lo script di tracciamento va incluso nei tuoi siti: con un indirizzo in HTTPS i browser non lo bloccano.",
  notes: [
    "Apri {APP_URL} e accedi con utente admin e password umami: Umami ti chiede subito di cambiarla. Fallo prima di tutto: finché resta quella, chiunque può entrare.",
    "Aggiungi un sito e copia lo script di tracciamento nelle sue pagine.",
  ],
  compose: `
services:
  umami:
    image: ghcr.io/umami-software/umami:3
    restart: unless-stopped
    init: true
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      DATABASE_URL: "postgresql://umami:\${DB_PASSWORD:-}@db:5432/umami"
      APP_SECRET: "\${APP_SECRET:-}"
      TWO_FACTOR_ENCRYPTION_KEY: "\${TWO_FACTOR_ENCRYPTION_KEY:-}"

  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: umami
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: "\${DB_PASSWORD:-}"
    volumes:
      - umami_db:/var/lib/postgresql
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "umami", "-d", "umami"]
      start_period: 20s
      interval: 5s
      timeout: 5s
      retries: 12

volumes:
  umami_db:
`,
};
