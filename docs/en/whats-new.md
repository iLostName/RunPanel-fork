[← RunPanel](../../README.md) · [Italiano](../it/novita.md) · **English**

---

# What's new

For people already using the panel: where things moved and what was added. Nothing has to be redone: projects, databases, backups and users stay as they are, and the old page addresses still lead where they should.

## The menu

- **Salute** (health) holds Monitor, Diagnostica, Avvio automatico and Spazio disco (formerly under *Sistema*).
- **Team** holds Utenti and Registro attività (formerly under *Accesso*).
- **Impostazioni** (settings) holds Generale (the panel's preferences), Account, GitHub, AI e API, Aggiornamenti and Server collegati.
- **Domini** (domains) has its own entry.
- **Expert mode** (from the account menu or **Impostazioni › Account**) shows technical details and opens the "Avanzate" sections. Off, the panel talks about what the app does rather than ports and runtimes.
- Search (**Ctrl K**) opens pages, projects and databases and runs the most common actions.

## New project

Three steps, and the project is created only at the end: source (GitHub, or a ZIP dropped on the page), a review of what the panel recognised (for example *Next.js · porta 3000*), and going online with the first deploy followed live. A database the app needs is created and linked along with it; variables are pasted from a `.env`; an address is picked from the configured domains. If a step fails, nothing is left half-made. See [Deploying a project](deploy.md#creating-a-project).

## Ready-made apps

**Nuovo progetto › Da un modello** (from a template) opens a catalogue of one-click apps: n8n, WordPress, Uptime Kuma, Umami, Ghost, Vaultwarden, Gitea and MinIO. The panel asks only what is needed, generates the passwords (shown once, to copy), picks a free port, creates the database when the app wants one and runs the first deploy. Afterwards it is an ordinary Compose project. See [Deploying a project](deploy.md).

## The project page

- It opens on **Panoramica** (overview): the state in one sentence and the next thing to do, the last deploy, resources and charts, uptime, addresses, linked databases.
- Tabs **Deploy** (with **Ripristina** on earlier versions and **Annulla** on the deploy in progress), **Log**, **Variabili**, **File**, **Terminale**, **Impostazioni**.
- Settings have a side menu (Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa) and a single save bar. The old "Aggiungi al progetto › App" path is gone: the source is changed from **Impostazioni › Sorgente**.
- A failed deploy states its cause and the fix in words; for Docker projects, when the new version does not answer, the previous one comes back online by itself.
- From **Altro**: Duplica, Esporta configurazione, Vedi attività. An exported configuration is imported from the wizard in expert mode.
- **Variabili**: a table or a `.env` text view, paste a `.env` choosing whether to overwrite or skip existing keys, values hidden until shown, the error on the row that is wrong, linked databases' variables with where they come from, and **Salva e ridistribuisci** (save and redeploy).
- **Log**: search, errors only, pause, download. The panel keeps each app's log on disk, rotated, and it can be searched after a restart too.

## The database page

The same header as the project page and tabs Panoramica, Connessione, Console, Database interni, Backup, Impostazioni. On creation the panel proposes the name and a free port. The Nginx, Apache and Caddy cards, which did nothing, are gone.

## Addresses and HTTPS

An address is added from the project page: the panel shows the DNS record to create, checks it live and requests the certificate only once DNS is ready. Each address shows its certificate state; the domain can bring its `www` along. See [Domains](domains.md).

## Metrics and Monitor

History of CPU, memory, disk and network for the server, projects and databases, with 1-hour, 24-hour and 7-day charts; alerts when CPU or RAM stay above 90% for 5 minutes; a check every minute that apps answer, with uptime and incidents. The Monitor sorts, and shows Compose containers and the ones the panel does not manage.

## Backups

- The one-click nightly backup includes project volumes and uses the default destination.
- The schedule is picked in words ("every day at 03:00", "every Monday"…), with the raw cron under "Avanzate", and the time zone from a list.
- S3 destinations come with ready-made providers (AWS, Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO), are tested before being saved, can be edited and deleted; S3 errors are explained in Italian.
- **Verifica integrità** (integrity check) on every archive, and a restore checks the archive before touching anything. An archive uploaded from your computer can be restored too.
- Each database's page shows its backups, with "Esegui backup ora" (back up now) and restore.

## Notifications

Alerts by email, Telegram, Discord, Slack, ntfy or a signed webhook: each channel picks its events (or "only when something goes wrong") and has "Invia una prova" (send a test). In the panel, the bell at the top shows unread alerts and updates by itself; **Notifiche** lists them all. The old Telegram bot becomes the first channel. See [Notifications](notifications.md).

## Account and security

- **Two-step sign-in** with an authenticator app and recovery codes, "remember this device", sessions listed and closable.
- **`scripts/reset-owner.mjs`** resets the owner's password (and, if needed, two-step sign-in) from the server's terminal. See [Users and permissions](users.md).
- **Activity log** filterable by user, resource and action, and exportable as CSV.
- **AI e API › API**: a reference of every API with `curl` examples.

## First run

The setup screen says where to find the setup token for how the panel runs (systemd, Docker, PM2, a terminal), and the login page warns when the connection is not HTTPS.
