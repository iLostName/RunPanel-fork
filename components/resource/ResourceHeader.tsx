"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button, Dropdown, Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import { ActionSheet } from "@/components/ui/ActionSheet";
import { cn } from "@/lib/utils";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";

export interface ResourceMenuItem {
  id: string;
  label: string;
  icon: string;
  /** Destructive: drawn in red and kept at the end, after a separator. */
  danger?: boolean;
  disabled?: boolean;
  onAction: () => void;
}

/**
 * The top of a project or a database page: what it is, how it is, what to do.
 *
 * The two pages had grown their own headers, with the rename behind a pencil
 * that opened a dialog on one and not on the other, and actions in different
 * places. This is the one layout both use:
 *
 * - the name, renamed where it is written (Enter saves, Esc cancels);
 * - the status and a few badges that qualify it;
 * - one line of facts (`meta`);
 * - at most a primary action and a couple of secondary ones in sight, the
 *   rest in "Altro", destructive entries last.
 */
export function ResourceHeader({
  backHref,
  backLabel,
  name,
  onRename,
  status,
  badges,
  meta,
  actions,
  menu = [],
  menuLabel = "Altre azioni",
}: {
  backHref: string;
  backLabel: string;
  name: string;
  /** Resolves false to keep the field open (the caller already said why). */
  onRename?: (next: string) => Promise<boolean>;
  status?: string;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  menu?: ResourceMenuItem[];
  menuLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  // On a phone "Altro" opens an action sheet rather than a dropdown.
  const phone = useIsPhone();
  const [sheetOpen, setSheetOpen] = useState(false);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    if (!onRename || !next || next === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(next);
    setSaving(false);
    if (ok) setEditing(false);
  }

  const regular = menu.filter((item) => !item.danger);
  const danger = menu.filter((item) => item.danger);
  const ordered = [...regular, ...danger];
  const disabledKeys = ordered.filter((item) => item.disabled).map((item) => item.id);

  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {/* On a phone the top bar carries the way back, next to the status bar
            where an app keeps it; a second arrow here would be the same link. */}
        <Link
          href={backHref}
          aria-label={backLabel}
          className="text-muted hover:text-foreground hover:bg-surface-hover mt-0.5 rounded-[var(--radius)] p-1.5 transition-colors max-md:hidden"
        >
          <Icon icon="solar:arrow-left-linear" width={18} aria-hidden />
        </Link>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void commit();
                }}
              >
                <Input
                  autoFocus
                  value={draft}
                  aria-label="Nuovo nome"
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(false);
                    }
                  }}
                  className="min-w-0 text-lg font-semibold sm:w-80"
                />
                <Button type="submit" size="sm" variant="primary" isPending={saving} isDisabled={!draft.trim()}>
                  Salva
                </Button>
                <Button size="sm" variant="ghost" onPress={() => setEditing(false)} isDisabled={saving}>
                  Annulla
                </Button>
              </form>
            ) : (
              <>
                <h1 className="text-foreground truncate text-2xl font-semibold tracking-tight">{name}</h1>
                {onRename && (
                  <button
                    type="button"
                    onClick={startEditing}
                    className="text-muted hover:text-foreground rounded-[var(--radius)] p-1 transition-colors"
                    aria-label="Rinomina"
                    title="Rinomina"
                  >
                    <Icon icon="solar:pen-linear" width={15} aria-hidden />
                  </button>
                )}
              </>
            )}
            {status && <StatusBadge status={status} />}
            {badges}
          </div>
          {meta && <div className="text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">{meta}</div>}
        </div>
      </div>

      {(actions || ordered.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {ordered.length > 0 && phone && (
            <>
              <Button variant="outline" size="sm" aria-label={menuLabel} onPress={() => setSheetOpen(true)}>
                <Icon icon="solar:menu-dots-linear" width={16} aria-hidden />
                <span className="hidden sm:inline">Altro</span>
              </Button>
              <ActionSheet isOpen={sheetOpen} onOpenChange={setSheetOpen} title={`${menuLabel}: ${name}`} actions={ordered} />
            </>
          )}
          {ordered.length > 0 && !phone && (
            <Dropdown>
              <Button variant="outline" size="sm" aria-label={menuLabel}>
                <Icon icon="solar:menu-dots-linear" width={16} aria-hidden />
                <span className="hidden sm:inline">Altro</span>
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label={menuLabel}
                  disabledKeys={disabledKeys}
                  onAction={(key) => ordered.find((item) => item.id === key)?.onAction()}
                >
                  {ordered.map((item, i) => (
                    <Dropdown.Item
                      key={item.id}
                      id={item.id}
                      textValue={item.label}
                      className={cn(
                        item.danger && "text-danger",
                        item.danger && i === regular.length && regular.length > 0 && "border-separator mt-1 border-t pt-1"
                      )}
                    >
                      <Icon icon={item.icon} width={14} aria-hidden />
                      <span className="flex-1">{item.label}</span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          )}
        </div>
      )}
    </header>
  );
}
