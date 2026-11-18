/**
 * A schedule the way people say it, and the cron expression underneath.
 *
 * The backup form used to offer four presets and a raw cron field, so anything
 * else — "every Monday at 02:30", "the first of the month" — meant learning
 * cron. These are the shapes almost every schedule takes, each one a pair of
 * plain questions; the expression stays the stored truth, so the scheduler and
 * `lib/cron.ts` do not change at all.
 *
 * The rule that matters is in `cronToSchedule`: an expression is turned into a
 * friendly schedule only when the friendly one means *exactly* the same thing.
 * Anything else comes back as `custom` and the editor shows the raw cron —
 * rounding "0 3,15 * * *" to "every day at 03:00" would silently drop a run.
 *
 * Zero imports, so the unit suite loads it directly and the browser bundles it
 * without dragging the server in. `Intl` is a global, not an import.
 */

export type Schedule =
  /** No expression: runs only when someone asks. */
  | { kind: "manual" }
  /** Every `every` hours from midnight, at `minute`. `every` divides 24. */
  | { kind: "hourly"; every: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  /** `weekdays`: 0 = Sunday … 6 = Saturday, sorted, never empty. */
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number }
  /** `day`: 1–31. Days past 28 do not exist in every month, and cron then skips that month. */
  | { kind: "monthly"; day: number; hour: number; minute: number }
  /** Anything the shapes above cannot say without changing its meaning. */
  | { kind: "custom"; cron: string };

export type ScheduleKind = Schedule["kind"];

/**
 * Only the intervals that divide a day. "Every 5 hours" in cron fires at 0, 5,
 * 10, 15 and 20 — then again at 0, four hours later — so calling it "every 5
 * hours" would be a lie once a night.
 */
export const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12] as const;

export const WEEKDAY_LABELS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"] as const;
/** Short names, Monday first, as an Italian calendar reads. */
export const WEEKDAY_SHORT: readonly { day: number; label: string }[] = [
  { day: 1, label: "Lun" },
  { day: 2, label: "Mar" },
  { day: 3, label: "Mer" },
  { day: 4, label: "Gio" },
  { day: 5, label: "Ven" },
  { day: 6, label: "Sab" },
  { day: 0, label: "Dom" },
];

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** What a freshly chosen kind starts from: the nightly hour everybody picks anyway. */
export function defaultSchedule(kind: ScheduleKind, from?: Schedule): Schedule {
  const hour = from && "hour" in from ? from.hour : 3;
  const minute = from && "minute" in from ? from.minute : 0;
  switch (kind) {
    case "manual":
      return { kind: "manual" };
    case "hourly":
      return { kind: "hourly", every: 6, minute };
    case "daily":
      return { kind: "daily", hour, minute };
    case "weekly":
      return { kind: "weekly", weekdays: [1], hour, minute };
    case "monthly":
      return { kind: "monthly", day: 1, hour, minute };
    case "custom":
      return { kind: "custom", cron: from ? scheduleToCron(from) : "0 3 * * *" };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** The expression a schedule stands for. `manual` is the empty string, as stored. */
export function scheduleToCron(schedule: Schedule): string {
  switch (schedule.kind) {
    case "manual":
      return "";
    case "hourly": {
      const every = (HOUR_INTERVALS as readonly number[]).includes(schedule.every) ? schedule.every : 1;
      const minute = clamp(schedule.minute, 0, 59);
      return every === 1 ? `${minute} * * * *` : `${minute} */${every} * * *`;
    }
    case "daily":
      return `${clamp(schedule.minute, 0, 59)} ${clamp(schedule.hour, 0, 23)} * * *`;
    case "weekly": {
      const days = normaliseWeekdays(schedule.weekdays);
      return `${clamp(schedule.minute, 0, 59)} ${clamp(schedule.hour, 0, 23)} * * ${(days.length ? days : [1]).join(",")}`;
    }
    case "monthly":
      return `${clamp(schedule.minute, 0, 59)} ${clamp(schedule.hour, 0, 23)} ${clamp(schedule.day, 1, 31)} * *`;
    case "custom":
      return schedule.cron.trim();
  }
}

function normaliseWeekdays(days: readonly number[]): number[] {
  return [...new Set(days.map((d) => (d === 7 ? 0 : d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b
  );
}

// --- Reading an expression back ---------------------------------------------

/** A plain number in range, leading zeros allowed: what a minute or an hour field holds. */
function single(token: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(token)) return null;
  const value = Number(token);
  return value >= min && value <= max ? value : null;
}

/** The hour field of an "every N hours" expression, or null. */
function hourStep(token: string): number | null {
  if (token === "*") return 1;
  const match = /^(?:\*|0|0-23)\/(\d{1,2})$/.exec(token);
  if (!match) return null;
  const step = Number(match[1]);
  return (HOUR_INTERVALS as readonly number[]).includes(step) ? step : null;
}

function weekdayValue(token: string): number | null {
  const lower = token.toLowerCase();
  const named = DAY_NAMES.indexOf(lower);
  if (named >= 0) return named;
  const value = single(token, 0, 7);
  return value === null ? null : value;
}

/** `1-5`, `mon,wed,fri`, `0,6`: the set of weekdays, or null for anything with a step. */
function weekdays(token: string): number[] | null {
  const out: number[] = [];
  for (const item of token.split(",")) {
    if (!item || item.includes("/")) return null;
    const range = item.split("-");
    if (range.length === 1) {
      const value = weekdayValue(item);
      if (value === null) return null;
      out.push(value);
    } else if (range.length === 2) {
      const from = weekdayValue(range[0]);
      const to = weekdayValue(range[1]);
      if (from === null || to === null || from > to) return null;
      for (let day = from; day <= to; day++) out.push(day);
    } else {
      return null;
    }
  }
  const days = normaliseWeekdays(out);
  return days.length > 0 ? days : null;
}

const ALIASES: Record<string, string> = {
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

/**
 * The friendly schedule an expression is, or `custom` when none says the same.
 *
 * Deliberately narrow: only what `scheduleToCron` writes and its obvious
 * spellings (aliases, names, `1-5`, leading zeros). Recognising more would mean
 * re-implementing the parser, and a wrong recognition is worse than none.
 */
export function cronToSchedule(expression: string): Schedule {
  const source = expression.trim();
  if (!source) return { kind: "manual" };

  const expanded = source.startsWith("@") ? ALIASES[source.toLowerCase()] : source;
  if (!expanded) return { kind: "custom", cron: source };

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return { kind: "custom", cron: source };
  const [minuteField, hourField, domField, monthField, dowField] = parts;

  const custom: Schedule = { kind: "custom", cron: source };
  if (monthField !== "*") return custom;

  const minute = single(minuteField, 0, 59);
  if (minute === null) return custom;

  const hour = single(hourField, 0, 23);
  if (hour === null) {
    // Only "every N hours" has a non-fixed hour, and only on every day.
    const every = hourStep(hourField);
    if (every === null || domField !== "*" || dowField !== "*") return custom;
    return { kind: "hourly", every, minute };
  }

  if (domField === "*" && dowField === "*") return { kind: "daily", hour, minute };

  if (domField === "*") {
    const days = weekdays(dowField);
    if (!days) return custom;
    // Every day of the week is a daily schedule, said more simply.
    if (days.length === 7) return { kind: "daily", hour, minute };
    return { kind: "weekly", weekdays: days, hour, minute };
  }

  if (dowField === "*") {
    const day = single(domField, 1, 31);
    if (day === null) return custom;
    return { kind: "monthly", day, hour, minute };
  }

  // Both day fields narrowed: cron runs on either, which no shape here says.
  return custom;
}

/** Whether the friendly editor can show this expression without losing anything. */
export function isRepresentable(expression: string): boolean {
  return cronToSchedule(expression).kind !== "custom";
}

// --- Saying it in Italian ---------------------------------------------------

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatClock(hour: number, minute: number): string {
  return `${two(hour)}:${two(minute)}`;
}

function joinItalian(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** "il lunedì", "il lunedì e il giovedì", "dal lunedì al venerdì". */
function weekdayPhrase(days: number[]): string {
  const sorted = normaliseWeekdays(days);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "dal lunedì al venerdì";
  if (key === "0,6") return "il sabato e la domenica";
  // Monday first, Sunday last: the order an Italian week is read in.
  const ordered = [...sorted.filter((d) => d !== 0), ...sorted.filter((d) => d === 0)];
  return `ogni ${joinItalian(ordered.map((d) => WEEKDAY_LABELS[d]))}`;
}

/**
 * The schedule as the rest of a sentence, lower case: "ogni giorno alle
 * 03:00", "dal lunedì al venerdì alle 02:30". What the API returns — the
 * policy list and the cron preview say it with the same words.
 *
 * `custom` falls back to `fallback` — the server's `describeCron` — or to the
 * expression itself, because a wrong sentence is worse than raw cron.
 */
export function scheduleSentence(schedule: Schedule, fallback?: string): string {
  return (() => {
    switch (schedule.kind) {
      case "manual":
        return "solo su richiesta";
      case "hourly":
        if (schedule.every === 1) {
          return schedule.minute === 0 ? "ogni ora" : `ogni ora, al minuto ${two(schedule.minute)}`;
        }
        return `ogni ${schedule.every} ore, a partire dalle ${formatClock(0, schedule.minute)}`;
      case "daily":
        return `ogni giorno alle ${formatClock(schedule.hour, schedule.minute)}`;
      case "weekly":
        return `${weekdayPhrase(schedule.weekdays)} alle ${formatClock(schedule.hour, schedule.minute)}`;
      case "monthly":
        return (
          `ogni mese il giorno ${schedule.day} alle ${formatClock(schedule.hour, schedule.minute)}` +
          (schedule.day > 28 ? " (salta i mesi che non hanno quel giorno)" : "")
        );
      case "custom":
        return fallback?.trim() || schedule.cron;
    }
  })();
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The same sentence, capitalised, to open a line: "Ogni giorno alle 03:00". */
export function describeSchedule(schedule: Schedule, fallback?: string): string {
  return capitalize(scheduleSentence(schedule, fallback));
}

/** An expression as the rest of a sentence, through the friendly shapes when it is one of them. */
export function cronSentence(expression: string, fallback?: string): string {
  return scheduleSentence(cronToSchedule(expression), fallback);
}

/** An expression in words, capitalised. */
export function describeCronFriendly(expression: string, fallback?: string): string {
  return describeSchedule(cronToSchedule(expression), fallback);
}

// --- Time zones ---------------------------------------------------------------

/**
 * Every zone the picker offers: UTC first, then the runtime's list, plus
 * whatever is already stored.
 *
 * `Intl.supportedValuesOf` leaves UTC out in V8 and spells some zones the old
 * way (Europe/Kiev); a policy saved with a zone the browser does not list must
 * still show it, or opening the form would quietly change it.
 */
export function timeZoneOptions(supported: readonly string[], keep: readonly (string | null | undefined)[] = []): string[] {
  const rest = new Set<string>();
  for (const zone of [...supported, ...keep]) {
    if (zone && zone !== "UTC") rest.add(zone);
  }
  return ["UTC", ...[...rest].sort((a, b) => a.localeCompare(b))];
}

/** The runtime's zones, or just UTC where `Intl.supportedValuesOf` does not exist. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/** "UTC+01:00" at the given instant, or "" for a zone the runtime cannot resolve. */
export function zoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!part) return "";
    // "GMT" alone is UTC itself; "GMT+01:00" becomes "UTC+01:00".
    return part === "GMT" ? "UTC+00:00" : part.replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

/** "Europe/Rome" → "Europe/Rome", "America/New_York" → "America/New York": what a search should match. */
export function zoneSearchText(zone: string): string {
  return `${zone} ${zone.replace(/_/g, " ")}`;
}
