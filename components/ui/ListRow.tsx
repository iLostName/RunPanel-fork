"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Dropdown } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import { ActionSheet } from "./ActionSheet";

export interface RowAction {
  id: string;
  label: string;
  /** Iconify name, as a literal so the icon bundler finds it. */
  icon?: string;
  /** Red, and listed last: destructive actions ask for confirmation themselves. */
  danger?: boolean;
  disabled?: boolean;
  onAction: () => void;
}

/**
 * The "⋯" of a row: every action that is not the row's one obvious action.
 *
 * Rows used to carry their actions as loose icon buttons, a trash can here and a
 * red text link there. Whatever is destructive goes in here now, last and in
 * red, so it is never the thing under a hurried click.
 *
 * On a phone the same actions open as an action sheet from the bottom edge.
 */
export function RowMenu({ label, actions, className }: { label: string; actions: RowAction[]; className?: string }) {
  const phone = useIsPhone();
  const [sheetOpen, setSheetOpen] = useState(false);
  const visible = [...actions.filter((a) => !a.danger), ...actions.filter((a) => a.danger)];
  if (visible.length === 0) return null;

  const trigger = (onPress?: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      isIconOnly
      aria-label={label}
      className={cn("text-muted shrink-0", className)}
      onPress={onPress}
    >
      <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
    </Button>
  );

  if (phone) {
    return (
      <>
        {trigger(() => setSheetOpen(true))}
        <ActionSheet isOpen={sheetOpen} onOpenChange={setSheetOpen} title={label} actions={visible} />
      </>
    );
  }

  return (
    <Dropdown>
      {trigger()}
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={visible.filter((a) => a.disabled).map((a) => a.id)}
          onAction={(key) => visible.find((a) => a.id === key)?.onAction()}
        >
          {visible.map((action) => (
            <Dropdown.Item key={action.id} id={action.id} textValue={action.label} className={cn(action.danger && "text-danger")}>
              {action.icon && <Icon icon={action.icon} width={15} aria-hidden />}
              <span className="flex-1">{action.label}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * One item of a list: what it is, how it is, and what you can do with it.
 *
 * The panel had four shapes of list (separate cards, a card grid, rows in a
 * panel, a table) for the same kind of content. This is the row: an icon, a
 * title that links to the item, its status and badges on the same line, one
 * line of plain description under it, and at the end the row's main action and
 * its menu. Lists of rows sit in a `Panel padding="flush"` with `divide-y`.
 *
 * On a phone a row with `href` opens from anywhere on it, as a list row in an
 * app does: the title link stretches over the whole row (and lights it while
 * pressed), with the action and the menu lifted above it so they stay theirs.
 * On a desktop only the title is the link, as before.
 */
export function ListRow({
  href,
  icon,
  title,
  status,
  badges,
  description,
  meta,
  action,
  menu,
  className,
}: {
  href?: string;
  /** Iconify name, as a literal so the icon bundler finds it. */
  icon?: string;
  title: React.ReactNode;
  /** A `StatusBadge`. */
  status?: React.ReactNode;
  badges?: React.ReactNode;
  /** One line, in plain words. */
  description?: React.ReactNode;
  /** Secondary facts, smaller: "deploy 2 h fa", a technical detail. */
  meta?: React.ReactNode;
  /** The row's one obvious action, visible. */
  action?: React.ReactNode;
  /** Everything else: a `RowMenu`. */
  menu?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 px-4 py-3",
        href && "hover:bg-surface-hover max-md:active:bg-surface-hover transition-colors max-md:relative",
        className
      )}
    >
      {icon && (
        <span className="bg-surface-secondary text-muted grid size-8 shrink-0 place-items-center rounded-lg">
          <Icon icon={icon} width={17} aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {href ? (
            <Link
              href={href}
              className="text-foreground max-md:touch-chrome min-w-0 truncate text-sm font-medium hover:underline max-md:after:absolute max-md:after:inset-0"
            >
              {title}
            </Link>
          ) : (
            <span className="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
          )}
          {status}
          {badges}
        </div>
        {description && <p className="text-muted mt-0.5 truncate text-xs">{description}</p>}
        {meta && <p className="text-muted/80 mt-0.5 truncate text-meta">{meta}</p>}
      </div>
      {(action || menu) && (
        <div className="flex shrink-0 items-center gap-1.5 max-md:relative max-md:z-10">
          {action}
          {menu}
        </div>
      )}
    </div>
  );
}
