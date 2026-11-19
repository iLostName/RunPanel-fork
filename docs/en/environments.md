[← RunPanel](../../README.md) · [Italiano](../it/environments.md) · **English**

---

# Staging and pull request previews

A project from GitHub can have **environments**: sibling projects that run its code from another branch. A **Staging** copy follows a branch of its own, and every open pull request can get a **preview** (*anteprima*). Each environment is a project in its own right — its own container, folder, port, address and resources — linked to production:

- it **follows production's permissions**: whoever may manage production manages its environments, and a grant left on an environment itself counts for nothing ([Users and permissions](users.md));
- it **inherits production's variables**, under its own;
- it **never gets production's databases**, unless you pick them explicitly;
- it **never changes production**: the only way code goes from staging to production is **Promuovi in produzione** (promote to production).

The project page shows the environments as a switch at the top: **Produzione**, **Staging** and one entry per preview (**PR #12**), each with its state. The interface is in Italian; labels are quoted as they appear.

## Staging

### Creating it

From production's page, **Altro › Crea staging** (needs managing production, **Creare progetti** and **Accesso all'host**, like Duplica). In one step the panel creates `<name> (staging)` with:

- the same repository, runtime, deploy contract and resources, and the same network access, start at boot, scheduled restart and auto-deploy setting as production;
- another branch: `staging` or `develop`, whichever the repository has (never production's branch: two environments on one branch would deploy every push twice);
- its own port (the first free one) and, when one can be proposed, its own address: `shop-staging.example.com` next to `shop.example.com` on the same domain, or an instant sslip.io address;
- its own webhook, registered when production deploys automatically.

Not copied: bind mounts (two containers must not write to one host folder), scheduled tasks, linked databases.

### Variables

Staging receives production's variables and shared groups, and **what you set on staging wins**: its own variables, then the groups it attaches, over everything inherited. **Variabili › Cosa riceve l'app** shows where each one comes from (*produzione «Shop»*, *gruppo «smtp» di «Shop»*).

A variable inherited from production that reads one of **production's databases** (`${{ db.shop.main.url }}`, directly or through a group) is **not handed down**: the Variables tab lists it with the reason, and staging's deploy carries on without it. Production's database links are never inherited either. To give staging data, link a database of its own; to really use production's, tick **Usa i database di produzione** when creating it (the dialog says what that means) or write the reference in staging's own variables.

### Promote to production

On staging's page, **Promuovi in produzione** opens a confirmation with:

- the commit staging **runs** (its live deployment, not the head of its branch), its author and date;
- the variables the two environments do not share, by name only: missing in production first — the ones that break a promoted app most often — then different values, then production-only;
- how production will take it.

Confirming deploys that exact commit on production through production's own deploy: its settings, its variables, its automatic return to the previous version and its deploy without downtime. Production is then **held at that commit** (*Fermo su …*), so the next push to its branch does not undo the promotion; **Torna all'ultimo commit** releases it. If staging moved on between the dialog and the click, the promotion is refused and the dialog reads it again.

### Deleting

Deleting staging (Impostazioni › Zona pericolosa) never touches production. Production cannot be deleted while it has environments: the dialog lists them and asks for a box to be ticked to delete them together (`DELETE /api/projects/{id}?environments=delete`).

## Pull request previews

### Turning them on

**Impostazioni › Anteprime**, on production (needs managing it, **Creare progetti**, **GitHub** and **Accesso all'host**: previews create projects by themselves). Off by default, and only for a GitHub repository whose events reach the panel:

- with the **webhook**, the panel rewrites it to receive pull request events as well as pushes, and refuses to turn previews on if GitHub does not accept it;
- with **Controllo nuovi commit** (polling) it asks GitHub for the open pull requests at the same interval; a GitHub token must be connected.

Settings: how many previews may run at once (default 3), after how many idle days one is stopped (default 7), the address, and whether to write a commit status on the pull request.

### What happens

- **A pull request opened, reopened or pushed to** against production's branch: its preview is created or redeployed, held at the pull request's head commit, as `<name> · PR #12`.
- **Address**: `pr-12.<domain>` on one of the panel's domains with a wildcard record (see [Domains](domains.md)), else an instant address `pr-12-<project>.<ip>.sslip.io` (HTTP only).
- **Variables**: staging's if production has staging, else production's, plus **Variabili delle anteprime** (in the same settings section), over everything inherited. Never production's databases, as above.
- **Closed or merged**: the preview is removed with its containers, folders, address and its own databases.
- **Limits**: past the maximum, the preview idle the longest is stopped, and the list says so. One with no activity for the idle days is stopped by an hourly sweep. Previews run on this server next to production: the list shows how many run and their total memory and CPU.
- **Pull requests from forks are never deployed by themselves**: they would run strangers' code on this server, with the previews' variables. The list shows them as **Da approvare**; **Approva** deploys exactly the head commit shown, and every new push must be approved again.
- **Commit status** (optional): `runpanel/preview` with the address, pending while it deploys, then success or failure. Only if the stored token may write commit statuses ("Commit statuses: Read and write", or the classic `repo:status` scope); otherwise it is skipped and the list says why.

The project page lists the previews under production's **Panoramica** with number, title, author, commit, state and address, and **Apri**, **Ridistribuisci**, **Ferma**, **Elimina**. Deleting a preview by hand keeps the pull request: its next push makes it again. Turning previews off removes them all.

## What is not covered yet

- An environment is one level deep: staging and previews of production, not environments of an environment.
- A staging copy needs a GitHub source; an uploaded ZIP has no branches.
- Previews are named per pull request number; branches without a pull request get none.

## API

`GET/POST /api/projects/{id}/environments`, `GET/POST /api/projects/{id}/promote`, `GET/PUT /api/projects/{id}/previews`, `GET/PUT /api/projects/{id}/previews/env`, `POST/DELETE /api/projects/{id}/previews/{previewId}`. Details in the catalogue an MCP client reads ([AI and MCP](mcp.md)).
