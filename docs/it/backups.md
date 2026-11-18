[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/backups.md)

---

# Backup e ripristino

Una *policy* dice cosa salvare, dove — una destinazione o più, con una copia dello stesso archivio in ognuna —, ogni quanto e quanti archivi tenere. Policy, destinazioni, archivi e ripristini appartengono al server su cui stanno: con [più server](multi-server.md) ognuno ha i propri, e un archivio si decifra solo con la chiave del server che l'ha preso.

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

Un progetto caricato da ZIP include sempre il repository. La copia del repository salta `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` e simili, e il `.env` scritto dal pannello. Per un progetto nativo con le [cartelle per versione](deploy.md#tornare-alla-versione-precedente) comprende anche i file che l'app ha creato nella versione che gira e che passeranno alla cartella del progetto solo al deploy successivo.

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

- **Disco locale**: `data/backups/archives/<anno>/<mese>`, file 0600. Creato al primo avvio. Il proprietario può aggiungere altre destinazioni locali con una **cartella** propria (in **Avanzate** del modulo), per esempio un secondo disco o un NAS montato: percorso completo, fuori dalla cartella dei dati del pannello, che esista già e in cui l'utente del pannello possa scrivere; gli archivi vanno in `<cartella>/<anno>/<mese>`. La cartella non si cambia dopo: per scrivere altrove si aggiunge una destinazione nuova. Se la cartella sta sullo stesso disco dei dati del pannello, **Verifica** riesce ma lo segnala: è anche quello che succede quando il secondo disco non è montato e si scrive nel suo punto di montaggio vuoto. Un archivio che sta solo sulla macchina che protegge si perde con lei: per questo c'è S3.
- **S3-compatibile**: Amazon S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi, e MinIO o un server tuo. Scegliendo il servizio si riempiono endpoint e indirizzamento; di solito resta da cambiare solo la regione. Bucket, chiavi e un prefisso facoltativo completano; la configurazione è cifrata. `https://` ovunque, `http://` solo verso un indirizzo privato. L'oggetto si chiama `<prefisso>/<file>`, caricato in un'unica richiesta: su AWS vale il limite di 5 GB per oggetto. Dopo il caricamento il pannello rilegge la dimensione conservata dal bucket, e se non torna il backup fallisce.
- **Telegram**: un canale privato creato dal pannello, o i tuoi Messaggi salvati, attraverso il tuo account. Gli archivi più grandi di un file Telegram vengono divisi in parti. Vedi [Telegram](#telegram) qui sotto.
- **Server SFTP o NAS**: Synology, QNAP, una Storage Box di Hetzner, un altro server; con una chiave generata dal pannello. Vedi [Server SFTP o NAS](#server-sftp-o-nas).
- **WebDAV**: Nextcloud, ownCloud, il WebDAV di un NAS, Koofr, pCloud. Vedi [WebDAV](#webdav).
- **Google Drive, OneDrive, Dropbox** e gli altri servizi di rclone, se rclone è installato sul server. Vedi [rclone](#rclone-google-drive-onedrive-dropbox-e-gli-altri).
- **Server RunPanel collegato**: un altro server del tuo [cluster](multi-server.md), che tiene le copie nella sua cartella dei dati, senza un account esterno. Due server possono farsi da copia a vicenda. Vedi [Un altro server RunPanel](#un-altro-server-runpanel).

Una destinazione nuova, o una che modifichi, viene **provata prima di essere salvata**: un oggetto di prova viene scritto, riletto e cancellato. Se la verifica non riesce non si salva niente e si dice perché; **Salva comunque** serve per un bucket che da qui, apposta, non si raggiunge. **Verifica** nella lista ripete la stessa prova quando vuoi. Un bucket in cui la chiave non può cancellare viene accettato con un avviso: è una protezione voluta contro i ransomware, ma la retention non potrà togliere gli archivi vecchi.

Gli errori di S3 sono spiegati in italiano, con causa e soluzione: access key inesistente, secret sbagliata, bucket che non esiste, permesso mancante (con le azioni AWS da concedere), bucket in un'altra regione (con quella giusta, quando il servizio la dice), orologio del server sballato, spazio esaurito, oggetto troppo grande, endpoint che non si risolve, rifiuta la connessione, non risponde in tempo, ha un certificato scaduto, non riconosciuto o per un altro nome, o parla HTTP semplice su quella porta. Codice e messaggio del servizio sono nel log del backup e, in modalità esperto, sotto l'esito della verifica.

Dalla lista il proprietario può anche:

- **Modifica**: nome, endpoint, regione, bucket, chiavi, prefisso. La secret non viene mai mostrata: lasciala vuota per tenere quella salvata. Il tipo non cambia. Se ci sono già archivi, cambiare bucket, endpoint o prefisso fa sì che il pannello li cerchi nel posto nuovo: il modulo lo dice.
- **Imposta come predefinita**: dove vanno il backup notturno, le nuove pianificazioni e il backup di sicurezza di ogni ripristino. Può anche spostarci tutte le pianificazioni esistenti: diventa la loro destinazione principale (al posto della vecchia, o portata in cima se ci tenevano già una copia), e le altre copie restano; gli archivi già fatti restano dove sono e si possono ancora ripristinare.
- **Elimina**: rifiutato finché una pianificazione ci scrive, come principale o come copia (il dialog la nomina e la apre), mentre una copia è in viaggio verso di lei, e per l'ultima destinazione rimasta. Se contiene archivi serve il proprietario e il nome della destinazione scritto per intero: i file restano dove sono, ma il pannello non li conosce più (niente ripristino, download o retention da lì). I backup che hanno una copia anche altrove si ripristinano da quella. Se era la predefinita, il suo posto lo prende la destinazione rimasta più vecchia.

Gli altri account con il permesso `backup` possono aggiungere destinazioni, verificarle, rinominarle ed eliminarne una vuota, ma non cambiare dove scrive una esistente né quale sia la predefinita: entrambe le cose sposterebbero gli archivi di tutti, quelli del proprietario compresi.

Ogni archivio viene costruito prima in `data/backups/staging`, anche per S3, Telegram e le altre destinazioni fuori dal server: serve spazio libero in locale, e il backup si interrompe se scende sotto 2 GB.

### Telegram

Gli archivi vanno su Telegram attraverso il **tuo account**, non un bot: un bot carica al massimo 50 MB, un account fino a 2 GB per file, 4 GB con Telegram Premium.

**Le chiavi.** Telegram chiede che ogni programma usi le proprie, e il pannello non ne ha di sue:

1. Apri [my.telegram.org](https://my.telegram.org) e accedi con il numero dell'account che terrà i backup: il codice arriva nell'app di Telegram.
2. Scegli **API development tools** e crea un'app: nome e titolo a piacere (per esempio *RunPanel*), piattaforma *Other*; URL e descrizione possono restare vuoti.
3. In **Backup › Destinazioni › Aggiungi › Telegram** copia **api_id** e **api_hash**.

**Il collegamento.** Con il **codice QR**: sul telefono apri Telegram › Impostazioni › Dispositivi › Collega dispositivo e inquadralo (si rinnova da solo ogni 30 secondi). Oppure con il **numero di telefono**: Telegram manda un codice nell'app o per SMS. Se l'account ha la verifica in due passaggi, il pannello chiede anche quella password. Il collegamento resta in sospeso sul server, dieci minuti per completarlo e venti per salvare; la sessione che ne esce finisce solo nella configurazione cifrata della destinazione e non passa mai dal browser. Un collegamento abbandonato viene chiuso, anche su Telegram. Avviarne uno richiede gli stessi permessi che servono per aggiungere una destinazione; i tentativi sono limitati, perché Telegram blocca per ore un account che chiede troppi codici.

**Dove.** Un **canale privato** che il pannello crea per questo server quando salvi («RunPanel · backup di» seguito dal nome del server, si può cambiare), oppure i tuoi **Messaggi salvati**. La chat si sceglie creando la destinazione e poi non cambia: gli archivi sono lì. Non eliminare né modificare a mano i loro messaggi: il pannello li ritrova dal numero del messaggio.

**Le parti.** Un file su Telegram ha al massimo 4000 pezzi da 512 KiB, 8000 con Premium: 2000 e 4000 MiB. A ogni backup il pannello legge dall'account se è Premium — un abbonamento può scadere — e dalla configurazione di Telegram il numero di pezzi, e tiene un margine di 20 MiB: parti fino a 1980 MiB, o 3980 MiB con Premium. Un archivio più grande viene diviso in parti, caricate come documenti separati (`….zip.enc.001`, `.002`…), lette dal file dell'archivio senza copie temporanee. Ogni parte ha una didascalia con il nome dell'archivio, la parte («Parte 2 di 3»), la dimensione e lo sha256. Il riferimento salvato con il backup elenca i messaggi in ordine: ripristino, verifica e download riscaricano le parti in sequenza e le ricompongono nell'archivio di sempre, controllando lo sha256 di ognuna. Senza il pannello si scaricano le parti dalla chat e si uniscono con `cat nome.zip.enc.* > nome.zip.enc` (su Windows `copy /b nome.zip.enc.001 + nome.zip.enc.002 nome.zip.enc`).

Nel log del backup ci sono l'account, se è Premium, in quante parti va l'archivio, l'avanzamento e le attese che Telegram chiede (FLOOD_WAIT): fino a 15 minuti il pannello aspetta e riprende da solo, oltre il backup fallisce e il successivo riprova. Una connessione caduta viene ritentata pezzo per pezzo. Se una parte non va su, quelle già caricate vengono cancellate: nella chat restano solo archivi interi. Dopo il caricamento il pannello rilegge da Telegram la dimensione di ogni parte, e se non torna il backup fallisce. **Verifica** collega l'account, dice se è Premium e quanto può essere grande una parte, poi scrive, rilegge e cancella un piccolo file nella chat.

**Sicurezza.**

- La sessione apre **tutto l'account**: chi la ottenesse potrebbe leggere e scrivere ogni chat. È cifrata con la chiave del pannello come ogni altro segreto e serve solo ai backup; se preferisci, usa un account Telegram dedicato. In Telegram › Impostazioni › Dispositivi compare come «RunPanel su» seguito dal nome del server: chiudendola da lì, il backup successivo fallisce con «Sessione chiusa dall'app di Telegram, o scaduta: ricollega l'account».
- Le chat cloud di Telegram **non sono cifrate end-to-end**: Telegram può leggere quello che carichi. Attiva la [cifratura con una password](#cifratura-con-una-password); quando è spenta, il modulo della destinazione la propone.
- Eliminare la destinazione chiude anche la sessione su Telegram; gli archivi restano nella chat.

**Ricollegare.** Con la sessione chiusa, **Modifica › Ricollega l'account** rifà il collegamento (lasciando vuoto l'api_hash resta quello salvato) e la vecchia sessione viene chiusa. Un altro account è accettato solo se raggiunge ancora gli archivi: per un canale deve esserne amministratore, per i Messaggi salvati la destinazione deve essere ancora vuota. Il proprietario ricollega, come per le chiavi di S3.

### Server SFTP o NAS

Un NAS (Synology, QNAP), una Storage Box di Hetzner, un secondo VPS: qualsiasi server che offra SFTP, anche **solo** SFTP, senza shell, come le Storage Box e molti NAS.

- **La chiave**: scegliendo questo tipo, il pannello genera una coppia di chiavi Ed25519 per la destinazione e mostra la chiave pubblica, con il pulsante per copiarla: è la riga da aggiungere a `.ssh/authorized_keys` dell'utente sul server. Il modulo dice come, per il tipo di server scelto: per un server Linux i due comandi da incollare, per una Storage Box `ssh-copy-id -p 23 -s`, per Synology e QNAP dove attivare SFTP e la cartella home degli utenti. La chiave privata non esce dal pannello: è salvata cifrata con la destinazione e scritta su disco (un file 0600 in `data/tmp`) solo finché ssh non ha fatto l'accesso. **Modifica › Genera una nuova chiave** la sostituisce. L'accesso con password non c'è: con l'`ssh` di sistema servirebbe un programma che la digiti al posto tuo, e una chiave dedicata è comunque più sicura.
- **L'impronta del server**: alla prima verifica riuscita il pannello mostra l'impronta della chiave del server (`SHA256:…`) e la salva. Da lì in poi un server che si presenta con un'altra chiave viene rifiutato: «si presenta con una chiave diversa da quella salvata alla prima connessione». Se hai reinstallato o sostituito il server, **Modifica › Dimentica l'impronta**, e la verifica successiva salva quella nuova. Cambiare server o porta la dimentica da sola. Una destinazione salvata senza verifica salva l'impronta al primo uso.
- **Il caricamento**: l'archivio viene scritto come `.<nome>.<casuale>.partial`, a blocchi in parallelo, scaricato sul disco del server (quando il server lo permette), controllato nella dimensione e solo allora rinominato. Una connessione interrotta lascia al massimo un `.partial`, mai un file che sembri un archivio completo. Per questo all'utente servono i permessi di scrivere e rinominare nella cartella; quello di eliminare serve alla retention (senza, la verifica passa con un avviso). Download a flusso, senza tenere l'archivio in memoria.
- **La cartella** è relativa alla cartella dell'utente, o assoluta (`/volume1/backup/runpanel`); viene creata se manca. Sui NAS la prima parte è una cartella condivisa che deve già esistere.
- Il pannello usa il programma `ssh` del sistema (OpenSSH) con il sottosistema SFTP, senza leggere `~/.ssh/config` e senza l'agent: se manca, il modulo lo dice (`sudo apt install openssh-client`).
- **La verifica** scrive, rinomina, rilegge ed elimina un file di prova, e dice lo spazio libero quando il server lo comunica. Gli errori sono spiegati: indirizzo che non esiste, porta chiusa o sbagliata, nessuna risposta, chiave non autorizzata (con i permessi giusti per `.ssh`), SFTP non attivo, algoritmi troppo vecchi, sulla porta risponde qualcos'altro, chiave del server cambiata, permesso mancante, disco o quota pieni, un `echo` nel `.bashrc` che rompe SFTP.

### WebDAV

Nextcloud, ownCloud, un NAS Synology con il pacchetto WebDAV Server, Koofr, pCloud o qualsiasi server WebDAV.

- Per Nextcloud e ownCloud bastano l'indirizzo del server e l'utente: il pannello compone `https://<server>/remote.php/dav/files/<utente>/` (si cambia in **Avanzate**). Per Koofr e pCloud l'indirizzo è già pronto; per gli altri si scrive per intero.
- **Password per app**: su Nextcloud si crea in **Impostazioni personali › Sicurezza › Dispositivi e sessioni › Crea nuova password per app**. Con la verifica in due passaggi attiva la password dell'account non funziona, e una password per app si revoca da sola, senza toccare l'account.
- `https://` ovunque, `http://` solo verso un indirizzo privato, come per S3. Utente e password vanno nei loro campi, non nell'indirizzo; la password non viene mai mostrata (vuota in **Modifica** = quella salvata).
- Il caricamento è un PUT a flusso verso un nome provvisorio (`.partial`); poi la dimensione viene controllata con PROPFIND e il file rinominato con MOVE. Un caricamento interrotto non lascia mai un file con il nome dell'archivio. Download a flusso (GET), eliminazione con DELETE.
- **Archivi grandi e reverse proxy**: se davanti al server c'è un reverse proxy (nginx, Apache, Cloudflare), può limitare la dimensione di una richiesta. Si vede in due modi: un errore 413, o la connessione che si chiude a metà caricamento. Nel secondo caso il pannello carica un file minuscolo per capire: se quello passa, dice che è quasi certamente il limite del proxy. Il limite si alza sul server: `client_max_body_size` in nginx, `LimitRequestBody` in Apache; il piano gratuito di Cloudflare si ferma a 100 MB per richiesta. Un caricamento lungo può incontrare anche il timeout del proxy (un 504: `proxy_read_timeout` in nginx).
- Gli errori sono spiegati: password non accettata (con dove crearne una per app), permessi, indirizzo sbagliato (con la forma giusta per Nextcloud), indirizzo che non è WebDAV, reindirizzamento (con l'indirizzo a cui rimanda), quota esaurita (507), archivio troppo grande (413), proxy (502, 504), oltre agli errori di rete e di certificato.

### rclone: Google Drive, OneDrive, Dropbox e gli altri

Con [rclone](https://rclone.org), se è installato sul server del pannello: un solo tipo di destinazione per Google Drive, OneDrive, Dropbox, Mega, Box, pCloud e gli altri servizi che rclone supporta.

- Il modulo dice se rclone c'è e quale versione (serve almeno la 1.60; quella di alcune distribuzioni è più vecchia). Se manca, dice come installarlo: `sudo -v ; curl https://rclone.org/install.sh | sudo bash` dal terminale del server, oppure il programma scaricato da rclone.org in `/usr/local/bin`. Il pannello non installa niente da solo.
- **Configurazione guidata** per Google Drive, OneDrive e Dropbox: sul tuo computer, che ha un browser, lanci `rclone authorize "drive"` (o `"onedrive"`, `"dropbox"`), accedi e consenti, e incolli quello che il terminale stampa tra `--->` e `<---End paste` (anche tutto l'output: il pannello trova il token). Per OneDrive il pannello chiede a Microsoft quale unità usare, quindi il token va incollato entro un'ora.
- **Modalità esperto**, solo per il proprietario: incolli una o più sezioni di `rclone.conf` (le stampa `rclone config show`) — un remote qualsiasi, anche un `crypt` sopra un altro — e scegli quale usare. Le opzioni che fanno eseguire un programma (`ssh`, `…_command`) sono rifiutate; ed è solo del proprietario perché altre opzioni di rclone agiscono sui file di questo server.
- **Nessun `rclone.conf` viene scritto**: il remote arriva a rclone dalle variabili d'ambiente `RCLONE_CONFIG_<REMOTE>_<OPZIONE>`, costruite per ogni comando dalla configurazione salvata cifrata, e `RCLONE_CONFIG` punta a `/dev/null`, così rclone tiene la configurazione in memoria. Il token di accesso rinnovato vale per quel comando; resta salvato il refresh token, che i servizi tengono valido finché lo usi (OneDrive lo revoca dopo 90 giorni senza uso, Google dopo sei mesi). Con backup regolari non succede; se succede, la verifica dice di rifare `rclone authorize`.
- Le operazioni sono `rclone copyto` con l'archivio preparato in `staging`, `rclone cat` per rileggerlo a flusso, `rclone deletefile` e `rclone lsjson --stat` per la dimensione. rclone controlla dimensione e, dove il servizio lo ha, hash di ogni file caricato, e questi servizi rendono visibile un file solo quando è completo; dopo il caricamento il pannello rilegge comunque la dimensione.
- **La verifica** elenca la cartella, poi scrive, rilegge ed elimina un file di prova. Gli errori sono spiegati: rclone mancante o troppo vecchio, autorizzazione scaduta o revocata (con il comando per rifarla), credenziali non accettate, spazio dell'account esaurito, troppe richieste, permessi, cartella o archivio che non ci sono, errori di rete e di certificato.
- Con Google Drive rclone usa un client ID condiviso da tutti i suoi utenti, che Google limita: per archivi grandi o frequenti conviene crearne uno tuo nella Google Cloud Console e usare la modalità esperto, con `client_id` e `client_secret`.

### Un altro server RunPanel

La copia fuori sede sul tuo secondo server, se è collegato a questo in un [cluster](multi-server.md): niente account, chiavi o servizi da configurare. L'uso tipico sono due server che si fanno da copia a vicenda: su ognuno aggiungi la destinazione **Server RunPanel collegato** e scegli l'altro.

- **Dove finiscono**: nella cartella dei dati dell'altro server, in `data/peer-backups/<id di questo server>/<anno>/<mese>`. Una cartella per ogni server che manda copie, separata dai backup di quel server: i suoi backup, la sua retention e i suoi ripristini non le toccano, e nemmeno il backup del suo store le contiene.
- **Come viaggiano**: con le stesse richieste firmate del cluster (HMAC-SHA256 con il segreto del cluster, da server a server, senza nessun account). La firma copre anche lo sha256 del corpo della richiesta, e un archivio di qualche gigabyte non può essere una richiesta sola: il proxy del pannello controlla la firma tenendo in memoria al massimo 10 MB, e Node chiude una richiesta il cui corpo arriva ancora dopo cinque minuti. Quindi:
  1. una piccola richiesta firmata **prenota** lo spazio con nome, dimensione e sha256 dell'archivio, e riceve un **token** che vale per quel solo caricamento (l'altro server ne tiene solo l'hash);
  2. l'archivio parte in **pezzi da 8 MB**, in ordine, ognuno una richiesta firmata con il token. Un pezzo la cui risposta si perde viene rimandato, e una connessione che cade costa un pezzo, non il caricamento;
  3. alla fine l'altro server confronta **dimensione e sha256** di quello che è arrivato con quelli prenotati, scrive il file sul disco e solo allora gli dà il nome. Un archivio diverso viene scartato; un caricamento lasciato a metà (il mittente si ferma, uno dei due si riavvia) viene tolto da solo, al riavvio e ogni ora.

  Ripristino, download e **Verifica integrità** riscaricano l'archivio in una richiesta firmata e lo confrontano con lo sha256 registrato dal backup, come per ogni destinazione.
- **Lo spazio lo decide chi tiene le copie**: nella sua pagina **Backup › Copie per altri server** c'è una riga per ogni server collegato (e per quelli scollegati che hanno ancora copie lì), con quanti archivi tiene, quanto spazio occupano e l'ultimo arrivato. Il proprietario sceglie per ognuno **Nessun limite**, **Un limite** in GB o **Non accettare**. In ogni caso il disco tiene sempre libero un decimo del suo spazio, tra 5 e 50 GB, per il server stesso. Un limite ferma le copie nuove, non elimina quelle che ci sono.
- **Sicurezza**: un server legge ed elimina solo le copie della sua cartella. Nomi e riferimenti che arrivano con le richieste vengono controllati prima di diventare un percorso, e nessuno esce dalla cartella. Un account non può raggiungere queste richieste attraverso un altro pannello: rispondono solo al server, mai a una richiesta inoltrata per un utente. Il segreto del cluster è uno solo per tutti i server, quindi la separazione tra le cartelle protegge dagli errori, non da un server del cluster compromesso: un server compromesso ha già in mano tutto il cluster.
- **Cifratura**: senza la password dei backup gli archivi arrivano in chiaro sull'altro disco, e chi amministra quel server può leggerli. Attiva la [cifratura con una password](#cifratura-con-una-password): quando è spenta, il modulo della destinazione la propone.
- **Verifica** controlla che l'altro server risponda e abbia una versione che conosce questa funzione, poi prenota, scrive, rilegge ed elimina un piccolo file, e dice quanto spazio resta per questo server (il limite, o il disco dell'altro). Gli errori sono spiegati: server spento o irraggiungibile, versione vecchia (da aggiornare), firma rifiutata (segreto diverso, server non più tra i suoi, orologi distanti più di cinque minuti), copie rifiutate o limite pieno (con i numeri), disco pieno, server non più collegato.
- **Con più copie** (vedi sotto) un server spento, vecchio o pieno fa fallire solo la sua copia: il backup resta riuscito con le altre, arriva l'avviso e la copia si può riprovare.
- **Se perdi un server**: sul server che tiene le sue copie, in **Backup › Copie per altri server**, il proprietario apre il menu ⋯ della sua riga, **Mostra gli archivi**, e scarica quello che serve. Poi, sul server che lo sostituisce, **Ripristina da un archivio**: se è cifrato chiede la password dei backup del server perso. Dallo stesso menu **Elimina le copie…** le cancella tutte, con il nome del server da scrivere per conferma; un server ancora collegato continua a mandarne di nuove, a meno di impostare **Non accettare**.

## Più copie di ogni backup (3-2-1)

Una pianificazione può scrivere lo stesso archivio in più destinazioni, per esempio il disco del server, un secondo disco e un bucket: perdere un disco, un bucket o un account non fa perdere i backup. È la regola 3-2-1: tre copie, su due supporti diversi, una fuori da qui.

- **Dove salvare**, nel modulo della pianificazione, è una lista in ordine: la prima è la **principale**, le altre ricevono una copia identica. **Aggiungi una copia** ne mette un'altra in fondo; dal menu ⋯ di ogni riga si sposta, si rende principale o si toglie. Fino a 5 destinazioni; la stessa due volte, o due che scrivono nello stesso posto (due destinazioni locali nella stessa cartella, due S3 sullo stesso bucket e prefisso, due Telegram sullo stesso canale o sugli stessi Messaggi salvati, due verso lo stesso server collegato), vengono rifiutate: lì una seconda copia non protegge da niente. Le pianificazioni che esistevano prima hanno una sola destinazione, e fanno quello che facevano.
- L'archivio viene scritto **una volta sola**, cifrato se c'è la password dei backup, e poi copiato in ogni destinazione **una dopo l'altra**, nell'ordine della lista: la principale per prima, così il backup è ripristinabile il prima possibile. In sequenza e non in parallelo perché la connessione è una sola — due caricamenti insieme non finiscono prima di due in fila — e perché il server serve anche le tue app: un carico alla volta, prevedibile. Sullo stesso disco della cartella di lavoro la copia locale è un collegamento al file, istantaneo e senza spazio in più; su un altro disco è una copia completa, scritta accanto e rinominata solo quando è intera. Il file nella cartella di lavoro resta finché tutte le copie non hanno finito.
- **Quanto tenerne**: ogni copia segue la regola della pianificazione, oppure una sua (**Per ogni destinazione**, con più di una destinazione): per esempio una settimana sul disco e un anno nel bucket. La retention toglie le copie destinazione per destinazione, e la copia più recente in ogni destinazione non viene mai tolta; un backup sparisce dalla cronologia solo quando non ne resta nessuna copia.
- **Se una copia non riesce** il backup non è fallito: l'archivio c'è nelle altre. Il backup resta riuscito (o parziale, per gli elementi che mancano), la cronologia mostra "2 copie su 3" e arriva la notifica di backup concluso come avviso, con la destinazione e il motivo. Nella pagina del backup, **Copie** elenca ogni copia con stato, dimensione, dove sta e l'errore; **Riprova la copia** la rimanda partendo da una copia che c'è, dopo averla confrontata con lo sha256 dell'archivio creato. Solo se nessuna copia arriva il backup è fallito.
- **Ripristino, download e Verifica integrità** usano la prima copia disponibile: prima quelle sul disco di questo server, poi nell'ordine della pianificazione. Una copia che non c'è più o non risponde lascia il posto alla successiva, e il log dice quale è stata usata; nel ripristino anche una copia danneggiata (sha256 diverso, un file che non si rilegge) lascia il posto alla successiva. Una password che manca o è sbagliata invece ferma subito: è la stessa per ogni copia.
- **Eliminare un backup** elimina tutte le sue copie. Se una non si lascia cancellare, il backup resta con quelle rimaste, e lo si può riprovare.
- **Esegui ora** su una pianificazione scrive in tutte le sue destinazioni, come quando parte da sola. Un backup fuori da ogni pianificazione — **Esegui backup ora** nella pagina di un database — va solo nella destinazione predefinita: non ha retention e resta finché non lo elimini, quindi una copia ovunque riempirebbe ogni destinazione, quelle a pagamento comprese; ed è di solito la copia veloce prima di una modifica rischiosa. Dall'API, `destinationIds` ne chiede più d'una. Anche il **backup di sicurezza** di un ripristino va solo nella predefinita: il ripristino lo aspetta, serve a tornare indietro nei minuti dopo, e non viene mai tolto dalla retention.
- Se il pannello si ferma a metà delle copie, al riavvio il backup si chiude con le copie arrivate, e quelle interrotte compaiono come non riuscite, da riprovare.

Dall'API: `destinations` in `POST`/`PUT /api/backups/policies` (`[{ destinationId, retention: { count, days, bytes } | null }]`, `null` per la regola della pianificazione), `copies` in ogni backup di `GET /api/backups/runs`, e `POST /api/backups/runs/{id}/copies/{copyId}/retry`. `destinationId` resta, ed è la principale; un client che manda solo quello cambia la principale e lascia le altre copie dove sono.

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
- **Retention**: numero (1–1000), età (1–3650 giorni) e dimensione totale (almeno 1 MB), insieme. Viene applicata dopo un'esecuzione riuscita, destinazione per destinazione, ognuna con la sua regola (vedi [Più copie](#più-copie-di-ogni-backup-3-2-1)), e la copia valida più recente in ogni destinazione non viene mai tolta. Un backup fatto a mano fuori da ogni pianificazione (vedi la pagina del database, più sotto) non ha retention: resta finché non lo elimini.

## Integrità

Ogni backup registra lo sha256 dell'archivio, e `checksums.txt` quello di ogni dump e volume. **Verifica integrità**, nella pagina di un backup, rilegge l'archivio in background, dalla prima copia disponibile (e dice quale, se sono più d'una):

- sul disco locale, per intero: lo sha256 dell'archivio, poi per ogni file il CRC-32, lo sha256 dove è elencato, e ogni `.gz` decompresso fino in fondo — un dump troncato ha comunque un checksum valido di se stesso troncato;
- in un bucket o su Telegram, scorrendolo una volta per calcolarne lo sha256, senza salvarlo: dimostra che i byte sono quelli scritti; i singoli file vengono controllati di nuovo prima di ogni ripristino. Su Telegram si controlla anche lo sha256 di ogni parte.

Un archivio cifrato si controlla allo stesso modo: lo sha256 è quello del file cifrato, e i file vengono letti attraverso la decifratura, che verifica ogni blocco. Se il pannello non ha più la sua password, controlla lo sha256 e dice che il contenuto non si è potuto aprire.

L'esito resta sul backup (uno scudo nella cronologia), con il file che non va e il motivo in modalità esperto. Un archivio danneggiato non si ripara: fai un nuovo backup.

## Ripristino

Il ripristino è un solo dialog. È tutto selezionato; ogni voce dice, in una riga, cosa succede a quello che c'è adesso, e dove va — lo stesso servizio o progetto di default, oppure un altro dello stesso tipo. Per confermare si scrive il nome della prima voce che verrà sovrascritta.

Prima di fermare, copiare o sovrascrivere qualsiasi cosa:

1. L'archivio viene preso dalla prima copia disponibile, partendo da quelle sul disco di questo server. Uno su S3 o su Telegram viene scaricato nella cartella di lavoro del ripristino (serve lo spazio libero, più la riserva di 2 GB), con lo sha256 calcolato durante il download e confrontato con quello registrato quando è stato scritto; se non coincide, e non c'è un'altra copia da provare, il ripristino si ferma. Le parti di un archivio diviso su Telegram vengono riscaricate in ordine e ricomposte; se ne manca una, il pannello dice quale prima di scaricare alcunché, e passa alla copia successiva se c'è.
2. I file che il ripristino userà — solo quelli — vengono controllati come fa **Verifica integrità**. Se uno è danneggiato, o la password di un archivio cifrato manca o è sbagliata, il ripristino si ferma senza aver toccato niente. Un archivio cifrato non viene mai decifrato per intero su disco: come per uno zip, il ripristino estrae solo i file che gli servono nella sua cartella di lavoro, che viene cancellata alla fine.
3. Un **backup di sicurezza** delle destinazioni va sulla destinazione predefinita (etichetta "Sicurezza pre-ripristino", mai tolto dalla retention, si cancella a mano). Se fallisce il ripristino si ferma, a meno che tu non abbia spuntato **Procedi anche senza backup di sicurezza**.

- **Volume**: il progetto si ferma; i suoi container rimasti accesi vengono fermati e riavviati alla fine, mentre un container di un altro progetto che usa il volume blocca il ripristino. I percorsi esclusi restano come sono. Un volume Compose che non esiste più si ricrea con un deploy, poi si ripete il ripristino.
- **Database**: se il servizio appartiene a un progetto acceso, il progetto si ferma e riparte alla fine. Su Postgres il ripristino rifiuta di partire se resta aperta una connessione, perché lo script cancella i database in ordine e si fermerebbe a metà. MySQL e Mongo sovrappongono il dump a quello che c'è. Un dump completo MySQL o Mongo porta con sé gli utenti del server di origine: su un altro servizio li sostituisce, e il ripristino finisce in errore dicendo che le credenziali salvate non valgono più, con i dati già al loro posto.
- **Repository**: i file vengono sovrascritti, quelli in più non vengono cancellati. Durante un deploy il ripristino rifiuta. Con le cartelle per versione i file vanno dove l'app li legge: nella versione che gira, e da lì nella cartella del progetto per quelli in comune.
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

La pagina di un database ha un riquadro **Backup**: le pianificazioni che lo salvano (quando e dove), i suoi archivi recenti con il segno dell'integrità, e **Ripristina…** limitato a quel database, con quel database come unica destinazione. Se nessuna pianificazione attiva lo salva propone **Salvalo ogni notte** (alle 03:00, sulla destinazione predefinita, conservando gli ultimi 7). Il proprietario ha anche **Esegui backup ora**, un backup fuori da ogni pianificazione e quindi fuori dalla retention, sulla sola destinazione predefinita.
