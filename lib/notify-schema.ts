import { z } from "zod";
import { isBlockedRepoHost } from "./validation";
import { NOTIFY_EVENTS, NOTIFY_FILTERS } from "./notify-events";
import {
  DEFAULT_NTFY_SERVER,
  DISCORD_WEBHOOK_PATTERN,
  EMAIL_PATTERN,
  HEADER_NAME_PATTERN,
  HEADER_VALUE_PATTERN,
  MAX_EMAIL_RECIPIENTS,
  MAX_WEBHOOK_HEADERS,
  MIN_SIGNING_SECRET,
  NTFY_TOPIC_PATTERN,
  SLACK_WEBHOOK_PATTERN,
  TELEGRAM_CHAT_PATTERN,
  TELEGRAM_TOKEN_PATTERN,
  isReservedHeader,
  type ChannelKind,
} from "./notify-channels";

/**
 * The request bodies of the notification routes.
 *
 * Validated here rather than trusted from the form, for the reason the S3
 * destination schema gives: a channel is stored encrypted and read back by a
 * notifier nobody is watching, so a typo has to be a 400 now, not a message
 * that never arrives on the night it mattered. Every message is in Italian and
 * names what to fix.
 *
 * Relative imports only, so the unit suite can load this file with the same
 * hook `validation-unit` uses.
 */

/**
 * Link-local addresses: cloud metadata endpoints live there (169.254.169.254)
 * and nothing a notification is for ever does. Refused outright.
 */
function isLinkLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * Where a webhook or an ntfy server may be: anywhere over https, or over plain
 * http inside a private network — a self-hosted ntfy on the LAN, an n8n on the
 * same machine. The same rule, and the same definition of "private", as the S3
 * endpoint of a backup destination.
 */
export function outboundUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Non è un indirizzo valido: deve iniziare con https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Serve un indirizzo https://";
  if (isLinkLocal(url.hostname)) return "Questo indirizzo non è raggiungibile dal pannello per una notifica";
  if (url.protocol === "http:" && !isBlockedRepoHost(url.hostname)) {
    return "Su internet serve https://; http:// va bene solo verso un indirizzo privato";
  }
  return null;
}

const outboundUrl = z
  .string()
  .trim()
  .min(1, "Serve un indirizzo")
  .max(2000, "L'indirizzo è troppo lungo")
  .superRefine((value, ctx) => {
    const problem = outboundUrlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const nameSchema = z
  .string()
  .trim()
  .min(1, "Dai un nome al canale")
  .max(60, "Il nome è troppo lungo: al massimo 60 caratteri");

const eventsSchema = z
  .array(z.enum(NOTIFY_EVENTS, { message: "Uno degli eventi non esiste più: ricarica la pagina" }))
  .max(NOTIFY_EVENTS.length * 2);

const filterSchema = z.enum(NOTIFY_FILTERS, { message: "Scegli «Tutto» o «Solo i problemi»" });

const recipientSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Indirizzo email troppo lungo")
  .regex(EMAIL_PATTERN, "Uno dei destinatari non è un indirizzo email valido");

const emailConfig = z
  .object({
    to: z
      .array(recipientSchema)
      .min(1, "Serve almeno un destinatario")
      .max(MAX_EMAIL_RECIPIENTS, `Al massimo ${MAX_EMAIL_RECIPIENTS} destinatari`),
  })
  .strict();

const telegramConfig = z
  .object({
    chatId: z
      .string()
      .trim()
      .regex(TELEGRAM_CHAT_PATTERN, "Chat non valida: un numero (negativo per i gruppi) o @nomedelcanale"),
  })
  .strict();

const ntfyConfig = z
  .object({
    server: outboundUrl.default(DEFAULT_NTFY_SERVER),
    topic: z
      .string()
      .trim()
      .regex(NTFY_TOPIC_PATTERN, "L'argomento può avere solo lettere, numeri, - e _ (al massimo 64)"),
  })
  .strict();

const emptyConfig = z.object({}).strict();

const botToken = z.string().trim().regex(TELEGRAM_TOKEN_PATTERN, "Token del bot non valido: copialo intero da @BotFather");
const discordUrl = z
  .string()
  .trim()
  .regex(DISCORD_WEBHOOK_PATTERN, "Non sembra un webhook di Discord: deve iniziare con https://discord.com/api/webhooks/");
const slackUrl = z
  .string()
  .trim()
  .regex(SLACK_WEBHOOK_PATTERN, "Non sembra un webhook di Slack: deve iniziare con https://hooks.slack.com/");
const ntfyToken = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{1,256}$/, "Il token di ntfy è una sola parola, senza spazi");
const signingSecret = z
  .string()
  .min(MIN_SIGNING_SECRET, `Il segreto deve avere almeno ${MIN_SIGNING_SECRET} caratteri`)
  .max(256, "Il segreto è troppo lungo")
  .regex(/^[\x21-\x7e]+$/, "Il segreto può avere solo caratteri visibili, senza spazi");

const headerName = z
  .string()
  .trim()
  .regex(HEADER_NAME_PATTERN, "Nome di intestazione non valido: lettere, numeri e trattini")
  .refine((name) => !isReservedHeader(name), { message: "Questa intestazione la imposta già il pannello" });

/** On create every value is required; on edit a blank one keeps the stored value. */
const headerOnCreate = z
  .object({ name: headerName, value: z.string().regex(HEADER_VALUE_PATTERN, "Valore di intestazione non valido") })
  .strict();
const headerOnEdit = z
  .object({
    name: headerName,
    value: z
      .string()
      .refine((value) => value === "" || HEADER_VALUE_PATTERN.test(value), { message: "Valore di intestazione non valido" })
      .optional(),
  })
  .strict();

function uniqueHeaderNames(headers: readonly { name: string }[]): boolean {
  const seen = new Set(headers.map((header) => header.name.trim().toLowerCase()));
  return seen.size === headers.length;
}

const headersOnCreate = z
  .array(headerOnCreate)
  .max(MAX_WEBHOOK_HEADERS, `Al massimo ${MAX_WEBHOOK_HEADERS} intestazioni`)
  .refine(uniqueHeaderNames, { message: "Due intestazioni hanno lo stesso nome" });
const headersOnEdit = z
  .array(headerOnEdit)
  .max(MAX_WEBHOOK_HEADERS, `Al massimo ${MAX_WEBHOOK_HEADERS} intestazioni`)
  .refine(uniqueHeaderNames, { message: "Due intestazioni hanno lo stesso nome" });

const common = {
  name: nameSchema,
  enabled: z.boolean().optional(),
  events: eventsSchema,
  filter: filterSchema.optional(),
};

export const createChannelSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("email"), config: emailConfig, secrets: emptyConfig.optional() }).strict(),
  z
    .object({ ...common, kind: z.literal("telegram"), config: telegramConfig, secrets: z.object({ botToken }).strict() })
    .strict(),
  z
    .object({ ...common, kind: z.literal("discord"), config: emptyConfig.optional(), secrets: z.object({ webhookUrl: discordUrl }).strict() })
    .strict(),
  z
    .object({ ...common, kind: z.literal("slack"), config: emptyConfig.optional(), secrets: z.object({ webhookUrl: slackUrl }).strict() })
    .strict(),
  z
    .object({ ...common, kind: z.literal("ntfy"), config: ntfyConfig, secrets: z.object({ token: ntfyToken.optional() }).strict().optional() })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("webhook"),
      config: emptyConfig.optional(),
      secrets: z.object({ url: outboundUrl, signingSecret, headers: headersOnCreate.optional() }).strict(),
    })
    .strict(),
]);

export type CreateChannelInput = z.infer<typeof createChannelSchema>;

/** A blank secret on edit means "keep the one stored", so it is read as absent. */
const blankIsKeep = <T extends z.ZodType<string>>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

/**
 * The body of an edit, which depends on the kind of the channel being edited:
 * the kind itself cannot change, since everything else about the channel
 * would have to.
 */
export function updateChannelSchema(kind: ChannelKind) {
  const base = {
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    events: eventsSchema.optional(),
    filter: filterSchema.optional(),
  };
  switch (kind) {
    case "email":
      return z.object({ ...base, config: emailConfig.partial().optional(), secrets: emptyConfig.optional() }).strict();
    case "telegram":
      return z
        .object({ ...base, config: telegramConfig.partial().optional(), secrets: z.object({ botToken: blankIsKeep(botToken) }).strict().optional() })
        .strict();
    case "discord":
      return z
        .object({ ...base, config: emptyConfig.optional(), secrets: z.object({ webhookUrl: blankIsKeep(discordUrl) }).strict().optional() })
        .strict();
    case "slack":
      return z
        .object({ ...base, config: emptyConfig.optional(), secrets: z.object({ webhookUrl: blankIsKeep(slackUrl) }).strict().optional() })
        .strict();
    case "ntfy":
      return z
        .object({
          ...base,
          config: z
            .object({ server: outboundUrl.optional(), topic: ntfyConfig.shape.topic.optional() })
            .strict()
            .optional(),
          // `null` removes the token; blank keeps it.
          secrets: z.object({ token: z.union([z.null(), blankIsKeep(ntfyToken)]) }).partial().strict().optional(),
        })
        .strict();
    case "webhook":
      return z
        .object({
          ...base,
          config: emptyConfig.optional(),
          secrets: z
            .object({ url: blankIsKeep(outboundUrl), signingSecret: blankIsKeep(signingSecret), headers: headersOnEdit.optional() })
            .strict()
            .optional(),
        })
        .strict();
  }
}

export type UpdateChannelInput = z.infer<ReturnType<typeof updateChannelSchema>>;

export const readNotificationsSchema = z.union([
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export const telegramChatsSchema = z
  .object({
    token: blankIsKeep(botToken),
    channelId: z.string().min(1).max(64).optional(),
  })
  .strict();

// --- The mail server -----------------------------------------------------------------

/** A host name or an address, nothing else: no scheme, no port, no path. */
const SMTP_HOST_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;

/** `panel@example.com`, or `RunPanel <panel@example.com>`. */
export const MAIL_FROM_PATTERN = /^(?:[^<>"\r\n]{1,100}\s<[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+>|[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+)$/;

export const smtpSettingsSchema = z
  .object({
    host: z
      .string()
      .trim()
      .max(253, "Nome del server troppo lungo")
      .regex(SMTP_HOST_PATTERN, "Solo il nome del server, per esempio smtp.esempio.it: senza smtp:// e senza porta"),
    port: z.number().int("La porta è un numero intero").min(1, "Porta non valida").max(65535, "Porta non valida"),
    security: z.enum(["starttls", "tls", "none"], { message: "Scegli il tipo di connessione" }),
    username: z.string().trim().max(254, "Nome utente troppo lungo"),
    /** Blank keeps the stored password. */
    password: z.string().max(512, "Password troppo lunga").optional(),
    from: z
      .string()
      .trim()
      .max(320, "Mittente troppo lungo")
      .regex(MAIL_FROM_PATTERN, "Il mittente è un indirizzo email, oppure Nome <indirizzo@esempio.it>"),
    allowInvalidCert: z.boolean().optional(),
  })
  .strict();

export type SmtpSettingsInput = z.infer<typeof smtpSettingsSchema>;

export const mailActionSchema = z.union([
  z.object({ action: z.literal("test"), to: recipientSchema }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
]);

/** The first problem, as one sentence for the field it belongs to. */
export function firstIssue(issues: readonly { message: string; path: PropertyKey[] }[]): string {
  return issues[0]?.message || "Dati non validi";
}
