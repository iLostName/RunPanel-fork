[← RunPanel](../../README.md) · [Italiano](../it/notifications.md) · **English**

---

# Notifications

The panel says what happened in two places:

- **the bell** in the top bar, and the **Notifiche** page it opens: every account has one, and sees in it only what it may see;
- **channels**, which send the same events outside the panel: email, Telegram, Discord, Slack, ntfy, or a signed webhook to a service of yours.

Everything below concerns the server selected in the bar: with [several servers](multi-server.md) each one keeps its own notifications and its own channels.

## The bell

Every event is filed here, whatever the channels are set to. Who sees it:

- about a **project** or a **service** (a crash, a deploy, a scheduled restart): whoever can see that project or service, decided when the list is read, so a grant given or removed later applies to old notifications too;
- about the **machine** or the **panel**: whoever holds the permission for the page that shows the same thing (Backup for backups, Updates for updates, Storage for the disk, Diagnostics for Docker; Monitor for anything without one);
- the **owner** sees everything.

Read and unread are per account. Following a notification marks it read; **Segna tutte come lette** clears the count on every tab where the account is open. The bell updates live (Server-Sent Events, one connection per tab, given up while the tab is in the background); if a proxy buffers the stream, it falls back to checking every minute.

The **Notifiche** page filters by unread, topic and severity. Notifications are kept 30 days, and never more than the latest 5000.

## Channels

In **Impostazioni › Generale › Notifiche**, for the owner and whoever holds the **Notifications** permission. A channel receives the events it asked for about *every* project on the server: holding the permission means reading what the panel says about all of them.

| Channel | What it needs |
|---|---|
| **Email** | One or more addresses, and the panel's mail server (see below) |
| **Telegram** | A bot token from `@BotFather` and the chat: write to the bot, then **Rileva** lists the chats that wrote to it |
| **Discord** | A channel webhook URL (channel settings › Integrations › Webhooks) |
| **Slack** | An *Incoming Webhooks* URL (`https://hooks.slack.com/services/…`) |
| **ntfy** | A topic, subscribed to in the ntfy app; optionally your own server and an access token |
| **Webhook** | An https URL (http only towards a private address) and a signing secret |

For each one you choose a name, the **events** it receives, and **what to send**: *Tutto*, or *Solo quando qualcosa va storto* — failures, crashes, low disk. That is how "tell me on Telegram when a deploy fails" is set: Telegram, the deploy event, only problems. A problem that resolves (Docker answering again, the disk back above its threshold) is still sent, so a warning is never left without its all-clear. An event added in a later release takes its default on channels saved before it existed.

A new channel is tested as soon as it is saved; **Invia una prova** sends another test at any time. Secrets (bot token, webhook URLs, the signing secret, header values, the ntfy token) are encrypted at rest with the panel's key and never shown again: on edit the field reads *configurato*, and leaving it empty keeps what is stored. The list shows, per channel, the outcome of the last delivery — *Ultimo invio non riuscito: …* with the reason, every secret removed.

### The mail server

**Impostazioni › Generale › Server di posta**, the owner's alone: the same server will carry invitations and password resets, and whoever controls it reads them. Pick a provider (Gmail, Outlook, Microsoft 365, iCloud, Aruba, Brevo, Mailgun) or type your own; host, port and security are under *Avanzate*.

- **STARTTLS** on 587, **TLS** on 465; *Nessuna* only for a relay on your own network.
- Gmail, Outlook and iCloud want an **app password**, not the account's.
- *Accetta certificati non verificati* is for an internal server with its own certificate; on the internet leave it off.
- **Invia una prova** sends a test email. Errors are explained: a TLS mode that does not match the port, a refused password, a port blocked by the provider (many block 25).

### ntfy

On `ntfy.sh` anyone who knows a topic's name can read it, so the panel proposes a hard-to-guess one. With your own server, put its address under *Avanzate*, with an access token if the topic is protected. Messages are sent with ntfy's JSON API: errors are high priority, never *max*, which would break through do-not-disturb.

### Webhook

Every notification is a `POST` with a JSON body:

```json
{
  "id": "Xq2…",
  "event": "deploy.finished",
  "level": "danger",
  "title": "Deploy fallito — api",
  "text": "Commit: 4d480c7 …\nErrore: exit code 1",
  "url": "https://panel.example.com/projects/abc",
  "server": null,
  "at": "2026-11-18T10:00:00.000Z",
  "data": { "slug": "api", "ok": false, "trigger": "webhook", "…": "…" }
}
```

`event` is the event key (`test` for a test); `level` is `ok`, `info`, `warn` or `danger`; `url` is set when the panel's public address is (**Impostazioni › Generale**); `server` is the server's name in a cluster. `data` carries the event's own fields and may grow between releases. A webhook gets every event on its own, never joined, up to 30 every 10 minutes.

Headers:

| Header | Value |
|---|---|
| `X-RunPanel-Event` | the event key |
| `X-RunPanel-Delivery` | one id per delivery, the same on its retry: use it to ignore duplicates |
| `X-RunPanel-Timestamp` | Unix seconds when it was sent |
| `X-RunPanel-Signature` | `v1=` followed by the hex HMAC-SHA256, with the signing secret, of `<timestamp>.<body>` |

To verify, compute the HMAC over the **raw body exactly as received** (not re-serialised JSON), compare in constant time, and refuse a timestamp more than **5 minutes** from your clock: since the timestamp is signed, that is what stops a captured request from being replayed later.

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

Any 2xx is a success. A redirect is not followed (it counts as a failure: use the final address), and the receiver's reply is not shown in the panel, only its status code. Custom headers (an `Authorization`, an API key) are under *Avanzate*; their values are stored with the secrets.

## What is notified

| Event | When |
|---|---|
| **Un progetto si è fermato da solo**, **Un servizio si è fermato da solo** | The process is gone and the panel did not stop it (two separate switches, confirmed over two readings) |
| **Riavvio programmato** | A scheduled restart performed, or the attempt after a crash failed |
| **Docker non risponde** | The daemon becomes unreachable, and when it is back (not if it was already down when the panel started) |
| **Deploy concluso** | Always for automatic deploys; for manual ones only when they fail |
| **Backup concluso** | Succeeded, partial or failed, with artifacts, size and duration |
| **Aggiornamento del pannello disponibile** | The check found new commits |
| **Il pannello è ripartito** | After a restart or an update; off by default |
| **Spazio su disco in esaurimento** | See below |

What is notified is the moment a threshold is crossed, not the state.

### Disk space

- **Low**: under 10% or 4 GB free, or under 5% of inodes. Everything still works, but the next build or a large volume copy can fill the rest.
- **Critical**: under 2 GB (the reserve below which a backup does not start), under 3%, or under 2% of inodes. Backups refused, builds failing, databases unable to write.

The check runs every five minutes, the first 90 seconds after start, on the data disk and, if different, Docker's. Every scheduled backup policy is compared with the space it will need (twice the last archive plus the reserve): if it will not fit, the warning arrives before the run. Thresholds have a margin before counting as recovered, and recovery is notified.

## So that it does not become noise

- **Once per quarter of an hour** for the same event about the same subject (a project, a disk, a policy): a project that keeps falling does not hide another, and the next message says how many times it happened in between. Deploys, backups and scheduled restarts are never held back. The bell counts the repeats on the notification that announced them.
- **Bursts are joined** per channel: the first message goes out at once, what follows within a minute (two for email) arrives as one message listing them. When Docker stops, twenty services stopping with it are one message, not twenty.
- **One retry** after a temporary failure (timeout, 5xx, 429 honouring its wait).

## When a notification does not go out

Nothing is blocked: a deploy does not fail because a channel does not answer. The reason is on the channel's row and in the panel's log, explained where the service is cryptic: with Telegram, `chat not found` usually means you have not written to the bot yet; with email, see the mail server above.

## Upgrading from Telegram-only

The bot configured before channels existed becomes the first channel, *Telegram*, with the same events, the first time the panel reads its channels. In a cluster the bot was shared: each server that had it makes its own copy, and from then on each server's channels are its own. A server added to the cluster after the upgrade starts with no channels.
