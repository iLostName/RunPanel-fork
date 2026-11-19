[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/environments.md)

---

# Staging e anteprime delle pull request

Un progetto da GitHub può avere degli **ambienti**: progetti fratelli che eseguono il suo codice da un altro branch. Lo **Staging** segue un branch suo, e ogni pull request aperta può avere la sua **anteprima**. Ogni ambiente è un progetto a tutti gli effetti — il suo container, la sua cartella, la sua porta, il suo indirizzo, le sue risorse — collegato alla produzione:

- **segue i permessi della produzione**: chi può gestire la produzione gestisce i suoi ambienti, e un permesso dato sull'ambiente stesso non conta ([Utenti e permessi](users.md));
- **eredita le variabili della produzione**, sotto le sue;
- **non riceve mai i database della produzione**, a meno di sceglierli esplicitamente;
- **non cambia mai la produzione**: il codice passa dallo staging alla produzione solo con **Promuovi in produzione**.

La pagina del progetto mostra gli ambienti come un selettore in alto: **Produzione**, **Staging** e una voce per anteprima (**PR #12**), ognuna con il suo stato.

## Staging

### Crearlo

Dalla pagina della produzione, **Altro › Crea staging** (serve poter gestire la produzione, più i permessi **Creare progetti** e **Accesso all'host**, come per Duplica). In un solo passo il pannello crea `<nome> (staging)` con:

- lo stesso repository, tipo di app, contratto di deploy e risorse, e lo stesso accesso di rete, avvio automatico, riavvio pianificato e deploy automatico della produzione;
- un altro branch: `staging` o `develop`, quello che il repository ha (mai quello della produzione: due ambienti sullo stesso branch distribuirebbero ogni push due volte);
- una sua porta (la prima libera) e, quando si può proporre, un suo indirizzo: `negozio-staging.esempio.it` accanto a `negozio.esempio.it` sullo stesso dominio, oppure un indirizzo di prova sslip.io;
- un suo webhook, registrato se la produzione ha il deploy automatico.

Non vengono copiati: le cartelle montate (due container non devono scrivere nella stessa cartella dell'host), le attività pianificate, i database collegati.

### Variabili

Lo staging riceve le variabili e i gruppi condivisi della produzione, e **vince quello che imposti sullo staging**: le sue variabili, poi i gruppi che collega, sopra tutto ciò che eredita. **Variabili › Cosa riceve l'app** dice da dove arriva ognuna (*produzione «Negozio»*, *gruppo «smtp» di «Negozio»*).

Una variabile ereditata che legge un **database della produzione** (`${{ db.negozio.main.url }}`, direttamente o attraverso un gruppo) **non arriva**: la scheda Variabili la elenca con il motivo, e il deploy dello staging prosegue senza. Nemmeno i collegamenti ai database della produzione vengono ereditati. Per dare dati allo staging collegagli un database suo; per usare davvero quelli della produzione, spunta **Usa i database di produzione** quando lo crei (il dialog spiega cosa comporta) oppure scrivi il riferimento nelle variabili dello staging.

### Promuovi in produzione

Sulla pagina dello staging, **Promuovi in produzione** apre una conferma con:

- il commit che lo staging **esegue** (il suo deploy attivo, non l'ultimo commit del branch), con autore e data;
- le variabili che i due ambienti non hanno in comune, solo per nome: prima quelle che mancano in produzione — le più pericolose per un'app promossa — poi quelle con un valore diverso, poi quelle solo della produzione;
- come la produzione lo riceverà.

Confermando, quel commit esatto viene distribuito in produzione con il deploy della produzione: le sue impostazioni, le sue variabili, il ritorno automatico alla versione precedente e il deploy senza interruzioni. La produzione resta poi **ferma su quel commit** (*Fermo su …*), così il prossimo push sul suo branch non annulla la promozione; **Torna all'ultimo commit** la sblocca. Se lo staging è cambiato tra la conferma e il clic, la promozione viene rifiutata e il dialog lo rilegge.

### Eliminare

Eliminare lo staging (Impostazioni › Zona pericolosa) non tocca la produzione. La produzione non si può eliminare finché ha ambienti: il dialog li elenca e chiede di spuntare una casella per eliminarli insieme (`DELETE /api/projects/{id}?environments=delete`).

## Anteprime delle pull request

### Attivarle

**Impostazioni › Anteprime**, sulla produzione (serve poterla gestire, più **Creare progetti**, **GitHub** e **Accesso all'host**: le anteprime creano progetti da sole). Spente di default, e solo per un repository GitHub i cui eventi arrivano al pannello:

- con il **webhook**, il pannello lo riscrive per ricevere anche le pull request, e non le attiva se GitHub non lo accetta;
- con il **Controllo nuovi commit** chiede a GitHub le pull request aperte con lo stesso intervallo; serve un token GitHub collegato.

Impostazioni: quante anteprime possono essere accese insieme (3 di default), dopo quanti giorni senza attività si fermano (7), l'indirizzo, e se scrivere lo stato del commit sulla pull request.

### Cosa succede

- **Una pull request aperta, riaperta o con un nuovo push** verso il branch della produzione: la sua anteprima viene creata o ridistribuita, ferma sul commit di testa della pull request, come `<nome> · PR #12`.
- **Indirizzo**: `pr-12.<dominio>` su un dominio del pannello con il record jolly (vedi [Domini](domains.md)), altrimenti un indirizzo di prova `pr-12-<progetto>.<ip>.sslip.io` (solo HTTP).
- **Variabili**: quelle dello staging se la produzione ne ha uno, altrimenti quelle della produzione, più le **Variabili delle anteprime** (nella stessa sezione), sopra tutto ciò che è ereditato. Mai i database della produzione, come sopra.
- **Chiusa o unita**: l'anteprima viene eliminata con i suoi container, le sue cartelle, il suo indirizzo e i suoi database.
- **Limiti**: oltre il massimo si ferma l'anteprima inattiva da più tempo, e l'elenco lo dice. Quella senza attività per i giorni impostati viene fermata da un controllo orario. Le anteprime girano su questo server accanto alla produzione: l'elenco mostra quante sono accese e quanta memoria e CPU usano in tutto.
- **Le pull request da un fork non partono mai da sole**: eseguirebbero codice di altri su questo server, con le variabili delle anteprime. L'elenco le mostra come **Da approvare**; **Approva** distribuisce esattamente il commit mostrato, e ogni nuovo push va approvato di nuovo.
- **Stato del commit** (facoltativo): `runpanel/preview` con l'indirizzo, in attesa durante il deploy, poi riuscito o non riuscito. Solo se il token salvato può scrivere lo stato dei commit ("Commit statuses: Read and write", o lo scope classico `repo:status`); altrimenti si salta e l'elenco dice perché.

La pagina del progetto elenca le anteprime sotto la **Panoramica** della produzione con numero, titolo, autore, commit, stato e indirizzo, e **Apri**, **Ridistribuisci**, **Ferma**, **Elimina**. Eliminare un'anteprima a mano non chiude la pull request: il suo prossimo push la ricrea. Spegnere le anteprime le elimina tutte.

## Cosa non c'è ancora

- Gli ambienti sono di un solo livello: staging e anteprime della produzione, non ambienti di un ambiente.
- Lo staging serve una sorgente GitHub: un archivio ZIP non ha branch.
- Le anteprime sono per numero di pull request: un branch senza pull request non ne ha.

## API

`GET/POST /api/projects/{id}/environments`, `GET/POST /api/projects/{id}/promote`, `GET/PUT /api/projects/{id}/previews`, `GET/PUT /api/projects/{id}/previews/env`, `POST/DELETE /api/projects/{id}/previews/{previewId}`. I dettagli sono nel catalogo che legge un client MCP ([AI e MCP](mcp.md)).
