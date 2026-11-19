import type { GlobalPermission } from "./authz";

/**
 * What the panel is willing to tell you about, and how it is grouped.
 *
 * In `lib/` with no imports, because three places have to agree on this list
 * and one of them runs in the browser: the settings screen draws the toggles
 * from it, the API validates a saved selection against it, and the notifier
 * asks it whether an event is switched on. A second copy is how a screen ends
 * up offering a switch that turns nothing off.
 *
 * (The one import above is a type, erased before anything runs: the unit suite
 * still loads this file on its own.)
 *
 * Adding an event is three edits here — the key, a row in a group, and whether
 * it is on by default — plus its words in `services/notify/messages.ts`. Every
 * channel's checklist, the API's validation and the notification centre's
 * filters are drawn from this list, so a new key shows up in all of them.
 */

export const NOTIFY_EVENTS = [
  "project.crashed",
  "service.crashed",
  "restart.scheduled",
  "docker.down",
  "disk.low",
  "deploy.finished",
  "backup.finished",
  "panel.update",
  "panel.restarted",
  "uptime.down",
  "metrics.high",
  "task.failed",
] as const;

export type NotifyEventKey = (typeof NOTIFY_EVENTS)[number];

export interface NotifyEventGroup {
  id: string;
  label: string;
  description: string;
  events: { key: NotifyEventKey; label: string; description: string }[];
}

/**
 * The four groups the operator actually thinks in. The individual switches stay
 * per-event so a single noisy one can be silenced without losing its neighbours.
 */
export const NOTIFY_GROUPS: NotifyEventGroup[] = [
  {
    id: "trouble",
    label: "Crash e problemi",
    description: "Qualcosa è caduto senza che il pannello lo avesse fermato",
    events: [
      {
        key: "project.crashed",
        label: "Un progetto si è fermato da solo",
        description:
          "Il processo non c'è più e il pannello non lo aveva fermato. Confermato su due letture, quindi un pm2 che non risponde per un istante non manda niente.",
      },
      {
        key: "service.crashed",
        label: "Un database si è fermato da solo",
        description: "Stessa cosa per un container di database.",
      },
      {
        key: "restart.scheduled",
        label: "Riavvio programmato",
        description:
          "Quando un riavvio a orario fisso riavvia un progetto o un database, o ci prova dopo un crash e non ci riesce. I salti non vengono notificati.",
      },
      {
        key: "docker.down",
        label: "Docker non risponde",
        description:
          "Il daemon è irraggiungibile: niente container, niente provisioning, niente dump. Ti avvisa anche quando torna.",
      },
    ],
  },
  {
    id: "deploy",
    label: "Deploy",
    description: "Esito dei deploy dei progetti",
    events: [
      {
        key: "deploy.finished",
        label: "Deploy concluso",
        description:
          "Sempre per i deploy automatici, da webhook o da controllo periodico. Per quelli lanciati a mano solo se falliscono: quelli li stai già guardando.",
      },
    ],
  },
  {
    id: "backup",
    label: "Backup",
    description: "Esito delle esecuzioni di backup",
    events: [
      {
        key: "backup.finished",
        label: "Backup concluso",
        description:
          "Riuscito, parziale o fallito, con quanti artefatti e quanto pesano, e un avviso quando una copia non arriva in una delle destinazioni. Un backup notturno che fallisce in silenzio te ne accorgi il giorno che ti serve.",
      },
    ],
  },
  {
    id: "panel",
    label: "Pannello e host",
    description: "Lo stato di RunPanel e della macchina",
    events: [
      {
        key: "panel.update",
        label: "Aggiornamento del pannello disponibile",
        description: "Quando il controllo periodico trova commit nuovi su RunPanel.",
      },
      {
        key: "panel.restarted",
        label: "Il pannello è ripartito",
        description:
          "Dopo un riavvio o un aggiornamento. È anche il modo di accorgersi di un pannello che va in crash-loop.",
      },
      {
        key: "disk.low",
        label: "Spazio su disco in esaurimento",
        description:
          "Due livelli: basso sotto il 10% o i 4 GB liberi, critico sotto i 2 GB, dove i backup vengono rifiutati, le build delle immagini falliscono e i database rischiano i dati. Guarda anche gli inode, il disco di Docker se è un altro, e ti avvisa prima quando il prossimo backup pianificato non avrebbe spazio.",
      },
    ],
  },
  {
    id: "health",
    label: "Salute delle app",
    description: "Un'app che non risponde, un server sotto sforzo",
    events: [
      {
        key: "uptime.down",
        label: "Un'app non risponde",
        description:
          "Il pannello chiede ogni minuto la pagina del controllo di salute di ogni app che ha una porta. Ti avvisa dopo due risposte mancate di fila, e di nuovo quando l'app risponde da qualche minuto senza interruzioni.",
      },
      {
        key: "metrics.high",
        label: "CPU o memoria sopra il 90%",
        description:
          "Del server o di un progetto, per almeno 5 minuti di fila. Ti avvisa di nuovo quando torna sotto l'80% per altri 5 minuti, così un picco breve o un valore che oscilla sulla soglia non manda niente.",
      },
    ],
  },
  {
    id: "tasks",
    label: "Attività pianificate",
    description: "I comandi dei progetti che girano da soli a orari fissi",
    events: [
      {
        key: "task.failed",
        label: "Un'attività pianificata non riesce",
        description:
          "Quando un'esecuzione a orario fallisce o supera il tempo massimo, e di nuovo quando torna a riuscire. Finché continua a fallire te lo ricorda al massimo ogni 12 ore. Le esecuzioni saltate non mandano niente, e nemmeno un «Esegui ora» che fallisce: lo stai guardando.",
      },
    ],
  },
];

/** The default selection for a panel that has just connected a bot. */
export const DEFAULT_NOTIFY_EVENTS: NotifyEventKey[] = [
  "project.crashed",
  "service.crashed",
  "restart.scheduled",
  "docker.down",
  "disk.low",
  "deploy.finished",
  "backup.finished",
  "panel.update",
  "uptime.down",
  "metrics.high",
  "task.failed",
];

export function isNotifyEventKey(value: unknown): value is NotifyEventKey {
  return NOTIFY_EVENTS.includes(value as NotifyEventKey);
}

/**
 * Narrow whatever came out of the store, dropping anything no longer offered.
 *
 * A copy of the defaults, never the array itself: it is a module-level constant
 * shared by every caller, and one of them handing it to something that sorts or
 * pushes would change the defaults for the lifetime of the process.
 *
 * An empty stored list is honoured rather than treated as absent. Turning every
 * notification off has to be possible, and "no keys" is exactly how that looks.
 */
export function parseNotifyEvents(raw: string | null | undefined): NotifyEventKey[] {
  if (!raw) return [...DEFAULT_NOTIFY_EVENTS];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_NOTIFY_EVENTS];
    return parsed.filter(isNotifyEventKey);
  } catch {
    return [...DEFAULT_NOTIFY_EVENTS];
  }
}

/**
 * Where the panel kept its one channel before there were several: one Telegram
 * bot, one chat, one selection. Read once, to turn into the first channel of the
 * list (`services/notify/channels.ts`), and never written again.
 */
export const NOTIFY_EVENTS_SETTING = "notify_events";
export const TELEGRAM_TOKEN_SETTING = "telegram_bot_token";
export const TELEGRAM_CHAT_SETTING = "telegram_chat_id";

/** The label the checklists show for an event; the key itself for one this list no longer offers. */
export function eventLabel(key: string): string {
  for (const group of NOTIFY_GROUPS) {
    const event = group.events.find((candidate) => candidate.key === key);
    if (event) return event.label;
  }
  return key;
}

/** Which group an event is filed under, for the notification centre's filter. */
export function eventGroupOf(key: string): string | null {
  return NOTIFY_GROUPS.find((group) => group.events.some((event) => event.key === key))?.id ?? null;
}

// --- Who sees an event in the panel ------------------------------------------

/**
 * Who sees an event in the notification centre when it is not about a project
 * or a service, and where it links to.
 *
 * An event about a project or a service is shown to whoever can see that
 * project or service, whatever this says: the notifier works the subject out
 * from the event itself (`services/notify/center.ts`). What is left is the
 * machine and the panel, which belong to whoever holds the permission for the
 * page that would show the same thing. The owner sees everything.
 *
 * Optional per event: one with no row here goes to `monitor` holders and links
 * nowhere, which is the cautious reading of "something about this server".
 */
export interface NotifyEventMeta {
  permission: GlobalPermission;
  href: string | null;
}

export const NOTIFY_EVENT_META: Partial<Record<NotifyEventKey, Partial<NotifyEventMeta>>> = {
  "project.crashed": { href: "/projects" },
  "service.crashed": { href: "/services" },
  "restart.scheduled": { href: null },
  "docker.down": { permission: "diagnostics", href: "/diagnostics" },
  "disk.low": { permission: "storage", href: "/storage" },
  "deploy.finished": { href: "/projects" },
  "backup.finished": { permission: "backup", href: "/backups" },
  "panel.update": { permission: "updates", href: "/updates" },
  "panel.restarted": { permission: "updates", href: "/updates" },
  // About a project, which the event names by id: these only apply to the
  // server-wide reading (`metrics.high` for the host itself).
  "uptime.down": { permission: "monitor", href: "/monitor" },
  "metrics.high": { permission: "monitor", href: "/monitor" },
  // Always about a project, named by id: only for one deleted since.
  "task.failed": { href: "/projects" },
};

export const DEFAULT_NOTIFY_AUDIENCE: GlobalPermission = "monitor";

export function eventMeta(key: string): NotifyEventMeta {
  const meta = NOTIFY_EVENT_META[key as NotifyEventKey];
  return { permission: meta?.permission ?? DEFAULT_NOTIFY_AUDIENCE, href: meta?.href ?? null };
}

// --- What one channel receives ------------------------------------------------

/**
 * A channel's choices, event by event.
 *
 * A map and not a list, for the events that do not exist yet. A list of the
 * keys that are on cannot tell "switched off" from "never offered", so every
 * event added after a channel was saved would start silenced on it — exactly
 * the trap the single `disk.low` key was designed around. With a map, a key the
 * channel has never been asked about takes its default, and the first save
 * writes an answer for every key there is.
 */
export type EventChoices = Partial<Record<string, boolean>>;

/** The keys a channel receives, defaults filled in for the ones it was never asked about. */
export function selectedEvents(choices: EventChoices | null | undefined): NotifyEventKey[] {
  return NOTIFY_EVENTS.filter((key) => {
    const choice = choices?.[key];
    return typeof choice === "boolean" ? choice : DEFAULT_NOTIFY_EVENTS.includes(key);
  });
}

/** An answer for every key there is: what a save writes. */
export function choicesFor(selected: readonly string[]): Record<NotifyEventKey, boolean> {
  const out = {} as Record<NotifyEventKey, boolean>;
  for (const key of NOTIFY_EVENTS) out[key] = selected.includes(key);
  return out;
}

/** Narrow a stored map; anything that is not one reads as "never asked", so the defaults apply. */
export function parseEventChoices(raw: string | null | undefined): EventChoices {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: EventChoices = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * "Everything", or "only when something is wrong".
 *
 * This is how "tell me on Telegram when a deploy fails" is said: the deploy
 * event, with `problems`. The event keys are what happened; this is how bad it
 * has to be. A channel set to problems still hears that something came back —
 * Docker answering again, the disk back above its threshold — because a warning
 * that is never followed by its all-clear leaves the reader guessing for ever.
 */
export const NOTIFY_FILTERS = ["all", "problems"] as const;
export type NotifyFilter = (typeof NOTIFY_FILTERS)[number];

export function isNotifyFilter(value: unknown): value is NotifyFilter {
  return NOTIFY_FILTERS.includes(value as NotifyFilter);
}

/**
 * Whether a message of this level gets through a channel's filter.
 *
 * `stateChange` is true for an event that reports both directions of one
 * condition (it carries `up`): its recovery is part of the problem it closes.
 */
export function passesFilter(filter: NotifyFilter, level: string, stateChange: boolean): boolean {
  if (filter === "all") return true;
  return level === "danger" || level === "warn" || stateChange;
}

/** Whether a channel with these choices and this filter wants this event. */
export function channelWants(
  channel: { events: EventChoices; filter: NotifyFilter },
  event: { key: string; up?: unknown },
  level: string
): boolean {
  if (!selectedEvents(channel.events).includes(event.key as NotifyEventKey)) return false;
  return passesFilter(channel.filter, level, typeof event.up === "boolean");
}
