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

## Notifiche

La campanella nella barra in alto raccoglie tutto quello che succede sul server, per ogni account e solo su quello che può vedere. Mandare gli stessi eventi fuori dal pannello — email, Telegram, Discord, Slack, ntfy o un webhook firmato — si imposta in **Impostazioni › Generale › Notifiche**: cosa viene notificato, i canali, la firma dei webhook e come gli avvisi ravvicinati non diventano rumore sono in [Notifiche](notifications.md).
