import { DEFAULT_NTFY_SERVER } from "@/lib/notify-channels";
import { discordPayload, emailContent, ntfyPayload, slackPayload, webhookBody, type Outbound } from "@/lib/notify-format";
import { WEBHOOK_HEADERS, signWebhook } from "@/lib/notify-sign";
import { sendMail } from "@/services/mail";
import { link, render, type Html } from "./messages";
import { sendMessage } from "./telegram";
import type { ChannelRecord } from "./channels";

/**
 * One function per way out. Each takes a channel and a message, sends it once,
 * and answers with what happened — never throws, never waits more than its
 * timeout. Coalescing, retries and bookkeeping are `deliver.ts`'s; this file
 * only knows how to talk to each service.
 *
 * Adding a kind of channel is a `case` here, a row in `lib/notify-channels.ts`
 * and its fields in `lib/notify-schema.ts` and on the settings screen.
 */

/** A message as it travels: the catalogue's typed HTML, so Telegram gets it unconverted. */
export type Delivery = Outbound & { body: Html };

export interface SendResult {
  ok: boolean;
  /** In Italian, for the channel's row on the settings screen. */
  error?: string;
  /** A timeout, a dropped connection, a 5xx or a 429: one more try is worth it. */
  retryable?: boolean;
  retryAfterMs?: number;
}

/** Long enough for a slow network, short enough not to hold anything up. */
const TIMEOUT_MS = 10_000;

const USER_AGENT = "RunPanel-Notifier/1";

export async function sendVia(channel: ChannelRecord, message: Delivery, deliveryId: string): Promise<SendResult> {
  if (!channel.secretsReadable) {
    return {
      ok: false,
      error: "I segreti del canale non sono più leggibili: la chiave del pannello è cambiata. Inseriscili di nuovo.",
    };
  }
  const secrets = channel.secrets;
  const config = channel.config;

  switch (channel.kind) {
    case "telegram": {
      const footer: Html | undefined = message.link ? link(message.link, "Apri in RunPanel") : undefined;
      const result = await sendMessage(
        String(secrets.botToken ?? ""),
        String(config.chatId ?? ""),
        render({ level: message.level, title: message.title, body: message.body }, footer)
      );
      return result.ok ? { ok: true } : { ok: false, error: result.error, retryable: result.retryable, retryAfterMs: result.retryAfterMs };
    }

    case "discord":
      return postJson(String(secrets.webhookUrl ?? ""), JSON.stringify(discordPayload(message)), {}, true);

    case "slack":
      return postJson(String(secrets.webhookUrl ?? ""), JSON.stringify(slackPayload(message)), {}, true);

    case "ntfy": {
      const server = String(config.server || DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
      const token = typeof secrets.token === "string" && secrets.token ? secrets.token : null;
      return postJson(
        `${server}/`,
        JSON.stringify(ntfyPayload(message, String(config.topic ?? ""))),
        token ? { Authorization: `Bearer ${token}` } : {},
        true
      );
    }

    case "webhook": {
      const body = webhookBody(message);
      const timestamp = Math.floor(Date.now() / 1000);
      const custom = secrets.headers && typeof secrets.headers === "object" ? (secrets.headers as Record<string, string>) : {};
      return postJson(
        String(secrets.url ?? ""),
        body,
        {
          ...custom,
          [WEBHOOK_HEADERS.event]: message.event,
          [WEBHOOK_HEADERS.delivery]: deliveryId,
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.signature]: signWebhook(String(secrets.signingSecret ?? ""), timestamp, body),
        },
        // A generic endpoint's reply is not shown: the URL is whatever someone
        // typed, possibly a service on the panel's own network, and its answer
        // is none of the screen's business. The status code says enough.
        false
      );
    }

    case "email": {
      const to = Array.isArray(config.to) ? config.to.filter((value): value is string => typeof value === "string") : [];
      if (to.length === 0) return { ok: false, error: "Nessun destinatario." };
      const result = await sendMail({ to, ...emailContent(message) });
      return result.ok ? { ok: true } : { ok: false, error: result.error, retryable: result.retryable };
    }
  }
}

/**
 * POST a JSON body, with a timeout and without following redirects.
 *
 * A redirect is refused rather than followed: the address was checked when it
 * was saved, and a 302 is how a request ends up somewhere that was not — a
 * service on the panel's own network, a host the rules would have refused.
 */
async function postJson(url: string, body: string, headers: Record<string, string>, reflect: boolean): Promise<SendResult> {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, error: "Indirizzo del canale non valido." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, ...headers },
      body,
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    const detail = reflect ? await shortReply(res) : null;
    if (!reflect) await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      error: httpProblem(res.status, detail),
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfter(res.headers.get("retry-after")),
    };
  } catch (err) {
    return networkProblem(err, host);
  } finally {
    clearTimeout(timer);
  }
}

/** The service's own explanation, one short line of it: Discord, Slack and ntfy all say what is wrong. */
async function shortReply(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 2000);
    let detail = text;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const candidate = json.message ?? json.error ?? json.description;
      if (typeof candidate === "string") detail = candidate;
    } catch {
      /* plain text, as Slack answers */
    }
    // eslint-disable-next-line no-control-regex
    const line = detail.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : null;
  } catch {
    return null;
  }
}

function httpProblem(status: number, detail: string | null): string {
  const tail = detail ? `: ${detail}` : "";
  if (status >= 300 && status < 400) {
    return `Il destinatario ha risposto con un reindirizzamento (HTTP ${status}): usa direttamente l'indirizzo finale.`;
  }
  if (status === 401 || status === 403) return `Rifiutato (HTTP ${status})${tail}. Il token o l'indirizzo non sono più validi?`;
  if (status === 404 || status === 410) return `Indirizzo non trovato (HTTP ${status})${tail}. Il webhook è stato eliminato?`;
  if (status === 413) return `Messaggio troppo grande per il destinatario (HTTP 413)${tail}.`;
  if (status === 429) return `Troppe richieste (HTTP 429)${tail}: il servizio chiede di rallentare.`;
  if (status >= 500) return `Il servizio ha risposto con un errore (HTTP ${status})${tail}.`;
  return `Il destinatario ha risposto HTTP ${status}${tail}.`;
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

const CERT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** A request that never got an answer, in words: which of the usual four it was. */
function networkProblem(err: unknown, host: string): SendResult {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "AbortError") return { ok: false, error: `Nessuna risposta da ${host} entro ${TIMEOUT_MS / 1000} s.`, retryable: true };
  const code = e?.cause?.code ?? "";
  if (code === "ENOTFOUND") return { ok: false, error: `${host} non esiste (DNS): controlla l'indirizzo.` };
  if (code === "EAI_AGAIN") return { ok: false, error: `Il DNS non ha risposto per ${host}.`, retryable: true };
  if (code === "ECONNREFUSED") return { ok: false, error: `${host} ha rifiutato la connessione.`, retryable: true };
  if (CERT_CODES.has(code)) return { ok: false, error: `Il certificato HTTPS di ${host} non è valido (${code}).` };
  if (code === "UND_ERR_CONNECT_TIMEOUT") return { ok: false, error: `Connessione a ${host} scaduta.`, retryable: true };
  const detail = e?.cause?.message ?? e?.message ?? "errore sconosciuto";
  return { ok: false, error: `Richiesta a ${host} non riuscita: ${detail}`, retryable: true };
}
