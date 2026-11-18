[← RunPanel](../../README.md) · [Italiano](../it/backups.md) · **English**

---

# Backups and restore

A *policy* says what to save, where — one destination or several, with a copy of the same archive on each —, how often and how many archives to keep. Policies, destinations, archives and restores belong to the server they are on: with [several servers](multi-server.md) each has its own, and an archive can only be decrypted with the key of the server that took it.

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

- **Disco locale** (local disk): `data/backups/archives/<year>/<month>`, files 0600. Created at first start. The owner can add more local destinations with a **folder** of their own (under **Avanzate** in the form), say a second disk or a mounted NAS: a full path, outside the panel's data directory, that already exists and that the panel's user can write to; archives go to `<folder>/<year>/<month>`. The folder cannot be changed afterwards: to write elsewhere, add a new destination. When the folder is on the same disk as the panel's data, **Verifica** succeeds but says so: that is also what happens when the second disk is not mounted and its empty mount point gets written. An archive that only lives on the machine it protects dies with it: add an S3 destination for that.
- **S3-compatible**: Amazon S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi, and MinIO or any server of your own. Picking the service fills the endpoint and the addressing style; the region is usually the only field to change. Bucket, keys and an optional prefix complete it; the configuration is encrypted. `https://` anywhere, `http://` only to a private address. The object is named `<prefix>/<file>` and uploaded in one request: on AWS the 5 GB per-object limit applies. After the upload the panel reads back the size the bucket kept, and a mismatch fails the run.
- **Telegram**: a private channel the panel creates, or your Saved Messages, through your own account. Archives larger than one Telegram file are split into parts. See [Telegram](#telegram) below.
- **SFTP server or NAS**: Synology, QNAP, a Hetzner Storage Box, another server; with a key the panel generates. See [SFTP server or NAS](#sftp-server-or-nas).
- **WebDAV**: Nextcloud, ownCloud, a NAS's WebDAV, Koofr, pCloud. See [WebDAV](#webdav).
- **Google Drive, OneDrive, Dropbox** and the other services rclone speaks, when rclone is installed on the server. See [rclone](#rclone-google-drive-onedrive-dropbox-and-the-rest).
- **Server RunPanel collegato** (linked RunPanel server): another server of your [cluster](multi-server.md), which keeps the copies in its own data directory, with no third-party account. Two servers can keep each other's copies. See [Another RunPanel server](#another-runpanel-server).

A new destination, or one being edited, is **tried before it is saved**: a test object is written, read back and deleted. A failed check saves nothing and says why; **Salva comunque** (save anyway) is there for a bucket that is unreachable from here on purpose. **Verifica** (check) in the list runs the same test later. A bucket where the key cannot delete is accepted with a warning: that is a deliberate protection against ransomware, but retention then cannot remove old archives.

S3 failures are explained in Italian, with the cause and the fix: unknown access key, wrong secret, missing bucket, missing permission (with the AWS actions to grant), bucket in another region (with the right one when the service says it), server clock off, quota exhausted, object too large, endpoint that does not resolve, refuses the connection, times out, has an expired, untrusted or mismatched certificate, or speaks plain HTTP on that port. The provider's own code and message are in the run's log and, in expert mode, under the check's result.

From the list, the owner can also:

- **Modifica** (edit): name, endpoint, region, bucket, keys, prefix. The secret is never shown: leave it empty to keep the stored one. The type does not change. If archives are already stored there, changing bucket, endpoint or prefix makes the panel look for them in the new place: the form says so.
- **Imposta come predefinita** (make default): where the nightly preset, new policies and every restore's safety backup go. It can also move every existing policy there: it becomes their primary destination (in place of the old one, or moved to the front when they already kept a copy there), and their other copies stay; archives already taken stay where they are and remain restorable.
- **Elimina** (delete): refused while a policy writes there, as its primary or as a copy (the dialog names it and opens it), while a copy is on its way there, and for the last destination left. With archives stored there it needs the owner and the destination's name typed: the files stay where they are, but the panel no longer knows about them (no restore, download or retention from there). Runs with a copy elsewhere are restored from that one. If it was the default, the oldest remaining destination takes over.

Other accounts holding the `backup` permission can add destinations, check them, rename them and delete one that holds nothing, but not change where an existing one writes or which one is the default: either would move everyone's archives, the owner's included.

Every archive is first built in `data/backups/staging`, S3, Telegram and the other off-server destinations included: local free space is needed, and the backup stops if it falls under 2 GB.

### Telegram

Archives go to Telegram through **your own account**, not a bot: a bot uploads 50 MB at most, an account up to 2 GB per file, 4 GB with Telegram Premium.

**The keys.** Telegram wants every program to use its own, and the panel ships none:

1. Open [my.telegram.org](https://my.telegram.org) and sign in with the number of the account that will hold the backups: the code arrives in the Telegram app.
2. Choose **API development tools** and create an app: any name and title (for example *RunPanel*), platform *Other*; URL and description can stay empty.
3. In **Backup › Destinazioni › Aggiungi › Telegram** paste **api_id** and **api_hash**.

**Linking.** With the **QR code**: on the phone open Telegram › Settings › Devices › Link Desktop Device and scan it (it renews itself every 30 seconds). Or with the **phone number**: Telegram sends a code in the app or by SMS. If the account has two-step verification, the panel asks for that password too. The login waits on the server, ten minutes to complete it and twenty to save; the session it produces goes only into the destination's encrypted configuration and never passes through the browser. An abandoned login is closed, at Telegram too. Starting one takes the same permission as adding a destination; attempts are limited, because Telegram locks out for hours an account that asks for too many codes.

**Where.** A **private channel** the panel creates for this server when you save ("RunPanel · backup di" followed by the server's name, which you can change), or your **Saved Messages**. The chat is chosen when the destination is created and does not change afterwards: the archives are there. Do not delete or edit their messages by hand: the panel finds them by message number.

**Parts.** A Telegram file has at most 4000 pieces of 512 KiB, 8000 with Premium: 2000 and 4000 MiB. At every backup the panel reads from the account whether it is Premium — a subscription can lapse — and the piece count from Telegram's configuration, and keeps a 20 MiB margin: parts of up to 1980 MiB, or 3980 MiB with Premium. A larger archive is split into parts uploaded as separate documents (`….zip.enc.001`, `.002`…), read straight from the archive file with no temporary copies. Each part's caption gives the archive's name, the part ("Parte 2 di 3"), its size and its sha256. The reference stored with the run lists the messages in order: restore, integrity check and download fetch the parts in sequence and rebuild the usual archive, checking each part's sha256. Without the panel, download the parts from the chat and join them with `cat name.zip.enc.* > name.zip.enc` (on Windows `copy /b name.zip.enc.001 + name.zip.enc.002 name.zip.enc`).

The run's log shows the account, whether it is Premium, how many parts the archive takes, the progress and the waits Telegram asks for (FLOOD_WAIT): up to 15 minutes the panel waits and carries on by itself, beyond that the run fails and the next one tries again. A dropped connection is retried piece by piece. If a part does not make it, the parts already uploaded are deleted: the chat only ever holds whole archives. After the upload the panel reads back from Telegram the size of every part, and a mismatch fails the run. **Verifica** (check) connects, says whether the account is Premium and how large a part can be, then writes, reads back and deletes a small file in the chat.

**Security.**

- The session opens **the whole account**: whoever got it could read and write every chat. It is encrypted with the panel's key like every other secret and used only for backups; if you prefer, use a Telegram account dedicated to backups. In Telegram › Settings › Devices it shows as "RunPanel su" followed by the server's name: closing it there makes the next backup fail with "Sessione chiusa dall'app di Telegram, o scaduta: ricollega l'account" (session closed from the app, or expired: link the account again).
- Telegram's cloud chats are **not end-to-end encrypted**: Telegram can read what you upload. Turn on [encryption with a password](#encryption-with-a-password); while it is off, the destination form suggests it.
- Deleting the destination also ends its session at Telegram; the archives stay in the chat.

**Re-linking.** With the session closed, **Modifica › Ricollega l'account** (edit, link the account again) logs in again (an empty api_hash keeps the stored one) and the old session is ended. Another account is accepted only if it still reaches the archives: for a channel it must be one of its admins, for Saved Messages the destination must still be empty. The owner re-links, as for S3 keys.

### SFTP server or NAS

A NAS (Synology, QNAP), a Hetzner Storage Box, a second VPS: any server that offers SFTP, including servers that offer **only** SFTP, without a shell, as storage boxes and many NAS do.

- **The key**: picking this type makes the panel generate an Ed25519 key pair for the destination and show the public key, with a copy button: it is the line to add to the user's `.ssh/authorized_keys` on the server. The form says how for the kind of server picked: the two commands to paste for a Linux server, `ssh-copy-id -p 23 -s` for a Storage Box, where to turn on SFTP and the users' home folders for Synology and QNAP. The private key never leaves the panel: it is stored encrypted with the destination and written to disk (a 0600 file in `data/tmp`) only until ssh has logged in. **Modifica › Genera una nuova chiave** (edit › generate a new key) replaces it. There is no password login: with the system's `ssh` it would need a program typing it in, and a dedicated key is safer anyway.
- **The server's fingerprint**: on the first successful check the panel shows the fingerprint of the server's host key (`SHA256:…`) and pins it. From then on a server presenting another key is refused: "si presenta con una chiave diversa da quella salvata alla prima connessione". If you reinstalled or replaced the server, **Modifica › Dimentica l'impronta** (edit › forget the fingerprint), and the next check pins the new one. Changing the host or the port forgets it by itself. A destination saved without a check pins it on first use.
- **The upload**: the archive is written as `.<name>.<random>.partial`, in pipelined blocks, flushed to the server's disk (when the server allows it), checked for size, and only then renamed. A cut connection leaves at most a `.partial`, never a file that looks like a finished archive. That is why the user needs permission to write and rename in the folder; deleting is what retention needs (without it, the check passes with a warning). Downloads stream, the archive is never held in memory.
- **The folder** is relative to the user's home, or absolute (`/volume1/backup/runpanel`); it is created when missing. On a NAS its first part is a shared folder that must already exist.
- The panel uses the system's `ssh` (OpenSSH) with the SFTP subsystem, ignoring `~/.ssh/config` and any agent: when it is missing, the form says so (`sudo apt install openssh-client`).
- **The check** writes, renames, reads back and deletes a test file, and reports the free space when the server tells it. Failures are explained: an address that does not exist, a closed or wrong port, no answer, a key the server does not know (with the right permissions for `.ssh`), SFTP not enabled, algorithms too old, something other than SSH on that port, a changed host key, a missing permission, a full disk or quota, an `echo` in `.bashrc` that breaks SFTP.

### WebDAV

Nextcloud, ownCloud, a Synology NAS with the WebDAV Server package, Koofr, pCloud or any WebDAV server.

- For Nextcloud and ownCloud the server's address and the user are enough: the panel builds `https://<server>/remote.php/dav/files/<user>/` (changeable under **Avanzate**). Koofr and pCloud have their address filled in; for anything else it is typed whole.
- **App password**: on Nextcloud it is made in **Personal settings › Security › Devices & sessions › Create new app password**. With two-factor authentication on, the account password does not work, and an app password can be revoked alone without touching the account.
- `https://` anywhere, `http://` only to a private address, as for S3. User and password go in their own fields, not in the address; the password is never shown (empty in **Modifica** = keep the stored one).
- The upload is a streamed PUT to a provisional name (`.partial`); then its size is checked with PROPFIND and it is renamed with MOVE. An interrupted upload never leaves a file with the archive's name. Downloads stream (GET), deletes are a DELETE.
- **Large archives and reverse proxies**: a reverse proxy in front of the server (nginx, Apache, Cloudflare) may cap the size of a request. It shows in one of two ways: a 413 error, or the connection closing halfway through the upload. In the second case the panel uploads a tiny file to find out: if that goes through, it says the proxy's limit is almost certainly the cause. The limit is raised on the server: `client_max_body_size` in nginx, `LimitRequestBody` in Apache; Cloudflare's free plan stops at 100 MB per request. A long upload can also meet the proxy's timeout (a 504: `proxy_read_timeout` in nginx).
- Failures are explained: password not accepted (with where to create an app password), permissions, wrong address (with Nextcloud's shape), an address that is not WebDAV, a redirect (with where it points), quota exhausted (507), archive too large (413), proxy errors (502, 504), as well as network and certificate errors.

### rclone: Google Drive, OneDrive, Dropbox and the rest

Through [rclone](https://rclone.org), when it is installed on the panel's server: one destination type for Google Drive, OneDrive, Dropbox, Mega, Box, pCloud and the other services rclone supports.

- The form says whether rclone is there and which version (1.60 or newer is needed; some distributions ship an older one). When it is missing, it says how to install it: `sudo -v ; curl https://rclone.org/install.sh | sudo bash` from the server's terminal, or the program downloaded from rclone.org into `/usr/local/bin`. The panel installs nothing by itself.
- **Guided setup** for Google Drive, OneDrive and Dropbox: on your own computer, which has a browser, run `rclone authorize "drive"` (or `"onedrive"`, `"dropbox"`), sign in and allow, and paste what the terminal prints between `--->` and `<---End paste` (the whole output works too: the panel finds the token). For OneDrive the panel asks Microsoft which drive to use, so paste the token within the hour.
- **Expert mode**, owner only: paste one or more sections of an `rclone.conf` (`rclone config show` prints them) — any remote, a `crypt` over another one included — and pick the one to use. Options that make rclone run a program (`ssh`, `…_command`) are refused; and it is the owner's alone because other rclone options act on this server's files.
- **No `rclone.conf` is ever written**: the remote reaches rclone through `RCLONE_CONFIG_<REMOTE>_<OPTION>` environment variables, built for each command from the encrypted stored config, and `RCLONE_CONFIG` points at `/dev/null`, so rclone keeps its configuration in memory. A refreshed access token lasts for that command; what stays stored is the refresh token, which the services keep valid while it is used (OneDrive revokes it after 90 days unused, Google after six months). Regular backups never get there; if it happens, the check says to run `rclone authorize` again.
- The operations are `rclone copyto` with the archive staged in `staging`, `rclone cat` to stream it back, `rclone deletefile`, and `rclone lsjson --stat` for its size. rclone checks the size and, where the service has one, the hash of every upload, and these services only show a file once it is complete; after the upload the panel reads the size back anyway.
- **The check** lists the folder, then writes, reads back and deletes a test file. Failures are explained: rclone missing or too old, an authorization expired or revoked (with the command to redo it), credentials not accepted, the account's space exhausted, too many requests, permissions, a folder or archive that is not there, network and certificate errors.
- With Google Drive, rclone uses a client ID shared by all its users and rate-limited by Google: for large or frequent archives create your own in the Google Cloud Console and use expert mode with `client_id` and `client_secret`.

### Another RunPanel server

The off-site copy on your second server, when it is linked to this one in a [cluster](multi-server.md): no account, keys or service to set up. The typical use is two servers keeping each other's copies: on each, add the **Server RunPanel collegato** destination and pick the other one.

- **Where they go**: into the other server's data directory, under `data/peer-backups/<this server's id>/<year>/<month>`. One folder per server sending copies, apart from that server's own backups: its backups, retention and restores never touch them, and neither does the backup of its store.
- **How they travel**: with the cluster's own signed requests (HMAC-SHA256 with the cluster secret, server to server, for no account). The signature also covers the sha256 of the request body, and an archive of a few gigabytes cannot be a single request: the panel's proxy checks the signature by holding at most 10 MB in memory, and Node closes a request whose body is still arriving after five minutes. So:
  1. a small signed request **reserves** room with the archive's name, size and sha256, and gets back a **token** valid for that one upload (the other server keeps only its hash);
  2. the archive goes in **8 MB pieces**, in order, each a signed request carrying the token. A piece whose answer is lost is sent again, and a dropped connection costs one piece, not the upload;
  3. at the end the other server compares the **size and sha256** of what arrived with the reserved ones, flushes the file to its disk and only then gives it its name. A different archive is discarded; an upload left halfway (the sender stops, either server restarts) is removed by itself, at the restart and every hour.

  Restore, download and **Verifica integrità** (integrity check) fetch the archive back in one signed request and compare it with the sha256 the backup recorded, as for every destination.
- **The server keeping the copies decides the space**: its **Backup › Copie per altri server** page (copies for other servers) has a row for every linked server (and for unlinked ones that still have copies there), with how many archives it keeps, how much space they take and the latest one. The owner picks for each **Nessun limite** (no limit), **Un limite** (a limit) in GB or **Non accettare** (refuse). Either way the disk always keeps a tenth of its space free, between 5 and 50 GB, for the server itself. A limit stops new copies, it never deletes the ones already there.
- **Security**: a server only reads and deletes the copies in its own folder. Names and refs that come with the requests are checked before they become a path, and none leaves the folder. An account cannot reach these requests through another panel: they answer the server alone, never a request forwarded for a user. The cluster secret is one for every server, so the separation between folders protects against mistakes, not against a compromised member: a compromised member already holds the whole cluster.
- **Encryption**: without the backup password the archives arrive in clear on the other disk, and whoever administers that server can read them. Turn on [encryption with a password](#encryption-with-a-password): when it is off, the destination form offers it.
- **Verifica** (check) makes sure the other server answers and runs a version that knows this feature, then reserves, writes, reads back and deletes a small file, and says how much room is left for this server (the limit, or the other server's disk). Failures are explained: server off or unreachable, an older version (to update), signature refused (a different secret, this server no longer among its members, clocks more than five minutes apart), copies refused or limit reached (with the numbers), a full disk, a server no longer linked.
- **With several copies** (see below) a server that is off, old or full only fails its own copy: the backup stays successful with the others, a warning is sent and the copy can be retried.
- **When a server is lost**: on the server keeping its copies, in **Backup › Copie per altri server**, the owner opens its row's ⋯ menu, **Mostra gli archivi** (show the archives), and downloads the one needed. Then, on the server replacing it, **Ripristina da un archivio** (restore from an archive): an encrypted one asks for the lost server's backup password. The same menu's **Elimina le copie…** (delete the copies) removes them all, with the server's name typed to confirm; a server that is still linked keeps sending new ones unless set to **Non accettare**.

## Several copies of every backup (3-2-1)

A policy can write the same archive to several destinations, say the server's disk, a second disk and a bucket: losing a disk, a bucket or an account does not lose the backups. That is the 3-2-1 rule: three copies, on two different media, one off-site.

- **Dove salvare** (where to save), in the policy form, is an ordered list: the first is the **primary**, the others receive an identical copy. **Aggiungi una copia** (add a copy) puts another at the end; each row's ⋯ menu moves it, makes it the primary or removes it. Up to 5 destinations; the same one twice, or two writing to the same place (two local destinations on one folder, two S3 ones on the same bucket and prefix, two Telegram ones on the same channel or the same Saved Messages, two to the same linked server), are refused: a second copy there protects from nothing. Policies that existed before have one destination, and do what they did.
- The archive is written **once**, encrypted when the backup password is set, then copied to each destination **one after the other**, in the list's order: the primary first, so the run is restorable as early as it can be. Sequential rather than parallel because the uplink is one — two uploads at once finish no sooner than two in a row — and because the server also runs your apps: one predictable load at a time. On the staging folder's disk the local copy is a link to the file, instant and free; on another disk it is a full copy, written beside the target and renamed only once whole. The staged file stays until every copy has finished.
- **Quanto tenerne** (retention): each copy follows the policy's rule, or one of its own (**Per ogni destinazione**, with more than one destination): a week on the disk and a year in the bucket, say. Retention removes copies destination by destination, and the newest copy on each destination is never removed; a run leaves the history only when no copy of it is left.
- **When a copy fails** the backup has not failed: the archive is in the others. The run stays successful (or partial, for missing items), the history shows "2 copie su 3" and the backup notification arrives as a warning, naming the destination and the reason. On the run's page, **Copie** lists every copy with its state, size, where it is and its error; **Riprova la copia** (retry the copy) sends it again from a copy that is there, after comparing it with the sha256 of the archive the run wrote. Only a run where no copy arrived has failed.
- **Restore, download and Verifica integrità** use the first available copy: those on this server's disk first, then the policy's order. A copy that is gone or does not answer gives way to the next, and the log says which one was used; in a restore a damaged copy (wrong sha256, a member that does not read back) gives way to the next too. A missing or wrong password stops at once instead: it is the same for every copy.
- **Deleting a run** deletes every copy of it. If one will not go, the run stays with the copies left, and the delete can be retried.
- **Esegui ora** (run now) on a policy writes to all its destinations, like a scheduled run. A backup outside any policy — **Esegui backup ora** on a database's page — goes to the default destination only: it has no retention and stays until you delete it, so a copy everywhere would fill every destination, paid ones included; and it is usually the quick copy before a risky change. From the API, `destinationIds` asks for several. A restore's **safety backup** also goes to the default destination only: the restore waits for it, it is there to undo the restore in the minutes after, and retention never removes it.
- If the panel stops halfway through the copies, at the next start the run closes with the copies that arrived, and the interrupted ones show as failed, ready to retry.

From the API: `destinations` in `POST`/`PUT /api/backups/policies` (`[{ destinationId, retention: { count, days, bytes } | null }]`, `null` for the policy's rule), `copies` on every run of `GET /api/backups/runs`, and `POST /api/backups/runs/{id}/copies/{copyId}/retry`. `destinationId` stays, and is the primary; a client that sends only that changes the primary and leaves the other copies where they are.

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
- **Retention**: count (1–1000), age (1–3650 days) and total size (at least 1 MB), together. It is applied after a successful run, destination by destination, each with its own rule (see [Several copies](#several-copies-of-every-backup-3-2-1)), and the newest valid copy on each destination is never removed. A backup started by hand outside any policy (see the database page below) has no retention: it stays until you delete it.

## Integrity

Every run records the archive's sha256, and `checksums.txt` the sha256 of each dump and volume. **Verifica integrità** (check integrity), on a run's page, reads the archive back in the background, from the first available copy (and says which, when there are several):

- on the local disk, completely: the archive's sha256, then every member's CRC-32, its sha256 where listed, and every `.gz` decompressed to the end — a dump cut short still has a valid checksum of its own short self;
- in a bucket or on Telegram, by streaming it once through its sha256, without storing it: that proves the bytes are the ones written; the members are checked again before any restore. On Telegram every part's own sha256 is checked too.

An encrypted archive is checked the same way: the sha256 is the encrypted file's, and the members are read through the decryption, which verifies every chunk. If the panel no longer has its password, it checks the sha256 and says the content could not be opened.

The result stays on the run (a shield in the history), with the member that failed and why in expert mode. A damaged archive is not repaired: take a new backup.

## Restore

Restoring is one dialog. Everything is selected; each item says, in a line, what happens to what is there now, and where it goes — the same service or project by default, or another of the same kind. To confirm, type the name of the first item that will be overwritten.

Before anything is stopped, copied or overwritten:

1. The archive comes from the first available copy, those on this server's disk first. One on S3 or Telegram is downloaded into the restore's working folder (free space is needed, plus the 2 GB reserve), hashed on the way in and compared with the sha256 recorded when it was written; a mismatch stops the restore when there is no other copy to try. The parts of an archive split on Telegram are downloaded in order and put back together; if one is missing, the panel says which one before downloading anything, and moves on to the next copy if there is one.
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

A database's page has a **Backup** panel: the policies that save it (with when and where), its recent archives with their integrity mark, and **Ripristina…** narrowed to that database, with that database as the only target. With no active schedule it offers **Salvalo ogni notte** (save it every night: 03:00, the default destination, last 7 kept). The owner also has **Esegui backup ora** (back it up now), a run outside any policy and therefore outside retention, on the default destination only.
