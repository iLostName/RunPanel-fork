[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/mcp.md)

---

# AI e MCP

RunPanel espone un server [MCP](https://modelcontextprotocol.io) su `/api/mcp`: Claude (o un altro client MCP) può leggere lo stato del pannello, fare deploy, riavviare, cambiare variabili e in generale usare ogni endpoint dell'API, con i permessi di chi ha creato il token. Gli stessi token valgono anche per l'API REST da uno script.

## Attivarlo

1. **Impostazioni › AI e API**: il proprietario accende **Permetti l'accesso via token**. Spento (il predefinito), nessun token funziona, né via MCP né via API.
2. Nella stessa pagina crea un token: un nome, i **permessi** e la **scadenza** (30 giorni, 90 giorni, 1 anno o mai).
3. Il token si vede **una volta sola**, insieme al comando pronto per Claude Code:

```bash
claude mcp add --transport http runpanel https://pannello.esempio.it/api/mcp \
  --header "Authorization: Bearer rpk_…"
```

Per altri client c'è anche la configurazione `.mcp.json` (`type: "http"`, `url`, `headers`).

## Permessi

- **Controllo completo**: tutto ciò che il tuo account può fare dal browser, niente di più. Un utente con accesso a due progetti dà a Claude quei due progetti.
- **Sola lettura**: stato, log, impostazioni. Ogni scrittura è rifiutata dal proxy prima di arrivare alla route, e via MCP gli strumenti di scrittura non compaiono nemmeno.

Ogni utente gestisce i propri token. Un token non può elencare, creare o revocare token: si fa solo dal pannello con una sessione, così un token rubato non può crearsi un successore. Creazione, revoca e interruttore finiscono nel registro attività.

Un token smette di funzionare subito se viene revocato, se scade, se l'account viene disattivato o se il proprietario spegne l'interruttore.

## Gli strumenti

| Strumento | Cosa fa |
|---|---|
| `list_servers` | I server del cluster, con stato e avvisi |
| `list_projects`, `get_project` | Progetti e dettaglio |
| `get_project_logs`, `get_deployment` | Output dell'app, storico e log di build |
| `get_project_env` | Variabili d'ambiente (mascherate se non puoi vederle) |
| `list_services`, `get_service` | Database e cache |
| `deploy_project` | Deploy o rebuild, anche di un commit preciso |
| `control_project`, `control_service` | Avvio, stop, riavvio |
| `set_project_env` | Aggiunge, cambia o toglie singole variabili, tenendo le altre |
| `list_endpoints` | Il catalogo di tutta l'API: metodo, path, query e body |
| `api_get`, `api_request` | Qualsiasi endpoint, in lettura o in scrittura |

Con `list_endpoints` + `api_get` / `api_request` Claude raggiunge tutto il pannello: backup, domini, utenti, aggiornamenti, Docker, notifiche. Ogni strumento accetta `server` per agire su un altro server del [cluster](multi-server.md).

## Limiti

- Gli stream in tempo reale (SSE) e i download binari non si leggono via MCP: per seguire un deploy si interroga `get_deployment`.
- L'upload di ZIP e l'inoltro `/api/nodes/…` del browser non accettano token.
- Su un server con ruolo **nodo** non si creano token: si usano quelli del pannello che lo gestisce.
