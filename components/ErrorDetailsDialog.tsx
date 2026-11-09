"use client";

import { useEffect } from "react";
import { Button, Modal } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { closeErrorDetails, trackReturnFocus, useErrorDetails } from "@/lib/error-details";
import { outsideToasts } from "@/lib/toast";

/** The whole text of a toast that showed only its first line. Mounted once, next to the Toaster. */
export function ErrorDetailsDialog() {
  const { open, text } = useErrorDetails();
  const { copied, copy } = useClipboard();
  useEffect(() => trackReturnFocus(), []);

  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) closeErrorDetails();
      }}
      shouldCloseOnInteractOutside={outsideToasts}
    >
      <Modal.Container>
        <Modal.Dialog className="max-w-3xl" data-error-details="">
          <Modal.Header>
            <Modal.Heading>Messaggio completo</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <pre className="border-border bg-surface-secondary text-foreground text-meta max-h-[60vh] overflow-auto rounded-[var(--radius)] border p-3 leading-relaxed break-words whitespace-pre-wrap">
              {text}
            </pre>
          </Modal.Body>
          <Modal.Footer className="justify-end gap-2">
            <Button variant="ghost" onPress={() => void copy(text)}>
              <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} aria-hidden />
              {copied ? "Copiato" : "Copia"}
            </Button>
            <Button onPress={closeErrorDetails}>Chiudi</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
