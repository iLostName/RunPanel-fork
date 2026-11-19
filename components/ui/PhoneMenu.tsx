"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { ActionSheet, type SheetAction } from "./ActionSheet";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The "⋯" of a page header, on a phone only.
 *
 * A header with a primary action and one or two secondary ones wrapped onto a
 * second line below `md`, the secondary buttons in front of the content. There
 * they move in here, an action sheet under the thumb, and the primary keeps the
 * row to itself: the caller hides the secondary buttons with `max-md:hidden`
 * and lists the same actions here. Drawn by CSS (`md:hidden`), not by a media
 * query in JavaScript, so a phone never paints the desktop row first.
 */
export function PhoneMenu({
  label,
  actions,
  className,
}: {
  /** Names the button and titles the sheet: "Altre azioni sui backup". */
  label: string;
  actions: SheetAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  return (
    <>
      <Button
        variant="outline"
        isIconOnly
        aria-label={label}
        className={cn("shrink-0 md:hidden", className)}
        onPress={() => setOpen(true)}
      >
        <Icon icon="solar:menu-dots-bold" width={18} aria-hidden />
      </Button>
      <ActionSheet isOpen={open} onOpenChange={setOpen} title={label} actions={actions} />
    </>
  );
}

/**
 * The same for a row: on a phone the row keeps one quick action and this "⋯",
 * and the rest of its icon buttons, laid out in a line on a desktop, move in
 * here (§6.3). A delete in the list asks first, as its button does.
 */
export function PhoneRowMenu({
  label,
  actions,
  remove,
}: {
  label: string;
  actions: SheetAction[];
  remove?: {
    label: string;
    title: string;
    description?: React.ReactNode;
    disabled?: boolean;
    onConfirm: () => void | Promise<void>;
  };
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const all: SheetAction[] = [
    ...actions,
    ...(remove
      ? [
          {
            id: "remove",
            label: remove.label,
            icon: "solar:trash-bin-trash-linear",
            danger: true,
            disabled: remove.disabled,
            onAction: () => setAsking(true),
          },
        ]
      : []),
  ];
  if (all.length === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={label}
        className="text-muted shrink-0 md:hidden"
        onPress={() => setOpen(true)}
      >
        <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
      </Button>
      <ActionSheet isOpen={open} onOpenChange={setOpen} title={label} actions={all} />
      {remove && (
        <ConfirmDialog
          isOpen={asking}
          onOpenChange={setAsking}
          title={remove.title}
          description={remove.description}
          confirmLabel="Elimina"
          destructive
          onConfirm={remove.onConfirm}
        />
      )}
    </>
  );
}
