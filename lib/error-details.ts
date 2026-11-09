"use client";

import { useSyncExternalStore } from "react";

/**
 * The whole text behind a toast that was too long to be one.
 *
 * A module-level store rather than a context: `toast.error()` is called from
 * event handlers all over the panel, outside any component, and the dialog
 * that shows the text is mounted once, next to the Toaster.
 */

interface State {
  open: boolean;
  text: string;
}

const CLOSED: State = { open: false, text: "" };

let current: State = CLOSED;
const listeners = new Set<() => void>();

function emit(next: State) {
  current = next;
  for (const listener of listeners) listener();
}

/** The last element focused outside the toasts and the dialog itself. */
let returnFocus: HTMLElement | null = null;

/** Installed by the dialog: what focus goes back to when it closes. */
export function trackReturnFocus(): () => void {
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && !target.closest("[data-sonner-toaster], [data-error-details]")) {
      returnFocus = target;
    }
  };
  document.addEventListener("focusin", onFocusIn, true);
  return () => document.removeEventListener("focusin", onFocusIn, true);
}

export function showErrorDetails(text: string) {
  // The press landed on the toast's button, which is about to go away. A
  // dialog hands focus back, on closing, to what had it when it opened: that
  // button, by then gone, so focus fell to the page — and Escape no longer
  // reached a dialog the error had come from. Back where it was first.
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  emit({ open: true, text });
}

export function closeErrorDetails() {
  // The text stays while the dialog animates out.
  emit({ ...current, open: false });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useErrorDetails(): State {
  return useSyncExternalStore(subscribe, () => current, () => CLOSED);
}
