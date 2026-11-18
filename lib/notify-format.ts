/**
 * One notification, in the format each channel speaks.
 *
 * The catalogue in `services/notify/messages.ts` writes every message once, in
 * the small HTML dialect Telegram parses: `<b>`, `<code>`, `<a href>`, and the
 * three entities `escapeHtml` produces. Nothing else can appear in it — the
 * `Html` type there guarantees it — so instead of a second catalogue per
 * channel, this file reads that dialect back into a tree and writes it out as
 * plain text, Discord's Markdown, Slack's mrkdwn, an email, or the panel's own
 * notification centre. An event added to the catalogue reaches every channel
 * with no change here.
 *
 * The output is rebuilt from the tree and escaped for its destination, never
 * passed through: a commit subject with `**` or `<@everyone>` in it is text in
 * every one of these formats.
 *
 * Zero imports: the unit suite loads it directly, and the browser renders the
 * notification centre with the same parser.
 */

export type NotifyLevel = "ok" | "warn" | "danger" | "info";

export type NotifyNode =
  | string
  | { tag: "b"; children: NotifyNode[] }
  | { tag: "code"; children: NotifyNode[] }
  | { tag: "a"; href: string; children: NotifyNode[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name]);
}

/** The tags the dialect has; anything else that looks like one is text. */
const TAG = /<(\/?)(b|code|a)(?:\s+href="([^"<>]*)")?\s*>/g;

/**
 * The dialect as a tree.
 *
 * Forgiving where it can be: a closer with no opener is dropped, an opener
 * with no closer ends with the text, and a link whose address is not http(s)
 * keeps its label and loses the link.
 */
export function parseNotifyHtml(html: string): NotifyNode[] {
  type Frame = { tag: "root" | "b" | "code" | "a"; href?: string; children: NotifyNode[] };
  const root: Frame = { tag: "root", children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1];

  const pushText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const children = top().children;
    const last = children[children.length - 1];
    if (typeof last === "string") children[children.length - 1] = last + text;
    else children.push(text);
  };

  let cursor = 0;
  for (const match of html.matchAll(TAG)) {
    pushText(html.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;

    const closing = match[1] === "/";
    const tag = match[2] as "b" | "code" | "a";
    if (closing) {
      const at = stack.map((frame) => frame.tag).lastIndexOf(tag);
      if (at <= 0) continue;
      while (stack.length > at) close();
      continue;
    }
    // A link with no address is not a tag, and neither is `<b href>`.
    if (tag === "a" && match[3] === undefined) {
      pushText(match[0]);
      continue;
    }
    if (tag !== "a" && match[3] !== undefined) {
      pushText(match[0]);
      continue;
    }
    stack.push({ tag, href: match[3], children: [] });
  }
  pushText(html.slice(cursor));
  while (stack.length > 1) close();
  return root.children;

  function close() {
    const frame = stack.pop()!;
    const parent = top().children;
    if (frame.tag === "a") {
      const href = decodeEntities(frame.href ?? "");
      if (/^https?:\/\/[^\s"'<>\\`]+$/.test(href)) parent.push({ tag: "a", href, children: frame.children });
      else parent.push(...frame.children);
    } else if (frame.tag === "b") {
      parent.push({ tag: "b", children: frame.children });
    } else if (frame.tag === "code") {
      parent.push({ tag: "code", children: frame.children });
    }
  }
}

function textOf(nodes: readonly NotifyNode[]): string {
  return nodes.map((node) => (typeof node === "string" ? node : textOf(node.children))).join("");
}

/** At most `max` characters, never half of a surrogate pair, with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}…`;
}

// --- The formats -------------------------------------------------------------------

/** Plain text: an SMS-grade rendering, for ntfy, email and the webhook's `text`. */
export function toPlainText(html: string): string {
  const walk = (nodes: readonly NotifyNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return node;
        if (node.tag === "a") {
          const label = walk(node.children);
          return label && label !== node.href ? `${label} (${node.href})` : node.href;
        }
        return walk(node.children);
      })
      .join("");
  return walk(parseNotifyHtml(html)).trim();
}

/** Discord's Markdown: every character that formats is escaped in text. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#[\]()-])/g, "\\$1");
}

export function toDiscordMarkdown(html: string): string {
  const walk = (nodes: readonly NotifyNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return escapeMarkdown(node);
        if (node.tag === "b") return `**${walk(node.children)}**`;
        // Inside code nothing formats, so nothing is escaped — but a backtick
        // would end it, so it becomes a look-alike.
        if (node.tag === "code") return `\`${textOf(node.children).replace(/`/g, "ˋ")}\``;
        return `[${walk(node.children)}](${node.href.replace(/\)/g, "%29")})`;
      })
      .join("");
  return walk(parseNotifyHtml(html)).trim();
}

/** Slack's mrkdwn: only `&`, `<` and `>` are special to its parser, and they are entities. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toSlackMrkdwn(html: string): string {
  const walk = (nodes: readonly NotifyNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return escapeSlack(node);
        if (node.tag === "b") return `*${walk(node.children)}*`;
        if (node.tag === "code") return `\`${escapeSlack(textOf(node.children).replace(/`/g, "ˋ"))}\``;
        const label = textOf(node.children).replace(/[|<>]/g, "");
        return `<${node.href.replace(/[|<>]/g, encodeURIComponent)}|${escapeSlack(label)}>`;
      })
      .join("");
  return walk(parseNotifyHtml(html)).trim();
}

/** A full HTML escape, quotes included: the email is read by a real HTML parser. */
function escapeFull(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toEmailHtml(html: string): string {
  const walk = (nodes: readonly NotifyNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return escapeFull(node).replace(/\n/g, "<br>\n");
        if (node.tag === "b") return `<strong>${walk(node.children)}</strong>`;
        if (node.tag === "code") {
          return `<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f3f5;padding:1px 4px;border-radius:4px">${walk(node.children)}</code>`;
        }
        return `<a href="${escapeFull(node.href)}">${walk(node.children)}</a>`;
      })
      .join("");
  return walk(parseNotifyHtml(html)).trim();
}

// --- Messages as they leave ---------------------------------------------------------

/** One notification ready to go out, whatever the channel. */
export interface Outbound {
  /** The notification's id in the panel, or a fresh one for a test. */
  id: string;
  /** The event key; `test` for a test, `digest` for several joined together. */
  event: string;
  level: NotifyLevel;
  /** Plain text. Already carries the server's name in a cluster. */
  title: string;
  /** The catalogue's HTML dialect. */
  body: string;
  /** An absolute link into the panel, when it knows its own public address. */
  link: string | null;
  server: string | null;
  /** ISO time of the event. */
  at: string;
  /** The event's own fields, for a program reading the webhook. */
  data?: Record<string, unknown> | null;
  /** For a digest: what it joined. */
  items?: { id: string; event: string; level: NotifyLevel; title: string; at: string }[];
}

export const LEVEL_EMOJI: Record<NotifyLevel, string> = { ok: "✅", warn: "⚠️", danger: "🔴", info: "ℹ️" };

/** Embed and attachment colours: the same green, amber, red and blue as the panel's status colours. */
export const LEVEL_COLOR: Record<NotifyLevel, number> = { ok: 0x22c55e, warn: 0xf59e0b, danger: 0xef4444, info: 0x3b82f6 };

/** ntfy's 1–5. Never 5: "max" breaks through do-not-disturb, and nothing here is worth a phone at 3 a.m. by default. */
export const NTFY_PRIORITY: Record<NotifyLevel, number> = { danger: 4, warn: 3, ok: 2, info: 2 };

/** ntfy turns these tag names into the emoji in front of the title. */
export const NTFY_TAGS: Record<NotifyLevel, string> = {
  ok: "white_check_mark",
  warn: "warning",
  danger: "rotating_light",
  info: "information_source",
};

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, ok: 1, warn: 2, danger: 3 };

/** The worst of several levels: what a digest is coloured with. */
export function worstLevel(levels: readonly NotifyLevel[]): NotifyLevel {
  return levels.reduce<NotifyLevel>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), "info");
}

export function discordPayload(message: Outbound): Record<string, unknown> {
  return {
    username: "RunPanel",
    // A commit subject that says "@everyone" must not ping the whole server.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: cut(`${LEVEL_EMOJI[message.level]} ${message.title}`, 256),
        description: cut(toDiscordMarkdown(message.body), 4000),
        color: LEVEL_COLOR[message.level],
        ...(message.link ? { url: message.link } : {}),
        timestamp: message.at,
        ...(message.server ? { footer: { text: cut(message.server, 200) } } : {}),
      },
    ],
  };
}

export function slackPayload(message: Outbound): Record<string, unknown> {
  const body = toSlackMrkdwn(message.body);
  const head = `${LEVEL_EMOJI[message.level]} *${escapeSlack(message.title)}*`;
  const footer = [
    message.link ? `<${message.link.replace(/[|<>]/g, encodeURIComponent)}|Apri in RunPanel>` : null,
    message.server ? escapeSlack(message.server) : null,
  ].filter(Boolean);
  return {
    // The notification preview on a phone, and what an old client shows.
    text: cut(`${LEVEL_EMOJI[message.level]} ${message.title}`, 300),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: cut(body ? `${head}\n${body}` : head, 2900) } },
      ...(footer.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: footer.join(" · ") }] }] : []),
    ],
  };
}

/** ntfy's JSON publishing: no headers to encode, so a title with an accent or a dash survives. */
export function ntfyPayload(message: Outbound, topic: string): Record<string, unknown> {
  return {
    topic,
    title: cut(message.title, 250),
    message: cut(toPlainText(message.body) || message.title, 3900),
    priority: NTFY_PRIORITY[message.level],
    tags: [NTFY_TAGS[message.level]],
    ...(message.link ? { click: message.link } : {}),
  };
}

/**
 * The webhook's body, as the exact string that is signed and sent.
 *
 * A string and not an object, because the signature covers these bytes: a
 * receiver that parses and re-serialises before verifying would be checking
 * different ones, and the documentation says so.
 */
export function webhookBody(message: Outbound): string {
  return JSON.stringify({
    id: message.id,
    event: message.event,
    level: message.level,
    title: message.title,
    text: toPlainText(message.body),
    url: message.link,
    server: message.server,
    at: message.at,
    data: message.data ?? null,
    ...(message.items ? { items: message.items } : {}),
  });
}

export function emailContent(message: Outbound): { subject: string; text: string; html: string } {
  const plain = toPlainText(message.body);
  const text = [plain, message.link ? `Apri in RunPanel: ${message.link}` : null, "—\nRunPanel"]
    .filter(Boolean)
    .join("\n\n");
  const color = `#${LEVEL_COLOR[message.level].toString(16).padStart(6, "0")}`;
  const html = [
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328">`,
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-top:4px solid ${color};border-radius:8px;padding:20px 24px">`,
    `<h1 style="font-size:17px;line-height:1.35;margin:0 0 12px">${escapeFull(`${LEVEL_EMOJI[message.level]} ${message.title}`)}</h1>`,
    `<div style="font-size:14px;line-height:1.55">${toEmailHtml(message.body)}</div>`,
    message.link
      ? `<p style="margin:18px 0 0"><a href="${escapeFull(message.link)}" style="color:#2563eb">Apri in RunPanel</a></p>`
      : "",
    `</div>`,
    `<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#6b7280">${escapeFull(
      message.server ? `RunPanel · ${message.server}` : "RunPanel"
    )}: questa email arriva da un canale di notifica del pannello.</p>`,
    `</body></html>`,
  ].join("");
  return { subject: cut(`[RunPanel] ${message.title}`, 200), text, html };
}
