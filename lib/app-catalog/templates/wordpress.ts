import type { CatalogTemplate } from "../types";

/**
 * WordPress with MariaDB in the same stack.
 *
 * MariaDB is pinned to 11.8, the LTS line, rather than `11`: within 11 the tag
 * used to walk through short-term releases too. The site address is not set
 * from here — WordPress records the one it is first opened on, and setting it
 * through `WORDPRESS_CONFIG_EXTRA` would mean writing a value into PHP source.
 * Behind the panel's proxy HTTPS is detected by the image itself, from
 * `X-Forwarded-Proto`.
 */
export const wordpress: CatalogTemplate = {
  id: "wordpress",
  revision: 1,
  name: "WordPress",
  description: "Il sito o il blog più diffuso al mondo, con migliaia di temi e plugin.",
  about:
    "Pagine, articoli, negozio online con i plugin giusti: si gestisce tutto dal browser. Il database MariaDB è compreso e collegato da solo.",
  category: "websites",
  icon: "solar:pen-new-square-linear",
  website: "https://wordpress.org/documentation/",
  keywords: ["sito", "blog", "cms", "pagine", "woocommerce", "negozio", "mariadb", "mysql"],
  web: { service: "wordpress", internalPort: 80, defaultPort: 8080 },
  healthcheck: { path: "/", expectStatus: [200, 301, 302], startPeriodSec: 5, timeoutSec: 180 },
  volumes: [
    { name: "wordpress_files", service: "wordpress", path: "/var/www/html", label: "WordPress, temi, plugin e caricamenti" },
    { name: "wordpress_db", service: "db", path: "/var/lib/mysql", label: "Il database" },
  ],
  databases: [{ service: "db", engine: "MariaDB 11.8" }],
  questions: [],
  secrets: [
    { key: "DB_PASSWORD", label: "Password del database", length: 32, alphabet: "alnum" },
    { key: "DB_ROOT_PASSWORD", label: "Password di amministrazione del database", length: 32, alphabet: "alnum" },
  ],
  derived: [],
  derive: () => ({}),
  address: "recommended",
  addressNote: "WordPress ricorda l'indirizzo da cui lo apri la prima volta: sceglilo ora, cambiarlo dopo è scomodo.",
  notes: [
    "Apri {APP_URL} e completa l'installazione: lingua, nome del sito e account amministratore. Fallo subito: finché non la completi, chiunque raggiunga l'indirizzo può farlo al posto tuo.",
    "Aprilo dall'indirizzo che userai sempre: WordPress lo ricorda e lo usa in tutti i link.",
  ],
  compose: `
services:
  wordpress:
    image: wordpress:7-apache
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "\${PORT:-8080}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: "\${DB_PASSWORD:-}"
    volumes:
      - wordpress_files:/var/www/html

  db:
    image: mariadb:11.8
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: "\${DB_PASSWORD:-}"
      MARIADB_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD:-}"
      # Aggiorna da solo i dati quando l'immagine passa a una versione nuova.
      MARIADB_AUTO_UPGRADE: "1"
    volumes:
      - wordpress_db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      start_period: 30s
      interval: 10s
      timeout: 5s
      retries: 12

volumes:
  wordpress_files:
  wordpress_db:
`,
};
