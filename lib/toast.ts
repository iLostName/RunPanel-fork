"use client";

import { toast as sonner, type ExternalToast } from "sonner";
import { showErrorDetails } from "./error-details";
import { summarize } from "./toast-text";

/**
 * The panel's toasts: sonner's, with one change for errors and warnings.
 *
 * Plenty of what the server answers with is not a sentence: a compose file
 * that failed puts docker's whole output in `error`, and a build can fail with
 * thousands of characters of it. Handed to sonner as it was, that made a toast
 * taller than the screen that went away after four seconds. Past one line or
 * `TOAST_MAX_CHARS`, the toast now shows the first line and a "Dettagli" button that
 * opens the whole text in a dialog, where it scrolls and copies — and it stays
 * up longer, so the button can be reached.
 *
 * Imported instead of sonner's own everywhere: the lint config refuses that one.
 */

const LONG_DURATION_MS = 12_000;

type Message = Parameters<typeof sonner.error>[0];

function withDetails(show: typeof sonner.error): typeof sonner.error {
  return (message: Message, data?: ExternalToast) => {
    if (typeof message !== "string") return show(message, data);
    const description = typeof data?.description === "string" ? data.description : null;
    const title = summarize(message);
    const extra = description ? summarize(description) : null;
    if (!title.cut && !extra?.cut) return show(message, data);

    const text = description ? `${message.trim()}\n\n${description.trim()}` : message.trim();
    return show(title.short, {
      duration: LONG_DURATION_MS,
      ...data,
      ...(extra ? { description: extra.short } : {}),
      action: data?.action ?? { label: "Dettagli", onClick: () => showErrorDetails(text) },
    });
  };
}

export const toast: typeof sonner = Object.assign(
  (message: Message, data?: ExternalToast) => sonner(message, data),
  sonner,
  { error: withDetails(sonner.error), warning: withDetails(sonner.warning) }
);

/**
 * For a dialog's `shouldCloseOnInteractOutside`: a press on a toast is not a
 * press outside the dialog. Without it, opening an error's details from a
 * dialog that just failed would close that dialog, and what was typed in it.
 */
export function outsideToasts(element: Element): boolean {
  return !element.closest("[data-sonner-toaster]");
}
