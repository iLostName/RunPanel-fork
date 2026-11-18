import type { CatalogTemplate } from "../types";
import { urlVariables } from "../render";

/**
 * MinIO, through the community's continuation of it.
 *
 * MinIO Inc. stopped publishing images of the community edition in October
 * 2025 and later removed `minio/minio` from Docker Hub, so the official name
 * no longer pulls at all. `pgsty/minio` is built from the same source, with the
 * administration console MinIO had taken out and the security fixes since; it
 * is a drop-in replacement and keeps MinIO's date-based tags, which is why the
 * pin is a whole release. Whoever prefers another build only has to change the
 * `image` line.
 *
 * Two ports: the console is the project's, the one an address goes to; the S3
 * API is the one programs use, published next to it.
 */
export const minio: CatalogTemplate = {
  id: "minio",
  revision: 1,
  name: "MinIO",
  description: "Archiviazione di file compatibile con Amazon S3, per backup e applicazioni.",
  about:
    "Un servizio S3 sul tuo server: le app ci salvano file e i backup ci finiscono dentro, con una console per gestire bucket e chiavi di accesso.",
  category: "storage",
  icon: "solar:cloud-storage-linear",
  website: "https://github.com/pgsty/minio",
  keywords: ["s3", "object storage", "archiviazione", "file", "bucket", "backup", "storage"],
  web: { service: "minio", internalPort: 9001, defaultPort: 9001 },
  healthcheck: { path: "/", expectStatus: [], startPeriodSec: 3, timeoutSec: 120 },
  volumes: [{ name: "minio_data", service: "minio", path: "/data", label: "I bucket e i file" }],
  databases: [],
  questions: [
    {
      key: "MINIO_ROOT_USER",
      label: "Nome dell'amministratore",
      type: "text",
      format: "username",
      required: true,
      default: "admin",
      minLength: 3,
      maxLength: 64,
      help: "Con questo nome e la password generata entri nella console.",
    },
    {
      key: "MINIO_API_PORT",
      label: "Porta dell'API S3",
      type: "number",
      port: true,
      required: true,
      advanced: true,
      default: "9000",
      help: "Dove le app e i backup si collegano. Ne propongo una libera; se la cambi, controllo che non sia occupata.",
    },
  ],
  secrets: [
    {
      key: "MINIO_ROOT_PASSWORD",
      label: "Password dell'amministratore",
      length: 24,
      alphabet: "alnum",
      important: true,
      help: "Per entrare nella console. Alle app dai chiavi di accesso create lì, non questa.",
    },
  ],
  derived: [{ key: "APP_URL", label: "Indirizzo della console" }],
  derive: (ctx) => ({ APP_URL: urlVariables(ctx).APP_URL }),
  address: "optional",
  notes: [
    "Apri {APP_URL} ed entra come {MINIO_ROOT_USER} con la password generata.",
    "Le app si collegano all'API S3 sulla porta {MINIO_API_PORT} di questo server: crea per loro una chiave di accesso dalla console, invece di dare la password dell'amministratore.",
  ],
  compose: `
services:
  minio:
    image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z
    restart: unless-stopped
    command: ["server", "/data", "--console-address", ":9001"]
    ports:
      - "\${PORT:-9001}:9001"
      - "\${MINIO_API_PORT:-9000}:9000"
    environment:
      MINIO_ROOT_USER: "\${MINIO_ROOT_USER:-}"
      MINIO_ROOT_PASSWORD: "\${MINIO_ROOT_PASSWORD:-}"
      MINIO_BROWSER_REDIRECT_URL: "\${APP_URL:-}"
    volumes:
      - minio_data:/data

volumes:
  minio_data:
`,
};
