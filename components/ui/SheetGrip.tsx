"use client";

import { useContext, useEffect, useRef } from "react";
import { OverlayTriggerStateContext } from "react-aria-components";

/** Movement before a press becomes a drag, so a tap on the header stays a tap. */
const DRAG_AFTER_PX = 6;
/** Dragged further than this share of its height, the sheet closes on release… */
const CLOSE_FRACTION = 0.25;
/** …and so does a flick, however short. In px per ms. */
const CLOSE_VELOCITY = 0.5;
/** While closing is not allowed the sheet still follows, a quarter as far and no further than this. */
const LOCKED_MAX_PX = 28;

/**
 * The handle of a dialog drawn as a bottom sheet (globals.css, below `md`), and
 * the gesture that goes with it: drag the sheet down by its handle or its
 * title and it closes, the way every sheet on a phone does.
 *
 * Rendered as the first child of `Modal.Dialog` or `AlertDialog.Dialog`.
 * Closing goes through the overlay's own state, so it is exactly Escape or
 * Annulla: the dialog's `onOpenChange` still decides, and a dialog that
 * refuses (one whose save is running) springs back instead of closing.
 *
 * It never closes over unsaved input. As soon as anything is typed or changed
 * inside the sheet, the drag only stretches and springs back; what was typed
 * goes away only through Annulla, never by a swipe that missed a scroll.
 * `disabled` locks it the same way, for a dialog whose work is running.
 *
 * Drawn and active only on a phone: on a desktop the dialog is a centred card
 * and there is nothing to pull.
 */
export function SheetGrip({ disabled = false }: { disabled?: boolean }) {
  const state = useContext(OverlayTriggerStateContext);
  const ref = useRef<HTMLDivElement>(null);
  // Refs, read when the finger lets go, so the listeners below are attached
  // once: the overlay's state is a new object on every render of the dialog,
  // and re-attaching on each one would also forget that something was typed.
  const disabledRef = useRef(disabled);
  const stateRef = useRef(state);
  const dirtyRef = useRef(false);
  useEffect(() => {
    disabledRef.current = disabled;
    stateRef.current = state;
  });

  useEffect(() => {
    const sheet = ref.current?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    if (!sheet) return;

    const onEdit = () => {
      dirtyRef.current = true;
    };

    let pointer: number | null = null;
    let startY = 0;
    let dragging = false;
    let offset = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;

    const springBack = () => {
      sheet.style.transition = "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";
      sheet.style.transform = "";
      sheet.addEventListener("transitionend", () => (sheet.style.transition = ""), { once: true });
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !window.matchMedia("(width < 48rem)").matches) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-sheet-grip], .modal__header, .alert-dialog__header")) return;
      if (target.closest("input, textarea, select, button, a, [role='button']")) return;
      pointer = event.pointerId;
      startY = lastY = event.clientY;
      lastT = event.timeStamp;
      dragging = false;
      offset = velocity = 0;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const raw = event.clientY - startY;
      if (!dragging) {
        if (Math.abs(raw) < DRAG_AFTER_PX) return;
        // Upwards is not a gesture of the sheet.
        if (raw < 0) {
          pointer = null;
          return;
        }
        dragging = true;
        sheet.setPointerCapture(event.pointerId);
        sheet.style.transition = "none";
      }
      const locked = dirtyRef.current || disabledRef.current;
      offset = Math.max(0, locked ? Math.min(raw / 4, LOCKED_MAX_PX) : raw);
      const dt = event.timeStamp - lastT;
      if (dt > 0) velocity = (event.clientY - lastY) / dt;
      lastY = event.clientY;
      lastT = event.timeStamp;
      sheet.style.transform = `translateY(${offset}px)`;
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      if (!dragging) return;
      dragging = false;
      if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
      const locked = dirtyRef.current || disabledRef.current;
      const close = !locked && (offset > sheet.offsetHeight * CLOSE_FRACTION || velocity > CLOSE_VELOCITY);
      const overlay = stateRef.current;
      if (!close || !overlay) {
        springBack();
        return;
      }
      // The exit animation carries on from where the finger let go. If the
      // dialog declined to close, it is still there two frames later.
      overlay.close();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (sheet.isConnected && !sheet.closest('[data-exiting="true"]')) springBack();
        })
      );
    };

    sheet.addEventListener("input", onEdit);
    sheet.addEventListener("change", onEdit);
    sheet.addEventListener("pointerdown", onDown);
    sheet.addEventListener("pointermove", onMove);
    sheet.addEventListener("pointerup", onUp);
    sheet.addEventListener("pointercancel", onUp);
    return () => {
      sheet.removeEventListener("input", onEdit);
      sheet.removeEventListener("change", onEdit);
      sheet.removeEventListener("pointerdown", onDown);
      sheet.removeEventListener("pointermove", onMove);
      sheet.removeEventListener("pointerup", onUp);
      sheet.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div
      ref={ref}
      data-sheet-grip=""
      aria-hidden
      // `touch-action: none` or the browser takes the drag for a scroll and
      // cancels the pointer halfway.
      style={{ touchAction: "none" }}
      className="touch-chrome -mb-1 flex h-6 shrink-0 cursor-grab items-center justify-center md:hidden"
    >
      <span className="bg-muted/40 h-1 w-10 rounded-full" />
    </div>
  );
}
