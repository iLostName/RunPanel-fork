import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { zoneOffset } from "@/lib/schedule";
import { durationWords, formatUptimePercent, shortDuration } from "@/lib/uptime-math";
import {
  PAGE_DAYS,
  STATE_WORDS,
  dayTone,
  verdictWords,
  type PageTone,
  type PublicPageIncident,
  type PublicProject,
  type PublicSnapshot,
} from "@/lib/status-page";

/**
 * What a visitor sees: the owner's title and message, one sentence on how
 * things are, each service with its state and its last thirty days, the
 * recent outages. A server component, so the page arrives whole and works
 * without JavaScript; the only script on it is the one that refreshes it.
 *
 * Everything it prints comes from `PublicSnapshot`, which holds only what
 * `lib/status-page.ts` lets through, and from the owner's own text, printed as
 * text. Times are in the panel's zone, which the footer names: the page is
 * rendered once for every visitor and cannot use each one's.
 */

const TONE_TEXT: Record<PageTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
  neutral: "text-muted",
};

const TONE_DOT: Record<PageTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-muted/50",
};

// "No data" is a muted grey rather than the `default` surface the project page
// uses: on the white of the light theme that one all but disappears, and here
// a day with no checks has to read as a day, not as a gap in the strip.
const TONE_BAR: Record<PageTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-muted/30",
};

const TONE_SURFACE: Record<PageTone, string> = {
  success: "border-success/30 bg-success/10",
  warning: "border-warning/30 bg-warning/10",
  danger: "border-danger/30 bg-danger/10",
  accent: "border-accent/30 bg-accent/10",
  neutral: "border-border bg-surface",
};

const VERDICT_ICON: Record<PageTone, string> = {
  success: "solar:check-circle-linear",
  warning: "solar:danger-triangle-linear",
  danger: "solar:close-circle-linear",
  accent: "solar:refresh-circle-linear",
  neutral: "solar:question-circle-linear",
};

const LEGEND: { tone: PageTone; label: string }[] = [
  { tone: "success", label: "Nessuna interruzione" },
  { tone: "warning", label: "Interruzioni brevi" },
  { tone: "danger", label: "Interruzioni" },
  { tone: "neutral", label: "Nessun dato" },
];

const HALF_DAY = 12 * 3_600_000;

interface Formats {
  when: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  dayKey: Intl.DateTimeFormat;
}

function formats(zone: string): Formats {
  return {
    when: new Intl.DateTimeFormat("it-IT", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    time: new Intl.DateTimeFormat("it-IT", { timeZone: zone, hour: "2-digit", minute: "2-digit" }),
    day: new Intl.DateTimeFormat("it-IT", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }),
    dayKey: new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }),
  };
}

function DayBars({ days, f }: { days: PublicProject["days"]; f: Formats }) {
  if (days.length === 0) return <p className="text-muted text-xs">Nessun dato degli ultimi {PAGE_DAYS} giorni.</p>;
  const good = days.filter((d) => dayTone(d.ratio) === "success").length;
  const none = days.filter((d) => d.ratio === null).length;
  return (
    <div>
      <div
        className="flex h-7 items-stretch gap-[2px]"
        role="img"
        aria-label={`Ultimi ${days.length} giorni: ${good} senza interruzioni, ${days.length - good - none} con interruzioni, ${none} senza dati.`}
      >
        {days.map((d) => (
          <span
            key={d.day}
            className={cn("min-w-0 flex-1 rounded-[2px]", TONE_BAR[dayTone(d.ratio)])}
            // Noon of the day, not its start: the start was cut with today's
            // offset, and across a change of hour it falls on the day before.
            title={`${f.day.format(d.day + HALF_DAY)}: ${d.ratio === null ? "nessun dato" : formatUptimePercent(d.ratio)}`}
          />
        ))}
      </div>
      <div className="text-muted mt-1 flex justify-between text-meta" aria-hidden>
        <span>{days.length} giorni fa</span>
        <span>Oggi</span>
      </div>
    </div>
  );
}

function ProjectRow({ project, now, f }: { project: PublicProject; now: number; f: Formats }) {
  const words = STATE_WORDS[project.state];
  const since = project.state === "down" && project.since !== null ? ` da ${durationWords(now - project.since)}` : "";
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-foreground min-w-0 text-sm font-medium break-words">{project.name}</h3>
        <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", TONE_TEXT[words.tone])}>
          <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[words.tone])} aria-hidden />
          {words.label}
          {since}
        </span>
      </div>
      <dl className="text-muted flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt>Ultime 24 ore</dt>
          <dd className="text-foreground font-medium tabular-nums">{formatUptimePercent(project.up24h)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Ultimi {PAGE_DAYS} giorni</dt>
          <dd className="text-foreground font-medium tabular-nums">{formatUptimePercent(project.up30d)}</dd>
        </div>
      </dl>
      <DayBars days={project.days} f={f} />
    </li>
  );
}

function IncidentRow({ incident, now, f }: { incident: PublicPageIncident; now: number; f: Formats }) {
  const end = incident.endedAt;
  const sameDay = end !== null && f.dayKey.format(incident.startedAt) === f.dayKey.format(end);
  const length = shortDuration((end ?? now) - incident.startedAt);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 text-sm">
      <span className={cn("size-1.5 shrink-0 self-center rounded-full", end === null ? "bg-danger" : "bg-muted/60")} aria-hidden />
      <span className="text-foreground font-medium break-words">{incident.name}</span>
      {/* One run of text, the separator glued to what precedes it: on a phone
          the line breaks inside the sentence, never before a lone "·". */}
      <span className="text-muted min-w-0">
        <span className="tabular-nums">
          {f.when.format(incident.startedAt)} → {end === null ? "in corso" : sameDay ? f.time.format(end) : f.when.format(end)}
        </span>
        {"\u00a0\u00b7 "}
        {incident.endUnknown ? `almeno ${length}, poi il controllo è stato sospeso` : length}
      </span>
    </li>
  );
}

export function StatusView({
  title,
  message,
  snapshot,
  zone,
  preview,
}: {
  title: string;
  message: string;
  snapshot: PublicSnapshot;
  zone: string;
  preview: boolean;
}) {
  const f = formats(zone);
  // Durations are measured to the moment the figures were read, which is the
  // time the page says it was updated: never a clock the figures did not see.
  const now = snapshot.generatedAt;
  const verdict = verdictWords(snapshot.verdict, snapshot.counts);
  const offset = zoneOffset(zone, new Date(now));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      {preview && (
        <div role="note" className="border-warning/30 bg-warning/10 text-foreground mb-6 rounded-[var(--radius)] border px-4 py-3 text-sm leading-relaxed">
          <strong className="font-medium">Anteprima.</strong> La pagina è spenta: la vedi solo tu, perché sei entrato nel pannello come
          proprietario. Chiunque altro, a questo indirizzo, trova «Pagina non trovata».{" "}
          <Link href="/settings?open=status-page" className="text-accent font-medium underline-offset-2 hover:underline">
            Torna alle impostazioni
          </Link>
        </div>
      )}

      <header className="space-y-3">
        <h1 className="text-foreground text-xl font-semibold break-words sm:text-2xl">{title}</h1>
        {message && (
          <p className="border-border bg-surface text-foreground rounded-[var(--radius)] border px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-line">
            {message}
          </p>
        )}
      </header>

      <section
        aria-label="Stato complessivo"
        className={cn("mt-6 flex items-start gap-3 rounded-[var(--radius)] border p-4 sm:p-5", TONE_SURFACE[verdict.tone])}
      >
        <Icon icon={VERDICT_ICON[verdict.tone]} width={24} ssr className={cn("mt-0.5 shrink-0", TONE_TEXT[verdict.tone])} aria-hidden />
        <div className="min-w-0">
          <p className="text-foreground text-base font-semibold">{verdict.title}</p>
          {verdict.detail && <p className="text-muted mt-0.5 text-sm">{verdict.detail}</p>}
          <p className="text-muted mt-1 text-meta">Aggiornato alle {f.time.format(now)}</p>
        </div>
      </section>

      {snapshot.projects.length > 0 && (
        <section aria-labelledby="status-services" className="mt-8">
          <h2 id="status-services" className="text-foreground mb-3 text-sm font-semibold">
            Servizi
          </h2>
          <ul className="border-border bg-surface divide-separator divide-y rounded-[var(--radius)] border shadow-[var(--surface-shadow)]">
            {snapshot.projects.map((project, index) => (
              // The position is the key: the page has no id to show, by design.
              <ProjectRow key={index} project={project} now={now} f={f} />
            ))}
          </ul>
          <ul className="text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta" aria-label="Legenda delle barre">
            {LEGEND.map((item) => (
              <li key={item.tone} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-[2px]", TONE_BAR[item.tone])} aria-hidden />
                {item.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="status-incidents" className="mt-8">
        <h2 id="status-incidents" className="text-foreground mb-1 text-sm font-semibold">
          Interruzioni recenti
        </h2>
        {snapshot.incidents.length === 0 ? (
          <p className="text-muted flex items-center gap-1.5 text-sm">
            <Icon icon="solar:check-circle-linear" width={16} ssr className="text-success shrink-0" aria-hidden />
            Nessuna interruzione negli ultimi {PAGE_DAYS} giorni.
          </p>
        ) : (
          <ul className="divide-separator divide-y">
            {snapshot.incidents.map((incident, index) => (
              <IncidentRow key={index} incident={incident} now={now} f={f} />
            ))}
          </ul>
        )}
      </section>

      <footer className="text-muted border-separator mt-10 border-t pt-4 text-meta leading-relaxed">
        Ogni servizio viene controllato una volta al minuto: due controlli senza risposta di fila contano come
        un&apos;interruzione. Orari nel fuso {zone}
        {offset ? ` (${offset})` : ""}. La pagina si aggiorna da sola.
      </footer>
    </main>
  );
}
