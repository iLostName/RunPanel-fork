[← RunPanel](../../README.it.md) · **Italiano** · [English](../en/domains.md)

---

# Domini

Ogni progetto con una porta può essere servito su un indirizzo in HTTPS: `app.esempio.it` invece di `203.0.113.7:3001`. Il pannello scrive i server block per l'**nginx** che hai già sulla macchina e chiede a **certbot** un certificato Let's Encrypt per ogni indirizzo; i blocchi scritti da te non vengono mai toccati.

## Cosa serve

- Linux, con nginx e certbot installati (per esempio `sudo apt install nginx certbot`).
- Un dominio tuo e, presso il suo provider DNS, un record per ogni indirizzo — oppure **un solo record wildcard**, `*.esempio.it` → l'indirizzo pubblico del server (`A`, più `AAAA` se ha IPv6), che copre in una volta tutti i sottodomini. Ogni indirizzo ha il suo certificato. Il dominio intero (`esempio.it`) vuole un record suo: la wildcard non lo copre. Non serve saperlo prima: quando aggiungi un indirizzo, il progetto mostra i record esatti da creare e li verifica.
- Le porte 80 e 443 che arrivano a nginx: sulla 80 Let's Encrypt verifica il nome, per il primo certificato e a ogni rinnovo. Per i domini su [Cloudflare](#domini-su-cloudflare) la verifica passa invece dal DNS.

## Preparare nginx

Una volta per server, dalla pagina **Domini** oppure direttamente dal dialog che aggiunge un indirizzo a un progetto, che mostra lo stesso passaggio (serve il permesso *Accesso all'host*):

- **Manca nginx**: il pannello lo dice e dà il comando per installarlo; poi premi **Li ho installati**.
- **Pannello che gira da root**: premi **Prepara nginx**.
- **Altrimenti**: i comandi da incollare in un terminale con sudo, poi **Ho eseguito i comandi**. I comandi sudo compaiono solo per questo passaggio, e solo quando il pannello non può farlo da sé.
- **Manca certbot**: gli indirizzi sono serviti solo in HTTP finché non lo installi.

La preparazione aggiunge un solo file alla configurazione di nginx, `/etc/nginx/conf.d/runpanel.conf`, che include `/var/lib/runpanel-proxy/sites/*.conf`. Quella cartella, il webroot di certbot e i certificati stanno in `/var/lib/runpanel-proxy`, dell'utente del pannello, così certbot gira senza root. Testare e ricaricare nginx è l'unica cosa che richiede root, e il pannello ci arriva in uno di tre modi:

| Come gira il pannello | Come ricarica nginx |
|---|---|
| da root | esegue da sé `nginx -t` e `nginx -s reload` |
| sotto systemd (anche con la unit di RunPanel) | scrive un file di richiesta; due path unit di root lanciano `/usr/local/sbin/runpanel-nginx`, che testa, ricarica e lascia l'esito in `/run/runpanel-proxy` |
| senza systemd | una regola sudo che consente solo `nginx -t` e `nginx -s reload` |

La strada systemd non è un giro inutile: la unit di RunPanel imposta `NoNewPrivileges=yes`, con cui sudo non può funzionare — ed è un'impostazione da tenere, perché impedisce anche a ogni progetto nativo sotto il pannello di usare sudo.

Cancellare `/etc/nginx/conf.d/runpanel.conf` e ricaricare spegne in un colpo tutti i nomi gestiti.

## Dare un indirizzo a un progetto

Nel progetto, **Impostazioni › Indirizzi › Aggiungi**:

1. Scegli il dominio — se non ce n'è ancora uno, lo aggiungi lì (`esempio.it`); compare anche nella pagina **Domini**.
2. Scegli **un sottodominio** (`app`, con l'anteprima `https://app.esempio.it`) oppure **il dominio intero**. Quello che si può sapere mentre scrivi viene detto subito: un indirizzo che il progetto ha già, l'indirizzo del pannello, un'etichetta che il DNS rifiuterebbe. Un nome che appartiene a un altro progetto lo segnala il server quando premi **Aggiungi**.
3. Per il dominio intero o per il suo `www`, spunta **Anche www.esempio.it, che rimanda qui** (o il contrario): vedi [www](#www).

Poi il dialog mostra quello che viene dopo, in ordine: il server (la preparazione di nginx, se manca ancora), **il record DNS da creare** — tipo, nome e valore con i bottoni per copiarli, dove il valore è l'indirizzo pubblico di questo server — e il certificato. Finché il record non è giusto viene ricontrollato ogni pochi secondi, quindi puoi tenerlo aperto accanto al pannello del provider DNS; quando il record punta qui il certificato viene richiesto, e dopo qualche secondo l'indirizzo risulta *HTTPS attivo*. Lo stesso dialog si apre da **Verifica**, accanto a ogni indirizzo che non è ancora a posto.

Il certificato viene chiesto **solo quando il record DNS punta qui**. Let's Encrypt concede pochi controlli falliti per nome e per ora, quindi una richiesta fatta mentre il record manca è una richiesta sprecata. Se chiudi il dialog il pannello continua a guardare da solo — ogni 2 minuti nella prima ora, ogni 10 nel primo giorno, poi ogni ora — e lo chiede appena il record è giusto. **Richiedi il certificato** lo chiede subito, qualunque cosa dica il controllo.

Accanto a ogni indirizzo c'è il suo stato, a parole: *HTTPS attivo*, *In attesa del DNS*, *Certificato in arrivo*, *Il certificato scade tra N giorni* (sotto i 14 giorni, cioè quando i rinnovi non riescono da tempo), *Certificato scaduto*, *Certificato non ottenuto* con cosa fare (manca il record, la porta 80 non è raggiungibile, ha risposto un altro server, troppi tentativi…). In modalità esperto compare anche il messaggio originale di Let's Encrypt.

I certificati li rinnova il pannello, che controlla due volte al giorno come fa certbot: il rinnovo avviene solo negli ultimi 30 giorni. Let's Encrypt non manda più email di scadenza, quindi **Email per Let's Encrypt** (in **Domini › Avanzate**) è facoltativa: è solo il contatto dell'account.

## La verifica del DNS

Il controllo chiede a **server DNS pubblici**, 1.1.1.1 e poi 8.8.8.8, con un resolver nuovo ogni volta: quello del server è spesso una cache, che continuerebbe a rispondere "questo nome non esiste" per minuti dopo che il record è stato creato. Dove la rete fa uscire il DNS solo dal proprio resolver, il controllo ripiega su quello del server, e in modalità esperto lo dice.

La risposta viene confrontata con **gli indirizzi pubblici di questo server**: quelli delle sue interfacce oppure — dietro NAT, e sui cloud che danno l'indirizzo pubblico con un NAT 1:1, come EC2 — l'IPv4 che si vede da fuori, chiesto a OpenDNS (`myip.opendns.com`, una query DNS, tenuta per cinque minuti). Cosa può dire:

| Cosa dice la pagina | Significato |
|---|---|
| *Punta a questo server* | ogni record A/AAAA punta a questo server (il record AAAA è facoltativo) |
| *Non ancora trovato* | il record non c'è ancora, o non si è ancora propagato |
| *Punta altrove* | un record punta a un'altra macchina, che viene nominata — per esempio un `AAAA` vecchio, che manda altrove anche Let's Encrypt, perché prova prima IPv6 |
| *Dietro Cloudflare* | gli indirizzi sono quelli del proxy di Cloudflare (nuvola arancione), che nasconde dove porta il nome: va bene per un dominio collegato a Cloudflare; altrimenti collegalo, o metti la nuvola grigia finché il certificato non arriva |
| *Da confermare* | il record risolve, ma l'indirizzo pubblico di questo server non è noto |
| *DNS non raggiungibile* | i resolver non hanno risposto, il che non dice nulla del record |

Quando gli indirizzi non coincidono con quelli che il server conosce di sé, il pannello chiede anche il nome in HTTP, per un token a cui risponde solo questo nginx: se torna, il nome arriva davvero a questo server (un NAT, un indirizzo flottante) e l'indirizzo conta come giusto. Un record giusto per una famiglia e sbagliato per l'altra resta sbagliato.

## www

Il dominio intero può avere anche il suo `www` (o `www` il dominio intero): un secondo indirizzo del progetto che **rimanda** al primo con un 301, mantenendo percorso e query, in un solo passaggio. Ha il suo certificato e il suo record DNS, quindi può arrivare dopo quello principale senza bloccarlo. Il progetto non lo mostra da lì: le regole di rete e la password valgono sull'indirizzo a cui rimanda. Rimuovendo l'indirizzo principale se ne va anche il suo gemello; il gemello da solo si toglie dal suo menu e si rimette dal menu dell'indirizzo principale.

## Domini su Cloudflare

Se il DNS di un dominio sta su Cloudflare, il pannello può chiedere i certificati tramite la sua API: funzionano anche con il record in proxy (nuvola arancione) e con la porta 80 chiusa.

1. Su Cloudflare, **My Profile › API Tokens › Create Token**, con i permessi **Zone · Zone · Read** e **Zone · DNS · Edit** sulle zone che vuoi usare.
2. In **Domini › Avanzate** incolla il token e premi **Collega**: il pannello lo prova elencando le zone, e lo rifiuta con il motivo di Cloudflare se non basta. Un token che Cloudflare smette di accettare viene segnalato fuori da Avanzate.
3. La pagina mostra i domini del tuo account: **Aggiungi** li porta fra i domini del pannello. Quelli già aggiunti la cui zona è attiva su Cloudflare prendono l'etichetta *Cloudflare*, e i nomi che aspettavano un certificato, o se l'erano visto rifiutare sulla porta 80, lo richiedono da soli.

Per un dominio su Cloudflare certbot fa la verifica DNS-01: un hook del pannello pubblica il record TXT `_acme-challenge` tramite l'API, aspetta che i nameserver di Cloudflare lo restituiscano e lo cancella a verifica finita. Il token è cifrato nello store del pannello e arriva a certbot solo nell'ambiente di ogni esecuzione: non finisce mai in un file né nelle impostazioni di rinnovo.

**Con la nuvola arancione.** In Cloudflare metti **SSL/TLS** su **Full (strict)**: con *Flexible* Cloudflare parla HTTP al server, che una volta in HTTPS lo rimanda su HTTPS, e la pagina gira in tondo. Dietro il proxy ogni connessione arriva da Cloudflare, quindi nei blocchi di questi domini nginx prende l'indirizzo del visitatore da `CF-Connecting-IP`, e solo dagli [indirizzi di Cloudflare](https://www.cloudflare.com/ips/): le regole d'accesso dei progetti continuano a valere, e chi aggira Cloudflare non può scegliersi l'indirizzo.

Se scolleghi Cloudflare, i certificati già emessi restano e al rinnovo i loro nomi tornano alla verifica sulla porta 80. Allo stesso modo, un dominio che entra o esce dall'account cambia verifica al primo rinnovo.

## Come un nome arriva all'app

nginx inoltra alla porta su cui l'app ascolta davvero, in loopback, passando `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` e i WebSocket, con un limite di 100 MB per richiesta. Se cambi la porta del progetto o le sue regole d'accesso il blocco si riscrive da solo; eliminando il progetto se ne vanno anche i suoi nomi e i loro certificati.

**Progetti limitati.** Un indirizzo segue le [regole di rete](network.md) del progetto: nginx consente gli stessi indirizzi IP (e questa macchina) e rifiuta gli altri. Per esporre un progetto **solo** in HTTPS, limita la sua porta con la lista vuota ("solo questa macchina") e spunta **Raggiungibile da tutti tramite l'indirizzo**: la porta resta chiusa all'esterno, l'indirizzo è aperto.

**Password.** Spunta **Chiedi una password** sotto un indirizzo e scegli utente e password (almeno 8 caratteri): nginx li chiede (`auth_basic`) prima che qualsiasi richiesta arrivi all'app, che non li vede mai. Il pannello tiene solo l'hash (SHA-512 crypt), quindi una password dimenticata si sostituisce, non si recupera. Vale solo per l'indirizzo — la porta non cambia — e con una lista di IP devono passare entrambi. Finché non arriva il certificato l'indirizzo è servito in HTTP e la password viaggia in chiaro.

Gli indirizzi su cui risponde un progetto compaiono anche sotto il suo titolo, così si apre con un clic senza passare dalle Impostazioni; un lucchetto segna quelli protetti da password.

## Cosa viene rifiutato

- Un nome già servito da un altro blocco di nginx: nginx ne terrebbe uno solo e vincerebbe quello gestito, quindi il pannello lo lascia fuori e lo scrive sotto l'indirizzo.
- L'indirizzo del pannello stesso (**Impostazioni › Pannello › Indirizzo pubblico**), anche come gemello `www`.
- Un indirizzo assegnato due volte, un progetto senza porta (si imposta nel campo **Porta** delle impostazioni del progetto), un dominio ancora in uso, un gemello `www` per un sottodominio diverso da `www`.

## Limiti

- Un solo livello di sottodominio (`app.esempio.it`, non `api.app.esempio.it`) oppure il dominio intero (`esempio.it`).
- Per server: il record wildcard punta a una macchina, quindi con [più server](multi-server.md) ciascuno ha i suoi domini — per esempio `*.s1.esempio.it`.
- I nomi sconosciuti sotto la wildcard finiscono sul server di default di nginx. Se è il pannello, valuta un blocco catch-all che risponde `444`.
- L'include funziona dove `nginx.conf` carica `/etc/nginx/conf.d/*.conf` dentro `http {}`, come fanno Debian, Ubuntu e RHEL di serie. Con un `nginx.conf` scritto a mano che non lo fa, aggiungi tu quella riga.
- Con SELinux attivo (RHEL, Fedora) nginx può vedersi negare `/var/lib/runpanel-proxy` finché la cartella non ha l'etichetta giusta (`semanage fcontext` e `restorecon`).
- La verifica del DNS ha bisogno di poter interrogare 1.1.1.1 e 8.8.8.8 (e OpenDNS, per scoprire l'indirizzo di un server dietro NAT). Senza, la verifica dice che non ha avuto risposta e il certificato viene chiesto comunque, come prima che la verifica esistesse.
- Non disponibile quando il pannello gira in un container, o con `RUNPANEL_DISABLE_SCHEDULERS`, che tiene un'istanza di prova lontana dall'nginx dell'host.
