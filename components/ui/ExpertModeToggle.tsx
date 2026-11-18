"use client";

import { useExpertMode } from "@/components/Providers";
import { SettingToggle } from "./SettingToggle";

/** The switch for expert mode, wherever it is offered: see lib/expert-mode.ts. */
export function ExpertModeToggle({ className }: { className?: string }) {
  const { expert, setExpert } = useExpertMode();
  return (
    <SettingToggle
      className={className}
      label="Modalità esperto"
      description="Mostra i dettagli tecnici (porte, container, comandi, errori completi) e apre già le sezioni avanzate. Vale solo per questo browser e si applica subito."
      isSelected={expert}
      onChange={setExpert}
    />
  );
}
