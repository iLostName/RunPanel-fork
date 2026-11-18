"use client";

import { Button, Drawer } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

export interface SheetAction {
  id: string;
  label: string;
  /** Iconify name, as a literal at the call site so the icon bundler finds it. */
  icon?: string;
  /** Red, in a group of its own at the end. */
  danger?: boolean;
  disabled?: boolean;
  onAction: () => void;
}

/**
 * A menu, as a phone draws one: a sheet from the bottom edge with one full-width
 * row per action and Annulla under the thumb.
 *
 * What `RowMenu` and the "Altro" of a project open below `md`, instead of a
 * dropdown hanging off a 36px button in a corner. Destructive actions sit in a
 * group of their own, last, so the row under a hurried thumb is never the red
 * one. Picking an action closes the sheet first, so a confirmation it opens
 * appears on its own rather than stacked on the sheet.
 *
 * HeroUI's Drawer underneath: the handle drags it closed, Escape closes it,
 * and focus is held inside and handed back like any dialog.
 */
export function ActionSheet({
  isOpen,
  onOpenChange,
  title,
  actions,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Says what the actions act on: "Azioni per «blog»". */
  title: string;
  actions: SheetAction[];
}) {
  const groups = [actions.filter((a) => !a.danger), actions.filter((a) => a.danger)].filter((g) => g.length > 0);

  function run(action: SheetAction) {
    onOpenChange(false);
    action.onAction();
  }

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog aria-label={title} className="max-h-[85dvh]">
          <Drawer.Handle />
          <Drawer.Header className="pb-1">
            <Drawer.Heading className="text-muted truncate text-center text-xs font-normal">{title}</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body className="space-y-2">
            {groups.map((group, i) => (
              <ul key={i} className="bg-surface-secondary divide-separator divide-y overflow-hidden rounded-[var(--radius)]">
                {group.map((action) => (
                  <li key={action.id}>
                    <button
                      type="button"
                      disabled={action.disabled}
                      onClick={() => run(action)}
                      className={cn(
                        "touch-chrome flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors",
                        "active:bg-default disabled:opacity-45 focus-visible:-outline-offset-2",
                        action.danger ? "text-danger" : "text-foreground"
                      )}
                    >
                      {action.icon && (
                        <Icon
                          icon={action.icon}
                          width={20}
                          aria-hidden
                          className={cn("shrink-0", action.danger ? "text-danger" : "text-muted")}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{action.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </Drawer.Body>
          <Drawer.Footer className="mt-3">
            <Button fullWidth variant="secondary" className="h-12" onPress={() => onOpenChange(false)}>
              Annulla
            </Button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
