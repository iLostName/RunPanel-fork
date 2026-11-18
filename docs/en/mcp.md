[← RunPanel](../../README.md) · [Italiano](../it/mcp.md) · **English**

---

# AI and MCP

RunPanel serves [MCP](https://modelcontextprotocol.io) at `/api/mcp`: Claude (or any MCP client) can read the panel's state, deploy, restart, change variables and generally use every API endpoint, with the permissions of whoever created the token. The same tokens also work for the REST API from a script.

## Turning it on

1. **Settings › AI e API**: the owner turns on **Permetti l'accesso via token**. Off (the default), no token works, neither over MCP nor over the API.
2. On the same page, create a token: a name, its **permissions** and an **expiry** (30 days, 90 days, 1 year or never).
3. The token is shown **once**, with the command ready for Claude Code:

```bash
claude mcp add --transport http runpanel https://panel.example.com/api/mcp \
  --header "Authorization: Bearer rpk_…"
```

For other clients there is also the `.mcp.json` configuration (`type: "http"`, `url`, `headers`).

## Permissions

- **Full control**: everything your account can do from the browser, nothing more. A user with access to two projects gives Claude those two projects.
- **Read-only**: state, logs, settings. Every write is refused by the proxy before it reaches a route, and over MCP the write tools are not even listed.

Each user manages their own tokens. A token cannot list, create or revoke tokens: that only happens in the panel with a session, so a stolen token cannot mint itself a successor. Creating, revoking and the switch are recorded in the activity log.

A token stops working at once when it is revoked or expires, when its account is disabled, or when the owner turns the switch off.

## The tools

| Tool | What it does |
|---|---|
| `list_servers` | The servers of the cluster, with status and warnings |
| `list_projects`, `get_project` | Projects and their detail |
| `get_project_logs`, `get_deployment` | App output, deploy history and build logs |
| `get_project_env` | Environment variables (masked unless you may see them) |
| `list_services`, `get_service` | Databases and caches |
| `deploy_project` | Deploy or rebuild, also of a given commit |
| `control_project`, `control_service` | Start, stop, restart |
| `set_project_env` | Add, change or remove single variables, keeping the rest |
| `list_endpoints` | The catalog of the whole API: method, path, query and body |
| `api_get`, `api_request` | Any endpoint, to read or to write |

With `list_endpoints` + `api_get` / `api_request` Claude reaches the whole panel: backups, domains, users, updates, Docker, notifications. Every tool takes `server` to act on another server of the [cluster](multi-server.md).

## API reference

**Settings › AI e API › Riferimento API** lists every endpoint a token can call, grouped by area: method, path, query parameters, body and the kind of answer. It is read from the same catalog `list_endpoints` returns (`services/mcp/catalog.ts`), so it cannot drift from the routes: a test fails when the two disagree. The descriptions are in English, the same text the assistant reads.

It searches by any word of path, description or parameters and filters by method. Each endpoint has a curl line to copy, with the token in a variable:

```bash
export RUNPANEL_TOKEN="rpk_…"
curl "https://panel.example.com/api/projects" -H "Authorization: Bearer $RUNPANEL_TOKEN"
```

Signing in, two-step verification and the token management are not in it: they only work from a browser.

## Limits

- Live streams (SSE) and binary downloads cannot be read over MCP: to follow a deploy, poll `get_deployment`.
- The ZIP upload and the browser's `/api/nodes/…` forward do not accept tokens.
- A server with the **node** role mints no tokens: use those of the panel that manages it.
