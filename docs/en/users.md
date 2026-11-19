[← RunPanel](../../README.md) · [Italiano](../it/users.md) · **English**

---

# Users and permissions

The panel can have several accounts. The first is the **owner**: created on first run, it always has every permission and nobody can limit, disable or delete it. Every other account starts with no access and gets only what you give it.

With [several servers](multi-server.md) the accounts are the same everywhere and are managed from any panel; sessions and invitation links stay with the panel they were created on.

## Signing in

You sign in with email and password. The panel sends no email: the address is only your login name.

Where the owner has set it up, **Accedi con GitHub** (sign in with GitHub) is there too: see [Signing in with GitHub](#signing-in-with-github).

## Signing in with GitHub

People can sign in with their GitHub account instead of the password. A GitHub account never creates a user: it is **linked** to one that already exists, and only then signs it in. Someone whose GitHub account is linked to nobody is told to ask the owner for an invitation.

**Setting it up** is the owner's, in **Impostazioni › Generale › Accesso con GitHub**, once for the whole panel. The section walks through it:

1. On GitHub, **Settings › Developer settings › OAuth Apps › New OAuth App** (the **Apri GitHub** button opens it). Any name, for example "RunPanel".
2. **Homepage URL** and **Authorization callback URL** are copied from the panel, which shows them with a copy button. The callback is `https://<the panel's address>/api/auth/github/callback` and must be identical. It comes from the panel's **Indirizzo pubblico** (public address) when one is set, otherwise from the address the page is open at. The panel refuses plain http, except on the machine itself (`http://localhost`, `http://127.0.0.1`): GitHub would send the sign-in code back unencrypted. Put the panel on HTTPS first (**Metti il pannello su HTTPS**).
3. On the app's page, **Generate a new client secret**, and paste the **Client ID** and the secret into the panel. The secret is stored encrypted with the panel's secret key and never shown again.
4. **Verifica** (verify) asks GitHub whether it accepts the Client ID and the secret.
5. **Consenti l'accesso con GitHub** (allow sign-in with GitHub) turns it on; it applies at once.

The callback URL is also the address sign-ins must start from: on another address of the same panel the button says where to go instead. If the panel's address changes, the section says so: update the URL on GitHub, then **Usa il nuovo indirizzo**.

**Linking an account**: in **Impostazioni › Account › Accesso con GitHub**, **Collega GitHub**, then your password, then GitHub asks you to authorize the app and brings you back. The link is made on GitHub's numeric user id, which never changes, never on the login name or the email. One GitHub account links to one user, and a user has at most one. **Scollega GitHub** removes it.

**Invitations**: an invitation link can also be accepted with **Accedi con GitHub** instead of choosing a password. The account then signs in only with GitHub; it can add a password from **Impostazioni › Account**, within ten minutes of signing in (afterwards the page offers to sign in with GitHub again first). A link to choose a new password cannot be used with GitHub.

**What GitHub does not change**:

- Two-step verification is asked for after GitHub exactly as after the password, and **Ricorda questo dispositivo** works the same way.
- A disabled account is refused, sessions are the panel's own, the same limits apply to attempts, and every sign-in, link, unlink and refusal is in the activity log.
- The panel asks GitHub only for `read:user`, uses the token once to read the account's id and login, then revokes it at GitHub and keeps nothing. Each sign-in is protected by a `state` bound to a short-lived cookie of the browser it started in, and by PKCE (S256); after it the browser is only ever sent to a page of the panel.

**Turning it off**: the owner switches it off in the same section (or removes the app). Sign-ins under way end at once, even one waiting for its code. Linked users then sign in with their password; the links stay, and work again when it is switched back on. Users who sign in only with GitHub would be locked out, so the panel refuses to switch off while there are any, and names them: each can set a password from their account page, or you send them a link to choose one from their page in **Team › Utenti** (their badge there reads GitHub with no password). It can still be switched off anyway, after a confirmation.

**Team › Utenti** shows the GitHub account of each user who has one. With [several servers](multi-server.md) all of this is per panel, like two-step verification: each panel has its own OAuth App, and accounts are linked on each panel separately.

## Two-step verification

With **Verifica in due passaggi** (two-step verification) on, signing in also asks for the 6-digit code an authenticator app on your phone shows, a new one every 30 seconds: a stolen password alone does not get in.

**Turning it on**, in **Impostazioni › Account**:

1. **Attiva**, then your password.
2. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden or any other), or type the key shown under it.
3. Type the code the app shows. Only a correct code turns it on, so a scan that did not work cannot lock you out.
4. Save the **10 recovery codes** (**Codici di recupero**): copy them or download them as a text file. They are shown once.

**Signing in** then takes the password, then the code. Without the phone, use a recovery code instead: each works once. **Ricorda questo dispositivo** skips the code on that browser for 30 days; the account page can forget every remembered browser at once, and they are forgotten anyway when the password is changed or reset.

**Nuovi codici di recupero** makes ten new ones (after the password) and voids all the old ones. **Disattiva** needs the password and a code, from the app or a recovery code: an open session alone is not enough.

Wrong codes are limited for each account: after five in a quarter of an hour, or twenty in a day, it has to wait before trying again, and five on the same sign-in mean typing the password again. Every failure is in the activity log. A link to choose a new password does not sign in an account with two-step verification: after it, the person signs in with the new password and the code.

Whoever manages users can turn it off for an account that has lost both the phone and the recovery codes, from that account's page; never for the owner. With [several servers](multi-server.md) it is per panel: turn it on on each panel you sign in to.

API tokens do not ask for the code: a token is a credential of its own, created from a signed-in browser. The token pages and two-step verification itself cannot be reached with a token.

Technical details: TOTP (RFC 6238) with HMAC-SHA-1, 6 digits and a 30-second step, accepting one step either side and never the same code twice. The key is stored encrypted with the panel's secret key, the recovery codes only as salted scrypt hashes. A store restored without its secret key cannot check the app's codes any more: sign in with a recovery code, then turn it off and on again.

## Devices

**Impostazioni › Account › Dispositivi** lists where you are signed in, with the address and the last activity. **Disconnetti** ends one session; **Esci da tutti gli altri dispositivi** ends all of them except the one you are using. Whoever manages users sees and ends the sessions of an account from its page.

## If the owner is locked out

Nobody can reset the owner from the panel. On the server, from the panel's directory, as the user the panel runs as:

```bash
node scripts/reset-owner.mjs
```

The script prints which database it opened and the owner's email, asks you to type that email to confirm, then a new password (Enter generates one and prints it once). If two-step verification is on, it asks whether to turn it off too (`--disable-2fa` answers yes, `--keep-2fa` no). In one go it sets the password, signs the owner out everywhere, forgets the remembered devices, clears the sign-in limits and writes the reset in the activity log.

It finds the database like the panel does: `RUNPANEL_DB_DRIVER`, `RUNPANEL_DATA_DIR`, `RUNPANEL_DB_FILE`, `RUNPANEL_DATABASE_URL` and the other `RUNPANEL_PG_*` variables, from the environment and then from the `.env` files of the panel's directory. If the panel gets them elsewhere (systemd `Environment=` lines, Docker), run the script where they are set (`docker exec -it <container> node scripts/reset-owner.mjs`) or pass `--data-dir`, `--db-file` or `--database-url`. `--help` lists the options. With several servers the new password reaches the other panels at the next sync; two-step verification is turned off only on the server where the script runs.

## Inviting someone

In **Accessi › Utenti › Invita utente** (access, users, invite user) type the email and choose how long the link lasts: 1 hour, 24 hours, 7 days or any duration up to 30 days. The panel shows the link **once** and you send it to the person yourself. The link works once: the person picks a password, or uses **Accedi con GitHub** where [sign-in with GitHub](#signing-in-with-github) is on, and is in.

From an account's page you generate a new link: an invitation if the account has not accepted one yet, otherwise a link to choose a new password (that is how a forgotten password is solved, and how an account that signs in only with GitHub gets one). Every new link voids the unused ones, and using one signs that account out of every device.

## What an account can do

### Projects and services

A grant points at **everything**, a **folder**, a **project** or a **service**, with one of three levels:

| Level | Project | Service |
|---|---|---|
| Lettura (read) | status, logs, deploy history, variable names with masked values | status |
| Operatore (operate) | plus deploy, start, stop, restart | plus start, stop, restart |
| Gestione (manage) | plus settings, plain variables, files, mounts, one-time commands, deletion | plus credentials, databases inside, mounts, settings, deletion |

The **Terminale e console** switch, from Operatore up, opens a shell in containers and the database console. Each person has their own session.

The highest level among the grants that concern an item applies. A grant on a folder also covers what is added to it later, and a service linked to a project follows the project's access. There are no deny rules: to remove access you remove the row. Someone who cannot see a project gets "not found", as if it did not exist.

With several servers a grant can point at a project or service on any server: in the editor every item has the server's name next to it.

### Panel permissions

Per-account switches: Create projects and services, GitHub, Registries, Shared variables, Storage, Backup, Restore, Monitor, Autostart, Diagnostics, Notifications, Updates, Host access, Manage users, Activity log, Linked servers. Menu and buttons follow them, but the real check happens on the server, on every request and every stream.

To grant with care:

- **Host access.** Native runtimes (PM2), Compose, shared folders (services included), Docker capabilities, host networking, one-time commands and changing a project's code (files, uploads, repository) reach past the container, as far as the panel's database and its secret key. Without this permission, even an account with Manage on a project only works with plain Docker containers.
- **Shared variables.** Reading, creating and changing the groups of [shared variables](deploy.md#shared-variables), and attaching them to the projects one manages: attaching a group hands its values to the app, and whoever manages the project can read them through it. A group that reaches a project running on the host also needs Host access to be changed.
- **Backup and Restore.** An account other than the owner backs up and restores only the projects and services it manages, one by one. Backing up the panel itself, or including the secret key, stays with the owner.
- **Manage users.** It never allows touching the owner or oneself, granting a permission or level one does not hold, or editing, resetting or deleting an account with more access than one's own.
- **Linked servers.** Linking, diagnosing, changing the role of and revoking the cluster's servers, and regenerating the shared secret. It gives no access to the projects of other servers, which follow the usual permissions.

The **presets** fill the fields in one click and can then be adjusted:

| Preset | Permissions | Access |
|---|---|---|
| Visualizzatore (viewer) | none | Read on everything |
| Sviluppatore (developer) | Create projects and services, GitHub | Operate on everything |
| Operatore sistema (system operator) | Monitor, Storage, Backup, Autostart, Diagnostics | Operate on everything |
| Nessun accesso (no access) | none | none |

### Who has access

In a project's or service's settings, whoever manages users sees the accounts that reach it, with the level and where the access comes from, and can change them there.

## Revoking

Removing a grant, disabling or deleting an account, closing a session: it takes effect at once, and that user's open streams and shells close. Disabling an account signs it out of every device.

## Activity log

**Accessi › Registro attività** lists who did what: successful and failed sign-ins, invitations, permission changes, deploys, restarts, changes to variables and settings, terminals opened, backups, restores, updates, deletions. It filters by category, period, person, action and what it was done to (a project, a database, a folder, a user, an area of the panel); the filters stay in the address, so a filtered view can be bookmarked. **Vedi attività** on a user's page, and in the **Altro** menu of a project, opens it already filtered. Each account sees only entries about resources it can see, and security entries only those who manage users. With several servers each server keeps its own log, and the page shows the selected server's.

**Esporta CSV** downloads what the filters show, newest first, up to 100,000 entries: date and time in the panel's time zone and in UTC, person, action, category, resource, detail and address. The file opens in a spreadsheet with a double click: `;` as separator (what a spreadsheet set to Italian expects), UTF-8, and any cell that would start a formula (`=`, `+`, `-`, `@`) written as text. In expert mode there is also a version with `,`. Each export is itself recorded in the log.

The owner chooses which categories to record (Sicurezza, Deploy, Configurazione, Terminale, Backup, Sistema, Eliminazioni; security is always on) and for how many days to keep them, 1 to 3650 (90 by default). Entries hold names, never secret values, and a failed log write never blocks the action it describes.

## Upgrading from a password-only version

If the panel was set up when it had a single password, the first sign-in after the update is done with the email field empty; the panel then asks for it. Open sessions stay valid.
