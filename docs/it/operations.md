[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/operations.md)

---

# Operatività

Tutto quello che segue riguarda il server selezionato nella barra: con [più server](multi-server.md) ognuno ha il proprio avvio automatico, la propria pulizia e il proprio aggiornamento.

## Avvio automatico

**Salute › Avvio automatico** dice cosa la macchina fa già al boot e genera quello che manca:

- una **unit systemd** con percorsi assoluti, dopo `docker.service` e dipendente da esso. Se il pannello gira da root la installa, altrimenti mostra un blocco da incollare;
- dove systemd non c'è, uno **script `@reboot`** supervisionato, che il pannello aggiunge al crontab dell'utente da solo. Il suo output va in `logs/autostart.log`.

Il pannello non esegue mai `systemctl start`, che metterebbe un secondo pannello sulla stessa porta. La unit ha `KillMode=process`, così `systemctl stop runpanel` non ferma PM2 né le app native che supervisiona; i container Docker non sono coinvolti.

La pagina controlla anche ciò che serve davvero al riavvio: Docker abilitato all'avvio (pulsante **Abilita**) e la lista di PM2 salvata (pulsante **pm2 save**), quando PM2 fa girare almeno un'app. Senza, dopo un riavvio il pannello torna e le app no.

Dopo un riavvio torna su quello che era acceso e quello che si era fermato da solo. Un progetto o un servizio fermato a mano resta fermo.

Ogni progetto e servizio ha un interruttore, un ordine, un ritardo e se aspettare che sia pronto prima di passare al successivo, al massimo un minuto: un servizio quando il motore risponde, un progetto quando passa l'health check del suo ultimo deploy (o, con l'health check spento, quando il processo è acceso). Di default i servizi ripartono e vengono attesi, i progetti no; i servizi partono sempre prima dei progetti. Al boot il pannello aspetta 20 secondi che Docker riavvii da sé quello che sa, poi avvia solo quello che è ancora giù, a 2 secondi di distanza, senza mai lanciare un build. **Simula** mostra cosa farebbe, **Esegui ora** lo fa subito.

Lo stato negli elenchi viene ricontrollato ogni mezzo minuto e dopo la riconciliazione: un progetto può passare a **Fermo** senza che nessuno l'abbia spento in quel momento, vuol dire che era già giù. Il controllo non avvia né ferma niente, e per segnare fermo qualcosa che risultava acceso vuole due letture d'accordo.

## Riavvio programmato

La sezione **Riavvio programmato** sta nelle impostazioni del progetto e nella pagina del servizio. Si sceglie un intervallo pronto (ogni notte alle 04:00, ogni domenica, ogni 6 ore, ogni ora) o un'espressione cron a cinque campi, con l'anteprima dei prossimi tre riavvii.

L'ora è nel **fuso orario del pannello** (**Impostazioni › Pannello**, lo stesso dei backup); finché non lo imposti è UTC, e la pagina lo dice. Cambiarlo ricalcola subito i riavvii in attesa.

Al momento stabilito:

- **In esecuzione**: lo riavvia. Un progetto riparte dall'ultimo deploy riuscito, con le variabili dei servizi collegati.
- **Fermato da te**: lo lascia fermo.
- **Caduto da solo**: fa **un solo tentativo** di rimetterlo su, e ci riprova solo se torna su e cade di nuovo.
- **Deploy in corso** o **ultimo deploy fallito**: lo salta.

La pagina mostra l'ultima occorrenza e cosa ha fatto. Se il pannello era spento all'ora prevista, il riavvio avviene una volta sola appena torna su, anche se nel frattempo ne sono saltati più d'uno. Con le notifiche attive arriva un messaggio per ogni riavvio eseguito o fallito, non per i salti.

## Liberare spazio

**Salute › Spazio disco** mostra quanto occupa Docker e cosa si può recuperare. **Pulisci ora** toglie solo ciò che si può ricreare, mai volumi o dati:

- le versioni vecchie delle immagini dei progetti, oltre quelle tenute per il rollback (2 per progetto di default);
- le immagini senza nome che nessun container usa, avanzi delle build compreso compose;
- container, immagini e reti orfani di RunPanel, comprese le immagini compose di un progetto eliminato;
- la cache di build: tutta, oppure solo quella più vecchia di una settimana. Tutta libera più spazio, ma il prossimo build di ogni progetto riparte da zero.

Un'opzione spenta di default toglie **tutte le immagini che nessun container usa**, anche quelle non create da RunPanel (database vecchi, immagini di base, altri progetti Docker). Si riscaricano quando servono, ma un'immagine costruita a mano e mai pubblicata andrebbe persa: per questo chiede conferma. Le versioni tenute per il rollback restano.

Il totale liberato è misurato sull'occupazione di Docker prima e dopo. I volumi orfani si tolgono solo dal riquadro **Risorse orfane**, perché contengono dati.

Ogni 6 ore il pannello fa da sé la parte sicura: applica la retention delle immagini, toglie le proprie immagini senza nome e la cache di build più vecchia di una settimana. Eliminare un progetto Compose toglie anche le immagini che compose ha costruito, e ogni container avviato dal pannello ha il log limitato a tre file da 10 MB (dal deploy o dalla ricreazione successivi; per Compose decide il tuo file).

## Aggiornare il pannello

RunPanel gira da un clone git del suo repository. La versione mostrata è `v0.1.0+125`, dove il numero è il conteggio dei commit sul ramo principale (su un clone shallow, lo SHA). A intervalli (1, 6 o 24 ore, si sceglie nella pagina) fa un `git fetch` e confronta; per un repository privato usa il token GitHub del pannello. **Non applica mai niente da solo**: quando il branch si è mosso compare una striscia in cima alle pagine con il pulsante **Aggiorna**, e **Impostazioni › Aggiornamenti** elenca i commit. Con più server, striscia e pagina seguono il server selezionato: per aggiornare un nodo, selezionalo.

Premuto **Aggiorna**, il pannello:

1. scarica i commit e, se l'hai attivata, verifica la firma;
2. copia lo store SQLite con `VACUUM INTO` (uno store Postgres non viene copiato);
3. allinea il checkout con `git reset --hard` e `git clean -fd`: le modifiche locali non committate si perdono, mentre i file ignorati (`data/`, `node_modules/`, `.next`) e i `.env*` restano, e il log elenca cosa viene rimosso;
4. installa le dipendenze e costruisce la nuova versione in `.next-update`, senza toccare quella in uso;
5. scambia le cartelle con due rename (la vecchia va in `.next-old`) ed esce con codice 75: a rimetterlo su pensa systemd (`Restart=always`) o lo script `@reboot`.

Un minuto dopo il riavvio riuscito, `.next-old` e la copia dello store vengono cancellati. Se qualcosa fallisce prima dello scambio, checkout e dipendenze tornano come prima e il pannello continua a girare sulla versione di prima.

L'aggiornamento viene rifiutato se il pannello non è un clone git con un remote `origin` https o ssh, se HEAD è staccato, se gira in modalità di sviluppo, in un container o su Windows, se ci sono meno di 2 GB liberi, o se è in corso un deploy, un backup o un ripristino (controllato anche dopo il build). Senza un supervisore il pulsante diventa **Prepara**: la nuova versione viene costruita, ma lo scambio e il riavvio restano due comandi da eseguire a mano.

**Firma dei commit.** Facoltativa e spenta di default: nella pagina Aggiornamenti si può richiedere che i commit siano firmati da chiavi GPG o SSH ammesse (**Firmatari ammessi**, per SSH).

Se il pannello non tornasse su, i comandi per rimettere la versione precedente sono in `<dataDir>/panel-update.json` e nel log del supervisore (journal di systemd, o `logs/autostart.log` con lo script).

## Installare il pannello come app

Il pannello si installa sul telefono e sul computer come un'app: si apre dalla sua icona, a tutto schermo e senza la barra del browser. Sul telefono le sezioni principali sono nella barra in basso, il resto (server, notifiche, account) in **Altro**.

- **Android, e Chrome o Edge sul computer**: **Installa l'app** nel menu dell'account (sul telefono in **Altro**), oppure l'icona di installazione nella barra degli indirizzi. Sul telefono la Panoramica lo propone anche una volta sola, con una scheda in basso.
- **iPhone e iPad**: in Safari tocca **Condividi**, poi **Aggiungi alla schermata Home**. **Installa l'app** mostra i passi.
- **Serve HTTPS.** Nessun browser installa un'app da un indirizzo senza lucchetto (l'eccezione è `localhost`). Aperto su `http://<ip>:3000`, **Installa l'app** spiega perché e porta a **Impostazioni › Generale › Metti il pannello su HTTPS**.

Tenendo premuta l'icona (su Android) o con il tasto destro (sul computer) ci sono le scorciatoie **Progetti**, **Backup** e **Nuovo progetto**.

L'app mostra sempre dati dal vivo: pagine e API arrivano ogni volta dal server, e restano in memoria solo i file del pannello, che cambiano nome a ogni versione, e le icone, perché si apra in fretta. Senza rete, o con il server che non risponde (per esempio mentre si riavvia dopo un aggiornamento), compare una pagina che lo dice e che si ricarica da sola appena il server torna. Quando il pannello viene aggiornato, l'app aperta mostra **Nuova versione del pannello** con **Aggiorna**: ricarica solo quando lo premi, così un modulo compilato a metà non si perde. I link ad altri siti si aprono nel browser.

## Notifiche

La campanella nella barra in alto raccoglie tutto quello che succede sul server, per ogni account e solo su quello che può vedere. Mandare gli stessi eventi fuori dal pannello — email, Telegram, Discord, Slack, ntfy o un webhook firmato — si imposta in **Impostazioni › Generale › Notifiche**: cosa viene notificato, i canali, la firma dei webhook e come gli avvisi ravvicinati non diventano rumore sono in [Notifiche](notifications.md).

## Pagina di stato pubblica

Ogni minuto il pannello chiede a ogni app con una porta e il controllo di salute acceso se risponde: due risposte mancate di fila aprono un'interruzione, e la Panoramica del progetto mostra uptime e incidenti. La **pagina di stato pubblica** fa vedere le stesse cose a chi usa le app, senza dargli un accesso al pannello. È facoltativa e resta spenta finché non la accendi.

Si imposta in **Impostazioni › Generale › Pagina di stato pubblica**, ed è del solo proprietario (come le altre preferenze del pannello). Diversamente dal resto di questa pagina, riguarda il pannello che hai aperto, non il server selezionato nella barra.

- **Indirizzo**: `<indirizzo del pannello>/status/<percorso>`. Il percorso proposto è casuale, dodici lettere e cifre, così la pagina la trova solo chi riceve il link. Puoi sceglierne uno facile da ricordare, per esempio `stato`, ma allora chiunque può arrivarci provando. **Nuovo indirizzo** ne genera un altro: quello vecchio smette di funzionare quando salvi. La pagina risponde ovunque risponda il pannello, anche al suo indirizzo HTTPS, e il link da copiare usa l'indirizzo pubblico del pannello, se l'hai impostato.
- **Titolo** e **messaggio**: il messaggio è facoltativo e compare in cima alla pagina così com'è, per esempio per annunciare una manutenzione.
- **Progetti**: quali compaiono, in che ordine e con che nome. Il nome proposto è quello del progetto nel pannello: lo confermi o lo cambi, e da lì resta quello che hai scritto, anche se il progetto viene rinominato. Accanto a un progetto che il controllo non interroga (controllo di salute spento, nessuna porta, app ferma) il pannello dice cosa comparirà sulla pagina.
- **Motori di ricerca**: spento di default; la pagina chiede di non essere indicizzata.

La pagina dice in una frase come vanno le cose e, per ogni progetto, lo stato (**Operativo**, **Non risponde**, **In aggiornamento** durante un deploy o un riavvio, **Nessun dato** quando non ci sono controlli recenti), l'uptime delle ultime 24 ore e degli ultimi 30 giorni, una barra per ogni giorno e le interruzioni degli ultimi 30 giorni, con l'inizio, la fine e la durata. Gli orari sono nel fuso orario del pannello, che la pagina indica. Non mostra mai il nome interno dei progetti, porte, percorsi, indirizzi, server né il motivo tecnico di un'interruzione: solo il titolo, il messaggio e i nomi che hai scritto. Funziona su telefono, in chiaro e in scuro, e anche senza JavaScript.

Spenta, o a un percorso sbagliato, risponde **Pagina non trovata**, esattamente come un indirizzo che non esiste: chi tira a indovinare non scopre che la pagina c'è. Se sei il proprietario e hai fatto l'accesso, il link di una pagina spenta ti apre un'anteprima, segnata come tale, che vedi solo tu. I dati vengono ricalcolati al massimo ogni 30 secondi, per quanti visitatori ci siano, e una pagina aperta si aggiorna da sola ogni minuto. Accendere, spegnere e modificare la pagina finisce nel registro attività. Il link si copia anche dalla scheda del controllo, nella Panoramica di ogni progetto di questo server che compare sulla pagina.

Con [più server](multi-server.md) la pagina può mostrare anche progetti dei server collegati: ognuno controlla le proprie app, e il pannello chiede a ciascuno, con una richiesta firmata e al massimo ogni 30 secondi, il solo stato pubblico dei progetti scelti. Se un server non risponde, i suoi progetti compaiono come **Nessun dato**; un progetto eliminato sparisce dalla pagina. Per i progetti degli altri server il link non compare nella loro scheda: si copia dalle impostazioni.
