[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/whats-new.md)

---

# Cosa è cambiato

Per chi usa già il pannello: dove sono finite le cose e cosa c'è di nuovo. Niente va rifatto: progetti, database, backup e utenti restano come sono, e i vecchi indirizzi delle pagine portano ancora dove servono.

## Il menu

- **Salute** raccoglie Monitor, Diagnostica, Avvio automatico e Spazio disco (prima in *Sistema*).
- **Team** raccoglie Utenti e Registro attività (prima in *Accesso*).
- **Impostazioni** raccoglie Generale (le preferenze del pannello), Account, GitHub, AI e API, Aggiornamenti e Server collegati.
- **Domini** è una voce sua.
- **Modalità esperto** (dal menu dell'account o da **Impostazioni › Account**): mostra i dettagli tecnici e apre le sezioni «Avanzate». Spenta, il pannello parla di cosa fa l'app invece che di porte e runtime.
- La ricerca (**Ctrl K**) apre pagine, progetti e database e attiva le azioni più comuni.

## Sul telefono, come un'app

- **Si installa**: **Installa l'app** (nel menu dell'account, o in **Altro** sul telefono) lo mette sulla schermata Home e nel menu delle app del computer; si apre a tutto schermo, con le scorciatoie Progetti, Backup e Nuovo progetto. Su iPhone sono tre tocchi da Condividi, e il pannello li mostra. Serve HTTPS: su un indirizzo senza lucchetto il pannello spiega come metterlo. Vedi [Installare il pannello come app](operations.md#installare-il-pannello-come-app).
- **Una barra in basso**: Panoramica, Progetti, Database, Backup e **Altro**, che apre un foglio con il resto del menu, il server, le notifiche e l'account. In alto restano il titolo, la ricerca e, nelle pagine di dettaglio, la freccia per tornare indietro.
- **Finestre dal basso**: conferme e moduli si aprono come fogli che salgono dal bordo, con i bottoni sotto il pollice, e si chiudono trascinandoli giù (non se hai già scritto qualcosa). I menu «⋯» diventano un elenco di azioni a tutta larghezza.
- Le schede scorrono di lato e tengono in vista quella aperta, i campi non fanno più ingrandire la pagina su iPhone, e le notifiche a comparsa non finiscono più sotto la barra.
- **Sempre dal vivo**: l'app non mostra mai dati vecchi. Senza rete lo dice, e dopo un aggiornamento del pannello propone **Aggiorna** invece di ricaricare da sola.
- **Notifiche push**: in **Account › Notifiche push** ognuno le attiva sui propri dispositivi, sceglie per ognuno quali eventi ricevere e lo prova con un tocco. Arrivano anche a pannello chiuso, solo per quello che l'account può vedere, una per progetto, e aprono la pagina giusta; sull'icona dell'app compare il numero di notifiche da leggere. Su iPhone, dall'app sulla schermata Home. Vedi [Sul telefono e sul computer](notifications.md#sul-telefono-e-sul-computer).

## Nuovo progetto

Tre passi, e il progetto viene creato solo alla fine: sorgente (GitHub o ZIP trascinato), revisione di quello che il pannello ha riconosciuto (per esempio *Next.js · porta 3000*), messa online con il primo deploy seguito dal vivo. Se serve un database viene creato e collegato insieme; le variabili si incollano da un `.env`; un indirizzo si sceglie tra i domini configurati. Se un passo non riesce, non resta niente a metà. Vedi [Distribuire un progetto](deploy.md#creare-un-progetto).

## App pronte da installare

**Nuovo progetto › Da un modello** apre un catalogo di app a un clic: n8n, WordPress, Uptime Kuma, Umami, Ghost, Vaultwarden, Gitea e MinIO. Il pannello fa solo le domande che servono, genera le password (mostrate una volta, da copiare), sceglie una porta libera, crea anche il database quando l'app ne vuole uno e fa il primo deploy. Dopo è un normale progetto Compose. Vedi [Distribuire un progetto](deploy.md).

## La pagina del progetto

- Si apre sulla **Panoramica**: lo stato in una frase e la prossima cosa da fare, l'ultimo deploy, risorse e grafici, uptime, indirizzi, database collegati.
- Schede **Deploy** (con **Ripristina** sulle versioni precedenti e **Annulla** sul deploy in corso), **Log**, **Variabili**, **File**, **Terminale**, **Impostazioni**.
- Le impostazioni hanno un menu laterale (Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa) e una sola barra per salvare. Il vecchio passaggio «Aggiungi al progetto › App» non c'è più: la sorgente si cambia da **Impostazioni › Sorgente**.
- Un deploy fallito dice la causa in parole e il rimedio; per i progetti Docker, se la nuova versione non risponde, torna online da sola quella precedente. Per i progetti nativi si può accendere, vedi sotto.
- **Una cartella per versione, novità da provare** (progetti nativi da GitHub, su Linux): spenta di serie, si accende per progetto con **Se non risponde, rimetti online la versione precedente** (Impostazioni › Build e avvio, segnato **Nuovo**). Da lì ogni deploy prepara la nuova versione in `data/releases/<slug>/<id>` mentre la vecchia resta online, e se la nuova non risponde torna quella di prima. Database SQLite, upload e gli altri file che l'app scrive restano nella cartella del progetto, in comune tra le versioni; la scheda **File**, le attività pianificate e Riavvia seguono la versione che gira. Il primo deploy dopo averla accesa prepara le cartelle e il ritorno funziona dal secondo: conviene provarla prima su un progetto meno importante. Aggiornare il pannello non cambia niente ai progetti esistenti, e spegnerla rimette il deploy nella cartella del progetto senza niente da spostare. Vedi [Tornare alla versione precedente](deploy.md#tornare-alla-versione-precedente).
- Dal menu **Altro**: Duplica, Esporta configurazione, Vedi attività. Una configurazione esportata si importa dal wizard in modalità esperto.
- **Variabili**: vista a tabella o come testo `.env`, incolla un `.env` scegliendo se sovrascrivere o saltare le chiavi che ci sono già, valori nascosti finché non li mostri, l'errore sulla riga sbagliata, le variabili dei database collegati con la loro provenienza, e **Salva e ridistribuisci**.
- **Attività pianificate** (Impostazioni › Automazioni): un comando con un orario, eseguito nel progetto («ogni notte alle 3 svuota la cache»), con storico, output ed esito di ogni esecuzione, «Esegui ora», un limite di tempo e un avviso se fallisce. Non parte mai due volte insieme né durante un deploy.
- **Log**: ricerca, solo errori, pausa, download. Il pannello conserva il log di ogni app su disco, a rotazione, e lo si cerca anche dopo un riavvio.

## La pagina del database

Stesso header della pagina progetto e schede Panoramica, Connessione, Console, **Dati**, Database interni, Backup, Impostazioni. In **Dati** si guardano tabelle e righe (PostgreSQL, MySQL), chiavi (Redis) e documenti (MongoDB), e si scrivono query: sempre in sola lettura, con un limite di righe e di tempo, e ogni lettura finisce nel registro attività. Alla creazione nome e porta libera vengono proposti dal pannello. Le card Nginx, Apache e Caddy, che non facevano niente, sono state tolte.

## Indirizzi e HTTPS

Un indirizzo si aggiunge dalla pagina del progetto: il pannello mostra il record DNS da creare, lo controlla dal vivo e chiede il certificato solo quando il DNS è pronto. Ogni indirizzo mostra lo stato del certificato; il dominio può portarsi dietro il suo `www`. Vedi [Domini](domains.md).

- **Il pannello su HTTPS**: da **Impostazioni › Generale** gli dai un nome sul tuo dominio; il pannello verifica DNS e certificato, prova l'indirizzo nuovo e solo dopo propone di usarlo come indirizzo pubblico. La porta di sempre continua a funzionare, e «Disattiva» rimette tutto com'era.
- **Indirizzo immediato**: un progetto senza dominio può avere subito un nome del tipo `progetto.1-2-3-4.sslip.io`, solo in HTTP (il servizio è condiviso e non permette certificati affidabili): comodo per una prova, non per l'uso vero.

## Metriche e Monitor

Storico di CPU, memoria, disco e rete per il server, i progetti e i database, con grafici su 1 ora, 24 ore e 7 giorni; avvisi quando CPU o RAM restano sopra il 90% per 5 minuti; controllo ogni minuto che le app rispondano, con uptime e incidenti. Il Monitor si ordina, mostra i container dei Compose e quelli non gestiti dal pannello.

**Pagina di stato pubblica**, facoltativa e spenta di default: un indirizzo da dare a chi usa le app, che si apre senza accedere al pannello e dice se le app che scegli rispondono, con l'uptime delle ultime 24 ore e degli ultimi 30 giorni e le interruzioni recenti. Mostra solo il titolo, il messaggio e i nomi che scrivi tu, anche per i progetti dei server collegati; spenta, il suo indirizzo risponde «Pagina non trovata». Si imposta in **Impostazioni › Generale**. Vedi [Operatività](operations.md#pagina-di-stato-pubblica).

## Backup

- Il backup notturno con un clic include i volumi dei progetti e usa la destinazione predefinita.
- L'orario si sceglie a parole («ogni giorno alle 03:00», «ogni settimana il lunedì»…), con il cron grezzo in «Avanzate», e il fuso orario da un elenco.
- Le destinazioni S3 hanno i provider già pronti (AWS, Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO), vengono provate prima di salvarle, si modificano e si eliminano; gli errori di S3 sono spiegati in italiano.
- **Telegram come destinazione**: gli archivi vanno in un canale privato creato dal pannello, o nei tuoi Messaggi salvati, attraverso il tuo account — collegato con il QR dall'app o con numero, codice e password a due passaggi, con le chiavi della tua app presa da my.telegram.org. Telegram Premium porta i file da 2 a 4 GB, e il pannello lo rileva da solo a ogni backup; gli archivi più grandi vengono divisi in parti e ricomposti da soli al ripristino. Vedi [Backup](backups.md#telegram).
- **Nuove destinazioni**: un server SFTP o un NAS (Synology, QNAP, Storage Box di Hetzner), con una chiave generata dal pannello e l'impronta del server salvata alla prima verifica; una cartella WebDAV (Nextcloud, ownCloud, Koofr, pCloud, il WebDAV di un NAS); Google Drive, OneDrive, Dropbox e gli altri servizi di rclone, se rclone è installato sul server. Ogni archivio viene caricato con un nome provvisorio e prende il suo nome solo quando è completo. Vedi [Backup](backups.md#dove-finiscono).
- **Verifica integrità** su ogni archivio, e il ripristino controlla l'archivio prima di toccare qualcosa. Si può ripristinare anche da un archivio caricato dal computer.
- La pagina di ogni database mostra i suoi backup, con «Esegui backup ora» e il ripristino.
- **Più copie di ogni backup** (regola 3-2-1): una pianificazione scrive lo stesso archivio in più destinazioni, in ordine — per esempio il disco del server, un secondo disco e un bucket —, ognuna con la sua conservazione. Se una copia non arriva il backup resta valido, arriva un avviso e dalla pagina del backup si può riprovare la copia; ripristino, download e verifica usano la prima copia disponibile, partendo da quelle sul server. Una destinazione locale può ora scrivere in una cartella sua, come un secondo disco. Le pianificazioni che c'erano restano con la loro sola destinazione finché non ne aggiungi. Vedi [Backup](backups.md#più-copie-di-ogni-backup-3-2-1).
- **Cifratura degli archivi** (pagina Backup): con una password dei backup ogni nuovo archivio esce dal server cifrato per intero (`.zip.enc`), anche quelli manuali e di sicurezza. Il pannello apre da solo i suoi archivi, anche dopo un cambio di password; un archivio di un altro server chiede la password quando lo carichi, e `scripts/decrypt-backup.mjs` lo decifra senza il pannello. Finché non la imposti non cambia niente. Vedi [Backup](backups.md#cifratura-con-una-password).
- **Un altro server RunPanel come destinazione**: con due server collegati, ognuno può tenere la copia fuori sede dell'altro, senza un account esterno. Le copie stanno nella cartella dei dati dell'altro server, separate dai suoi backup, e viaggiano con le richieste firmate del cluster, controllate in dimensione e sha256 prima di prendere il loro nome. Su ogni server, **Backup › Copie per altri server** mostra cosa tiene per gli altri e quanto spazio occupa, con un limite per server e il download per ricostruire un server perso. Vedi [Backup](backups.md#un-altro-server-runpanel).

## Notifiche

Avvisi via email, Telegram, Discord, Slack, ntfy o webhook firmato: per ogni canale si scelgono gli eventi (o «solo quando qualcosa va storto») e c'è «Invia una prova». Nel pannello, la campanella in alto mostra gli avvisi non letti e si aggiorna da sola; **Notifiche** li elenca tutti. Il vecchio bot Telegram diventa il primo canale. Vedi [Notifiche](notifications.md).

## Account e sicurezza

- **Verifica in due passaggi** con app di autenticazione e codici di recupero, «ricorda questo dispositivo», sessioni visibili e chiudibili.
- **Accesso con GitHub**: il proprietario configura una volta un'app OAuth di GitHub (**Impostazioni › Generale › Accesso con GitHub**, una guida passo per passo con l'URL di callback da copiare e il bottone **Verifica**); poi ogni utente collega il suo account GitHub da **Impostazioni › Account**, oppure accetta un invito con GitHub. Un account GitHub non crea mai un utente, la verifica in due passaggi viene chiesta lo stesso, e prima di spegnerlo il pannello nomina chi entra solo con GitHub e resterebbe fuori. Vedi [Accesso con GitHub](users.md#accesso-con-github).
- **`scripts/reset-owner.mjs`** reimposta dal terminale del server la password del proprietario (e, se serve, la verifica in due passaggi). Vedi [Utenti e permessi](users.md).
- **Registro attività** filtrabile per utente, risorsa e azione, ed esportabile in CSV.
- **AI e API › API**: il riferimento di tutte le API con esempi `curl`.

## Primo avvio

La schermata di configurazione dice dove trovare il token di setup in base a come gira il pannello (systemd, Docker, PM2, terminale), e il login avvisa quando la connessione non è HTTPS.
