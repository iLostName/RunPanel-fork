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

## On a phone, like an app

- **It installs**: **Installa l'app** (install the app; in the account menu, or under **Altro** on a phone) puts it on the home screen and in the computer's app menu; it opens full screen, with the shortcuts Progetti, Backup and Nuovo progetto. On an iPhone it is three taps from Share, and the panel shows them. HTTPS is required: on an address without the padlock the panel explains how to get one. See [Installing the panel as an app](operations.md#installing-the-panel-as-an-app).
- **A bar along the bottom**: Panoramica, Progetti, Database, Backup and **Altro** (more), which opens a sheet with the rest of the menu, the server, notifications and the account. The top keeps the title, search and, on detail pages, the arrow back.
- **Sheets from the bottom**: confirmations and forms open as sheets rising from the edge, with their buttons under the thumb, and close by dragging them down (not once something has been typed). The "⋯" menus become a full-width list of actions.
- Tabs scroll sideways and keep the open one in view, fields no longer zoom the page on an iPhone, and toasts no longer end up under the bar.
- **Always live**: the app never shows stale data. With no network it says so, and after a panel update it offers **Aggiorna** (update) instead of reloading by itself.
- **Push notifications**: in **Account › Notifiche push** everyone turns them on on their own devices, chooses for each which events to receive and tries it with one tap. They arrive with the panel closed too, only for what the account may see, one per project, and open the right page; the app's icon shows the number of unread notifications. On iPhone, from the home-screen app. See [On your phone and computer](notifications.md#on-your-phone-and-computer).

## New project

Three steps, and the project is created only at the end: source (GitHub, or a ZIP dropped on the page), a review of what the panel recognised (for example *Next.js · porta 3000*), and going online with the first deploy followed live. A database the app needs is created and linked along with it; variables are pasted from a `.env`; an address is picked from the configured domains. If a step fails, nothing is left half-made. See [Deploying a project](deploy.md#creating-a-project).

## Ready-made apps

**Nuovo progetto › Da un modello** (from a template) opens a catalogue of one-click apps: n8n, WordPress, Uptime Kuma, Umami, Ghost, Vaultwarden, Gitea and MinIO. The panel asks only what is needed, generates the passwords (shown once, to copy), picks a free port, creates the database when the app wants one and runs the first deploy. Afterwards it is an ordinary Compose project. See [Deploying a project](deploy.md).

## The project page

- It opens on **Panoramica** (overview): the state in one sentence and the next thing to do, the last deploy, resources and charts, uptime, addresses, linked databases.
- Tabs **Deploy** (with **Ripristina** on earlier versions and **Annulla** on the deploy in progress), **Log**, **Variabili**, **File**, **Terminale**, **Impostazioni**.
- Settings have a side menu (Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa) and a single save bar. The old "Aggiungi al progetto › App" path is gone: the source is changed from **Impostazioni › Sorgente**.
- A failed deploy states its cause and the fix in words; for Docker projects, when the new version does not answer, the previous one comes back online by itself. Native projects can turn it on, see below.
- **One folder per version, new and to be tried** (native projects from GitHub, on Linux): off by default, turned on per project with **Se non risponde, rimetti online la versione precedente** (Impostazioni › Build e avvio, marked **Nuovo**). From then on every deploy prepares the new version in `data/releases/<slug>/<id>` while the old one stays online, and if the new one does not answer the previous one comes back. SQLite databases, uploads and the other files the app writes stay in the project folder, shared between versions; the **File** tab, scheduled tasks and Restart follow the running version. The first deploy after turning it on prepares the folders and the return works from the second: trying it first on a less important project is a good idea. Updating the panel changes nothing for existing projects, and switching it off puts the deploy back in the project folder with nothing to move. See [Going back to the previous version](deploy.md#going-back-to-the-previous-version).
- **Deploys without downtime, new** (Docker projects with an address): off by default, turned on per project with **Deploy senza interruzioni** (Impostazioni › Build e avvio, marked **Nuovo**). The new version starts beside the one online, on an internal port of its own; once it passes the health check nginx moves to it with a configuration checked by `nginx -t`, and the old one stops after finishing its requests. If the new one does not answer, or nginx refuses the switch, the version online is never touched. The app is then reached through its addresses only, and for a few seconds two copies run on the same volumes. See [Deploys without downtime](deploy.md#deploys-without-downtime).
- From **Altro**: Duplica, Esporta configurazione, Vedi attività. An exported configuration is imported from the wizard in expert mode.
- **Variabili**: a table or a `.env` text view, paste a `.env` choosing whether to overwrite or skip existing keys, values hidden until shown, the error on the row that is wrong, linked databases' variables with where they come from, and **Salva e ridistribuisci** (save and redeploy).
- **Scheduled tasks** (Impostazioni › Automazioni): a command with a schedule, run in the project ("every night at 3, clear the cache"), with history, output and outcome of every run, "Esegui ora" (run now), a time limit and an alert when it fails. It never runs twice at once nor during a deploy.
- **Log**: search, errors only, pause, download. The panel keeps each app's log on disk, rotated, and it can be searched after a restart too.

## Shared variables

- **Variabili condivise** (in the menu, next to Database): named groups of encrypted variables — SMTP credentials, an API key — that several projects receive and that are changed in one place. A group's page lists the projects that use it and, after a change, offers **Ridistribuisci i progetti interessati** (redeploy the affected projects).
- A project attaches groups from the **Variabili** tab, in the order it wants. The project's own variables win over the groups, a later group over an earlier one, and an enabled database link still wins over everything, as before. **Cosa riceve l'app** (what the app receives) shows every variable once, with where it comes from, what it replaces and the conflicts between groups.
- **References**: a value can read another one — `${{ shared.smtp.HOST }}`, `${{ db.cache.url }}`, `${{ project.api.url }}` — resolved at every deploy and restart. One that does not resolve stops the deploy before anything is touched, naming the variable: an empty value never reaches the app.
- A new **Variabili condivise** permission reads, edits and attaches groups; a reference may only point at what whoever writes it could read. Groups belong to one server: a project uses those of the server it runs on. See [Shared variables](deploy.md#shared-variables).

## The database page

The same header as the project page and tabs Panoramica, Connessione, Console, **Dati** (data), Database interni, Backup, Impostazioni. **Dati** shows tables and rows (PostgreSQL, MySQL), keys (Redis) and documents (MongoDB), and runs queries: always read-only, with a row and a time limit, and every read goes to the activity log. On creation the panel proposes the name and a free port. The Nginx, Apache and Caddy cards, which did nothing, are gone.

## Addresses and HTTPS

An address is added from the project page: the panel shows the DNS record to create, checks it live and requests the certificate only once DNS is ready. Each address shows its certificate state; the domain can bring its `www` along. See [Domains](domains.md).

- **The panel on HTTPS**: from **Impostazioni › Generale** give it a name on your domain; the panel checks DNS and the certificate, tries the new address, and only then offers to use it as the public address. The usual port keeps working, and "Disattiva" puts everything back.
- **Instant address**: a project without a domain can get a name like `project.1-2-3-4.sslip.io` right away, HTTP only (the service is shared and does not allow dependable certificates): handy for a test, not for real use.

## Metrics and Monitor

History of CPU, memory, disk and network for the server, projects and databases, with 1-hour, 24-hour and 7-day charts; alerts when CPU or RAM stay above 90% for 5 minutes; a check every minute that apps answer, with uptime and incidents. The Monitor sorts, and shows Compose containers and the ones the panel does not manage.

**Public status page**, optional and off by default: an address to give the people using the apps, which opens without signing in and says whether the apps you choose answer, with uptime over the last 24 hours and 30 days and the recent outages. It shows only the title, the message and the names you write, projects of linked servers included; while off, its address answers "Pagina non trovata" (page not found). Set it up in **Impostazioni › Generale**. See [Operations](operations.md#public-status-page).

## Backups

- The one-click nightly backup includes project volumes and uses the default destination.
- The schedule is picked in words ("every day at 03:00", "every Monday"…), with the raw cron under "Avanzate", and the time zone from a list.
- S3 destinations come with ready-made providers (AWS, Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO), are tested before being saved, can be edited and deleted; S3 errors are explained in Italian.
- **Telegram as a destination**: archives go to a private channel the panel creates, or to your Saved Messages, through your own account — linked with the QR code from the app or with number, code and two-step password, using your own app's keys from my.telegram.org. Telegram Premium raises files from 2 to 4 GB, and the panel detects it at every backup; larger archives are split into parts and put back together by the restore. See [Backups](backups.md#telegram).
- **New destinations**: an SFTP server or NAS (Synology, QNAP, Hetzner Storage Box), with a key the panel generates and the server's fingerprint pinned on the first check; a WebDAV folder (Nextcloud, ownCloud, Koofr, pCloud, a NAS's WebDAV); Google Drive, OneDrive, Dropbox and the other services rclone speaks, when rclone is installed on the server. Every archive is uploaded under a provisional name and only gets its own once complete. See [Backups](backups.md#where-they-go).
- **Verifica integrità** (integrity check) on every archive, and a restore checks the archive before touching anything. An archive uploaded from your computer can be restored too.
- Each database's page shows its backups, with "Esegui backup ora" (back up now) and restore.
- **Several copies of every backup** (the 3-2-1 rule): a policy writes the same archive to several destinations, in order — the server's disk, a second disk and a bucket, say —, each with its own retention. When a copy does not arrive the backup stays valid, a warning is sent and the copy can be retried from the run's page; restore, download and integrity check use the first available copy, those on the server first. A local destination can now write to a folder of its own, like a second disk. Existing policies keep their one destination until you add more. See [Backups](backups.md#several-copies-of-every-backup-3-2-1).
- **Archive encryption** (Backup page): with a backup password every new archive leaves the server encrypted whole (`.zip.enc`), manual and safety backups included. The panel opens its own archives by itself, even after a password change; an archive from another server asks for its password when you upload it, and `scripts/decrypt-backup.mjs` decrypts one without the panel. Nothing changes until you set it. See [Backups](backups.md#encryption-with-a-password).
- **Another RunPanel server as a destination**: with two linked servers, each can keep the other's off-site copy, with no third-party account. The copies sit in the other server's data directory, apart from its own backups, and travel with the cluster's signed requests, checked for size and sha256 before they get their name. On every server, **Backup › Copie per altri server** (copies for other servers) shows what it keeps for the others and how much space it takes, with a limit per server and the download to rebuild a lost server. See [Backups](backups.md#another-runpanel-server).

## Notifications

Alerts by email, Telegram, Discord, Slack, ntfy or a signed webhook: each channel picks its events (or "only when something goes wrong") and has "Invia una prova" (send a test). In the panel, the bell at the top shows unread alerts and updates by itself; **Notifiche** lists them all. The old Telegram bot becomes the first channel. See [Notifications](notifications.md).

## Account and security

- **Two-step sign-in** with an authenticator app and recovery codes, "remember this device", sessions listed and closable.
- **Sign in with GitHub**: the owner sets up a GitHub OAuth App once (**Impostazioni › Generale › Accesso con GitHub**, a step-by-step guide with the callback URL to copy and a **Verifica** button); each user then links their GitHub account from **Impostazioni › Account**, or accepts an invitation with GitHub. A GitHub account never creates a user, two-step verification is still asked for, and before it is turned off the panel names whoever signs in only with GitHub and would be locked out. See [Signing in with GitHub](users.md#signing-in-with-github).
- **`scripts/reset-owner.mjs`** resets the owner's password (and, if needed, two-step sign-in) from the server's terminal. See [Users and permissions](users.md).
- **Activity log** filterable by user, resource and action, and exportable as CSV.
- **AI e API › API**: a reference of every API with `curl` examples.

## First run

The setup screen says where to find the setup token for how the panel runs (systemd, Docker, PM2, a terminal), and the login page warns when the connection is not HTTPS.
