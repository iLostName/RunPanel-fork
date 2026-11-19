"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useUnsavedGuard } from "@/lib/hooks/useUnsavedGuard";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The one way a form in the panel saves: a bar that appears with the first
 * change and leaves when it is saved or undone.
 *
 * While it is up, leaving the page asks first (`useUnsavedGuard`): closing the
 * tab gets the browser's question, a click on another page of the panel gets
 * ours. `secondaryLabel` is for a save that also does the thing the change is
 * for, the way variables offer "Salva e fai il deploy".
 */
export function StickySaveBar({
  isDirty,
  isPending = false,
  onSave,
  onReset,
  message = "Modifiche non salvate",
  saveLabel = "Salva",
  secondaryLabel,
  onSecondary,
  guard = true,
}: {
  isDirty: boolean;
  isPending?: boolean;
  onSave: () => void;
  onReset?: () => void;
  message?: string;
  saveLabel?: string;
  /** A second, primary action: save and then deploy, save and then restart. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Ask before leaving with unsaved changes. On by default. */
  guard?: boolean;
}) {
  const { pendingHref, leave, stay } = useUnsavedGuard(guard && isDirty);
  // With two saves the buttons share the line under the message on a phone.
  const shared = secondaryLabel ? "max-md:flex-1" : undefined;

  return (
    <>
      {isDirty && (
        <div
          role="region"
          aria-label="Modifiche non salvate"
          className="sticky bottom-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.75rem)] z-20 -mx-4 mt-2 sm:-mx-5 md:bottom-3"
        >
          {/*
            On a phone: "Annulla" for "Annulla modifiche", so the message keeps
            more than a word, and with a second save the message takes the top
            line and the buttons share the one under it, each wide enough for
            a thumb, instead of wrapping wherever they happened to.
          */}
          <div className="border-border bg-overlay/95 shadow-overlay mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius)] border px-4 py-3 backdrop-blur sm:mx-5">
            <span className="bg-warning size-2 shrink-0 rounded-full" aria-hidden />
            <span role="status" className={cn("text-foreground min-w-0 flex-1 truncate text-sm", secondaryLabel && "max-md:basis-[calc(100%-1.25rem)]")}>
              {message}
            </span>
            {onReset && (
              <Button className={shared} variant="ghost" size="sm" isDisabled={isPending} onPress={onReset}>
                Annulla<span className="max-md:hidden"> modifiche</span>
              </Button>
            )}
            <Button
              className={shared}
              size="sm"
              variant={secondaryLabel ? "secondary" : "primary"}
              isPending={isPending && !onSecondary}
              onPress={onSave}
            >
              {saveLabel}
            </Button>
            {secondaryLabel && onSecondary && (
              <Button className={shared} size="sm" variant="primary" isDisabled={isPending} onPress={onSecondary}>
                <Icon icon="solar:upload-minimalistic-linear" width={15} aria-hidden />
                {secondaryLabel}
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) stay();
        }}
        title="Uscire senza salvare?"
        description="Le modifiche fatte su questa pagina non sono ancora salvate e andranno perse."
        confirmLabel="Esci senza salvare"
        cancelLabel="Resta qui"
        destructive
        onConfirm={leave}
      />
    </>
  );
}
