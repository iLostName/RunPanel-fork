[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/deploy.md)

---

# Distribuire un progetto

Un progetto vive sul server su cui è stato creato: con [più server](multi-server.md), crealo con quel server selezionato. Cambiare sorgente, branch, repository o caricare file richiede il permesso **Accesso all'host** (vedi [Utenti e permessi](users.md)).

## Creare un progetto

**Nuovo progetto** fa tre passi, e crea il progetto solo all'ultimo: un wizard abbandonato non lascia niente.

1. **Sorgente**: un repository GitHub (dall'elenco, se GitHub è collegato, o incollando l'indirizzo di uno pubblico) oppure un archivio ZIP trascinato nella pagina. GitHub si collega da un dialog, senza uscire dal wizard.
2. **Rivedi**: il pannello legge il codice senza clonarlo (l'API di GitHub, o l'indice dello ZIP nel browser) e dice cosa ha trovato, per esempio *Next.js · porta 3000 · npm*. Il nome arriva dal repository. Le domande rimaste hanno già una risposta: che cosa fa l'app (sito o servizio in background, che spegne il controllo di salute), se serve un database (proposto quando il codice ne usa uno: viene creato e collegato), le variabili (incollando un `.env`), un indirizzo su un dominio già configurato, e gli aggiornamenti a ogni push. Runtime, porta e comandi stanno in **Personalizza**. La porta proposta è già libera: per le app native, se quella rilevata è occupata, l'app riceve la successiva nella variabile `PORT`.
3. **Online**: crea progetto, database, variabili e indirizzo, poi avvia il primo deploy e ne mostra le fasi e il log. Se un passo prima del deploy non riesce, quello che era già stato creato viene tolto. Gli aggiornamenti automatici usano il webhook quando GitHub può raggiungere il pannello, altrimenti il controllo periodico.

Un progetto vuoto, da configurare a mano, si crea dallo stesso wizard in modalità esperto.

## Catalogo di app

**Nuovo progetto › Da un modello**, oppure **Installa un'app pronta** dalla ricerca (Ctrl K), apre un catalogo di app pronte: n8n, WordPress (con MariaDB), Uptime Kuma, Umami (con PostgreSQL), Ghost (con MySQL), Vaultwarden, Gitea e MinIO, con la ricerca e le categorie. Per installarne una servono **Creare progetti** e **Accesso all'host**, come per qualsiasi sorgente.

La pagina di installazione fa solo le domande dell'app, già compilate: il nome, una porta libera, il fuso orario, un indirizzo facoltativo su un dominio configurato (obbligatorio per Vaultwarden, la cui cassaforte si apre solo in HTTPS). Password e chiavi le genera il server e le mostra una volta sola, alla fine, con il pulsante per copiarle; dopo stanno solo nelle variabili del progetto. In **Avanzate** ci sono la porta, il nome del server che l'app scrive nei propri link finché non ha un indirizzo, il file compose esattamente come verrà scritto, le variabili e i volumi.

Il resto lo fa una sola richiesta, tutto o niente. Controlla Docker e Compose; rifiuta un nome di cui restano i dati di un'installazione precedente (eliminare un progetto Compose ne conserva i volumi con nome, e un nuovo stack li riuserebbe senza dire niente); sceglie o verifica le porte confrontandole con quelle del pannello e con quello che è in ascolto sulla macchina; poi scrive `compose.yaml` nella cartella del progetto e salva insieme progetto, variabili (cifrate) e indirizzo. Se qualcosa non riesce, quello che era stato creato viene tolto. Poi parte il primo deploy, seguito dal vivo, e la pagina elenca cosa fare quando l'app è online: di solito aprirla e creare l'account amministratore prima che possa farlo qualcun altro.

Quello che viene installato è un normale progetto Compose. Ogni valore che il file sostituisce è una variabile del progetto (`${NOME:-…}`), passata a Compose a ogni deploy e mai scritta nei file del progetto; `PORT` è la porta del progetto. I dati stanno in volumi con nome, che un nuovo deploy ritrova come li aveva lasciati e che i backup del progetto includono quando scegli anche i volumi. Il file si cambia da **File**, i valori da **Variabili**, poi si rifà il deploy; se più avanti l'app riceve un indirizzo, aggiorna anche `APP_URL` (e `APP_HOST`, dove c'è). MinIO usa `pgsty/minio`, la continuazione di MinIO portata avanti dalla comunità: l'immagine ufficiale non viene più pubblicata.

## La pagina del progetto

- **Panoramica** (si apre qui): lo stato in una frase con la prossima cosa da fare (scegliere la sorgente, fare il primo deploy, correggere un deploy fallito, riavviare), l'ultimo deploy, le risorse, gli indirizzi, i database collegati e cosa manca per un progetto affidabile.
- **Deploy**: la cronologia, il deploy in corso seguito dal vivo (con **Annulla**), e **Ripristina** sulle versioni precedenti riuscite di un repository GitHub. Un deploy fallito dice la causa in parole (porta sbagliata, memoria finita durante la build, dipendenze non installate, repository non leggibile…) con il messaggio originale in **Dettagli**.
- **Log**, **Variabili**, **File** (con l'avviso che il deploy successivo rimette i file come nella sorgente), **Terminale** (solo Docker).
- **Impostazioni**, con un menu laterale: Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa. Una sola barra salva tutte le sezioni modificate, e il menu segna quelle con modifiche non salvate. Viene inviato solo quello che è cambiato.

## Sorgenti

- **GitHub**: collega un token nella pagina **GitHub** e scegli il repository da un elenco, con i branch letti dall'API. In alternativa incolla un URL `https://` pubblico. In un cluster il token è condiviso da tutti i server.
- **Upload ZIP**: per il codice che non sta su GitHub. Limiti: 100 MB di archivio, 1 GB decompresso, 50.000 voci. Le voci con traversal e i link vengono rifiutati, una singola cartella principale viene tolta, e i file nuovi sostituiscono i vecchi solo a estrazione riuscita. Durante un deploy l'upload è rifiutato. Caricare non avvia un deploy.

## Runtime e preset

| Runtime | Cosa fa | Chi lo esegue |
|---|---|---|
| `node` | Rileva il package manager dal lockfile e usa gli script | PM2 |
| `custom` | Solo i comandi che scrivi tu, in qualsiasi linguaggio | PM2 |
| `docker` | Costruisce il Dockerfile del repository | Docker |
| `compose` | Avvia lo stack descritto dal compose file | Docker |
| `static` | Serve una cartella di build; arriva dal preset Vite o da **Applica i comandi** | PM2 |

I **preset** sono punti di partenza per forme di repository comuni: Dockerfile, Next.js server, Vite/SPA statica, Python (uvicorn/gunicorn), Go. Ognuno porta un runtime e i comandi che gli servono.

- Alla creazione la scelta di default è **Rileva da solo**: il preset viene riconosciuto a ogni deploy, guardando i file del repository. Puoi sceglierne uno a mano quando la forma del repository non si vede da fuori.
- In **Impostazioni › Build e avvio** scegli un preset e premi **Applica i comandi**: runtime e comandi vengono compilati con i suoi. Niente viene salvato finché non salvi.

La precedenza, dal basso: il preset, poi il `runpanel.json` del repository, poi le impostazioni del pannello.

## Dove stanno i file

Il codice di un progetto sta in `data/repos/<slug>`. Per un progetto nativo, dalle impostazioni si può spostare la cartella su un altro disco con tutto dentro, `node_modules` e build compresi, così riparte senza ricostruire. Al vecchio posto resta un collegamento, e la copia di partenza resta finché non la cancelli tu.

## Il contratto di deploy

Quello che a RunPanel serve sapere per distribuire un progetto. I campi sono neutri rispetto al runtime e ognuno li traduce a modo suo.

| Campo | Docker | PM2 / nativo |
|---|---|---|
| `buildEnv`, `buildEnvPrefixes` | un `--build-arg` per voce | ambiente di install e build (i valori di `buildEnv` scritti nel pannello sono cifrati nello store; tornando a una versione del pannello precedente vanno riscritti) |
| `envFile` | scritto 0600 e montato in sola lettura | scritto 0600 nel repository (percorso relativo alla sua radice) |
| `commands.release` | container usa-e-getta prima dell'avvio | comando nella cartella del repository |
| `healthcheck` | sondato da RunPanel dopo l'avvio | identico |
| `runtime.restartPolicy` | `--restart` | `autorestart` di PM2 |
| `runtime.memory` / `cpus` / `shmSize` | limiti del container | `max_memory_restart` dove applicabile |
| `docker.network` / `hostname` / `capAdd` / `extraHosts` | flag di `docker run` | non applicabile |
| `build.timeoutSec` / `nodeOptions` | tempo massimo del build (default 900 s) e opzioni di Node | identico |

Per **Compose** valgono comandi, variabili e health check; policy di riavvio, limiti, rete e `envFile` li decide il compose file. `capAdd` ed `extraHosts` non hanno un campo nell'interfaccia.

### `runpanel.json`

Un repository può dichiarare come vuole essere distribuito:

```json
{
  "version": 1,
  "commands": { "release": "npx prisma migrate deploy" },
  "envFile": { "enabled": true },
  "healthcheck": { "startPeriodSec": 45, "timeoutSec": 120 },
  "runtime": { "restartPolicy": "unless-stopped", "memory": "2g" }
}
```

Dove entrambi indicano un valore vince il pannello. Un file non valido viene ignorato per intero.

Alcuni campi sono **solo del pannello** e vengono scartati se arrivano dal repository, con una riga nel log del deploy: `docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts`, `docker.context`, `docker.dockerfile`, `docker.target`, `envFile.path`, `healthcheck.path` e `healthcheck.port`. Decidono cosa il progetto raggiunge fuori dal proprio container, dove finiscono i segreti decifrati e cosa sonda il pannello: un repository non deve poterli scegliere da sé. Per lo stesso motivo i [comandi una tantum](automation.md#comandi-una-tantum) stanno fuori dal contratto.

## Variabili d'ambiente

Si gestiscono nella scheda **Variabili** e sono cifrate a riposo. Valgono dal deploy o riavvio successivo, non al salvataggio: **Salva e ridistribuisci** salva e avvia subito un deploy. Vengono passate al processo o al container e, se `envFile` è attivo, scritte anche in un file che l'app legge da sola. Limiti: 500 variabili, 64 KB per valore, ogni nome una volta sola.

- **Tabella** e **Testo .env** modificano la stessa lista. Il testo si scrive come un normale `.env`: virgolette doppie per un valore con spazi all'inizio o alla fine, con `#` o su più righe. I commenti non vengono salvati; una riga che non si legge viene indicata con il suo numero, e il salvataggio aspetta che sia corretta.
- **Incolla .env** e **Importa file** aggiungono le variabili di un file a quelle che ci sono. Per un nome già presente con un altro valore si sceglie **Sovrascrivi** o **Salta**, e prima di applicare il pannello dice cosa farà ("2 aggiunte, 1 sostituita, 1 uguale"). Non toglie niente e non salva niente finché non premi Salva.
- I valori restano nascosti finché non li mostri, una riga alla volta. Il pannello li manda solo a chi può gestire il progetto: gli altri vedono i nomi e basta.
- Gli errori compaiono sulla riga sbagliata, sia quelli trovati prima di salvare sia quelli che il server rifiuta.

RunPanel aggiunge `NODE_ENV=production` e, per i runtime nativi, `PORT` (3000 se non indicata). Le variabili di un [servizio collegato](databases.md) prevalgono su quelle con lo stesso nome: la scheda le elenca in sola lettura sotto **Dai database collegati**, con il database da cui arrivano, e segna la tua variabile che verrebbe sostituita.

Le variabili con prefisso `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` o `REACT_APP_` arrivano anche al **build** (badge **usata nella build**), perché i frontend le incorporano nel bundle: chiunque apra il sito può leggerle, quindi niente segreti lì. Nei runtime nativi il build vede comunque tutte le variabili; per Docker arrivano come `--build-arg`. L'elenco dei prefissi (`buildEnvPrefixes`) e le chiavi aggiuntive (`buildEnv`) si cambiano nel contratto.

## Log

La scheda **Log** mostra il build del deploy in corso o dell'ultimo, con il suo esito, e l'output dell'app.

- **In diretta**: le ultime 2000 righe dell'esecuzione attuale. Si possono cercare (le corrispondenze sono evidenziate), filtrare fra output ed errori, mettere in pausa e pulire. Sono operazioni sulla vista: non cancellano niente.
- **Storico**: l'output che RunPanel ha salvato, anche da prima dei riavvii e dei nuovi deploy, che i runtime da soli non conservano (PM2 svuota i suoi file a ogni avvio, Docker cancella il log insieme al container). Qui la ricerca gira sul server, su tutto quello che è stato salvato.
- **Scarica** dà tutto lo storico in un file di testo, con ora e stream (`stdout`/`stderr`) su ogni riga.

Lo storico sta nella cartella dati, in `logs/apps/<id progetto>/`: al massimo 5 file da 4 MB per progetto, e il più vecchio viene cancellato quando ne inizia uno nuovo. I file di PM2 vengono letti ogni 10 secondi (l'ora salvata è quella della lettura), i container ogni 30 secondi con l'ora scritta da Docker; prima di un riavvio o di un deploy dal pannello l'output viene letto un'ultima volta. Nella diretta dei container output ed errori arrivano insieme; nello storico sono separati. Per gli stack Compose lo storico è approssimato: niente separazione e le righe perdono il rientro. Un file di PM2 che supera 16 MB viene svuotato dopo essere stato salvato. Lo storico di un progetto eliminato se ne va entro qualche minuto.

Via API: `GET /api/projects/<id>/logs/app` (le ultime righe, con `lines`, `q` e `stream`) e `GET /api/projects/<id>/logs/app/download`, con lo stesso permesso dei log.

## Com'è fatto un deploy

1. **Coda**: un deploy alla volta per progetto. Le richieste che arrivano nel frattempo diventano **un** deploy successivo; quel deploy in attesa vive in memoria e si perde se il pannello si riavvia.
2. **Sorgente**: clone o pull del branch, oppure il commit su cui il progetto è fermo. Il checkout viene riportato al commit (`reset --hard` e `clean`): le modifiche fatte dal file manager a file non ignorati si perdono.
3. **Contratto**: preset, `runpanel.json`, impostazioni del pannello.
4. **Build**: install e build secondo il runtime, con l'output in diretta.
5. **Release command**: eseguito una volta, al massimo 10 minuti. Se fallisce la nuova versione non parte e la vecchia resta su: è il posto per le migrazioni.
6. **Avvio**: la versione vecchia si ferma solo adesso (sui runtime nativi Windows, prima del build), poi PM2 o Docker avviano la nuova con policy e limiti del contratto.
7. **Health check**: RunPanel sonda l'app ogni 2 secondi, dopo 3 secondi di attesa e per al massimo 30 (`startPeriodSec`, `timeoutSec`). Passa qualsiasi risposta HTTP, a meno che il contratto indichi `expectStatus`; un container senza porta deve solo restare acceso.

Se l'health check fallisce, il deploy è segnato come fallito con le ultime 40 righe del processo nel log, e il progetto va in errore. **Non c'è un ritorno automatico alla versione precedente**, che è già stata fermata: per tornare indietro vedi [Tornare a un commit](automation.md#tornare-a-un-commit). Un release command fallito lascia il progetto Docker sull'ultima immagine riuscita, che è quella da cui riparte Riavvia. Compose e i runtime nativi non hanno un'immagine da conservare: Riavvia parte da quello che il deploy fallito ha già costruito, e per tornare indietro serve un nuovo deploy del commit buono.

Fermare un progetto durante un deploy annulla il deploy: il comando in corso viene interrotto, il deploy finisce come fallito, l'app resta ferma e anche un deploy in coda viene scartato. Restart, spostamento del checkout, applicazione dei bind e ripristino di un volume non si sovrappongono: una richiesta di deploy che arriva in quel momento parte appena finiscono.

**Re-build da zero** (menu **Altro**) ferma l'app, cancella i file di build del runtime e rifà tutto dal codice già presente, senza `git pull`:

- node: `.next`, `node_modules`, `dist`, `build`, `.turbo`;
- static: `dist`, `build`;
- custom: `venv`, `__pycache__`, `dist`, `build`;
- Docker e Compose: niente da cancellare.

Un progetto caricato da ZIP tiene `dist` e `build`. Non si può fare su un progetto fermo su un commit.
