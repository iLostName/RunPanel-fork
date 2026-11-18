"use client";

import { useState } from "react";
import { AlertDialog, Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { SheetGrip } from "./SheetGrip";

/**
 * Confirmation for destructive actions.
 *
 * Replaces six `window.confirm()` calls and two hand-rolled modals that had no
 * focus trap, no `role="dialog"` and no scroll lock. Built on HeroUI's
 * AlertDialog so focus management and Escape handling come from the library
 * rather than from a `window.addEventListener("keydown")` in a page component.
 *
 * `onConfirm` may be async: the dialog stays open with the button in a pending
 * state until it settles, so a slow delete cannot be fired twice.
 *
 * Two levels, one dialog. Something that interrupts (stop, restart, revoke)
 * says what will happen and asks. Something that cannot be undone and loses
 * data passes `confirmText`: the button stays disabled until that name is
 * typed, so the dialog cannot be dismissed with a reflexive Enter.
 *
 * On a phone it is a bottom sheet; swiping it down is Annulla (`SheetGrip`).
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  confirmLabel = "Conferma",
  cancelLabel = "Annulla",
  destructive = false,
  confirmText,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** For what cannot be undone: the name to type before the button unlocks. */
  confirmText?: string;
  /** Return `false` to keep the dialog open after a failure it already reported. */
  onConfirm: () => void | boolean | Promise<void | boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const locked = confirmText !== undefined && typed.trim() !== confirmText;

  // A fresh dialog starts empty: what was typed for the last one is not consent
  // for this one. Adjusted during render, not in an effect.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setTyped("");
  }

  async function handleConfirm() {
    if (locked) return;
    setPending(true);
    try {
      // `false` means the action failed and said so itself: stay open.
      if ((await onConfirm()) === false) return;
      onOpenChange(false);
    } catch (err) {
      // Callers that already reported their failure throw to stay open; only a
      // fetch that never reached the panel (a TypeError) is left to say here.
      if (err instanceof TypeError) toast.error(MSG.unreachable);
    } finally {
      setPending(false);
    }
  }

  // No AlertDialog.Root: that is react-aria's DialogTrigger, which wraps its
  // children in a PressResponder to turn the first one into the trigger. This
  // dialog has no trigger element — it is opened from state — so nothing ever
  // registered as pressable and every mount logged "A PressResponder was
  // rendered without a pressable child". The backdrop is a ModalOverlay, which
  // takes isOpen/onOpenChange directly when it is not inside a trigger.
  return (
    <AlertDialog.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never let a backdrop click cancel work that is already running.
        if (pending) return;
        onOpenChange(open);
      }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <SheetGrip disabled={pending} />
          <AlertDialog.Header>
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          {(description || confirmText !== undefined) && (
            <AlertDialog.Body className="space-y-4">
              {/* A div, not a p: callers put labels and controls in here. */}
              {description && <div className="text-muted text-sm">{description}</div>}
              {confirmText !== undefined && (
                <TextField value={typed} onChange={setTyped} isDisabled={pending} autoFocus>
                  <Label>
                    Scrivi <span className="text-foreground font-mono">{confirmText}</span> per confermare
                  </Label>
                  <Input autoComplete="off" spellCheck={false} className="font-mono text-sm" />
                </TextField>
              )}
            </AlertDialog.Body>
          )}
          <AlertDialog.Footer className="justify-end gap-2">
            <Button variant="ghost" isDisabled={pending} onPress={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? "danger" : "primary"}
              isPending={pending}
              isDisabled={locked}
              onPress={handleConfirm}
            >
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

