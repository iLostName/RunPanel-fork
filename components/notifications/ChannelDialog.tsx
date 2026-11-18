"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Field } from "@/components/ui/Field";
import { FormError } from "@/components/ui/FormError";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { CopyField } from "@/components/ui/CopyField";
import { Code, Hint } from "@/components/ui/Hint";
import { Advanced, Technical } from "@/components/ui/Technical";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useNodeApi } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";
import { DEFAULT_NOTIFY_EVENTS, type NotifyEventKey, type NotifyFilter } from "@/lib/notify-events";
import {
  CHANNEL_KINDS,
  CHANNEL_KIND_INFO,
  DEFAULT_NTFY_SERVER,
  DISCORD_WEBHOOK_PATTERN,
  EMAIL_PATTERN,
  HEADER_NAME_PATTERN,
  MAX_EMAIL_RECIPIENTS,
  MAX_WEBHOOK_HEADERS,
  MIN_SIGNING_SECRET,
  NTFY_TOPIC_PATTERN,
  SLACK_WEBHOOK_PATTERN,
  TELEGRAM_CHAT_KIND,
  TELEGRAM_CHAT_PATTERN,
  TELEGRAM_TOKEN_PATTERN,
  isReservedHeader,
  parseRecipients,
  type ChannelKind,
  type PublicChannel,
} from "@/lib/notify-channels";
import { EventPicker } from "./EventPicker";

interface Chat {
  id: string;
  title: string;
  kind: string;
}

interface HeaderRow {
  name: string;
  /** Blank on an existing row keeps the stored value. */
  value: string;
  stored: boolean;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hard to guess on purpose: on ntfy.sh, knowing the topic is all it takes to read it. */
function randomTopic(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const buffer = new Uint8Array(14);
  crypto.getRandomValues(buffer);
  return `runpanel-${Array.from(buffer, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const isHttpUrl = (value: string) => /^https?:\/\/[^\s]+$/i.test(value.trim());

/** A text field with its label, hint and error, the panel's way. */
function TextInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  explain,
  secret = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: React.ReactNode;
  error?: string | null;
  explain?: React.ReactNode;
  secret?: boolean;
  mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error ?? undefined} explain={explain}>
      <TextField value={value} onChange={onChange} type={secret ? "password" : "text"} aria-label={label} isInvalid={Boolean(error)}>
        <Input
          placeholder={placeholder}
          className={cn(mono && "font-mono text-sm")}
          autoComplete={secret ? "new-password" : "off"}
          spellCheck={false}
        />
      </TextField>
    </Field>
  );
}

/**
 * Adding or editing one channel.
 *
 * A new channel starts from the kind — the six ways out, each in one line —
 * and asks only what that kind needs, in plain words; what an expert might
 * want (the ntfy server, custom headers, how the signature works) waits under
 * "Avanzate". On edit every secret field starts empty with "configurato" in
 * it: leaving it so keeps what is stored, which the server never sends back.
 *
 * A new channel is tested as soon as it is saved, so a wrong token shows up
 * now, while the person who typed it is still looking.
 */
export function ChannelDialog({
  isOpen,
  onOpenChange,
  channel,
  mailReady,
  isOwner,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to add a new one. */
  channel: PublicChannel | null;
  mailReady: boolean;
  isOwner: boolean;
  onSaved: () => void;
}) {
  const api = useNodeApi();
  const editing = channel !== null;
  const config = channel?.config ?? {};
  const has = (field: string) => Boolean(channel?.secrets[field]);

  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "telegram");
  const [name, setName] = useState(channel?.name ?? "");
  const [nameTouched, setNameTouched] = useState(editing);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [events, setEvents] = useState<NotifyEventKey[]>(channel?.events ?? [...DEFAULT_NOTIFY_EVENTS]);
  const [filter, setFilter] = useState<NotifyFilter>(channel?.filter ?? "all");

  const [recipients, setRecipients] = useState(Array.isArray(config.to) ? (config.to as string[]).join(", ") : "");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(typeof config.chatId === "string" ? config.chatId : "");
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [ntfyServer, setNtfyServer] = useState(typeof config.server === "string" ? config.server : DEFAULT_NTFY_SERVER);
  const [topic, setTopic] = useState(() => (typeof config.topic === "string" ? config.topic : editing ? "" : randomTopic()));
  const [ntfyToken, setNtfyToken] = useState("");
  const [removeNtfyToken, setRemoveNtfyToken] = useState(false);
  const [url, setUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [headers, setHeaders] = useState<HeaderRow[]>(
    Array.isArray(config.headerNames) ? (config.headerNames as string[]).map((header) => ({ name: header, value: "", stored: true })) : []
  );
  const [serverError, setServerError] = useState<string | null>(null);

  const info = CHANNEL_KIND_INFO[kind];
  const shownName = nameTouched ? name : name || info.label;

  // --- what is wrong, field by field ------------------------------------------
  const recipientList = parseRecipients(recipients);
  const badRecipient = recipientList.find((address) => !EMAIL_PATTERN.test(address));
  const problems: Record<string, string | null> = {
    name: shownName.trim() ? null : "Dai un nome al canale",
    recipients:
      kind !== "email"
        ? null
        : badRecipient
          ? `«${badRecipient}» non è un indirizzo email valido`
          : recipientList.length > MAX_EMAIL_RECIPIENTS
            ? `Al massimo ${MAX_EMAIL_RECIPIENTS} destinatari`
            : null,
    botToken: kind === "telegram" && botToken.trim() && !TELEGRAM_TOKEN_PATTERN.test(botToken.trim()) ? "Non sembra un token di BotFather: numeri, due punti, poi il resto" : null,
    chatId: kind === "telegram" && chatId.trim() && !TELEGRAM_CHAT_PATTERN.test(chatId.trim()) ? "Un numero (negativo per i gruppi) o @nomedelcanale" : null,
    webhookUrl:
      (kind === "discord" && webhookUrl.trim() && !DISCORD_WEBHOOK_PATTERN.test(webhookUrl.trim())
        ? "Deve iniziare con https://discord.com/api/webhooks/"
        : null) ??
      (kind === "slack" && webhookUrl.trim() && !SLACK_WEBHOOK_PATTERN.test(webhookUrl.trim())
        ? "Deve iniziare con https://hooks.slack.com/services/"
        : null),
    topic: kind === "ntfy" && topic.trim() && !NTFY_TOPIC_PATTERN.test(topic.trim()) ? "Solo lettere, numeri, - e _ (al massimo 64)" : null,
    ntfyServer: kind === "ntfy" && !isHttpUrl(ntfyServer) ? "Un indirizzo che inizia con https://" : null,
    url: kind === "webhook" && url.trim() && !isHttpUrl(url) ? "Un indirizzo che inizia con https://" : null,
    signingSecret:
      kind === "webhook" && signingSecret && signingSecret.length < MIN_SIGNING_SECRET
        ? `Almeno ${MIN_SIGNING_SECRET} caratteri: premi «Genera» per uno sicuro`
        : null,
    headers:
      kind !== "webhook"
        ? null
        : headers.some((row) => row.name.trim() && !HEADER_NAME_PATTERN.test(row.name.trim()))
          ? "Nome di intestazione non valido: lettere, numeri e trattini"
          : headers.some((row) => isReservedHeader(row.name.trim()))
            ? "Una delle intestazioni la imposta già il pannello"
            : headers.some((row) => row.name.trim() && !row.stored && !row.value.trim())
              ? "Ogni intestazione nuova ha bisogno di un valore"
              : null,
  };

  // What a save needs that is not there yet. On edit a stored secret counts.
  const missing =
    (kind === "email" && recipientList.length === 0) ||
    (kind === "telegram" && ((!botToken.trim() && !has("botToken")) || !chatId.trim())) ||
    ((kind === "discord" || kind === "slack") && !webhookUrl.trim() && !has("webhookUrl")) ||
    (kind === "ntfy" && !topic.trim()) ||
    (kind === "webhook" && ((!url.trim() && !has("url")) || (!signingSecret && !has("signingSecret"))));
  const invalid = Object.values(problems).some(Boolean);

  function chooseKind(next: ChannelKind) {
    setKind(next);
    setServerError(null);
  }

  async function detectChats() {
    setDetecting(true);
    try {
      const res = await fetch(api("/api/notifications/telegram/chats"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botToken.trim() ? { token: botToken.trim() } : { channelId: channel?.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; chats?: Chat[]; error?: string };
      setChats(body.chats ?? []);
      if (body.error) toast.error(body.error);
      else if (body.chats?.length === 1) setChatId(body.chats[0].id);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setDetecting(false);
    }
  }

  function payload(): Record<string, unknown> {
    const common = { name: shownName.trim(), enabled, events, filter };
    switch (kind) {
      case "email":
        return { ...common, config: { to: recipientList } };
      case "telegram":
        return { ...common, config: { chatId: chatId.trim() }, secrets: { botToken: botToken.trim() } };
      case "discord":
      case "slack":
        return { ...common, secrets: { webhookUrl: webhookUrl.trim() } };
      case "ntfy":
        return {
          ...common,
          config: { server: ntfyServer.trim(), topic: topic.trim() },
          secrets: removeNtfyToken ? { token: null } : { token: ntfyToken.trim() },
        };
      case "webhook":
        return {
          ...common,
          secrets: {
            url: url.trim(),
            signingSecret,
            // On edit a blank value keeps the stored one; the server merges.
            headers: headers.filter((row) => row.name.trim()).map((row) => ({ name: row.name.trim(), value: row.value.trim() })),
          },
        };
    }
  }

  /** A create sends only what it has: a blank optional secret is simply left out. */
  function createBody(): Record<string, unknown> {
    const body = { kind, ...payload() } as Record<string, unknown> & { secrets?: Record<string, unknown> };
    if (kind === "ntfy") body.secrets = ntfyToken.trim() ? { token: ntfyToken.trim() } : {};
    if (kind === "email") delete body.secrets;
    return body;
  }

  async function submit(): Promise<boolean> {
    setServerError(null);
    const res = await fetch(api(editing ? `/api/notifications/channels/${channel.id}` : "/api/notifications/channels"), {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? payload() : createBody()),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; channel?: PublicChannel };
    if (!res.ok) {
      setServerError(body.error ?? (editing ? MSG.saveFailed : MSG.createFailed));
      return false;
    }

    if (!editing && body.channel) {
      // Tested straight away, like a backup destination: a wrong token or URL
      // is found now, by whoever just typed it.
      try {
        const test = await fetch(api(`/api/notifications/channels/${body.channel.id}/test`), { method: "POST" });
        const verdict = (await test.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (verdict.ok) toast.success(`«${body.channel.name}» aggiunto: controlla che la prova sia arrivata.`);
        else toast.warning(`«${body.channel.name}» aggiunto, ma la prova non è arrivata`, { description: verdict.error });
      } catch {
        toast.success(`«${body.channel.name}» aggiunto`);
      }
    } else {
      toast.success("Canale salvato");
    }
    onSaved();
    return true;
  }

  const secretPlaceholder = (field: string, fallback: string) => (has(field) ? "••••••••  (configurato)" : fallback);
  const keepHint = (field: string) => (has(field) ? "Lascia vuoto per tenere quello salvato." : undefined);

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      wide
      title={editing ? `Modifica «${channel.name}»` : "Nuovo canale di notifica"}
      submitLabel={editing ? "Salva" : "Aggiungi e invia una prova"}
      isSubmitDisabled={missing || invalid}
      onSubmit={submit}
    >
      {editing ? (
        <div className="flex items-center gap-2">
          <Icon icon={info.icon} width={18} className="text-muted" aria-hidden />
          <Badge>{info.label}</Badge>
          {!channel.secretsReadable && <Badge tone="danger">Segreti da reinserire</Badge>}
        </div>
      ) : (
        <div className="space-y-2">
          <span className="text-foreground block text-sm">Dove vuoi ricevere gli avvisi?</span>
          <ChoiceGroup label="Dove vuoi ricevere gli avvisi" className="sm:grid-cols-2">
            {CHANNEL_KINDS.map((candidate) => (
              <ChoiceCard
                key={candidate}
                selected={kind === candidate}
                onSelect={() => chooseKind(candidate)}
                icon={CHANNEL_KIND_INFO[candidate].icon}
                title={CHANNEL_KIND_INFO[candidate].label}
                description={CHANNEL_KIND_INFO[candidate].description}
              />
            ))}
          </ChoiceGroup>
        </div>
      )}

      {editing && !channel.secretsReadable && (
        <Hint tone="warn" title="I segreti salvati non sono più leggibili">
          Sono stati cifrati con un&apos;altra chiave del pannello (un backup ripristinato altrove, o la chiave cambiata).
          Inseriscili di nuovo: finché non lo fai, il canale non invia niente.
        </Hint>
      )}

      <TextInput
        label="Nome"
        value={shownName}
        onChange={(next) => {
          setName(next);
          setNameTouched(true);
        }}
        placeholder={info.label}
        hint="Come lo riconosci nell'elenco: per esempio «Telegram del team» o «Email di Marco»."
        error={nameTouched ? problems.name : null}
      />

      {/* --- what this kind needs ---------------------------------------------- */}
      {kind === "email" && (
        <>
          {!mailReady && (
            <Hint tone="warn" title="Manca il server di posta">
              {isOwner
                ? "Per mandare email il pannello usa un server SMTP: configuralo nella sezione «Server di posta» di questa pagina. Puoi salvare il canale anche ora."
                : "Per mandare email il pannello usa un server SMTP, che configura il proprietario. Puoi salvare il canale anche ora: inizierà a inviare quando il server ci sarà."}
            </Hint>
          )}
          <TextInput
            label="Destinatari"
            value={recipients}
            onChange={setRecipients}
            placeholder="ops@esempio.it, mario@esempio.it"
            hint={`Uno o più indirizzi, separati da virgole. Al massimo ${MAX_EMAIL_RECIPIENTS}.`}
            error={problems.recipients}
          />
        </>
      )}

      {kind === "telegram" && (
        <>
          {!editing && (
            <Hint tone="tip" title="Come si collega">
              Su Telegram apri <strong className="text-foreground">@BotFather</strong>, scrivi <Code>/newbot</Code> e incolla qui
              il token che ti dà. Poi scrivi un messaggio qualsiasi al tuo bot e premi <strong className="text-foreground">Rileva</strong>.
              Il pannello parla solo in uscita: non serve che sia raggiungibile da internet.
            </Hint>
          )}
          <TextInput
            label="Token del bot"
            value={botToken}
            onChange={setBotToken}
            secret
            mono
            placeholder={secretPlaceholder("botToken", "123456789:AA…")}
            hint={keepHint("botToken") ?? "Viene verificato con Telegram e salvato cifrato; da qui non si rilegge più."}
            error={problems.botToken}
          />
          <div className="space-y-2">
            <TextInput
              label="Chat"
              value={chatId}
              onChange={setChatId}
              mono
              placeholder="123456789"
              hint="Chi riceve i messaggi: tu, un gruppo o un canale. Premi Rileva dopo aver scritto al bot."
              error={problems.chatId}
            />
            <Button
              size="sm"
              variant="secondary"
              isPending={detecting}
              isDisabled={detecting || (!botToken.trim() && !has("botToken")) || Boolean(problems.botToken)}
              onPress={() => void detectChats()}
            >
              <Icon icon="solar:magnifer-linear" width={15} aria-hidden />
              Rileva
            </Button>
            {chats !== null && chats.length > 0 && (
              <ul className="border-border divide-border divide-y overflow-hidden rounded-[var(--radius)] border">
                {chats.map((chat) => (
                  <li key={chat.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                      {chat.title}
                      <span className="text-muted ml-2 text-xs">{TELEGRAM_CHAT_KIND[chat.kind] ?? chat.kind}</span>
                    </span>
                    <Technical>
                      <code className="text-muted shrink-0 font-mono text-xs">{chat.id}</code>
                    </Technical>
                    <Button size="sm" variant={chatId === chat.id ? "secondary" : "ghost"} onPress={() => setChatId(chat.id)}>
                      {chatId === chat.id ? "Scelta" : "Usa"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {(kind === "discord" || kind === "slack") && (
        <>
          {!editing && (
            <Hint tone="tip" title="Dove si trova l'URL">
              {kind === "discord" ? (
                <>
                  Nel tuo server Discord: impostazioni del canale › <strong className="text-foreground">Integrazioni</strong> ›{" "}
                  <strong className="text-foreground">Webhook</strong> › Nuovo webhook › Copia URL del webhook.
                </>
              ) : (
                <>
                  Su <Code>api.slack.com/apps</Code> crea un&apos;app, attiva <strong className="text-foreground">Incoming Webhooks</strong>{" "}
                  e aggiungine uno per il canale che vuoi: copia l&apos;URL che inizia con <Code>https://hooks.slack.com/services/</Code>.
                </>
              )}
            </Hint>
          )}
          <TextInput
            label="URL del webhook"
            value={webhookUrl}
            onChange={setWebhookUrl}
            secret
            mono
            placeholder={secretPlaceholder(
              "webhookUrl",
              kind === "discord" ? "https://discord.com/api/webhooks/…" : "https://hooks.slack.com/services/…"
            )}
            hint={
              keepHint("webhookUrl") ??
              "Chi ha questo indirizzo può scrivere nel canale: viene salvato cifrato e non si rilegge più."
            }
            explain={typeof config.hint === "string" && config.hint ? `Salvato: ${config.hint}` : undefined}
            error={problems.webhookUrl}
          />
        </>
      )}

      {kind === "ntfy" && (
        <>
          {!editing && (
            <Hint tone="tip" title="Come si collega">
              Installa l&apos;app <strong className="text-foreground">ntfy</strong> sul telefono e iscriviti allo stesso argomento qui sotto.
              Su ntfy.sh chiunque conosca il nome dell&apos;argomento può leggerlo: quello proposto è difficile da indovinare.
            </Hint>
          )}
          <div className="space-y-2">
            <TextInput
              label="Argomento"
              value={topic}
              onChange={setTopic}
              mono
              placeholder="runpanel-…"
              hint="Lo stesso nome che scrivi nell'app ntfy, alla voce «Iscriviti a un argomento»."
              error={problems.topic}
            />
            <Button size="sm" variant="ghost" onPress={() => setTopic(randomTopic())}>
              <Icon icon="solar:refresh-linear" width={15} aria-hidden />
              Proponine un altro
            </Button>
          </div>
          <Advanced
            summary="server ntfy tuo, token di accesso"
            defaultExpanded={editing && (ntfyServer !== DEFAULT_NTFY_SERVER || has("token")) ? true : undefined}
          >
            <TextInput
              label="Server"
              value={ntfyServer}
              onChange={setNtfyServer}
              mono
              placeholder={DEFAULT_NTFY_SERVER}
              hint="Cambialo solo se usi un server ntfy tuo. http:// va bene solo dentro la tua rete."
              error={problems.ntfyServer}
            />
            <TextInput
              label="Token di accesso"
              value={ntfyToken}
              onChange={(next) => {
                setNtfyToken(next);
                setRemoveNtfyToken(false);
              }}
              secret
              mono
              placeholder={secretPlaceholder("token", "tk_…")}
              hint={keepHint("token") ?? "Facoltativo: serve se l'argomento è protetto da un account."}
            />
            {has("token") && (
              <SettingToggle
                label="Togli il token salvato"
                description="L'argomento verrà usato senza autenticazione."
                isSelected={removeNtfyToken}
                onChange={(on) => {
                  setRemoveNtfyToken(on);
                  if (on) setNtfyToken("");
                }}
              />
            )}
          </Advanced>
        </>
      )}

      {kind === "webhook" && (
        <>
          <TextInput
            label="Indirizzo"
            value={url}
            onChange={setUrl}
            secret
            mono
            placeholder={secretPlaceholder("url", "https://automazioni.esempio.it/runpanel")}
            hint={keepHint("url") ?? "Riceve una richiesta POST con un JSON per ogni avviso. http:// solo verso un indirizzo della tua rete."}
            explain={typeof config.hint === "string" && config.hint ? `Salvato: ${config.hint}` : undefined}
            error={problems.url}
          />
          <div className="space-y-2">
            <TextInput
              label="Segreto per la firma"
              value={signingSecret}
              onChange={(next) => {
                setSigningSecret(next);
                setGeneratedSecret(null);
              }}
              secret
              mono
              placeholder={secretPlaceholder("signingSecret", "almeno 16 caratteri")}
              hint={
                keepHint("signingSecret") ??
                "Con questo il servizio che riceve controlla che la richiesta arrivi davvero dal pannello."
              }
              error={problems.signingSecret}
            />
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                const secret = randomHex(32);
                setSigningSecret(secret);
                setGeneratedSecret(secret);
              }}
            >
              <Icon icon="solar:key-linear" width={15} aria-hidden />
              Genera
            </Button>
            {generatedSecret && (
              <div className="space-y-1.5">
                <CopyField value={generatedSecret} label="Segreto generato" secret />
                <p className="text-warning text-meta">
                  Copialo ora nel servizio che riceve: dopo il salvataggio il pannello non lo mostra più.
                </p>
              </div>
            )}
          </div>

          <Advanced summary="intestazioni aggiuntive, come verificare la firma">
            <div className="space-y-2">
              <span className="text-foreground block text-sm">Intestazioni aggiuntive</span>
              {headers.map((row, index) => (
                <div key={index} className="flex items-start gap-2">
                  <TextField
                    value={row.name}
                    onChange={(next) => setHeaders((rows) => rows.map((r, i) => (i === index ? { ...r, name: next, stored: false } : r)))}
                    aria-label={`Nome dell'intestazione ${index + 1}`}
                    className="w-2/5"
                  >
                    <Input placeholder="Authorization" className="font-mono text-sm" spellCheck={false} />
                  </TextField>
                  <TextField
                    value={row.value}
                    onChange={(next) => setHeaders((rows) => rows.map((r, i) => (i === index ? { ...r, value: next } : r)))}
                    type="password"
                    aria-label={`Valore dell'intestazione ${index + 1}`}
                    className="flex-1"
                  >
                    <Input placeholder={row.stored ? "••••  (configurato)" : "Bearer …"} className="font-mono text-sm" autoComplete="new-password" />
                  </TextField>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={`Togli l'intestazione ${row.name || index + 1}`}
                    onPress={() => setHeaders((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Icon icon="solar:trash-bin-trash-linear" width={15} aria-hidden />
                  </Button>
                </div>
              ))}
              <FormError>{problems.headers}</FormError>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={headers.length >= MAX_WEBHOOK_HEADERS}
                onPress={() => setHeaders((rows) => [...rows, { name: "", value: "", stored: false }])}
              >
                <Icon icon="solar:add-circle-linear" width={15} aria-hidden />
                Aggiungi un&apos;intestazione
              </Button>
              <p className="text-muted text-meta">I valori sono salvati cifrati, come gli altri segreti.</p>
            </div>
            <div className="text-muted space-y-1.5 text-xs leading-relaxed">
              <p className="text-foreground text-sm">Come verificare la firma</p>
              <p>
                Ogni richiesta porta <Code>X-RunPanel-Timestamp</Code> (secondi Unix) e <Code>X-RunPanel-Signature</Code>, che vale{" "}
                <Code>v1=</Code> seguito dall&apos;HMAC-SHA256 esadecimale, con il segreto, di <Code>timestamp.corpo</Code>: il
                timestamp, un punto e il corpo della richiesta così com&apos;è arrivato.
              </p>
              <p>
                Rifiuta le richieste con un timestamp lontano più di 5 minuti dal tuo orologio. <Code>X-RunPanel-Delivery</Code>{" "}
                identifica la consegna, anche quando viene ritentata. Esempi in Node e Python nella documentazione, alla pagina
                Notifiche.
              </p>
            </div>
          </Advanced>
        </>
      )}

      {/* --- what it receives --------------------------------------------------- */}
      <EventPicker events={events} onEventsChange={setEvents} filter={filter} onFilterChange={setFilter} />

      {editing && (
        <SettingToggle
          label="Canale attivo"
          description="Spento, non invia niente; le notifiche restano comunque nella campanella."
          isSelected={enabled}
          onChange={setEnabled}
        />
      )}

      <FormError>{serverError}</FormError>
    </FormDialog>
  );
}
