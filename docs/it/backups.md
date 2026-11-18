[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/backups.md)

---

# Backup e ripristino

Una *policy* dice cosa salvare, dove, ogni quanto e quanti archivi tenere. Policy, destinazioni, archivi e ripristini appartengono al server su cui stanno: con [più server](multi-server.md) ognuno ha i propri, e un archivio si decifra solo con la chiave del server che l'ha preso.

Chi non è proprietario salva e ripristina solo i progetti e i servizi che gestisce, uno alla volta (vedi [Utenti e permessi](users.md)).

## Cosa si può salvare

| Target | Cosa comprende |
|---|---|
| Un servizio | il dump per intero (`pg_dumpall`, ruoli compresi, per Postgres) o dei database che scegli |
| Tutti i servizi | anche quelli che creerai dopo |
| Un progetto | a scelta: configurazione, volumi Docker, repository |
| Tutti i progetti | stesso criterio, anche quelli futuri |
| Il pannello | lo store di RunPanel, con o senza la chiave di cifratura |

Ogni dump gira **dentro il container a cui appartiene**, così client e server sono della stessa versione. Lo store SQLite del pannello viene catturato con `VACUUM INTO` e verificato con `PRAGMA integrity_check`; lo store Postgres con un `pg_dump` in formato custom, in un container della stessa major.

Un progetto caricato da ZIP include sempre il repository. La copia del repository salta `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` e simili, e il `.env` scritto dal pannello.

## I volumi dei progetti

Con **volumi Docker** tra le cose da salvare, un progetto porta nell'archivio ogni suo volume (`projects/<slug>/volumes/<volume>.tar.gz`):

- quelli creati da RunPanel con l'etichetta `runpanel.project=<slug>`, per esempio il volume di un database collegato;
- quelli dello **stack Compose** del progetto, riconosciuti dal nome di progetto Compose `runpanel-<slug>` esatto (`runpanel-shop` non prende i volumi di `runpanel-shop2`).

Un volume `external: true` non appartiene allo stack e non entra nel backup: va salvato a parte. Il log elenca i volumi trovati per ogni progetto; se Docker non risponde, il progetto compare come saltato con il motivo.

### Coerenza della copia

Copiare un volume mentre l'app ci scrive può dare un database che si ripristina senza errori ed è rotto. Nella scheda **Impostazioni** del progetto, sezione **Backup dei volumi**, si sceglie cosa succede durante la copia:

| Modalità | Cosa fa |
|---|---|
| **Metti in pausa chi scrive** (predefinita) | `docker pause` sui soli container del progetto che montano il volume in scrittura, per il solo tempo della lettura. La copia equivale a un'interruzione di corrente, da cui SQLite (anche in WAL) e Postgres ripartono da soli. |
| **Copia a caldo** | Nessuna pausa. La copia può essere incoerente, e log e manifest lo dicono. |

Per tenere breve la pausa, il volume viene scritto su disco non compresso e compresso dopo, a container ripresi. Se lo spazio libero (oltre una riserva di 2 GB) non basta, si comprime durante la pausa al livello più veloce; se nemmeno così ci sta, il volume viene rifiutato prima di fermare qualcosa. Una pausa oltre i 10 minuti viene interrotta, i container ripresi e il volume segnato come non salvato. I container in sola lettura non si fermano; un container di un altro progetto che scrive nello stesso volume non viene toccato e la copia viene segnata come non garantita.

Se il pannello si ferma durante una pausa, i container vengono ripresi al riavvio o al backup successivo. Un container in pausa non genera notifiche di crash.

**Comando prima del backup.** Per i progetti Compose, un comando da eseguire una volta per backup in un servizio dello stack, prima di copiare i volumi (`sh -c`, timeout da 5 a 3600 secondi): per esempio un `.backup` di SQLite o un `pg_dump` dentro il volume. Se fallisce con la pausa attiva, il backup prosegue; se fallisce con la copia a caldo e qualcuno scrive, il volume non viene salvato.

### Esclusioni

Sempre da **Backup dei volumi**, per ogni volume si escludono percorsi relativi alla sua radice, uno per riga: `trades` esclude quella cartella e il suo contenuto, non `reports/trades`. Niente `..`, niente `/` iniziale, niente caratteri jolly. Il log (in italiano) riporta ogni esclusione con la sua dimensione, o "non presente nel volume":

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

## Dove finiscono

- **Disco locale**: sempre `data/backups/archives/<anno>/<mese>`, file 0600. Creato al primo avvio; il percorso non si cambia. Un archivio che sta solo sulla macchina che protegge si perde con lei: per questo c'è S3.
- **S3-compatibile**: Amazon S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi, e MinIO o un server tuo. Scegliendo il servizio si riempiono endpoint e indirizzamento; di solito resta da cambiare solo la regione. Bucket, chiavi e un prefisso facoltativo completano; la configurazione è cifrata. `https://` ovunque, `http://` solo verso un indirizzo privato. L'oggetto si chiama `<prefisso>/<file>`, caricato in un'unica richiesta: su AWS vale il limite di 5 GB per oggetto. Dopo il caricamento il pannello rilegge la dimensione conservata dal bucket, e se non torna il backup fallisce.

Una destinazione nuova, o una che modifichi, viene **provata prima di essere salvata**: un oggetto di prova viene scritto, riletto e cancellato. Se la verifica non riesce non si salva niente e si dice perché; **Salva comunque** serve per un bucket che da qui, apposta, non si raggiunge. **Verifica** nella lista ripete la stessa prova quando vuoi. Un bucket in cui la chiave non può cancellare viene accettato con un avviso: è una protezione voluta contro i ransomware, ma la retention non potrà togliere gli archivi vecchi.

Gli errori di S3 sono spiegati in italiano, con causa e soluzione: access key inesistente, secret sbagliata, bucket che non esiste, permesso mancante (con le azioni AWS da concedere), bucket in un'altra regione (con quella giusta, quando il servizio la dice), orologio del server sballato, spazio esaurito, oggetto troppo grande, endpoint che non si risolve, rifiuta la connessione, non risponde in tempo, ha un certificato scaduto, non riconosciuto o per un altro nome, o parla HTTP semplice su quella porta. Codice e messaggio del servizio sono nel log del backup e, in modalità esperto, sotto l'esito della verifica.

Dalla lista il proprietario può anche:

- **Modifica**: nome, endpoint, regione, bucket, chiavi, prefisso. La secret non viene mai mostrata: lasciala vuota per tenere quella salvata. Il tipo non cambia. Se ci sono già archivi, cambiare bucket, endpoint o prefisso fa sì che il pannello li cerchi nel posto nuovo: il modulo lo dice.
- **Imposta come predefinita**: dove vanno il backup notturno, le nuove pianificazioni e il backup di sicurezza di ogni ripristino. Può anche spostarci tutte le pianificazioni esistenti; gli archivi già fatti restano dove sono e si possono ancora ripristinare.
- **Elimina**: rifiutato finché una pianificazione ci scrive (il dialog la nomina e la apre) e per l'ultima destinazione rimasta. Se contiene archivi serve il proprietario e il nome della destinazione scritto per intero: i file restano dove sono, ma il pannello non li conosce più (niente ripristino, download o retention). Se era la predefinita, il suo posto lo prende la destinazione rimasta più vecchia.

Gli altri account con il permesso `backup` possono aggiungere destinazioni, verificarle, rinominarle ed eliminarne una vuota, ma non cambiare dove scrive una esistente né quale sia la predefinita: entrambe le cose sposterebbero gli archivi di tutti, quelli del proprietario compresi.

Ogni archivio viene costruito prima in `data/backups/staging`, anche per S3: serve spazio libero in locale, e il backup si interrompe se scende sotto 2 GB.

L'archivio è uno zip con `manifest.json`, `LEGGIMI.txt` e `checksums.txt` in formato `sha256sum -c` (per i dump e i volumi; i file del repository non sono elencati). Le variabili dei progetti e le credenziali dei servizi sono cifrate con la chiave di questo server; includere la chiave stessa è una scelta esplicita a parte. Il resto (dump, volumi, codice) è in chiaro, a meno di cifrare l'archivio intero con una password: vedi qui sotto.

## Cifratura con una password

Con la cifratura attiva, ogni archivio esce dal server cifrato per intero con la **password dei backup**: chi ne ha una copia — un bucket, un disco portato via, un download dimenticato — senza la password non legge niente, nemmeno i nomi dei file. Senza, vale quello che c'è sopra: sono cifrate solo variabili e credenziali, con la chiave del pannello.

- **Una password per server**, in **Backup › Cifratura degli archivi**. La imposta il proprietario; gli altri account vedono se è attiva. Vale per ogni nuovo archivio: le pianificazioni, **Esegui backup ora** e i backup di sicurezza presi prima di un ripristino, che vanno sulla destinazione predefinita, spesso un bucket. Per questo è una per server e non una per pianificazione: un interruttore per pianificazione lascerebbe in chiaro proprio quei due.
- Le pianificazioni esistenti non cambiano finché non imposti la password. Creando una pianificazione, il modulo la propone subito sotto la destinazione, con un avviso quando gli archivi andrebbero fuori dal server in chiaro.
- La password si scrive due volte, ha almeno 12 caratteri e niente spazi all'inizio o alla fine, e si conferma di averla salvata altrove. **Non si può rileggere**: **Verifica la password** dice solo se quella che hai salvato è giusta.
- Il pannello la conserva, cifrata con la sua chiave, e apre da solo i propri archivi: verifica, ripristino e download funzionano come prima. **Cambia password** vale dal prossimo archivio, e le password precedenti restano: gli archivi che hanno cifrato si aprono ancora qui. **Disattiva** riporta in chiaro i prossimi archivi; quelli già cifrati restano cifrati.
- Se la chiave del pannello cambia e la password salvata non si decifra più, i backup **non partono** finché non la imposti di nuovo: meglio nessun archivio che uno in chiaro fuori da qui. Il pannello lo dice nella pagina Backup, e la notifica di backup fallito arriva come sempre.
- Un archivio cifrato si chiama `….zip.enc`, si scarica così com'è (cifrato) e nella cronologia ha un lucchetto; la pagina del backup dice con quale password, per data.

> **Se perdi la password, perdi i backup che stanno fuori da questo server.** Nessuno, RunPanel compreso, può recuperarla. Tienila in un gestore di password, non sul server che protegge. Se l'hai cambiata, tieni anche quelle di prima finché esistono archivi cifrati con loro: la data della password è scritta in chiaro nell'archivio, e il pannello la mostra quando la chiede.

Le password stanno nello store del pannello. Ripristinare lo store rimette quelle che c'erano il giorno di quel backup: gli archivi cifrati con una password impostata dopo, da lì in poi, la chiedono. Lo stesso vale per uno store portato su un server con un'altra chiave.

### Su un altro server

**Ripristina da un archivio** accetta anche i `.zip.enc`. Uno cifrato da questo pannello si apre da solo. Uno di un altro server si ferma su **serve la password**: scrivi quella in uso il giorno del backup, il pannello la prova sull'archivio (se è sbagliata lo dice subito), poi lo controlla e lo ripristina come gli altri. La password resta con l'archivio caricato, cifrata con la chiave del pannello, e viene cancellata con lui. Lo stesso vale per un backup della lista cifrato con una password che il pannello non ha più, per esempio dopo aver ripristinato lo store di un altro pannello: il dialog del ripristino la chiede.

Dall'API: `POST /api/backups/uploads/{id}/unlock` con `{ "password": "…" }` per un archivio caricato, e il campo `password` in `POST /api/backups/restore` per un backup della lista.

### Senza il pannello

Il `LEGGIMI.txt` dell'archivio sta dentro la cifratura, per questo le istruzioni sono qui. [`scripts/decrypt-backup.mjs`](../../scripts/decrypt-backup.mjs) è un file solo, senza dipendenze: serve Node 18 o successivo, non il pannello né il resto del repository. Copialo accanto all'archivio e:

```sh
node decrypt-backup.mjs runpanel-20261118-030000-backup-notturno-abc123.zip.enc
# chiede la password senza mostrarla e scrive runpanel-…-abc123.zip accanto

node decrypt-backup.mjs --check archivio.zip.enc     # controlla password e archivio, senza scrivere niente
node decrypt-backup.mjs archivio.zip.enc altro.zip   # sceglie il nome dello zip
node decrypt-backup.mjs --password-file pw.txt archivio.zip.enc
RUNPANEL_BACKUP_PASSWORD='…' node decrypt-backup.mjs archivio.zip.enc
```

Ogni blocco viene verificato prima di essere scritto, e lo zip prende il suo nome solo alla fine (fino ad allora è `….zip.part`): una password sbagliata (codice di uscita 2), un archivio danneggiato o troncato (codice 1) non lasciano mai uno zip a metà. Quello che ne esce è lo zip di sempre, con `LEGGIMI.txt` e i comandi per ripristinare a mano; caricato nel pannello, si ripristina anche così.

### Il formato

Per chi vuole leggerlo con altri strumenti: un'intestazione — `RPBKENC`, la versione (1 byte), la lunghezza (uint32 big-endian) e un JSON con i parametri — poi lo zip a blocchi di 64 KiB, ognuno cifrato con AES-256-GCM e seguito dal suo tag di 16 byte. La chiave viene dalla password, normalizzata NFC, con scrypt (N = 2^17, r = 8, p = 1, un sale casuale di 32 byte per ogni archivio) e HKDF-SHA256. Il nonce è il numero del blocco, e i dati associati legano a ogni blocco lo sha256 dell'intestazione, il suo numero e se è l'ultimo: un blocco modificato, spostato o ripetuto, un file troncato o allungato vengono rifiutati. In chiaro restano solo i parametri, un identificativo della password e la data in cui è stata impostata. I dettagli sono in [`services/backup/archive-crypto.ts`](../../services/backup/archive-crypto.ts).

## Pianificazione e retention

- **Pianificazione**: si sceglie a parole — ogni N ore (1, 2, 3, 4, 6, 8 o 12, a partire da mezzanotte), ogni giorno, ogni settimana nei giorni che spunti, ogni mese in un giorno — a un'ora e un minuto. L'espressione cron a cinque campi (o `@daily` e simili) è in **Avanzate**; un'espressione che nessuna di queste forme sa dire senza cambiarne il significato (per esempio `0 3,15 * * *`) viene mostrata com'è, con quella sezione aperta. I giorni 29–31 non esistono in tutti i mesi, e cron salta quei mesi: l'editor lo dice. Non sono supportati secondi, `L`, `W`, `#` e `@reboot`. **Solo su richiesta** non ha orario.
- **Fuso orario**: si sceglie dall'elenco completo, cercando per città. **Come il pannello** (quello di default) è il fuso impostato in **Impostazioni › Generale**, o UTC se non ce n'è uno — mai quello dell'host. Gli orari si leggono in quel fuso anche quando cambia l'ora legale: un orario che quella notte non esiste parte al primo minuto che esiste, uno che capita due volte parte una volta sola.
- **Un backup alla volta**, e nessuno durante un ripristino. Un'esecuzione pianificata che trova il sistema occupato viene saltata, non accodata. Un'esecuzione persa a pannello spento viene recuperata solo entro il doppio dell'intervallo, o 24 ore se di più.
- **Retention**: numero (1–1000), età (1–3650 giorni) e dimensione totale (almeno 1 MB), insieme. Viene applicata dopo un'esecuzione riuscita, e l'archivio valido più recente non viene mai tolto. Un backup fatto a mano fuori da ogni pianificazione (vedi la pagina del database, più sotto) non ha retention: resta finché non lo elimini.

## Integrità

Ogni backup registra lo sha256 dell'archivio, e `checksums.txt` quello di ogni dump e volume. **Verifica integrità**, nella pagina di un backup, rilegge l'archivio in background:

- sul disco locale, per intero: lo sha256 dell'archivio, poi per ogni file il CRC-32, lo sha256 dove è elencato, e ogni `.gz` decompresso fino in fondo — un dump troncato ha comunque un checksum valido di se stesso troncato;
- in un bucket, scorrendolo una volta per calcolarne lo sha256, senza salvarlo: dimostra che i byte sono quelli scritti; i singoli file vengono controllati di nuovo prima di ogni ripristino.

Un archivio cifrato si controlla allo stesso modo: lo sha256 è quello del file cifrato, e i file vengono letti attraverso la decifratura, che verifica ogni blocco. Se il pannello non ha più la sua password, controlla lo sha256 e dice che il contenuto non si è potuto aprire.

L'esito resta sul backup (uno scudo nella cronologia), con il file che non va e il motivo in modalità esperto. Un archivio danneggiato non si ripara: fai un nuovo backup.

## Ripristino

Il ripristino è un solo dialog. È tutto selezionato; ogni voce dice, in una riga, cosa succede a quello che c'è adesso, e dove va — lo stesso servizio o progetto di default, oppure un altro dello stesso tipo. Per confermare si scrive il nome della prima voce che verrà sovrascritta.

Prima di fermare, copiare o sovrascrivere qualsiasi cosa:

1. Un archivio su S3 viene scaricato nella cartella di lavoro del ripristino (serve lo spazio libero, più la riserva di 2 GB), con lo sha256 calcolato durante il download e confrontato con quello registrato quando è stato scritto; se non coincide il ripristino si ferma.
2. I file che il ripristino userà — solo quelli — vengono controllati come fa **Verifica integrità**. Se uno è danneggiato, o la password di un archivio cifrato manca o è sbagliata, il ripristino si ferma senza aver toccato niente. Un archivio cifrato non viene mai decifrato per intero su disco: come per uno zip, il ripristino estrae solo i file che gli servono nella sua cartella di lavoro, che viene cancellata alla fine.
3. Un **backup di sicurezza** delle destinazioni va sulla destinazione predefinita (etichetta "Sicurezza pre-ripristino", mai tolto dalla retention, si cancella a mano). Se fallisce il ripristino si ferma, a meno che tu non abbia spuntato **Procedi anche senza backup di sicurezza**.

- **Volume**: il progetto si ferma; i suoi container rimasti accesi vengono fermati e riavviati alla fine, mentre un container di un altro progetto che usa il volume blocca il ripristino. I percorsi esclusi restano come sono. Un volume Compose che non esiste più si ricrea con un deploy, poi si ripete il ripristino.
- **Database**: se il servizio appartiene a un progetto acceso, il progetto si ferma e riparte alla fine. Su Postgres il ripristino rifiuta di partire se resta aperta una connessione, perché lo script cancella i database in ordine e si fermerebbe a metà. MySQL e Mongo sovrappongono il dump a quello che c'è. Un dump completo MySQL o Mongo porta con sé gli utenti del server di origine: su un altro servizio li sostituisce, e il ripristino finisce in errore dicendo che le credenziali salvate non valgono più, con i dati già al loro posto.
- **Repository**: i file vengono sovrascritti, quelli in più non vengono cancellati. Durante un deploy il ripristino rifiuta.
- **Configurazione di un progetto**: il progetto deve esistere ancora. È cifrata con la chiave del pannello che l'ha scritta: dall'archivio di un altro pannello non si legge, e il ripristino lo dice.
- **Store del pannello (SQLite)**: non viene ripristinato a caldo. Il database viene messo da parte ed entra in servizio al riavvio successivo, con il precedente conservato accanto. La chiave di cifratura non viene rimessa: se serve, va copiata a mano.
- **Store del pannello (Postgres)**: il pannello rifiuta; il comando `pg_restore` da eseguire a pannello fermo è nel `manifest.json`.

Il ripristino non confronta le versioni dei motori: un dump di una major ripristinato su un'altra viene accettato e fallisce a metà, con il backup di sicurezza già preso.

### Da un archivio caricato

**Ripristina da un archivio**, nella pagina Backup, serve per un archivio che non è nella lista: uno scaricato in precedenza, o i backup di un server che non c'è più. Solo per il proprietario.

1. **Carica** lo `.zip`, o il `.zip.enc` se è cifrato (trascinalo o sceglilo). Sale a pezzi da 8 MB, ognuno ritentato da solo, così un archivio grande sopravvive a una connessione instabile e il reverse proxy non ha bisogno di limiti particolari. Prima si controlla che ci sia spazio per l'intero archivio più la riserva di 2 GB.
2. **Controllo**: quando è arrivato tutto, l'archivio viene controllato per intero — deve contenere il `manifest.json` di RunPanel, e ogni file supera i controlli di sopra. Un archivio danneggiato o che non è di RunPanel viene rifiutato con il motivo. Un archivio cifrato su un altro server prima chiede la sua password (vedi [Su un altro server](#su-un-altro-server)).
3. **Ripristino**: lo stesso dialog di un backup della lista. Le voci di un altro pannello nominano progetti e servizi che questo non ha: ognuna chiede dove andare, e devono esistere già qui.

Un archivio caricato resta sul server per 24 ore dall'ultimo uso, così un ripristino non riuscito si può ripetere senza ricaricarlo; dalla pagina si può eliminare prima.

## Nella pagina del database

La pagina di un database ha un riquadro **Backup**: le pianificazioni che lo salvano (quando e dove), i suoi archivi recenti con il segno dell'integrità, e **Ripristina…** limitato a quel database, con quel database come unica destinazione. Se nessuna pianificazione attiva lo salva propone **Salvalo ogni notte** (alle 03:00, sulla destinazione predefinita, conservando gli ultimi 7). Il proprietario ha anche **Esegui backup ora**, un backup fuori da ogni pianificazione e quindi fuori dalla retention.
