[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/notifications.md)

---

# Notifiche

Il pannello dice cosa è successo in due posti:

- la **campanella** nella barra in alto, e la pagina **Notifiche** che apre: ogni account ha la sua, e ci vede solo quello che può vedere;
- i **canali**, che mandano gli stessi eventi fuori dal pannello: email, Telegram, Discord, Slack, ntfy, o un webhook firmato verso un tuo servizio.

Tutto quello che segue riguarda il server selezionato nella barra: con [più server](multi-server.md) ognuno tiene le sue notifiche e i suoi canali.

## La campanella

Qui finisce ogni evento, comunque siano impostati i canali. Chi lo vede:

- se riguarda un **progetto** o un **servizio** (un crash, un deploy, un riavvio programmato): chi può vedere quel progetto o quel servizio, deciso quando la lista viene letta, quindi un accesso dato o tolto dopo vale anche per le notifiche vecchie;
- se riguarda la **macchina** o il **pannello**: chi ha il permesso della pagina che mostra la stessa cosa (Backup per i backup, Aggiornamenti per gli aggiornamenti, Storage per il disco, Diagnostica per Docker; Monitor per quello che non ne ha una);
- il **proprietario** vede tutto.

Lette e da leggere sono per account. Aprire una notifica la segna come letta; **Segna tutte come lette** azzera il conteggio in ogni scheda in cui l'account è aperto. La campanella si aggiorna in tempo reale (Server-Sent Events, una connessione per scheda, chiusa mentre la scheda è in secondo piano); se un proxy trattiene lo stream, ricontrolla da sola ogni minuto.

La pagina **Notifiche** filtra per da leggere, argomento e gravità. Le notifiche restano 30 giorni, e mai più delle ultime 5000.

## I canali

In **Impostazioni › Generale › Notifiche**, per il proprietario e per chi ha il permesso **Notifiche**. Un canale riceve gli eventi che ha scelto su *tutti* i progetti del server: avere il permesso vuol dire leggere quello che il pannello dice di tutti.

| Canale | Cosa serve |
|---|---|
| **Email** | Uno o più indirizzi, e il server di posta del pannello (vedi sotto) |
| **Telegram** | Il token di un bot creato con `@BotFather` e la chat: scrivi al bot, poi **Rileva** elenca le chat che gli hanno scritto |
| **Discord** | L'URL di un webhook del canale (impostazioni del canale › Integrazioni › Webhook) |
| **Slack** | Un URL di *Incoming Webhooks* (`https://hooks.slack.com/services/…`) |
| **ntfy** | Un argomento, a cui ti iscrivi dall'app ntfy; se vuoi, un tuo server e un token di accesso |
| **Webhook** | Un indirizzo https (http solo verso un indirizzo privato) e un segreto per la firma |

Per ognuno scegli un nome, gli **eventi** che riceve e **cosa inviare**: *Tutto*, oppure *Solo quando qualcosa va storto* — errori, crash, disco quasi pieno. È così che si imposta «avvisami su Telegram quando un deploy fallisce»: Telegram, l'evento dei deploy, solo i problemi. Un problema che si risolve (Docker che risponde di nuovo, il disco che torna sopra la soglia) arriva comunque, perché un avviso non resti mai senza il suo cessato allarme. Un evento aggiunto in una versione successiva prende il suo valore predefinito anche sui canali salvati prima che esistesse.

Un canale nuovo viene provato appena salvato; **Invia una prova** ne manda un'altra quando vuoi. I segreti (token del bot, URL dei webhook, segreto della firma, valori delle intestazioni, token di ntfy) sono cifrati a riposo con la chiave del pannello e non vengono più mostrati: in modifica il campo dice *configurato*, e lasciarlo vuoto tiene quello salvato. L'elenco mostra, per ogni canale, l'esito dell'ultimo invio — *Ultimo invio non riuscito: …* con il motivo, senza nessun segreto.

### Il server di posta

**Impostazioni › Generale › Server di posta**, solo per il proprietario: lo stesso server porterà inviti e recupero della password, e chi lo controlla li legge. Scegli un servizio (Gmail, Outlook, Microsoft 365, iCloud, Aruba, Brevo, Mailgun) o scrivi il tuo; server, porta e sicurezza sono in *Avanzate*.

- **STARTTLS** sulla 587, **TLS** sulla 465; *Nessuna* solo per un server dentro la tua rete.
- Gmail, Outlook e iCloud vogliono una **password per le app**, non quella dell'account.
- *Accetta certificati non verificati* è per un server interno con un certificato tuo; su internet lascialo spento.
- **Invia una prova** manda un'email di prova. Gli errori sono spiegati: sicurezza che non corrisponde alla porta, password rifiutata, porta bloccata dal provider (molti bloccano la 25).

### ntfy

Su `ntfy.sh` chiunque conosca il nome di un argomento può leggerlo, quindi il pannello ne propone uno difficile da indovinare. Con un tuo server, mettine l'indirizzo in *Avanzate*, con un token di accesso se l'argomento è protetto. I messaggi partono con l'API JSON di ntfy: gli errori hanno priorità alta, mai *max*, che scavalca il «non disturbare».

### Webhook

Ogni notifica è una `POST` con un corpo JSON:

```json
{
  "id": "Xq2…",
  "event": "deploy.finished",
  "level": "danger",
  "title": "Deploy fallito — api",
  "text": "Commit: 4d480c7 …\nErrore: exit code 1",
  "url": "https://panel.esempio.it/projects/abc",
  "server": null,
  "at": "2026-11-18T10:00:00.000Z",
  "data": { "slug": "api", "ok": false, "trigger": "webhook", "…": "…" }
}
```

`event` è la chiave dell'evento (`test` per una prova); `level` è `ok`, `info`, `warn` o `danger`; `url` c'è quando è impostato l'indirizzo pubblico del pannello (**Impostazioni › Generale**); `server` è il nome del server in un cluster. `data` porta i campi dell'evento e può crescere da una versione all'altra. Un webhook riceve ogni evento da solo, mai raggruppato, fino a 30 ogni 10 minuti.

Intestazioni:

| Intestazione | Valore |
|---|---|
| `X-RunPanel-Event` | la chiave dell'evento |
| `X-RunPanel-Delivery` | un id per consegna, lo stesso nel suo nuovo tentativo: serve a ignorare i doppioni |
| `X-RunPanel-Timestamp` | i secondi Unix dell'invio |
| `X-RunPanel-Signature` | `v1=` seguito dall'HMAC-SHA256 esadecimale, con il segreto della firma, di `<timestamp>.<corpo>` |

Per verificare, calcola l'HMAC sul **corpo così com'è arrivato** (non sul JSON riserializzato), confronta in tempo costante e rifiuta un timestamp lontano più di **5 minuti** dal tuo orologio: visto che il timestamp è firmato, è questo che impedisce di rigiocare più tardi una richiesta intercettata.

```js
// Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const timestamp = headers["x-runpanel-timestamp"];
  const signature = headers["x-runpanel-signature"] ?? "";
  if (!/^\d+$/.test(timestamp ?? "") || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

```python
# Python
import hashlib, hmac, time

def verify(secret: str, headers, raw_body: bytes) -> bool:
    timestamp = headers.get("X-RunPanel-Timestamp", "")
    signature = headers.get("X-RunPanel-Signature", "")
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, signature)
```

Qualsiasi 2xx è un successo. Un reindirizzamento non viene seguito (conta come errore: usa l'indirizzo finale), e la risposta del destinatario non compare nel pannello, solo il suo codice. Le intestazioni in più (un `Authorization`, una chiave API) sono in *Avanzate*; i loro valori sono salvati con i segreti.

## Cosa viene notificato

| Evento | Quando |
|---|---|
| **Un progetto si è fermato da solo**, **Un servizio si è fermato da solo** | Il processo non c'è più e non l'ha fermato il pannello (due interruttori separati, conferma su due letture) |
| **Riavvio programmato** | Un riavvio programmato eseguito, o il tentativo dopo un crash fallito |
| **Docker non risponde** | Il daemon diventa irraggiungibile, e quando torna (non se era già giù all'avvio del pannello) |
| **Deploy concluso** | Sempre per i deploy automatici; per quelli manuali solo se falliscono |
| **Backup concluso** | Riuscito, parziale o fallito, con artefatti, dimensione e durata |
| **Aggiornamento del pannello disponibile** | Il controllo ha trovato commit nuovi |
| **Il pannello è ripartito** | Dopo un riavvio o un aggiornamento; spento di default |
| **Spazio su disco in esaurimento** | Vedi sotto |

Viene notificato il momento in cui una soglia viene attraversata, non lo stato.

### Lo spazio su disco

- **Basso**: sotto il 10% o i 4 GB liberi, o sotto il 5% degli inode. Funziona ancora tutto, ma il prossimo build o la copia di un volume grande possono riempire il resto.
- **Critico**: sotto i 2 GB (la riserva sotto cui un backup non parte), sotto il 3%, o sotto il 2% degli inode. Backup rifiutati, build che falliscono, database che non scrivono.

Il controllo gira ogni cinque minuti, il primo 90 secondi dopo l'avvio, sul disco dei dati e, se è un altro, su quello di Docker. Ogni policy di backup pianificata viene confrontata con lo spazio che le servirà (il doppio dell'ultimo archivio più la riserva): se non ci sta, l'avviso arriva prima dell'esecuzione. Le soglie hanno un margine prima di dirsi rientrate, e il rientro viene notificato.

## Perché non diventi rumore

- **Una volta ogni quarto d'ora** per lo stesso evento sullo stesso soggetto (un progetto, un disco, una policy): un progetto che continua a cadere non copre un altro, e il messaggio dopo dice quante volte è successo nel frattempo. Deploy, backup e riavvii programmati non vengono mai trattenuti. La campanella conta le ripetizioni sulla notifica che le ha annunciate.
- **Gli avvisi ravvicinati si uniscono**, canale per canale: il primo parte subito, quelli che arrivano entro un minuto (due per l'email) arrivano insieme, in un messaggio solo che li elenca. Quando si ferma Docker, venti servizi che si fermano con lui sono un messaggio, non venti.
- **Un nuovo tentativo** dopo un errore temporaneo (timeout, 5xx, 429 rispettando l'attesa richiesta).

## Se la notifica non parte

Non si blocca niente: un deploy non fallisce perché un canale non risponde. Il motivo compare sulla riga del canale e nel log del pannello, spiegato dove il servizio è criptico: con Telegram, `chat not found` di solito vuol dire che non hai ancora scritto al bot; con l'email, vedi il server di posta qui sopra.

## Dalla versione con il solo Telegram

Il bot configurato prima che esistessero i canali diventa il primo canale, *Telegram*, con gli stessi eventi, la prima volta che il pannello legge i suoi canali. In un cluster il bot era condiviso: ogni server ne fa una copia sua, e da lì in poi i canali di ogni server sono suoi.
