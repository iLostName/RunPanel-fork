"use client";

import { useState } from "react";
import { Button, Dropdown, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { ActionSheet } from "@/components/ui/ActionSheet";
import { Badge } from "@/components/ui/Badge";
import { FieldHint } from "@/components/ui/Hint";
import { RowMenu } from "@/components/ui/ListRow";
import { Segmented } from "@/components/ui/Segmented";
import { MAX_COPIES } from "@/lib/backup-copies";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import type { DestinationView, PolicyDestinationView } from "@/components/backups/types";
import { describeDestination } from "./providers";

/**
 * Where a policy's archive goes: an ordered list of destinations, the first
 * the primary, each other one a copy of the same file — the 3-2-1 rule, so that
 * losing a disk, a bucket or an account never loses the backups.
 *
 * The order is what a run follows when it sends the copies, one after the
 * other, and what a restore follows after the copies on this server's disk.
 * Moving and removing are in each row's menu (§6.3: one obvious action per
 * row); nothing is saved until the form is.
 */

/** One destination as the form holds it: retention as typed, so a half-typed number is not lost. */
export interface DestinationDraft {
  destinationId: string;
  /** A rule of its own instead of the policy's. */
  own: boolean;
  count: string;
  days: string;
  gb: string;
}

export function draftFrom(entry: PolicyDestinationView): DestinationDraft {
  const rule = entry.retention;
  return {
    destinationId: entry.destinationId,
    own: rule !== null,
    count: rule?.count ? String(rule.count) : "",
    days: rule?.days ? String(rule.days) : "",
    gb: rule?.bytes ? String(Math.round(rule.bytes / 1024 ** 3)) : "",
  };
}

export function blankDraft(destinationId: string): DestinationDraft {
  return { destinationId, own: false, count: "", days: "", gb: "" };
}

/** A rule as words, for a closed section: "30 archivi · 90 giorni", or `none` when it has no limit. */
export function ruleWords(rule: { count: string; days: string; gb: string }, none = "tutti"): string {
  return (
    [rule.count ? `${rule.count} archivi` : null, rule.days ? `${rule.days} giorni` : null, rule.gb ? `${rule.gb} GB` : null]
      .filter(Boolean)
      .join(" · ") || none
  );
}

export function DestinationList({
  list,
  destinations,
  onChange,
}: {
  list: DestinationDraft[];
  destinations: DestinationView[];
  onChange: (next: DestinationDraft[]) => void;
}) {
  const byId = new Map(destinations.map((destination) => [destination.id, destination]));
  const remaining = destinations.filter((destination) => !list.some((draft) => draft.destinationId === destination.id));
  const nameOf = (id: string) => byId.get(id)?.name ?? "destinazione non più configurata";

  const move = (from: number, to: number) => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const phone = useIsPhone();
  const [sheetOpen, setSheetOpen] = useState(false);

  const listed = list.map((draft) => byId.get(draft.destinationId)).filter((d): d is DestinationView => Boolean(d));
  const offsite = listed.some((destination) => destination.type !== "local");
  const full = list.length >= MAX_COPIES;

  return (
    <div className="mt-4">
      <ol className="border-border divide-y divide-[var(--color-border)] rounded-[var(--radius)] border">
        {list.map((draft, index) => {
          const destination = byId.get(draft.destinationId);
          const name = nameOf(draft.destinationId);
          return (
            <li key={draft.destinationId} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <span
                className="bg-surface-secondary text-muted grid size-7 shrink-0 place-items-center rounded-md text-xs font-medium tabular-nums"
                aria-hidden
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground min-w-0 truncate text-sm font-medium">{name}</span>
                  {index === 0 && list.length > 1 && <Badge tone="accent">Principale</Badge>}
                  {destination?.isDefault && <Badge icon="solar:star-linear">Predefinita</Badge>}
                </div>
                <p className="text-muted truncate text-xs">
                  {destination ? describeDestination(destination) : "Non esiste più: toglila, o il backup la salterà"}
                </p>
              </div>
              {list.length > 1 && (
                <RowMenu
                  label={`Azioni per ${name}`}
                  actions={[
                    ...(index > 0
                      ? [{ id: "primary", label: "Rendi principale", icon: "solar:star-linear", onAction: () => move(index, 0) }]
                      : []),
                    ...(index > 1
                      ? [{ id: "up", label: "Sposta su", icon: "solar:alt-arrow-up-linear", onAction: () => move(index, index - 1) }]
                      : []),
                    ...(index < list.length - 1
                      ? [{ id: "down", label: "Sposta giù", icon: "solar:alt-arrow-down-linear", onAction: () => move(index, index + 1) }]
                      : []),
                    {
                      id: "remove",
                      label: "Togli questa copia",
                      icon: "solar:trash-bin-minimalistic-linear",
                      onAction: () => onChange(list.filter((_, at) => at !== index)),
                    },
                  ]}
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* On a phone the choice opens as an action sheet, each destination on
            a row of its own with where it writes under its name. */}
        {phone ? (
          <>
            <Button size="sm" variant="secondary" isDisabled={remaining.length === 0 || full} onPress={() => setSheetOpen(true)}>
              <Icon icon="solar:add-circle-linear" width={15} aria-hidden />
              Aggiungi una copia
            </Button>
            <ActionSheet
              isOpen={sheetOpen}
              onOpenChange={setSheetOpen}
              title="Destinazione della nuova copia"
              actions={remaining.map((destination) => ({
                id: destination.id,
                label: destination.name,
                description: describeDestination(destination),
                icon:
                  destination.type === "local"
                    ? "solar:server-linear"
                    : destination.type === "telegram"
                      ? "solar:plain-linear"
                      : "solar:cloud-storage-linear",
                onAction: () => onChange([...list, blankDraft(destination.id)]),
              }))}
            />
          </>
        ) : (
          <Dropdown>
            <Button size="sm" variant="secondary" isDisabled={remaining.length === 0 || full}>
              <Icon icon="solar:add-circle-linear" width={15} aria-hidden />
              Aggiungi una copia
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu
                aria-label="Destinazione della nuova copia"
                onAction={(key) => onChange([...list, blankDraft(String(key))])}
              >
                {remaining.map((destination) => (
                  <Dropdown.Item key={destination.id} id={destination.id} textValue={destination.name}>
                    <Icon
                      icon={
                        destination.type === "local"
                          ? "solar:server-linear"
                          : destination.type === "telegram"
                            ? "solar:plain-linear"
                            : "solar:cloud-storage-linear"
                      }
                      width={15}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{destination.name}</span>
                      <span className="text-muted truncate text-xs">{describeDestination(destination)}</span>
                    </span>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
        {remaining.length === 0 && !full && (
          <span className="text-muted text-xs">Per una copia in più, aggiungi prima un&apos;altra destinazione dalla pagina Backup.</span>
        )}
      </div>

      <FieldHint>
        {offsite
          ? list.length > 1
            ? "Almeno una copia esce da questo server: se il server si rompe, il backup resta. Il ripristino usa la prima copia disponibile, partendo da quelle su questo server."
            : "Gli archivi vanno fuori da questo server: se il server si rompe, il backup resta."
          : "Tutte le copie sono su dischi di questo server: un guasto, un furto o un ransomware le prenderebbe insieme. Per la regola 3-2-1 aggiungi una copia fuori da qui, per esempio su S3 o su Telegram."}
      </FieldHint>
    </div>
  );
}

/**
 * Each copy's retention, under the policy's own rule: the same, or one of its
 * own — a week on the disk, a year in the bucket. Shown only with more than
 * one destination: with one, the policy's rule is that destination's.
 */
export function CopyRetention({
  list,
  destinations,
  onChange,
}: {
  list: DestinationDraft[];
  destinations: DestinationView[];
  onChange: (next: DestinationDraft[]) => void;
}) {
  if (list.length < 2) return null;
  const byId = new Map(destinations.map((destination) => [destination.id, destination]));
  const update = (index: number, patch: Partial<DestinationDraft>) =>
    onChange(list.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));

  return (
    <div className="border-border mt-5 border-t pt-4">
      <p className="text-foreground text-sm font-medium">Per ogni destinazione</p>
      <FieldHint>
        Ogni copia segue la regola qui sopra, oppure una sua: per esempio una settimana sul disco e un anno nel bucket.
        Anche così, la copia più recente in ogni destinazione resta sempre.
      </FieldHint>
      <ul className="mt-3 space-y-4">
        {list.map((draft, index) => {
          const name = byId.get(draft.destinationId)?.name ?? "destinazione non più configurata";
          return (
            <li key={draft.destinationId}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground min-w-0 truncate text-sm">{name}</span>
                <Segmented
                  label={`Quanto tenerne su ${name}`}
                  value={draft.own ? "own" : "policy"}
                  onChange={(value) => update(index, { own: value === "own" })}
                  options={[
                    { value: "policy", label: "Come sopra" },
                    { value: "own", label: "Personalizzata" },
                  ]}
                />
              </div>
              {draft.own && (
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <TextField value={draft.count} onChange={(count) => update(index, { count })}>
                    <Label>Quanti archivi</Label>
                    <Input inputMode="numeric" placeholder="nessun limite" />
                  </TextField>
                  <TextField value={draft.days} onChange={(days) => update(index, { days })}>
                    <Label>Per quanti giorni</Label>
                    <Input inputMode="numeric" placeholder="nessun limite" />
                  </TextField>
                  <TextField value={draft.gb} onChange={(gb) => update(index, { gb })}>
                    <Label>Spazio massimo (GB)</Label>
                    <Input inputMode="numeric" placeholder="nessun limite" />
                  </TextField>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
