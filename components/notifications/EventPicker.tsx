"use client";

import { Button } from "@heroui/react";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Segmented } from "@/components/ui/Segmented";
import { DEFAULT_NOTIFY_EVENTS, NOTIFY_EVENTS, NOTIFY_GROUPS, type NotifyEventKey, type NotifyFilter } from "@/lib/notify-events";

/**
 * Which events a channel receives, and how bad they have to be.
 *
 * Drawn from `NOTIFY_GROUPS`, so an event added there appears here with its
 * label and its explanation and no edit to this file. Tick boxes rather than
 * switches: nothing changes until the dialog is saved.
 */
export function EventPicker({
  events,
  onEventsChange,
  filter,
  onFilterChange,
}: {
  events: readonly NotifyEventKey[];
  onEventsChange: (next: NotifyEventKey[]) => void;
  filter: NotifyFilter;
  onFilterChange: (next: NotifyFilter) => void;
}) {
  const toggle = (key: NotifyEventKey, on: boolean) => {
    const next = new Set(events);
    if (on) next.add(key);
    else next.delete(key);
    // In the catalogue's order, so a saved selection reads the same every time.
    onEventsChange(NOTIFY_EVENTS.filter((candidate) => next.has(candidate)));
  };

  return (
    <div className="space-y-4">
      <div>
        <span className="text-foreground mb-2 block text-sm">Cosa inviare</span>
        <Segmented
          label="Cosa inviare"
          value={filter}
          onChange={onFilterChange}
          options={[
            { value: "all", label: "Tutto" },
            { value: "problems", label: "Solo quando qualcosa va storto" },
          ]}
        />
        <p className="text-muted text-meta mt-1.5 leading-relaxed">
          {filter === "problems"
            ? "Deploy e backup falliti, crash, disco quasi pieno. Quando un problema si risolve (Docker che torna, il disco che rientra) arriva comunque."
            : "Anche le buone notizie: deploy riusciti, backup completati, aggiornamenti disponibili."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-foreground text-sm">Per quali eventi</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onPress={() => onEventsChange([...DEFAULT_NOTIFY_EVENTS])}>
              Consigliati
            </Button>
            <Button size="sm" variant="ghost" onPress={() => onEventsChange([...NOTIFY_EVENTS])}>
              Tutti
            </Button>
          </div>
        </div>
        {NOTIFY_GROUPS.map((group) => (
          <fieldset key={group.id} className="space-y-2">
            <legend className="text-muted/70 text-meta mb-1 tracking-wider uppercase">{group.label}</legend>
            {group.events.map((event) => (
              <CheckboxField
                key={event.key}
                label={event.label}
                description={event.description}
                isSelected={events.includes(event.key)}
                onChange={(on) => toggle(event.key, on)}
              />
            ))}
          </fieldset>
        ))}
        {events.length === 0 && <p className="text-warning text-meta">Scegli almeno un evento, o il canale non riceverà niente.</p>}
      </div>
    </div>
  );
}
