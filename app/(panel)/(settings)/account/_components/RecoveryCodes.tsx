"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Hint } from "@/components/ui/Hint";
import { useClipboard } from "@/lib/hooks/useClipboard";

/**
 * The ten recovery codes, the one time they exist in readable form.
 *
 * Copy and download both, because people keep them in different places — a
 * password manager, a printed sheet — and the panel cannot show them again.
 * The tick box is what closes the dialog: a person who scrolled past them is
 * the person who is locked out next month.
 */
export function RecoveryCodes({
  codes,
  account,
  saved,
  onSavedChange,
}: {
  codes: string[];
  account: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}) {
  const { copied, copy } = useClipboard();

  function download() {
    const text = [
      "RunPanel — codici di recupero",
      `Account: ${account}`,
      `Creati il ${new Date().toLocaleString("it-IT")}`,
      "",
      "Ogni codice vale un solo accesso. Servono se perdi il telefono con l'app di autenticazione.",
      "Conservali lontano dal telefono, per esempio stampati o in un gestore di password.",
      "",
      ...codes,
      "",
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "runpanel-codici-di-recupero.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Hint tone="warn" title="Salvali adesso: non verranno più mostrati">
        Se perdi il telefono, ognuno di questi codici vale un accesso al posto del codice dell&apos;app. Senza telefono e
        senza codici non potrai entrare.
      </Hint>
      <ul className="grid grid-cols-2 gap-2" aria-label="Codici di recupero">
        {codes.map((code) => (
          <li
            key={code}
            className="border-border bg-surface-secondary text-foreground rounded-[var(--radius)] border px-2 py-1.5 text-center font-mono text-sm tracking-wide"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onPress={() => void copy(codes.join("\n"))}>
          <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} aria-hidden />
          {copied ? "Copiati" : "Copia"}
        </Button>
        <Button variant="secondary" size="sm" onPress={download}>
          <Icon icon="solar:download-minimalistic-linear" width={15} aria-hidden />
          Scarica .txt
        </Button>
      </div>
      <CheckboxField label="Ho salvato i codici in un posto sicuro" isSelected={saved} onChange={onSavedChange} />
    </div>
  );
}
