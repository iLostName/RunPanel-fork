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

A project uploaded as a ZIP always includes its repository. The repository copy skips `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` and the like, and the `.env` the panel writes.

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

The archive is a zip with `manifest.json`, `LEGGIMI.txt` and a `checksums.txt` in `sha256sum -c` format (for dumps and volumes; repository files are not listed). Project variables and service credentials are encrypted with this server's key; including the key itself is a separate, explicit choice. Archives are not encrypted with a password of their own.

## Schedule and retention

- **Schedule**: picked in words — every N hours (1, 2, 3, 4, 6, 8 or 12, from midnight), every day, every week on the days you tick, every month on a day — at an hour and minute. The five-field cron expression (or `@daily` and friends) is under **Avanzate**; an expression that none of those shapes can say without changing its meaning (say `0 3,15 * * *`) is shown as it is, with that section open. Days 29–31 do not exist in every month, and cron skips those months: the editor says so. Seconds, `L`, `W`, `#` and `@reboot` are not supported. **Solo su richiesta** (on demand only) has no schedule.
- **Time zone**: chosen from the full list, searchable by city. **Come il pannello** (the panel's, the default) is the zone set in **Impostazioni › Generale**, or UTC when none is — never the host's. Times are read in that zone across daylight-saving changes: a time that does not exist that night runs at the first minute that does, a time that happens twice runs once.
- **One backup at a time**, and none during a restore. A scheduled run that finds the system busy is skipped, not queued. A run missed while the panel was down is caught up only within twice the interval, or 24 hours if longer.
- **Retention**: count (1–1000), age (1–3650 days) and total size (at least 1 MB), together. It is applied after a successful run, and the newest valid archive is never removed. A backup started by hand outside any policy (see the database page below) has no retention: it stays until you delete it.

## Integrity

Every run records the archive's sha256, and `checksums.txt` the sha256 of each dump and volume. **Verifica integrità** (check integrity), on a run's page, reads the archive back in the background:

- on the local disk, completely: the archive's sha256, then every member's CRC-32, its sha256 where listed, and every `.gz` decompressed to the end — a dump cut short still has a valid checksum of its own short self;
- in a bucket, by streaming it once through its sha256, without storing it: that proves the bytes are the ones written; the members are checked again before any restore.

The result stays on the run (a shield in the history), with the member that failed and why in expert mode. A damaged archive is not repaired: take a new backup.

## Restore

Restoring is one dialog. Everything is selected; each item says, in a line, what happens to what is there now, and where it goes — the same service or project by default, or another of the same kind. To confirm, type the name of the first item that will be overwritten.

Before anything is stopped, copied or overwritten:

1. An archive on S3 is downloaded into the restore's working folder (free space is needed, plus the 2 GB reserve), hashed on the way in and compared with the sha256 recorded when it was written; a mismatch stops the restore.
2. The members the restore will use — only those — are checked as **Verifica integrità** does. A damaged one stops the restore with nothing touched.
3. A **safety backup** of the targets goes to the default destination (labelled "Sicurezza pre-ripristino", never removed by retention, deleted by hand). If it fails the restore stops, unless you ticked **Procedi anche senza backup di sicurezza** (go on without a safety backup).

- **Volume**: the project stops; its containers still running are stopped and restarted at the end, while a container of another project using the volume blocks the restore. Excluded paths are left as they are. A Compose volume that no longer exists is recreated by a deploy, then the restore is repeated.
- **Database**: if the service belongs to a running project, the project stops and comes back at the end. On Postgres the restore refuses to start while a connection stays open, because the script drops databases in order and would stop halfway. MySQL and Mongo lay the dump over what is there. A full MySQL or Mongo dump carries the users of its source server: on another service it replaces them, and the restore ends in error saying the stored credentials no longer work, with the data already in place.
- **Repository**: files are overwritten, extra files are not deleted. During a deploy the restore refuses.
- **A project's configuration**: the project must still exist. It is encrypted with the key of the panel that wrote it: from another panel's archive it cannot be read, and the restore says so.
- **Panel store (SQLite)**: not restored live. The database is set aside and takes over at the next restart, with the previous one kept next to it. The encryption key is not put back: if needed, copy it by hand.
- **Panel store (Postgres)**: refused by the panel; the `pg_restore` command to run with the panel stopped is in `manifest.json`.

Restore does not compare engine versions: a dump from one major restored onto another is accepted and fails halfway, with the safety backup already taken.

### From an uploaded archive

**Ripristina da un archivio** (restore from an archive), on the Backup page, is for an archive that is not in the list: one downloaded earlier, or the backups of a server that is gone. Owner only.

1. **Upload** the `.zip` (drag it or pick it). It goes up in 8 MB pieces, each retried on its own, so a large archive survives a flaky link and the reverse proxy needs no special limit. Free space for the whole archive plus the 2 GB reserve is checked first.
2. **Check**: once in, the archive is checked whole — it must carry a RunPanel `manifest.json`, and every member passes the checks above. A damaged or foreign archive is refused with the reason.
3. **Restore**: the same dialog as for a run in the list. Items from another panel name projects and services this one does not have: each asks where to go, and they must exist here first.

An uploaded archive stays on the server for 24 hours after its last use, so a failed restore can be retried without uploading it again; it can be deleted sooner from the page.

## On the database page

A database's page has a **Backup** panel: the policies that save it (with when and where), its recent archives with their integrity mark, and **Ripristina…** narrowed to that database, with that database as the only target. With no active schedule it offers **Salvalo ogni notte** (save it every night: 03:00, the default destination, last 7 kept). The owner also has **Esegui backup ora** (back it up now), a run outside any policy and therefore outside retention.
