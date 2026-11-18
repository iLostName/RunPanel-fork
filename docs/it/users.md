[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/users.md)

---

# Utenti e permessi

Il pannello può avere più account. Il primo è il **proprietario**: lo crea il primo avvio, ha sempre tutti i permessi e nessuno può limitarlo, disattivarlo o eliminarlo. Ogni altro account nasce senza accessi e riceve solo quello che gli dai.

Con [più server](multi-server.md) gli account sono gli stessi ovunque e si gestiscono da qualunque pannello; sessioni e link di invito restano del pannello su cui nascono.

## Accedere

Si entra con email e password. Il pannello non invia email: l'email è solo il nome con cui accedi.

## Verifica in due passaggi

Con la **verifica in due passaggi** attiva, per entrare serve anche il codice di 6 cifre che un'app di autenticazione sul telefono mostra e cambia ogni 30 secondi: chi scopre la password, da sola, non entra.

**Per attivarla**, in **Impostazioni › Account**:

1. **Attiva**, poi la tua password.
2. Inquadra il codice QR con un'app di autenticazione (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden o un'altra), oppure scrivi a mano la chiave che compare sotto.
3. Scrivi il codice che mostra l'app. Si attiva solo con un codice giusto, così una scansione andata male non ti chiude fuori.
4. Salva i **10 codici di recupero**: copiali o scaricali come file di testo. Vengono mostrati una volta sola.

**Per entrare** servono poi la password e il codice. Senza telefono usa uno dei codici di recupero: ognuno vale una volta. **Ricorda questo dispositivo** evita il codice su quel browser per 30 giorni; dalla pagina Account si dimenticano tutti i browser ricordati in un colpo, e vengono dimenticati comunque quando la password cambia o viene reimpostata.

**Nuovi codici di recupero** ne crea dieci nuovi (dopo la password) e annulla tutti i precedenti. **Disattiva** chiede la password e un codice, dell'app o di recupero: una sessione aperta da sola non basta.

I codici sbagliati sono limitati per ogni account: dopo cinque in un quarto d'ora, o venti in un giorno, bisogna aspettare prima di riprovare, e cinque sullo stesso accesso obbligano a riscrivere la password. Ogni errore finisce nel registro attività. Un link per scegliere una nuova password non fa entrare un account con la verifica attiva: dopo averlo usato, la persona entra con la nuova password e il codice.

Chi gestisce gli utenti può disattivarla, dalla pagina dell'account, a chi ha perso sia il telefono sia i codici di recupero; mai al proprietario. Con [più server](multi-server.md) vale per pannello: va attivata su ogni pannello da cui entri.

I token API non chiedono il codice: un token è una credenziale a sé, creata da un browser in cui sei entrato. Le pagine dei token e la verifica stessa non si raggiungono con un token.

Dettagli tecnici: TOTP (RFC 6238) con HMAC-SHA-1, 6 cifre e periodo di 30 secondi, con un periodo di tolleranza prima e dopo, e mai lo stesso codice due volte. La chiave è salvata cifrata con la chiave segreta del pannello, i codici di recupero solo come hash scrypt con sale. Un database ripristinato senza la sua chiave segreta non può più controllare i codici dell'app: entra con un codice di recupero, poi disattiva e riattiva la verifica.

## Dispositivi

**Impostazioni › Account › Dispositivi** elenca dove sei entrato, con indirizzo e ultima attività. **Disconnetti** chiude una sessione; **Esci da tutti gli altri dispositivi** le chiude tutte tranne quella che stai usando. Chi gestisce gli utenti vede e chiude le sessioni di un account dalla sua pagina.

## Se il proprietario resta fuori

Nessuno può reimpostare il proprietario dal pannello. Sul server, dalla cartella del pannello, con l'utente con cui gira il pannello:

```bash
node scripts/reset-owner.mjs
```

Lo script mostra quale database ha aperto e l'email del proprietario, chiede di scrivere quell'email per confermare, poi la nuova password (con Invio ne genera una e la mostra una volta). Se la verifica in due passaggi è attiva chiede se disattivare anche quella (`--disable-2fa` risponde sì, `--keep-2fa` no). In un colpo imposta la password, disconnette il proprietario da ogni dispositivo, dimentica i dispositivi ricordati, azzera i limiti ai tentativi di accesso e scrive il ripristino nel registro attività.

Trova il database come il pannello: `RUNPANEL_DB_DRIVER`, `RUNPANEL_DATA_DIR`, `RUNPANEL_DB_FILE`, `RUNPANEL_DATABASE_URL` e le altre variabili `RUNPANEL_PG_*`, prima dall'ambiente e poi dai file `.env` della cartella del pannello. Se il pannello le riceve altrove (righe `Environment=` di systemd, Docker), lancia lo script dove sono impostate (`docker exec -it <container> node scripts/reset-owner.mjs`) oppure passa `--data-dir`, `--db-file` o `--database-url`. `--help` elenca le opzioni. Con più server la nuova password arriva agli altri pannelli alla sincronizzazione successiva; la verifica in due passaggi si disattiva solo sul server dove gira lo script.

## Invitare qualcuno

In **Accessi › Utenti › Invita utente** scrivi l'email e scegli per quanto vale il link: 1 ora, 24 ore, 7 giorni o una durata a piacere fino a 30 giorni. Il pannello mostra il link **una volta sola** e lo mandi tu alla persona. Il link funziona una volta: la persona sceglie la password ed entra.

Dalla pagina di un account generi un link nuovo: un invito se l'account non ha ancora una password, altrimenti un link per sceglierne una nuova (così si risolve una password dimenticata). Ogni link nuovo annulla quelli non usati, e usarne uno disconnette quell'account da ogni dispositivo.

## Cosa può fare un account

### Progetti e servizi

Un accesso punta a **tutto**, a una **cartella**, a un **progetto** o a un **servizio**, con uno di tre livelli:

| Livello | Progetto | Servizio |
|---|---|---|
| Lettura | stato, log, storico dei deploy, nomi delle variabili con valori mascherati | stato |
| Operatore | in più deploy, avvio, stop, riavvio | in più avvio, stop, riavvio |
| Gestione | in più impostazioni, variabili in chiaro, file, mount, comandi una tantum, eliminazione | in più credenziali, database interni, mount, impostazioni, eliminazione |

L'interruttore **Terminale e console**, da Operatore in su, apre una shell nei container e la console dei database. Ogni persona ha la sua sessione.

Vale il livello più alto tra gli accessi che riguardano un elemento. Un accesso a una cartella vale anche per ciò che ci finisce dopo, e un servizio collegato a un progetto segue l'accesso del progetto. Non esistono regole di divieto: per togliere un accesso si toglie la riga. Chi non vede un progetto riceve "non trovato", come se non esistesse.

Con più server un accesso può puntare a un progetto o servizio di qualunque server: nell'editor ogni elemento ha accanto il nome del server.

### Permessi del pannello

Interruttori per account: Crea progetti e servizi, GitHub, Registry, Storage, Backup, Ripristino, Monitor, Avvio automatico, Diagnostica, Notifiche, Aggiornamenti, Accesso all'host, Gestione utenti, Registro attività, Server collegati. Menu e pulsanti li seguono, ma il controllo vero lo fa il server su ogni richiesta e su ogni stream.

Da dare con attenzione:

- **Accesso all'host.** Runtime nativi (PM2), Compose, cartelle condivise (anche sui servizi), cap Docker, rete host, comandi una tantum e modifica del codice di un progetto (file, upload, repository) escono dal container e arrivano fino al database del pannello e alla sua chiave segreta. Senza questo permesso, anche chi ha Gestione su un progetto lavora solo con container Docker semplici.
- **Backup e Ripristino.** Chi non è proprietario salva e ripristina solo i progetti e i servizi che gestisce, uno per uno. Il backup del pannello e quello con la chiave segreta restano al proprietario.
- **Gestione utenti.** Non permette di toccare il proprietario né sé stessi, di concedere un permesso o un livello che non si possiede, né di modificare, reimpostare o eliminare un account con più accessi dei propri.
- **Server collegati.** Collegare, diagnosticare, cambiare ruolo e revocare i server del cluster, e rigenerare il segreto condiviso. Non dà accesso ai progetti degli altri server, che seguono i permessi di sempre.

I **modelli rapidi** compilano i campi in un clic e poi si ritoccano:

| Modello | Permessi | Accesso |
|---|---|---|
| Visualizzatore | nessuno | Lettura su tutto |
| Sviluppatore | Crea progetti e servizi, GitHub | Operatore su tutto |
| Operatore sistema | Monitor, Storage, Backup, Avvio automatico, Diagnostica | Operatore su tutto |
| Nessun accesso | nessuno | nessuno |

### Chi ha accesso

Nelle impostazioni di un progetto o di un servizio, chi gestisce gli utenti vede gli account che lo raggiungono, con livello e provenienza dell'accesso, e da lì può cambiarli.

## Revoca

Togliere un accesso, disattivare o eliminare un account, chiudere una sessione: ha effetto subito, e gli stream e le shell aperti di quell'utente si chiudono. Disattivare un account lo disconnette da ogni dispositivo.

## Registro attività

**Accessi › Registro attività** elenca chi ha fatto cosa: accessi riusciti e falliti, inviti, modifiche ai permessi, deploy, riavvii, modifiche a variabili e impostazioni, terminali aperti, backup, ripristini, aggiornamenti, eliminazioni. Si filtra per categoria, periodo, persona, azione e oggetto (un progetto, un database, una cartella, un utente, un'area del pannello); i filtri restano nell'indirizzo, così una vista filtrata si salva nei preferiti. **Vedi attività** nella pagina di un utente, e nel menu **Altro** di un progetto, la apre già filtrata. Ogni account vede solo le voci sulle risorse che può vedere, e le voci di sicurezza solo chi gestisce gli utenti. Con più server ogni server tiene il proprio registro, e la pagina mostra quello del server selezionato.

**Esporta CSV** scarica quello che mostrano i filtri, dal più recente, fino a 100.000 voci: data e ora nel fuso del pannello e in UTC, persona, azione, categoria, oggetto, dettaglio e indirizzo. Il file si apre con un doppio clic in un foglio di calcolo: separatore `;` (quello che si aspetta un foglio di calcolo in italiano), UTF-8, e ogni cella che inizierebbe una formula (`=`, `+`, `-`, `@`) scritta come testo. In modalità esperto c'è anche la versione con la `,`. Anche ogni esportazione finisce nel registro.

Il proprietario sceglie quali categorie registrare (Sicurezza, Deploy, Configurazione, Terminale, Backup, Sistema, Eliminazioni; Sicurezza è sempre attiva) e per quanti giorni conservarle, da 1 a 3650 (90 di default). Le voci contengono nomi, mai valori segreti, e una scrittura del registro non riuscita non blocca l'azione che descrive.

## Aggiornare da una versione con la sola password

Se il pannello era stato configurato quando aveva una sola password, il primo accesso dopo l'aggiornamento si fa lasciando vuota l'email; subito dopo il pannello la chiede. Le sessioni aperte restano valide.
