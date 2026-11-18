[← RunPanel](../../README.md) · [Italiano](../it/operations.md) · **English**

---

# Operations

Everything below concerns the server selected in the bar: with [several servers](multi-server.md) each has its own autostart, cleanup and update.

## Autostart

**Salute › Avvio automatico** (health, autostart) says what the machine already does at boot and generates what is missing:

- a **systemd unit** with absolute paths, after and requiring `docker.service`. If the panel runs as root it installs it, otherwise it shows a block to paste;
- where there is no systemd, a supervised **`@reboot` script**, which the panel adds to the user's crontab itself. Its output goes to `logs/autostart.log`.

The panel never runs `systemctl start`, which would put a second panel on the same port. The unit has `KillMode=process`, so `systemctl stop runpanel` does not stop PM2 or the native apps it supervises; Docker containers are not involved.

The page also checks what a reboot really needs: Docker enabled at boot (**Abilita** button) and PM2's process list saved (**pm2 save** button) when PM2 runs at least one app. Without them, after a reboot the panel comes back and the apps do not.

After a reboot, what was on and what stopped by itself comes back. A project or service stopped by hand stays stopped.

Every project and service has a switch, an order, a delay and whether to wait for it to be ready before moving on, at most one minute: a service when its engine answers, a project when it passes the health check of its last deploy (or, with the health check off, when the process is up). By default services come back and are waited for, projects do not; services always start before projects. At boot the panel waits 20 seconds for Docker to restart what it knows about, then starts only what is still down, 2 seconds apart, never triggering a build. **Simula** (simulate) shows what it would do, **Esegui ora** (run now) does it.

Status in the lists is rechecked every half minute and after the reconcile: a project can turn **Fermo** (stopped) without anyone stopping it just then, meaning it was already down. The check never starts or stops anything, and needs two agreeing readings before marking stopped something that was up.

## Scheduled restart

The **Riavvio programmato** section is in the project's settings and on the service page. Pick a ready interval (every night at 04:00, every Sunday, every 6 hours, every hour) or a five-field cron expression, with a preview of the next three restarts.

Times are in the **panel's timezone** (**Impostazioni › Pannello**, the same as backups); until you set it, UTC, and the page says so. Changing it recomputes pending restarts at once.

At the scheduled time:

- **Running**: restarted. A project comes back from its last successful deploy, with the linked services' variables.
- **Stopped by you**: left stopped.
- **Crashed on its own**: **one attempt** to bring it back, retried only if it comes up and falls again.
- **Deploy in progress** or **last deploy failed**: skipped.

The page shows the last occurrence and what it did. If the panel was off at the scheduled time, the restart happens once as soon as it is back, even if several were missed. With notifications on, every restart performed or failed sends a message; skips do not.

## Freeing space

**Salute › Spazio disco** (Docker cleanup) shows how much Docker uses and what can be reclaimed. **Pulisci ora** (clean now) removes only what can be recreated, never volumes or data:

- old versions of project images, beyond those kept for rollback (2 per project by default);
- unnamed images no container uses, build leftovers including compose's;
- RunPanel's orphan containers, images and networks, including compose images of a deleted project;
- build cache: all of it, or only what is older than a week. All of it frees more, but every project's next build starts from scratch.

An option, off by default, removes **every image no container uses**, including those RunPanel did not create (old databases, base images, other Docker projects). They are pulled again when needed, but an image built by hand and never pushed would be lost: that is why it asks to confirm. Versions kept for rollback stay.

The space freed is measured on Docker's usage before and after. Orphan volumes are removed only from the **Risorse orfane** (orphan resources) panel, because they hold data.

Every 6 hours the panel does the safe part by itself: image retention, its own unnamed images, and build cache older than a week. Deleting a Compose project also removes the images compose built, and every container the panel starts has its log capped at three 10 MB files (from the next deploy or recreation; for Compose your file decides).

## Updating the panel

RunPanel runs from a git clone of its repository. The version shown is `v0.1.0+125`, where the number is the mainline commit count (on a shallow clone, the SHA). At intervals (1, 6 or 24 hours, chosen on the page) it runs `git fetch` and compares; for a private repository it uses the panel's GitHub token. **It never applies anything by itself**: when the branch moves a strip appears at the top of the pages with the **Aggiorna** (update) button, and **Impostazioni › Aggiornamenti** lists the commits. With several servers, strip and page follow the selected server: to update a node, select it.

After **Aggiorna**, the panel:

1. fetches the commits and, if you turned it on, checks the signature;
2. copies the SQLite store with `VACUUM INTO` (a Postgres store is not copied);
3. aligns the checkout with `git reset --hard` and `git clean -fd`: uncommitted local changes are lost, while ignored files (`data/`, `node_modules/`, `.next`) and `.env*` stay, and the log lists what is removed;
4. installs dependencies and builds the new version into `.next-update`, without touching the running one;
5. swaps the folders with two renames (the old one goes to `.next-old`) and exits with code 75: systemd (`Restart=always`) or the `@reboot` script brings it back.

A minute after a successful restart, `.next-old` and the store copy are deleted. If something fails before the swap, checkout and dependencies go back as they were and the panel keeps running the previous version.

The update is refused if the panel is not a git clone with an https or ssh `origin` remote, if HEAD is detached, if it runs in development mode, in a container or on Windows, with less than 2 GB free, or while a deploy, backup or restore runs (checked again after the build). Without a supervisor the button becomes **Prepara** (prepare): the new version is built, but the swap and the restart remain two commands to run by hand.

**Commit signatures.** Optional and off by default: the Updates page can require commits signed by allowed GPG or SSH keys (**Firmatari ammessi**, for SSH).

If the panel did not come back, the commands to restore the previous version are in `<dataDir>/panel-update.json` and in the supervisor's log (systemd's journal, or `logs/autostart.log` with the script).

## Installing the panel as an app

The panel installs on a phone and on a computer as an app: it opens from its own icon, full screen and without the browser's bar. On a phone the main sections are in the bar along the bottom, and the rest (server, notifications, account) is under **Altro** (more).

- **Android, and Chrome or Edge on a computer**: **Installa l'app** (install the app) in the account menu (under **Altro** on a phone), or the install icon in the address bar. On a phone the overview also suggests it once, with a card at the bottom.
- **iPhone and iPad**: in Safari tap **Share**, then **Add to Home Screen**. **Installa l'app** shows the steps.
- **HTTPS is required.** No browser installs an app from an address without the padlock (`localhost` is the exception). Opened at `http://<ip>:3000`, **Installa l'app** explains why and leads to **Impostazioni › Generale › Metti il pannello su HTTPS** (put the panel on HTTPS).

A long press on the icon (Android) or a right click (computer) offers the shortcuts **Progetti**, **Backup** and **Nuovo progetto**.

The app always shows live data: pages and API calls come from the server every time, and only the panel's own files, which are renamed with every version, and the icons are kept, so that it opens quickly. With no network, or with the server not answering (for example while it restarts after an update), a page says so and reloads by itself as soon as the server is back. When the panel is updated, the open app shows **Nuova versione del pannello** (new version of the panel) with **Aggiorna**: it reloads only when you press it, so a half-filled form is never lost. Links to other sites open in the browser.

## Notifications

The bell in the top bar collects everything that happens on the server, for every account and only about what it may see. Sending the same events outside the panel — email, Telegram, Discord, Slack, ntfy or a signed webhook — is set up in **Impostazioni › Generale › Notifiche**: what is notified, the channels, the webhook signature and how bursts are kept from becoming noise are in [Notifications](notifications.md).

## Public status page

Every minute the panel asks each app with a port and its health check on whether it answers: two missed answers in a row open an outage, and the project's Overview shows uptime and incidents. The **public status page** shows the same to the people using the apps, without giving them access to the panel. It is optional and stays off until you turn it on.

It is set up in **Impostazioni › Generale › Pagina di stato pubblica** (settings, general, public status page), by the owner only, like the panel's other preferences. Unlike the rest of this page, it belongs to the panel you have open, not to the server selected in the bar.

- **Indirizzo** (address): `<panel address>/status/<path>`. The proposed path is random, twelve letters and digits, so only people given the link find the page. You can pick a memorable one, such as `stato`, but then anyone can reach it by guessing. **Nuovo indirizzo** (new address) generates another one: the old one stops working when you save. The page answers wherever the panel does, its HTTPS address included, and the link to copy uses the panel's public address when one is set.
- **Titolo** and **messaggio** (title and message): the message is optional and shown at the top of the page as typed, for instance to announce maintenance.
- **Progetti** (projects): which ones appear, in what order and under what name. The proposed name is the project's name in the panel: you confirm or change it, and from then on it stays what you wrote, even if the project is renamed. Next to a project the check does not ask (health check off, no port, app stopped) the panel says what the page will show.
- **Motori di ricerca** (search engines): off by default; the page asks not to be indexed.

The page says in one sentence how things are and, for each project, its state (**Operativo** — up, **Non risponde** — not answering, **In aggiornamento** — being updated, during a deploy or a restart, **Nessun dato** — no data, when there are no recent checks), uptime over the last 24 hours and 30 days, one bar per day, and the outages of the last 30 days with start, end and length. Times are in the panel's time zone, which the page names. It never shows the projects' internal names, ports, paths, addresses, servers or the technical reason for an outage: only the title, the message and the names you wrote. It works on a phone, light and dark, and without JavaScript.

Off, or at a wrong path, it answers **Pagina non trovata** (page not found), exactly like an address that does not exist: guessing does not reveal that the page is there. If you are the owner and signed in, the link of a page that is off opens a preview, marked as such, that only you see. The figures are recomputed at most every 30 seconds however many people visit, and an open page refreshes itself every minute. Turning the page on or off and changing it is recorded in the activity log. The link can also be copied from the check's card in the Overview of each project of this server that is on the page.

With [several servers](multi-server.md) the page can also show projects of linked servers: each one checks its own apps, and the panel asks each of them, with a signed request and at most every 30 seconds, for only the public state of the chosen projects. If a server does not answer, its projects show as **Nessun dato**; a deleted project disappears from the page. For projects of other servers the link does not appear on their card: copy it from the settings.
