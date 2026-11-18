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

## Nuovo progetto

Tre passi, e il progetto viene creato solo alla fine: sorgente (GitHub o ZIP trascinato), revisione di quello che il pannello ha riconosciuto (per esempio *Next.js · porta 3000*), messa online con il primo deploy seguito dal vivo. Se serve un database viene creato e collegato insieme; le variabili si incollano da un `.env`; un indirizzo si sceglie tra i domini configurati. Se un passo non riesce, non resta niente a metà. Vedi [Distribuire un progetto](deploy.md#creare-un-progetto).

## App pronte da installare

**Nuovo progetto › Da un modello** apre un catalogo di app a un clic: n8n, WordPress, Uptime Kuma, Umami, Ghost, Vaultwarden, Gitea e MinIO. Il pannello fa solo le domande che servono, genera le password (mostrate una volta, da copiare), sceglie una porta libera, crea anche il database quando l'app ne vuole uno e fa il primo deploy. Dopo è un normale progetto Compose. Vedi [Distribuire un progetto](deploy.md).

## La pagina del progetto

- Si apre sulla **Panoramica**: lo stato in una frase e la prossima cosa da fare, l'ultimo deploy, risorse e grafici, uptime, indirizzi, database collegati.
- Schede **Deploy** (con **Ripristina** sulle versioni precedenti e **Annulla** sul deploy in corso), **Log**, **Variabili**, **File**, **Terminale**, **Impostazioni**.
- Le impostazioni hanno un menu laterale (Generale, Sorgente, Build e avvio, Indirizzi, Rete, Risorse, Automazioni, Backup, Avanzate, Permessi, Zona pericolosa) e una sola barra per salvare. Il vecchio passaggio «Aggiungi al progetto › App» non c'è più: la sorgente si cambia da **Impostazioni › Sorgente**.
- Un deploy fallito dice la causa in parole e il rimedio; per i progetti Docker, se la nuova versione non risponde, torna online da sola quella precedente.
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

## Backup

- Il backup notturno con un clic include i volumi dei progetti e usa la destinazione predefinita.
- L'orario si sceglie a parole («ogni giorno alle 03:00», «ogni settimana il lunedì»…), con il cron grezzo in «Avanzate», e il fuso orario da un elenco.
- Le destinazioni S3 hanno i provider già pronti (AWS, Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO), vengono provate prima di salvarle, si modificano e si eliminano; gli errori di S3 sono spiegati in italiano.
- **Verifica integrità** su ogni archivio, e il ripristino controlla l'archivio prima di toccare qualcosa. Si può ripristinare anche da un archivio caricato dal computer.
- La pagina di ogni database mostra i suoi backup, con «Esegui backup ora» e il ripristino.

## Notifiche

Avvisi via email, Telegram, Discord, Slack, ntfy o webhook firmato: per ogni canale si scelgono gli eventi (o «solo quando qualcosa va storto») e c'è «Invia una prova». Nel pannello, la campanella in alto mostra gli avvisi non letti e si aggiorna da sola; **Notifiche** li elenca tutti. Il vecchio bot Telegram diventa il primo canale. Vedi [Notifiche](notifications.md).

## Account e sicurezza

- **Verifica in due passaggi** con app di autenticazione e codici di recupero, «ricorda questo dispositivo», sessioni visibili e chiudibili.
- **`scripts/reset-owner.mjs`** reimposta dal terminale del server la password del proprietario (e, se serve, la verifica in due passaggi). Vedi [Utenti e permessi](users.md).
- **Registro attività** filtrabile per utente, risorsa e azione, ed esportabile in CSV.
- **AI e API › API**: il riferimento di tutte le API con esempi `curl`.

## Primo avvio

La schermata di configurazione dice dove trovare il token di setup in base a come gira il pannello (systemd, Docker, PM2, terminale), e il login avvisa quando la connessione non è HTTPS.
