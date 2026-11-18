/**
 * The public status page: whether an address gets it, and what it may say.
 *
 * It is the one screen of the panel anyone can open without signing in, so
 * the two decisions that matter live here, free of imports, where
 * `status-page-unit` drives them without a server:
 *
 *  - whether a request is answered with the page (`pageAccess`). Switched off,
 *    or any path but the one the owner chose, is the same "pagina non
 *    trovata" as an address that never existed. A 403 would say there is
 *    something behind it, and the point of an unguessable path is that nobody
 *    learns that by trying.
 *  - what it shows (`projectStatus`, `assembleSnapshot`). Every value the page
 *    renders is copied here field by field, from an allowlist: the name the
 *    owner typed, a state, the uptime figures and when outages began and
 *    ended. Never the project's name inside the panel, its slug, port, path,
 *    id or address, the server it runs on, nor why a check failed —
 *    `causeLabel` talks about ports and HTTP codes, which are the operator's
 *    business. Nothing is spread from a richer object, so a field the uptime
 *    summary grows one day cannot reach the page by accident.
 *
 * The words are here too, so the settings and the page say the same thing.
 */

/** The `settings` key holding the page, as JSON. One page per panel. */
export const STATUS_PAGE_SETTING = "status_page";

/**
 * Every page lives under this prefix and the owner picks the rest. A fixed
 * prefix keeps the chosen part from ever colliding with a page of the panel,
 * and costs nothing in secrecy: `/status/<wrong>` is the same 404 as any other
 * path, whether or not a page exists.
 */
export const STATUS_PAGE_BASE = "/status";

export const SLUG_MIN = 3;
export const SLUG_MAX = 64;
/** Twelve characters of a 32-letter alphabet: 60 bits, beyond guessing one request at a time. */
export const RANDOM_SLUG_LENGTH = 12;
export const TITLE_MAX = 80;
export const MESSAGE_MAX = 600;
export const PUBLIC_NAME_MAX = 60;
export const MAX_PAGE_PROJECTS = 30;
/** What the bars cover, and how far back the incident list goes. */
export const PAGE_DAYS = 30;
/** Incidents the page lists, all projects together, newest first. */
export const PAGE_INCIDENTS = 10;

export const DEFAULT_TITLE = "Stato dei servizi";

/** Lower case and digits, without 0/o and 1/l: a path someone may read off a screen and retype. */
const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const SLUG_RULE = `Da ${SLUG_MIN} a ${SLUG_MAX} caratteri: lettere minuscole, numeri e trattini, senza un trattino all'inizio o alla fine`;

/** The panel's ids (projects, members of the cluster): `nanoid`, URL-safe. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && value.length >= SLUG_MIN && value.length <= SLUG_MAX && SLUG_PATTERN.test(value);
}

/**
 * A fresh unguessable path. Web Crypto, present in Node and in the browser,
 * so the settings page can offer a new one before anything is saved. 256 is a
 * multiple of 32, so masking the byte leaves every letter equally likely.
 */
export function randomSlug(length = RANDOM_SLUG_LENGTH): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += SLUG_ALPHABET[byte & 31];
  return out;
}

export function statusPagePath(slug: string): string {
  return `${STATUS_PAGE_BASE}/${slug}`;
}

/** Whether a request path is one `proxy.ts` gates for the page: the prefix itself or anything under it. */
export function isStatusPagePath(pathname: string): boolean {
  return pathname === STATUS_PAGE_BASE || pathname.startsWith(`${STATUS_PAGE_BASE}/`);
}

/** The path after the prefix, as the page's `[slug]` would receive it; checked by `isValidSlug` before use. */
export function slugOfPath(pathname: string): string {
  return isStatusPagePath(pathname) ? pathname.slice(STATUS_PAGE_BASE.length + 1) : "";
}

/**
 * Where `proxy.ts` sends a request the page does not answer. A folder whose
 * name starts with `_` is private in the app router, so no page can ever
 * live here: the request gets the panel's 404 exactly as any mistyped
 * address does.
 */
export const STATUS_PAGE_MISS = "/_status-page-miss";

// --- What the owner set ------------------------------------------------------------

export interface StatusPageEntry {
  /** The member of the cluster holding the project; null for this server. */
  server: string | null;
  projectId: string;
  /**
   * What the page calls it. Typed, or accepted from the prefilled display
   * name, by the owner: the page never falls back to anything else, so a
   * later rename inside the panel does not reach the public by itself.
   */
  name: string;
}

export interface StatusPageConfig {
  enabled: boolean;
  slug: string;
  title: string;
  /** Shown above the list as typed, e.g. a planned maintenance. Empty for none. */
  message: string;
  /** Off: `noindex`. The page is for the people given the link, unless the owner says otherwise. */
  allowIndexing: boolean;
  projects: StatusPageEntry[];
}

export function defaultStatusPageConfig(slug = randomSlug()): StatusPageConfig {
  return { enabled: false, slug, title: DEFAULT_TITLE, message: "", allowIndexing: false, projects: [] };
}

export function entryKey(entry: Pick<StatusPageEntry, "server" | "projectId">): string {
  return `${entry.server ?? ""}/${entry.projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Zero-width characters and direction overrides: invisible, and on a public
 * page what they are good for is making a name read as something it is not.
 */
const INVISIBLE = /[​-‏‪-‮⁠-⁯﻿]/g;

/** One line of text: no control characters, no line breaks, single spaces. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** A short paragraph: line breaks kept, at most one empty line in a row, nothing else invisible. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * The stored page, read defensively.
 *
 * It decides whether a public address answers, so anything that does not
 * parse is a page that does not exist rather than a guess: no slug, no page.
 * `enabled` has to be literally `true`. An entry with an empty name is
 * dropped, not shown as a blank row; a second entry for the same project is
 * dropped too.
 */
export function parseStatusPageConfig(raw: string | null | undefined): StatusPageConfig | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isValidSlug(value.slug)) return null;

  const projects: StatusPageEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.projects) ? value.projects : []) {
    if (projects.length >= MAX_PAGE_PROJECTS) break;
    if (!isRecord(item)) continue;
    const server = item.server ?? null;
    if (server !== null && !(typeof server === "string" && ID_PATTERN.test(server))) continue;
    if (typeof item.projectId !== "string" || !ID_PATTERN.test(item.projectId)) continue;
    const name = cleanLine(item.name, PUBLIC_NAME_MAX);
    if (!name) continue;
    const entry = { server, projectId: item.projectId, name };
    if (seen.has(entryKey(entry))) continue;
    seen.add(entryKey(entry));
    projects.push(entry);
  }

  return {
    enabled: value.enabled === true,
    slug: value.slug,
    title: cleanLine(value.title, TITLE_MAX) || DEFAULT_TITLE,
    message: cleanText(value.message, MESSAGE_MAX),
    allowIndexing: value.allowIndexing === true,
    projects,
  };
}

/**
 * Entries naming this server by its member id are entries for this server.
 * Stored as null, so a panel that leaves the cluster, or joins one, keeps its
 * own projects on its page.
 */
export function normalizeEntries(entries: readonly StatusPageEntry[], selfId: string | null): StatusPageEntry[] {
  return entries.map((entry) => ({ ...entry, server: entry.server !== null && entry.server === selfId ? null : entry.server }));
}

// --- Who gets the page --------------------------------------------------------------

/**
 * `public`: the page is on and this is its address. `preview`: it is off,
 * this is its address, and the one asking is the owner, signed in — the
 * settings link lets them see it before anybody else can. null for anything
 * else, which the page turns into the same 404 as a path that was never
 * there: off and wrong look alike on purpose.
 */
export type PageAccess = "public" | "preview" | null;

export function pageAccess(config: StatusPageConfig | null, slug: unknown, viewerIsOwner: boolean): PageAccess {
  if (!config || !isValidSlug(slug) || slug !== config.slug) return null;
  if (config.enabled) return "public";
  return viewerIsOwner ? "preview" : null;
}

/** Whether search engines may list it: never a preview, otherwise the owner's choice. */
export function allowsIndexing(config: StatusPageConfig, access: PageAccess): boolean {
  return access === "public" && config.allowIndexing;
}

// --- What a project shows -----------------------------------------------------------

export type PublicState = "up" | "down" | "maintenance" | "unknown";

/**
 * What the page is computed from, for one project: the project's status in
 * the store and its uptime summary (`services/uptime/summary.ts`). Only the
 * fields this file reads are named, so a richer object passes the type and
 * nothing beyond them reaches the output.
 */
export interface ProjectStatusInput {
  /** `projects.status`: running, stopped, deploying, error. */
  status: string;
  /** Whether the uptime check asks this app now (`planFor(...).target !== null`). */
  watched: boolean;
  up24h: number | null;
  up30d: number | null;
  days: readonly { day: number; ratio: number | null }[];
  /** The newest check, when recent enough to describe now. */
  last: { at: number; ok: boolean } | null;
  open: { startedAt: string } | null;
  incidents: readonly { startedAt: string; endedAt: string | null; resolution: string | null }[];
}

export interface PublicIncident {
  startedAt: number;
  endedAt: number | null;
  /**
   * The check stopped asking before the app answered again — it was stopped
   * or redeployed — so the real end is not known and the duration is a floor.
   */
  endUnknown: boolean;
}

/** One project as the page may show it, before the owner's name is put on it. */
export interface PublicProjectStatus {
  state: PublicState;
  /** When the outage going on began, for "non risponde da 12 minuti". */
  since: number | null;
  up24h: number | null;
  up30d: number | null;
  days: { day: number; ratio: number | null }[];
  incidents: PublicIncident[];
}

/**
 * The state a visitor reads.
 *
 * A deploy is maintenance, not an outage. A project stopped or in error does
 * not answer, whatever the history says: the check skips it, so its numbers
 * stop at the last time it was asked, and only its status tells the truth
 * about now. Then the check: an open incident is an outage; no recent check
 * at all (the check is off for this project, or has not run yet) is "no
 * data", not good news. A single failed check with no incident is still up:
 * one missed answer is a garbage-collection pause, and the incident rule
 * (`stepUptime`) is what says an app is down — the page does not get to be
 * more nervous than the notifications.
 */
export function publicState(input: Pick<ProjectStatusInput, "status" | "watched" | "last" | "open">): PublicState {
  if (input.status === "deploying") return "maintenance";
  if (input.status === "stopped" || input.status === "error") return "down";
  if (!input.watched) return "unknown";
  if (input.open) return "down";
  if (!input.last) return "unknown";
  return "up";
}

function ratio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function instant(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The outages of the last `PAGE_DAYS` days, newest first; anything unreadable is left out. */
export function publicIncidents(incidents: ProjectStatusInput["incidents"], now: number): PublicIncident[] {
  const from = now - PAGE_DAYS * 86_400_000;
  const out: PublicIncident[] = [];
  for (const incident of incidents) {
    const startedAt = instant(incident.startedAt);
    if (startedAt === null || startedAt < from || startedAt > now) continue;
    const endedAt = incident.endedAt === null ? null : instant(incident.endedAt);
    if (incident.endedAt !== null && endedAt === null) continue;
    out.push({ startedAt, endedAt, endUnknown: endedAt !== null && incident.resolution === "paused" });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, PAGE_INCIDENTS);
}

/** One project, field by field: see the top of the file for why nothing is spread. */
export function projectStatus(input: ProjectStatusInput, now: number): PublicProjectStatus {
  const state = publicState(input);
  const openStart = input.open ? instant(input.open.startedAt) : null;
  return {
    state,
    since: state === "down" && openStart !== null ? openStart : null,
    up24h: ratio(input.up24h),
    up30d: ratio(input.up30d),
    days: input.days.slice(-PAGE_DAYS).map((d) => ({ day: Number(d.day), ratio: ratio(d.ratio) })),
    incidents: publicIncidents(input.incidents, now),
  };
}

/**
 * A status that came from another server, checked as strictly as one made
 * here: the shape is rebuilt from known fields, so a member on another
 * release, or one that answers with more than it should, still cannot put
 * anything else on the page. null when it is not a status at all.
 */
export function readProjectStatus(value: unknown): PublicProjectStatus | null {
  if (!isRecord(value)) return null;
  const states: readonly PublicState[] = ["up", "down", "maintenance", "unknown"];
  const state = states.find((s) => s === value.state);
  if (!state) return null;
  const days = Array.isArray(value.days) ? value.days : [];
  const incidents = Array.isArray(value.incidents) ? value.incidents : [];
  return {
    state,
    since: typeof value.since === "number" && Number.isFinite(value.since) ? value.since : null,
    up24h: ratio(value.up24h),
    up30d: ratio(value.up30d),
    days: days
      .slice(-PAGE_DAYS)
      .filter((d): d is Record<string, unknown> => isRecord(d) && typeof d.day === "number" && Number.isFinite(d.day))
      .map((d) => ({ day: d.day as number, ratio: ratio(d.ratio) })),
    incidents: incidents
      .filter((i): i is Record<string, unknown> => isRecord(i) && typeof i.startedAt === "number" && Number.isFinite(i.startedAt))
      .map((i) => ({
        startedAt: i.startedAt as number,
        endedAt: typeof i.endedAt === "number" && Number.isFinite(i.endedAt) ? i.endedAt : null,
        endUnknown: i.endUnknown === true,
      }))
      .slice(0, PAGE_INCIDENTS),
  };
}

// --- The page -------------------------------------------------------------------------

export type Verdict = "up" | "partial" | "down" | "maintenance" | "unknown" | "empty";

export interface PublicProject {
  name: string;
  state: PublicState;
  since: number | null;
  up24h: number | null;
  up30d: number | null;
  days: { day: number; ratio: number | null }[];
}

export interface PublicPageIncident extends PublicIncident {
  name: string;
}

/** Everything the public page renders besides the owner's title and message. */
export interface PublicSnapshot {
  generatedAt: number;
  verdict: Verdict;
  counts: Record<PublicState, number>;
  projects: PublicProject[];
  incidents: PublicPageIncident[];
}

/**
 * One project's outcome: its status, or why there is none. `missing` is a
 * project deleted since it was chosen, left off the page rather than shown
 * as a name with nothing behind it; `unavailable` is one whose server did not
 * answer, shown as "no data".
 */
export type EntryOutcome = PublicProjectStatus | "missing" | "unavailable";

export function overallVerdict(states: readonly PublicState[]): Verdict {
  if (states.length === 0) return "empty";
  const count = (state: PublicState) => states.filter((s) => s === state).length;
  const down = count("down");
  if (down > 0) return down === states.length ? "down" : "partial";
  if (count("maintenance") > 0) return "maintenance";
  return count("up") > 0 ? "up" : "unknown";
}

export function assembleSnapshot(
  entries: readonly { name: string; outcome: EntryOutcome }[],
  now: number
): PublicSnapshot {
  const projects: PublicProject[] = [];
  const incidents: PublicPageIncident[] = [];
  const counts: Record<PublicState, number> = { up: 0, down: 0, maintenance: 0, unknown: 0 };

  for (const { name, outcome } of entries) {
    if (outcome === "missing") continue;
    const status: PublicProjectStatus =
      outcome === "unavailable" ? { state: "unknown", since: null, up24h: null, up30d: null, days: [], incidents: [] } : outcome;
    counts[status.state] += 1;
    projects.push({ name, state: status.state, since: status.since, up24h: status.up24h, up30d: status.up30d, days: status.days });
    for (const incident of status.incidents) {
      incidents.push({ name, startedAt: incident.startedAt, endedAt: incident.endedAt, endUnknown: incident.endUnknown });
    }
  }

  return {
    generatedAt: now,
    verdict: overallVerdict(projects.map((p) => p.state)),
    counts,
    projects,
    incidents: incidents.sort((a, b) => b.startedAt - a.startedAt).slice(0, PAGE_INCIDENTS),
  };
}

// --- Saying it ---------------------------------------------------------------------------

export type PageTone = "success" | "warning" | "danger" | "accent" | "neutral";

export const STATE_WORDS: Record<PublicState, { label: string; tone: PageTone }> = {
  up: { label: "Operativo", tone: "success" },
  down: { label: "Non risponde", tone: "danger" },
  maintenance: { label: "In aggiornamento", tone: "accent" },
  unknown: { label: "Nessun dato", tone: "neutral" },
};

export function verdictWords(verdict: Verdict, counts: Record<PublicState, number>): { title: string; detail: string | null; tone: PageTone } {
  const total = counts.up + counts.down + counts.maintenance + counts.unknown;
  switch (verdict) {
    case "up":
      return counts.unknown > 0
        ? { title: "Nessun problema rilevato", detail: `${counts.up} su ${total} con dati recenti, tutti operativi.`, tone: "success" }
        : { title: "Tutti i servizi sono operativi", detail: null, tone: "success" };
    case "partial":
      return {
        title: counts.down === 1 ? "Un servizio non risponde" : "Alcuni servizi non rispondono",
        detail: `${counts.down} su ${total} non ${counts.down === 1 ? "risponde" : "rispondono"} in questo momento.`,
        tone: "warning",
      };
    case "down":
      return { title: total === 1 ? "Il servizio non risponde" : "I servizi non rispondono", detail: null, tone: "danger" };
    case "maintenance":
      return { title: "Aggiornamento in corso", detail: "Il servizio potrebbe non rispondere per qualche istante.", tone: "accent" };
    case "unknown":
      return { title: "Stato non disponibile", detail: "Non ci sono ancora controlli recenti da mostrare.", tone: "neutral" };
    case "empty":
      return { title: "Nessun servizio da mostrare", detail: null, tone: "neutral" };
  }
}

/** The tone of a day's bar: a single failed check is not a red day. Same thresholds as the project page. */
export function dayTone(ratio: number | null): PageTone {
  if (ratio === null) return "neutral";
  if (ratio >= 0.9995) return "success";
  if (ratio >= 0.99) return "warning";
  return "danger";
}

/**
 * Minutes east of UTC of a zone at an instant (Rome in winter: 60), or 0 for
 * a zone the runtime cannot resolve. The page draws its days and prints its
 * times in the panel's zone: rendered once for every visitor, it cannot use
 * each one's.
 */
export function zoneOffsetMinutes(zone: string, at: number): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName")?.value;
    const match = name ? /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name) : null;
    if (!match) return 0;
    if (!match[1]) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return 0;
  }
}
