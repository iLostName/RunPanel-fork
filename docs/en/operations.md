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

## Notifications

The bell in the top bar collects everything that happens on the server, for every account and only about what it may see. Sending the same events outside the panel — email, Telegram, Discord, Slack, ntfy or a signed webhook — is set up in **Impostazioni › Generale › Notifiche**: what is notified, the channels, the webhook signature and how bursts are kept from becoming noise are in [Notifications](notifications.md).
