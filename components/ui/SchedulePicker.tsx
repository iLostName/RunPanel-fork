"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { ComboBox, Input, Label, ListBox, TextField } from "@heroui/react";
import { Advanced } from "@/components/ui/Technical";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { Segmented, SegmentedMulti } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { useNodeApi } from "@/lib/hooks/useNode";
import { formatWhen } from "@/lib/format";
import {
  HOUR_INTERVALS,
  WEEKDAY_SHORT,
  cronToSchedule,
  defaultSchedule,
  describeSchedule,
  scheduleToCron,
  supportedTimeZones,
  timeZoneOptions,
  zoneOffset,
  type Schedule,
  type ScheduleKind,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

/**
 * When something runs, asked the way people say it.
 *
 * "Ogni giorno alle 03:00", "Ogni settimana il lunedì", "Ogni mese il giorno
 * 1", "Ogni 6 ore" — and the raw cron under Avanzate, for whoever wants it. The
 * expression stays the value: the picker reads it with `cronToSchedule` and
 * writes it with `scheduleToCron`, and an expression none of the shapes can say
 * without changing its meaning is shown as it is, with the cron field open.
 *
 * The preview comes from the server's own parser (`POST /api/backups/cron-preview`,
 * despite the path a plain helper any signed-in user may call), so what the
 * picker accepts is what the scheduler will run.
 *
 * Written for backups first and meant for any schedule — the project's
 * scheduled tasks will use it too.
 */

interface Preview {
  cron: string;
  description: string;
  timezone: string;
  occurrences: string[];
}

const KIND_OPTIONS: { value: ScheduleKind; label: string }[] = [
  { value: "manual", label: "Solo su richiesta" },
  { value: "hourly", label: "Ogni tot ore" },
  { value: "daily", label: "Ogni giorno" },
  { value: "weekly", label: "Ogni settimana" },
  { value: "monthly", label: "Ogni mese" },
];

const two = (value: number) => String(value).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: two(hour) }));
const DAYS = Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: `il giorno ${index + 1}` }));

/** Every five minutes, plus the one already chosen if it is not on that grid. */
function minuteOptions(current: number) {
  const values = new Set(Array.from({ length: 12 }, (_, i) => i * 5));
  values.add(current);
  return [...values].sort((a, b) => a - b).map((minute) => ({ value: String(minute), label: two(minute) }));
}

/** An instant on the schedule's clock, which is not necessarily the browser's. */
function formatInZone(iso: string, zone: string | undefined): string {
  if (!zone) return formatWhen(iso);
  try {
    return new Intl.DateTimeFormat("it-IT", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return formatWhen(iso);
  }
}

export function SchedulePicker({
  value,
  onChange,
  timeZone,
  onTimeZoneChange,
  panelTimeZone,
  allowManual = true,
  onValidityChange,
  previewPath = "/api/backups/cron-preview",
  className,
}: {
  /** The cron expression. Empty means "only when asked", when `allowManual`. */
  value: string;
  onChange: (cron: string) => void;
  /** The schedule's own zone; null follows the panel's. Omit both to hide the zone picker. */
  timeZone?: string | null;
  onTimeZoneChange?: (zone: string | null) => void;
  /** The zone a null `timeZone` means, to name it. */
  panelTimeZone?: string | null;
  allowManual?: boolean;
  /**
   * What the server's parser says about the expression: null when valid. Only
   * reported for a non-empty expression — an empty one has nothing to check, so
   * a caller should ignore a stale error once the value is empty.
   */
  onValidityChange?: (error: string | null) => void;
  previewPath?: string;
  className?: string;
}) {
  const api = useNodeApi();
  const schedule = useMemo(() => cronToSchedule(value), [value]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ cron: string; message: string } | null>(null);

  const effectiveZone = timeZone || panelTimeZone || undefined;
  // The latest callback, without a new identity on every render refetching.
  const report = useEffectEvent((message: string | null) => onValidityChange?.(message));

  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => {
      fetch(api(previewPath), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: value, ...(timeZone ? { timezone: timeZone } : {}), count: 3 }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            const message = body.error ?? "Espressione non valida";
            setPreview(null);
            setError({ cron: value, message });
            report(message);
            return;
          }
          setError(null);
          setPreview({ cron: value, ...body });
          report(null);
        })
        .catch(() => {
          const message = "Impossibile verificare la pianificazione";
          setError({ cron: value, message });
          report(message);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [api, previewPath, value, timeZone]);

  const set = (next: Schedule) => onChange(scheduleToCron(next));
  const custom = schedule.kind === "custom";
  const kinds = KIND_OPTIONS.filter((option) => allowManual || option.value !== "manual");
  const shownError = value && error?.cron === value ? error.message : null;
  const shownPreview = value && preview?.cron === value && !shownError ? preview : null;

  return (
    <div className={cn("space-y-4", className)}>
      <Segmented
        label="Con che frequenza"
        value={custom ? ("custom" as ScheduleKind) : schedule.kind}
        onChange={(kind) => set(defaultSchedule(kind, schedule))}
        options={custom ? [...kinds, { value: "custom" as ScheduleKind, label: "Personalizzata" }] : kinds}
      />

      {schedule.kind === "hourly" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Ogni"
            value={String(schedule.every)}
            onChange={(every) => set({ ...schedule, every: Number(every) })}
            options={HOUR_INTERVALS.map((every) => ({ value: String(every), label: every === 1 ? "ora" : `${every} ore` }))}
          />
          <SelectField
            label="Al minuto"
            value={String(schedule.minute)}
            onChange={(minute) => set({ ...schedule, minute: Number(minute) })}
            options={minuteOptions(schedule.minute)}
          />
        </div>
      )}

      {schedule.kind === "weekly" && (
        <div>
          <p className="text-foreground mb-2 text-sm">Nei giorni</p>
          <SegmentedMulti
            label="Giorni della settimana"
            values={schedule.weekdays.map(String)}
            onChange={(days) => {
              // A week with no day in it is not a schedule: the last one stays.
              if (days.length > 0) set({ ...schedule, weekdays: days.map(Number) });
            }}
            options={WEEKDAY_SHORT.map((day) => ({ value: String(day.day), label: day.label }))}
          />
        </div>
      )}

      {(schedule.kind === "daily" || schedule.kind === "weekly" || schedule.kind === "monthly") && (
        <div className="grid gap-4 sm:grid-cols-3">
          {schedule.kind === "monthly" && (
            <SelectField
              label="Quale giorno"
              value={String(schedule.day)}
              onChange={(day) => set({ ...schedule, day: Number(day) })}
              options={DAYS}
            />
          )}
          <SelectField
            label="Alle ore"
            value={String(schedule.hour)}
            onChange={(hour) => set({ ...schedule, hour: Number(hour) })}
            options={HOURS}
          />
          <SelectField
            label="E minuti"
            value={String(schedule.minute)}
            onChange={(minute) => set({ ...schedule, minute: Number(minute) })}
            options={minuteOptions(schedule.minute)}
          />
        </div>
      )}

      {schedule.kind === "monthly" && schedule.day > 28 && (
        <FieldHint>
          Non tutti i mesi hanno il giorno {schedule.day}: in quelli che non ce l&apos;hanno non parte. Per
          non saltarne nessuno scegli un giorno fino al 28.
        </FieldHint>
      )}

      {custom && (
        <Hint tone="info" title="Pianificazione personalizzata">
          Questa pianificazione non si può dire con le scelte qui sopra senza cambiarne il significato: la
          trovi, e la modifichi, nell&apos;espressione cron qui sotto.
        </Hint>
      )}

      {onTimeZoneChange && schedule.kind !== "manual" && (
        <TimeZonePicker value={timeZone ?? null} onChange={onTimeZoneChange} panelTimeZone={panelTimeZone ?? null} />
      )}

      {schedule.kind !== "manual" && (
        <div className="text-sm">
          <p className="text-foreground font-medium">
            {describeSchedule(schedule, shownPreview?.description)}
            {effectiveZone && <span className="text-muted font-normal"> · ora di {effectiveZone}</span>}
          </p>
          {shownError ? (
            <p role="alert" className="text-danger mt-1 text-meta">
              {shownError}
            </p>
          ) : (
            shownPreview &&
            shownPreview.occurrences.length > 0 && (
              <p className="text-muted mt-1 text-xs">
                Prossime volte:{" "}
                {shownPreview.occurrences.map((occurrence) => formatInZone(occurrence, shownPreview.timezone)).join(" · ")}
              </p>
            )
          )}
        </div>
      )}

      <Advanced summary="espressione cron" defaultExpanded={custom || undefined}>
        <div>
          <TextField value={value} onChange={onChange}>
            <Label>Espressione cron</Label>
            <Input placeholder={allowManual ? "vuota = solo su richiesta" : "0 3 * * *"} className="font-mono text-sm" />
          </TextField>
          <FieldHint>
            Cinque campi: minuto, ora, giorno del mese, mese, giorno della settimana; anche <code>@daily</code> e
            simili. Non sono supportati secondi, <code>L</code>, <code>W</code>, <code>#</code> e <code>@reboot</code>.
            {allowManual && " Vuota significa che parte solo quando lo chiedi tu."}
          </FieldHint>
        </div>
      </Advanced>
    </div>
  );
}

const PANEL_ZONE = "__panel__";

/**
 * A zone from the full list, searchable — "rome", "new york", "utc".
 *
 * Null is its own entry, "come il pannello", because that is what most
 * schedules want and what a policy saved without a zone already does: the
 * panel's zone from Impostazioni, then UTC — never the host's.
 */
export function TimeZonePicker({
  value,
  onChange,
  panelTimeZone,
  label = "Fuso orario",
}: {
  value: string | null;
  onChange: (zone: string | null) => void;
  panelTimeZone: string | null;
  label?: string;
}) {
  // Built once per mount: four hundred formatters are cheap once, not on every keystroke.
  const options = useMemo(() => {
    const now = new Date();
    return timeZoneOptions(supportedTimeZones(), [value, panelTimeZone]).map((zone) => ({
      id: zone,
      offset: zoneOffset(zone, now),
    }));
  }, [value, panelTimeZone]);

  const panelLabel = `Come il pannello${panelTimeZone ? ` (${panelTimeZone})` : ""}`;

  return (
    <div>
      <ComboBox
        className="w-full"
        variant="secondary"
        fullWidth
        value={value ?? PANEL_ZONE}
        onChange={(key) => {
          // Clearing the text is not a choice: the last zone stays until another is picked.
          if (key === null) return;
          onChange(String(key) === PANEL_ZONE ? null : String(key));
        }}
        defaultFilter={(text, input) => normaliseZone(text).includes(normaliseZone(input))}
      >
        <Label>{label}</Label>
        <ComboBox.InputGroup>
          <Input placeholder="Cerca una città o un fuso, per esempio Rome" />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <ListBox>
            <ListBox.Item id={PANEL_ZONE} textValue={panelLabel}>
              {panelLabel}
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {options.map((option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.id}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{option.id.replace(/_/g, " ")}</span>
                  {option.offset && <span className="text-muted shrink-0 text-xs tabular-nums">{option.offset}</span>}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
      <FieldHint>
        {value
          ? `Gli orari si leggono nell'ora di ${value}, anche quando l'ora legale cambia.`
          : "Il fuso scelto in Impostazioni › Generale: se lo cambi lì, cambia anche qui."}
      </FieldHint>
    </div>
  );
}

/** Case, underscores and slashes do not matter when looking for a zone. */
function normaliseZone(text: string): string {
  return text.toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
}
