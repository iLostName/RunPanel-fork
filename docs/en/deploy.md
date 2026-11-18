[← RunPanel](../../README.md) · [Italiano](../it/deploy.md) · **English**

---

# Deploying a project

A project lives on the server it was created on: with [several servers](multi-server.md), create it with that server selected. Changing the source, branch, repository or uploading files needs the **Accesso all'host** (host access) permission (see [Users and permissions](users.md)).

The interface is in Italian; labels are quoted as they appear, with a translation where it helps.

## Creating a project

**Nuovo progetto** (new project) takes three steps and creates the project only at the last one: an abandoned wizard leaves nothing behind.

1. **Sorgente** (source): a GitHub repository (from the list when GitHub is connected, or by pasting a public one's address) or a ZIP archive dropped on the page. GitHub can be connected from a dialog without leaving the wizard.
2. **Rivedi** (review): the panel reads the code without cloning it (GitHub's API, or the ZIP's index in the browser) and says what it found, for example *Next.js · porta 3000 · npm*. The name comes from the repository. The remaining questions are already answered: what the app does (a website or a background service, which turns the health check off), whether it needs a database (offered when the code uses one: it is created and linked), variables (by pasting a `.env`), an address on a domain already set up, and updates on every push. Runtime, port and commands are under **Personalizza** (customise). The proposed port is already free: for native apps, when the detected one is taken, the app receives the next one in `PORT`.
3. **Online**: creates the project, database, variables and address, then starts the first deploy and shows its phases and log. If a step before the deploy fails, whatever had been created is removed again. Automatic updates use the webhook when GitHub can reach the panel, polling otherwise.

An empty project, configured by hand, is created from the same wizard in expert mode.

## App catalogue

**Nuovo progetto › Da un modello** (from a template), or **Installa un'app pronta** in the search (Ctrl K), opens a catalogue of ready apps: n8n, WordPress (with MariaDB), Uptime Kuma, Umami (with PostgreSQL), Ghost (with MySQL), Vaultwarden, Gitea and MinIO, with search and categories. Installing one needs **Creare progetti** and **Accesso all'host** (create projects, host access), as any source does.

The install page asks only the app's own questions, all prefilled: the name, a free port, the time zone, an optional address on a configured domain (required for Vaultwarden, whose vault only opens over HTTPS). Passwords and keys are generated on the server and shown once, at the end, with a copy button; afterwards they are only in the project's variables. **Avanzate** (advanced) shows the port, the server name the app writes into its own links while it has no address, the compose file exactly as it will be written, the variables and the volumes.

One request does the rest, all or nothing. It checks Docker and Compose; refuses a name whose data an earlier install left behind (deleting a Compose project keeps its named volumes, and a new stack would silently reuse them); picks or checks the ports against the panel's own lists and against what is listening on the machine; then writes `compose.yaml` into the project's folder and saves the project, its variables (encrypted) and its address together. If any of it fails, what was created is removed. Then the first deploy starts, followed live, and the page lists what to do once the app is online: usually, open it and create the administrator account before anyone else can.

What gets installed is an ordinary Compose project. Every value the file substitutes is a project variable (`${NAME:-…}`), handed to Compose at each deploy and never written into the project's files; `PORT` is the project's port. The data lives in named volumes, which a new deploy finds as it left them and the project's backups include when volumes are selected. Change the file from **File**, the values from **Variabili**, then deploy again; if the app gets an address later, update `APP_URL` (and `APP_HOST`, where there is one) as well. MinIO runs `pgsty/minio`, the community's continuation of MinIO: the official image is no longer published.

## The project page

- **Panoramica** (overview, the default): the state in one sentence with the next thing to do (choose a source, run the first deploy, fix a failed deploy, start it again), the last deploy, resources, addresses, linked databases and what is missing for a dependable project.
- **Deploy**: the history, the deploy in progress followed live (with **Annulla**, cancel), and **Ripristina** (restore) on earlier successful versions of a GitHub repository. A failed deploy states its cause in words (wrong port, out of memory during the build, dependencies not installed, repository not readable…) with the original message under **Dettagli**.
- **Log**, **Variabili** (variables), **File** (with a warning that the next deploy puts the files back as the source has them), **Terminale** (Docker only).
- **Impostazioni** (settings), with a side menu: Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa. One bar saves every section with edits, and the menu marks the ones with unsaved changes. Only what changed is sent.

## Sources

- **GitHub**: connect a token on the **GitHub** page and pick the repository from a list, with branches read from the API. Or paste a public `https://` URL. In a cluster the token is shared by every server.
- **ZIP upload**: for code that is not on GitHub. Limits: 100 MB archive, 1 GB unpacked, 50,000 entries. Traversal entries and links are refused, a single top-level folder is unwrapped, and the new files replace the old only once extraction succeeds. Uploads are refused during a deploy. Uploading does not start a deploy.

## Runtimes and presets

| Runtime | What it does | Run by |
|---|---|---|
| `node` | Detects the package manager from the lockfile and uses the scripts | PM2 |
| `custom` | Only the commands you write, in any language | PM2 |
| `docker` | Builds the repository's Dockerfile | Docker |
| `compose` | Starts the stack described by the compose file | Docker |
| `static` | Serves a build folder; comes from the Vite preset or **Applica i comandi** | PM2 |

**Presets** are starting points for common repository shapes: Dockerfile, Next.js server, Vite/static SPA, Python (uvicorn/gunicorn), Go. Each brings a runtime and the commands it needs.

- At creation the default is **Rileva da solo** (detect it): the preset is recognised at every deploy, from the repository's files. Pick one by hand when the repository's shape is not visible from outside.
- In **Impostazioni › Build e avvio** (settings, build and start) pick a preset and press **Applica i comandi** (apply the commands): runtime and commands are filled with its own. Nothing is stored until you save.

Precedence, from the bottom: the preset, then the repository's `runpanel.json`, then the panel's settings.

## Where the files live

A project's code lives in `data/repos/<slug>`. For a native project, the settings can move the folder to another disk with everything in it, `node_modules` and builds included, so it restarts without rebuilding. A link stays at the old place, and the original copy stays until you delete it.

## The deploy contract

What RunPanel needs to know to deploy a project. The fields are runtime-neutral and each runtime translates them its own way.

| Field | Docker | PM2 / native |
|---|---|---|
| `buildEnv`, `buildEnvPrefixes` | one `--build-arg` per entry | install and build environment (`buildEnv` values written in the panel are encrypted in the store; going back to an earlier panel version, they have to be written again) |
| `envFile` | written 0600 and mounted read-only | written 0600 in the repository (path relative to its root) |
| `commands.release` | throwaway container before start | command in the repository folder |
| `healthcheck` | probed by RunPanel after start | same |
| `runtime.restartPolicy` | `--restart` | PM2 `autorestart` |
| `runtime.memory` / `cpus` / `shmSize` | container limits | `max_memory_restart` where applicable |
| `docker.network` / `hostname` / `capAdd` / `extraHosts` | `docker run` flags | not applicable |
| `build.timeoutSec` / `nodeOptions` | build time limit (default 900 s) and Node options | same |

For **Compose**, commands, variables and the health check apply; restart policy, limits, network and `envFile` are up to the compose file. `capAdd` and `extraHosts` have no field in the interface.

### `runpanel.json`

A repository can declare how it wants to be deployed:

```json
{
  "version": 1,
  "commands": { "release": "npx prisma migrate deploy" },
  "envFile": { "enabled": true },
  "healthcheck": { "startPeriodSec": 45, "timeoutSec": 120 },
  "runtime": { "restartPolicy": "unless-stopped", "memory": "2g" }
}
```

Where both set a value the panel wins. An invalid file is ignored as a whole.

Some fields are **panel-only** and are dropped when they come from the repository, with a line in the deploy log: `docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts`, `docker.context`, `docker.dockerfile`, `docker.target`, `envFile.path`, `healthcheck.path` and `healthcheck.port`. They decide what the project reaches outside its container, where decrypted secrets are written and what the panel probes: a repository must not choose them for itself. For the same reason [one-time commands](automation.md#one-time-commands) are kept out of the contract.

## Environment variables

Managed in the **Variabili** (variables) tab, with **Importa .env** to paste a file, and encrypted at rest. They apply from the next deploy or restart, not on save. They are passed to the process or container and, if `envFile` is on, also written to a file the app reads itself. Limits: 500 variables, 64 KB per value.

RunPanel adds `NODE_ENV=production` and, for native runtimes, `PORT` (3000 if not set). Variables from a [linked service](databases.md) take precedence over those with the same name.

Variables prefixed `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` or `REACT_APP_` also reach the **build**, because frontends inline them into the bundle. The prefix list (`buildEnvPrefixes`) and extra keys (`buildEnv`) are set in the contract.

## What a deploy does

1. **Queue**: one deploy at a time per project. Requests arriving meanwhile become **one** following deploy; that waiting deploy lives in memory and is lost if the panel restarts.
2. **Source**: clone or pull of the branch, or the commit the project is pinned to. The checkout is reset to the commit (`reset --hard` and `clean`): changes made in the file manager to non-ignored files are lost.
3. **Contract**: preset, `runpanel.json`, panel settings.
4. **Build**: install and build according to the runtime, with live output.
5. **Release command**: run once, at most 10 minutes. If it fails the new version does not start and the old one stays up: this is where migrations go.
6. **Start**: the old version is stopped only now (on Windows native runtimes, before the build), then PM2 or Docker start the new one with the contract's policy and limits.
7. **Health check**: RunPanel probes the app every 2 seconds, after a 3-second wait and for at most 30 (`startPeriodSec`, `timeoutSec`). Any HTTP response passes unless the contract sets `expectStatus`; a container without a port only has to stay up.

If the health check fails, the deploy is marked failed with the process's last 40 lines in the log, and the project goes into error. **There is no automatic return to the previous version**, which has already been stopped: to go back see [Going back to a commit](automation.md#going-back-to-a-commit).

Stopping a project during a deploy cancels the deploy: the running command is interrupted, the deploy ends as failed, the app stays down and a queued deploy is dropped too. Restarts, checkout moves, bind applies and volume restores never overlap: a deploy requested meanwhile starts as soon as they finish.

**Re-build da zero** (rebuild from scratch, in the **Altro** menu) stops the app, deletes the runtime's build files and redoes everything from the code already there, with no `git pull`:

- node: `.next`, `node_modules`, `dist`, `build`, `.turbo`;
- static: `dist`, `build`;
- custom: `venv`, `__pycache__`, `dist`, `build`;
- Docker and Compose: nothing to delete.

A project uploaded as a ZIP keeps `dist` and `build`. It is not available on a project pinned to a commit.
