"use client";

import { useState } from "react";
import { Button, Dropdown, Header } from "@heroui/react";
import { Icon } from "@iconify/react";
import { ActionSheet } from "@/components/ui/ActionSheet";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import type { FolderLike } from "@/lib/overview-groups";
import { cn } from "@/lib/utils";

/**
 * The "⋯" on a card or a row: where it is filed, and where else it could go.
 *
 * One click, no dialog. The folders are few and named, so listing them is
 * quicker than a picker, and the current one is marked rather than hidden so
 * the menu also answers "which folder am I in" for a card seen out of context.
 *
 * Shared by the Overview's cards and the Projects list, so moving reads the
 * same on both: the heading says what the list is for, and "Senza cartella" is
 * the name the Projects page gives the projects filed nowhere.
 *
 * On a phone the same list opens as an action sheet: a dropdown hanging off a
 * 28px button cut long folder names short and sat wherever the card happened
 * to be on the screen.
 */
export function MoveMenu({
  label,
  folderId,
  folders,
  onMove,
  className,
}: {
  label: string;
  folderId: string | null;
  folders: FolderLike[];
  onMove: (folderId: string | null) => void;
  className?: string;
}) {
  const phone = useIsPhone();
  const [sheetOpen, setSheetOpen] = useState(false);

  const trigger = (onPress?: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      isIconOnly
      aria-label={`Azioni per ${label}`}
      className={cn("text-muted hover:text-foreground -my-1 h-7 w-7 min-w-0 shrink-0", className)}
      onPress={onPress}
    >
      <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
    </Button>
  );

  if (phone) {
    return (
      <>
        {trigger(() => setSheetOpen(true))}
        <ActionSheet
          isOpen={sheetOpen}
          onOpenChange={setSheetOpen}
          title={`Sposta «${label}» in…`}
          actions={[
            {
              id: "root",
              label: "Senza cartella",
              icon: "solar:inbox-linear",
              selected: folderId === null,
              disabled: folderId === null,
              onAction: () => onMove(null),
            },
            ...folders.map((folder) => ({
              id: folder.id,
              label: folder.name,
              icon: "solar:folder-linear",
              selected: folder.id === folderId,
              disabled: folder.id === folderId,
              onAction: () => onMove(folder.id),
            })),
          ]}
        />
      </>
    );
  }

  return (
    <Dropdown>
      {trigger()}
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={`Sposta ${label}`}
          onAction={(key) => onMove(key === "root" ? null : String(key))}
        >
          <Dropdown.Section>
            <Header>Sposta in…</Header>
            <Dropdown.Item id="root" textValue="Senza cartella" isDisabled={folderId === null}>
              <Icon icon="solar:inbox-linear" width={14} aria-hidden />
              <span className="flex-1">Senza cartella</span>
              {folderId === null && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
            </Dropdown.Item>
            {folders.map((folder) => (
              <Dropdown.Item
                key={folder.id}
                id={folder.id}
                textValue={folder.name}
                isDisabled={folder.id === folderId}
              >
                <Icon icon="solar:folder-linear" width={14} aria-hidden />
                <span className="flex-1 truncate">{folder.name}</span>
                {folder.id === folderId && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
