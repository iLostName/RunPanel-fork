[← RunPanel](../../README.md) · [Italiano](../it/backups.md) · **English**

---

# Backups and restore

A *policy* says what to save, where, how often and how many archives to keep. Policies, destinations, archives and restores belong to the server they are on: with [several servers](multi-server.md) each has its own, and an archive can only be decrypted with the key of the server that took it.

Accounts other than the owner back up and restore only the projects and services they manage, one at a time (see [Users and permissions](users.md)).

## What can be saved

| Target | What it covers |
|---|---|
| One service | the whole dump (`pg_dumpall`, roles included, for Postgres) or the databases you pick |
| All services | including the ones you create later |
| One project | your choice of: configuration, Docker volumes, repository |
| All projects | same rule, future ones included |
| The panel | RunPanel's store, with or without the encryption key |

Every dump runs **inside the container it belongs to**, so client and server are the same version. The panel's SQLite store is captured with `VACUUM INTO` and checked with `PRAGMA integrity_check`; the Postgres store with a custom-format `pg_dump`, in a container of the same major.

A project uploaded as a ZIP always includes its repository. The repository copy skips `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` and the like, and the `.env` the panel writes. For a native project with [version folders](deploy.md#going-back-to-the-previous-version) it also takes the files the app created in the running version, which reach the project folder only at the next deploy.

## Project volumes

With **Docker volumes** among the things to save, a project brings every volume of its own into the archive (`projects/<slug>/volumes/<volume>.tar.gz`):

- those RunPanel creates with the `runpanel.project=<slug>` label, for instance the volume of a linked database;
- those of the project's **Compose stack**, recognised by the exact Compose project name `runpanel-<slug>` (`runpanel-shop` never takes `runpanel-shop2`'s volumes).

An `external: true` volume does not belong to the stack and is not backed up: save it separately. The log lists the volumes found for each project; if Docker does not answer, the project shows as skipped with the reason.

### Consistency of the copy

Copying a volume while the app writes to it can produce a database that restores without errors and is broken. In the project's **Impostazioni** tab, **Backup dei volumi** section (volume backup), you choose what happens during the copy:

| Mode | What it does |
|---|---|
| **Metti in pausa chi scrive** (pause the writers, default) | `docker pause` on just the project's containers that mount the volume read-write, for just the time of the read. The copy is what a power cut would leave, which SQLite (WAL included) and Postgres recover from by themselves. |
| **Copia a caldo** (live copy) | No pause. The copy may be inconsistent, and log and manifest say so. |

To keep the pause short, the volume is written to disk uncompressed and compressed afterwards, with the containers resumed. If free space (beyond a 2 GB reserve) is not enough, it is compressed during the pause at the fastest level; if even that will not fit, the volume is refused before anything is paused. A pause over 10 minutes is broken off, the containers resumed and the volume marked as not saved. Read-only containers are not paused; a container of another project writing to the same volume is never touched, and the copy is marked as not guaranteed.

If the panel stops during a pause, the containers are resumed at the next start or the next backup. A paused container triggers no crash notifications.

**Comando prima del backup** (pre-backup command). For Compose projects, a command run once per backup in a service of the stack before the volumes are copied (`sh -c`, timeout 5 to 3600 seconds): for instance a SQLite `.backup` or a `pg_dump` into the volume. If it fails with the pause on, the backup goes on; if it fails with a live copy and something is writing, the volume is not saved.

### Exclusions

Still in **Backup dei volumi**, each volume can exclude paths relative to its root, one per line: `trades` excludes that folder and its content, not `reports/trades`. No `..`, no leading `/`, no wildcards. The log (in Italian) reports each exclusion with its size, or "non presente nel volume" (not in the volume):

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

## Where they go

- **Disco locale** (local disk): always `data/backups/archives/<year>/<month>`, files 0600. Created at first start; the path cannot be changed. An archive that only lives on the machine it protects dies with it: add an S3 destination for that.
- **S3-compatible**: Amazon S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi, and MinIO or any server of your own. Picking the service fills the endpoint and the addressing style; the region is usually the only field to change. Bucket, keys and an optional prefix complete it; the configuration is encrypted. `https://` anywhere, `http://` only to a private address. The object is named `<prefix>/<file>` and uploaded in one request: on AWS the 5 GB per-object limit applies. After the upload the panel reads back the size the bucket kept, and a mismatch fails the run.

A new destination, or one being edited, is **tried before it is saved**: a test object is written, read back and deleted. A failed check saves nothing and says why; **Salva comunque** (save anyway) is there for a bucket that is unreachable from here on purpose. **Verifica** (check) in the list runs the same test later. A bucket where the key cannot delete is accepted with a warning: that is a deliberate protection against ransomware, but retention then cannot remove old archives.

S3 failures are explained in Italian, with the cause and the fix: unknown access key, wrong secret, missing bucket, missing permission (with the AWS actions to grant), bucket in another region (with the right one when the service says it), server clock off, quota exhausted, object too large, endpoint that does not resolve, refuses the connection, times out, has an expired, untrusted or mismatched certificate, or speaks plain HTTP on that port. The provider's own code and message are in the run's log and, in expert mode, under the check's result.

From the list, the owner can also:

- **Modifica** (edit): name, endpoint, region, bucket, keys, prefix. The secret is never shown: leave it empty to keep the stored one. The type does not change. If archives are already stored there, changing bucket, endpoint or prefix makes the panel look for them in the new place: the form says so.
- **Imposta come predefinita** (make default): where the nightly preset, new policies and every restore's safety backup go. It can also move every existing policy there; archives already taken stay where they are and remain restorable.
- **Elimina** (delete): refused while a policy writes there (the dialog names it and opens it), and for the last destination left. With archives stored there it needs the owner and the destination's name typed: the files stay where they are, but the panel no longer knows about them (no restore, download or retention). If it was the default, the oldest remaining destination takes over.

Other accounts holding the `backup` permission can add destinations, check them, rename them and delete one that holds nothing, but not change where an existing one writes or which one is the default: either would move everyone's archives, the owner's included.

Every archive is first built in `data/backups/staging`, S3 included: local free space is needed, and the backup stops if it falls under 2 GB.

The archive is a zip with `manifest.json`, `LEGGIMI.txt` and a `checksums.txt` in `sha256sum -c` format (for dumps and volumes; repository files are not listed). Project variables and service credentials are encrypted with this server's key; including the key itself is a separate, explicit choice. The rest (dumps, volumes, code) is in clear, unless the whole archive is encrypted with a password: see below.

## Encryption with a password

With encryption on, every archive leaves the server encrypted whole with the **backup password**: whoever holds a copy — a bucket, a disk that walked away, a forgotten download — reads nothing without the password, not even the file names. Without it, what is said above holds: only variables and credentials are encrypted, with the panel's key.

- **One password per server**, in **Backup › Cifratura degli archivi** (archive encryption). The owner sets it; other accounts see whether it is on. It applies to every new archive: schedules, **Esegui backup ora** (back up now) and the safety backups taken before a restore, which go to the default destination, often a bucket. That is why it is one per server rather than one per schedule: a per-schedule switch would leave exactly those two in clear.
- Existing schedules do not change until you set the password. When you create a schedule, the form offers it right under the destination, with a warning when the archives would leave the server in clear.
- The password is typed twice, has at least 12 characters and no space at either end, and you confirm you saved it somewhere else. **It cannot be read back**: **Verifica la password** (check the password) only says whether the one you saved is right.
- The panel keeps it, encrypted with its own key, and opens its own archives by itself: checking, restoring and downloading work as before. **Cambia password** (change password) applies from the next archive, and the previous passwords are kept: the archives they encrypted still open here. **Disattiva** (turn off) brings the next archives back in clear; those already encrypted stay encrypted.
- If the panel's key changes and the stored password no longer decrypts, backups **do not run** until you set it again: better no archive than one in clear outside this server. The Backup page says so, and the failed-backup notification goes out as usual.
- An encrypted archive is named `….zip.enc`, downloads as it is (encrypted) and has a padlock in the history; the run's page says which password, by date.

> **If you lose the password, you lose the backups that are outside this server.** Nobody, RunPanel included, can recover it. Keep it in a password manager, not on the server it protects. If you changed it, keep the earlier ones too while archives encrypted with them exist: the password's date is written in clear in the archive, and the panel shows it when it asks.

The passwords live in the panel's store. Restoring the store brings back the ones there were on the day of that backup: from then on, archives encrypted with a password set later ask for it. The same goes for a store moved to a server with another key.

### On another server

**Ripristina da un archivio** (restore from an archive) accepts `.zip.enc` files too. One encrypted by this panel opens by itself. One from another server stops at **serve la password** (password needed): type the one in use on the day of the backup, the panel tries it on the archive (a wrong one is refused at once), then checks and restores it like any other. The password stays with the uploaded archive, encrypted with the panel's key, and is deleted with it. The same goes for a run in the list encrypted with a password the panel no longer has, for instance after restoring another panel's store: the restore dialog asks for it.

From the API: `POST /api/backups/uploads/{id}/unlock` with `{ "password": "…" }` for an uploaded archive, and the `password` field of `POST /api/backups/restore` for a run in the list.

### Without the panel

The archive's `LEGGIMI.txt` is inside the encryption, which is why the instructions are here. [`scripts/decrypt-backup.mjs`](../../scripts/decrypt-backup.mjs) is a single file with no dependencies: it needs Node 18 or later, not the panel nor the rest of the repository. Copy it next to the archive and:

```sh
node decrypt-backup.mjs runpanel-20261118-030000-backup-notturno-abc123.zip.enc
# asks for the password without echoing it and writes runpanel-…-abc123.zip next to it

node decrypt-backup.mjs --check archive.zip.enc      # checks password and archive, writes nothing
node decrypt-backup.mjs archive.zip.enc other.zip    # picks the zip's name
node decrypt-backup.mjs --password-file pw.txt archive.zip.enc
RUNPANEL_BACKUP_PASSWORD='…' node decrypt-backup.mjs archive.zip.enc
```

Every chunk is verified before it is written, and the zip only gets its name at the end (until then it is `….zip.part`): a wrong password (exit status 2), a damaged or truncated archive (status 1) never leave half a zip behind. What comes out is the usual zip, with `LEGGIMI.txt` and the commands to restore by hand; uploaded to a panel, it restores like that too. The script's messages are in Italian, like the panel.

### The format

For anyone reading it with other tools: a header — `RPBKENC`, the version (1 byte), the length (uint32 big-endian) and a JSON with the parameters — then the zip in 64 KiB chunks, each encrypted with AES-256-GCM and followed by its 16-byte tag. The key comes from the password, NFC-normalised, through scrypt (N = 2^17, r = 8, p = 1, a random 32-byte salt per archive) and HKDF-SHA256. The nonce is the chunk number, and the associated data binds to every chunk the sha256 of the header, its number and whether it is the last one: a chunk altered, moved or repeated, a file cut short or extended, is refused. Only the parameters, an identifier of the password and the date it was set are in clear. The details are in [`services/backup/archive-crypto.ts`](../../services/backup/archive-crypto.ts).

## Schedule and retention

- **Schedule**: picked in words — every N hours (1, 2, 3, 4, 6, 8 or 12, from midnight), every day, every week on the days you tick, every month on a day — at an hour and minute. The five-field cron expression (or `@daily` and friends) is under **Avanzate**; an expression that none of those shapes can say without changing its meaning (say `0 3,15 * * *`) is shown as it is, with that section open. Days 29–31 do not exist in every month, and cron skips those months: the editor says so. Seconds, `L`, `W`, `#` and `@reboot` are not supported. **Solo su richiesta** (on demand only) has no schedule.
- **Time zone**: chosen from the full list, searchable by city. **Come il pannello** (the panel's, the default) is the zone set in **Impostazioni › Generale**, or UTC when none is — never the host's. Times are read in that zone across daylight-saving changes: a time that does not exist that night runs at the first minute that does, a time that happens twice runs once.
- **One backup at a time**, and none during a restore. A scheduled run that finds the system busy is skipped, not queued. A run missed while the panel was down is caught up only within twice the interval, or 24 hours if longer.
- **Retention**: count (1–1000), age (1–3650 days) and total size (at least 1 MB), together. It is applied after a successful run, and the newest valid archive is never removed. A backup started by hand outside any policy (see the database page below) has no retention: it stays until you delete it.

## Integrity

Every run records the archive's sha256, and `checksums.txt` the sha256 of each dump and volume. **Verifica integrità** (check integrity), on a run's page, reads the archive back in the background:

- on the local disk, completely: the archive's sha256, then every member's CRC-32, its sha256 where listed, and every `.gz` decompressed to the end — a dump cut short still has a valid checksum of its own short self;
- in a bucket, by streaming it once through its sha256, without storing it: that proves the bytes are the ones written; the members are checked again before any restore.

An encrypted archive is checked the same way: the sha256 is the encrypted file's, and the members are read through the decryption, which verifies every chunk. If the panel no longer has its password, it checks the sha256 and says the content could not be opened.

The result stays on the run (a shield in the history), with the member that failed and why in expert mode. A damaged archive is not repaired: take a new backup.

## Restore

Restoring is one dialog. Everything is selected; each item says, in a line, what happens to what is there now, and where it goes — the same service or project by default, or another of the same kind. To confirm, type the name of the first item that will be overwritten.

Before anything is stopped, copied or overwritten:

1. An archive on S3 is downloaded into the restore's working folder (free space is needed, plus the 2 GB reserve), hashed on the way in and compared with the sha256 recorded when it was written; a mismatch stops the restore.
2. The members the restore will use — only those — are checked as **Verifica integrità** does. A damaged one, or a missing or wrong password for an encrypted archive, stops the restore with nothing touched. An encrypted archive is never decrypted whole to disk: as with a zip, the restore extracts only the members it needs into its working folder, which is removed at the end.
3. A **safety backup** of the targets goes to the default destination (labelled "Sicurezza pre-ripristino", never removed by retention, deleted by hand). If it fails the restore stops, unless you ticked **Procedi anche senza backup di sicurezza** (go on without a safety backup).

- **Volume**: the project stops; its containers still running are stopped and restarted at the end, while a container of another project using the volume blocks the restore. Excluded paths are left as they are. A Compose volume that no longer exists is recreated by a deploy, then the restore is repeated.
- **Database**: if the service belongs to a running project, the project stops and comes back at the end. On Postgres the restore refuses to start while a connection stays open, because the script drops databases in order and would stop halfway. MySQL and Mongo lay the dump over what is there. A full MySQL or Mongo dump carries the users of its source server: on another service it replaces them, and the restore ends in error saying the stored credentials no longer work, with the data already in place.
- **Repository**: files are overwritten, extra files are not deleted. During a deploy the restore refuses. With version folders the files go where the app reads them: into the running version, and through it into the project folder for the shared ones.
- **A project's configuration**: the project must still exist. It is encrypted with the key of the panel that wrote it: from another panel's archive it cannot be read, and the restore says so.
- **Panel store (SQLite)**: not restored live. The database is set aside and takes over at the next restart, with the previous one kept next to it. The encryption key is not put back: if needed, copy it by hand.
- **Panel store (Postgres)**: refused by the panel; the `pg_restore` command to run with the panel stopped is in `manifest.json`.

Restore does not compare engine versions: a dump from one major restored onto another is accepted and fails halfway, with the safety backup already taken.

### From an uploaded archive

**Ripristina da un archivio** (restore from an archive), on the Backup page, is for an archive that is not in the list: one downloaded earlier, or the backups of a server that is gone. Owner only.

1. **Upload** the `.zip`, or the `.zip.enc` if it is encrypted (drag it or pick it). It goes up in 8 MB pieces, each retried on its own, so a large archive survives a flaky link and the reverse proxy needs no special limit. Free space for the whole archive plus the 2 GB reserve is checked first.
2. **Check**: once in, the archive is checked whole — it must carry a RunPanel `manifest.json`, and every member passes the checks above. A damaged or foreign archive is refused with the reason. An archive encrypted on another server asks for its password first (see [On another server](#on-another-server)).
3. **Restore**: the same dialog as for a run in the list. Items from another panel name projects and services this one does not have: each asks where to go, and they must exist here first.

An uploaded archive stays on the server for 24 hours after its last use, so a failed restore can be retried without uploading it again; it can be deleted sooner from the page.

## On the database page

A database's page has a **Backup** panel: the policies that save it (with when and where), its recent archives with their integrity mark, and **Ripristina…** narrowed to that database, with that database as the only target. With no active schedule it offers **Salvalo ogni notte** (save it every night: 03:00, the default destination, last 7 kept). The owner also has **Esegui backup ora** (back it up now), a run outside any policy and therefore outside retention.
