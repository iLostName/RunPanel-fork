"use client";

import { Input, Label, TextField } from "@heroui/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { FieldHint } from "@/components/ui/Hint";
import { HealthcheckHint } from "@/components/DeployHints";
import type { DeployForm } from "./useDeployForm";

const NATIVE_RUNTIMES = new Set(["node", "static", "custom"]);

/**
 * Why the automatic return is not on offer for what the form holds now, or
 * null when it is. Read from the form rather than the saved project, so
 * switching the runtime or the source says at once what that changes.
 */
function unavailableReason(runtimeType: string, sourceType: string, releasesSupported: boolean): string | null {
  if (runtimeType === "docker") return null;
  if (runtimeType === "compose") {
    return "Con Compose il ritorno automatico alla versione precedente non c'è ancora: lo stack viene ricostruito dalla cartella del progetto.";
  }
  if (!NATIVE_RUNTIMES.has(runtimeType)) return null;
  if (!releasesSupported) {
    return "Su un server Windows il ritorno automatico alla versione precedente c'è solo con Docker: le app native compilano nella cartella in cui girano.";
  }
  if (sourceType !== "github") {
    return "Il ritorno automatico alla versione precedente c'è per i progetti collegati a GitHub: in uno ZIP non si distinguono i file del codice da quelli che l'app scrive.";
  }
  return null;
}

/**
 * How a deploy is judged: the request the panel makes before calling it
 * done, and going back to the previous version when it fails — for Docker,
 * and for native apps, which then build each version in a folder of its own.
 */
export function HealthcheckPanel({ form, releasesSupported }: { form: DeployForm; releasesSupported: boolean }) {
  const { values, patchContract } = form;
  const { contract, runtimeType, sourceType } = values;
  const unavailable = unavailableReason(runtimeType, sourceType, releasesSupported);

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Controllo di salute"
        description={
          contract.healthcheck.enabled
            ? "Dopo ogni deploy il pannello aspetta che l'app risponda prima di darlo per riuscito"
            : "Spento: il deploy riesce appena il processo parte"
        }
        actions={
          <SettingToggle
            label="Attivo"
            isSelected={contract.healthcheck.enabled}
            onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, enabled: v } })}
            className="w-auto"
          />
        }
      />
      {contract.healthcheck.enabled ? (
        <>
          <HealthcheckHint />
          {unavailable ? (
            <FieldHint>{unavailable}</FieldHint>
          ) : (
            <SettingToggle
              label="Se non risponde, rimetti online la versione precedente"
              description={
                runtimeType === "docker"
                  ? "La nuova versione resta come deploy fallito, da correggere; intanto l'app continua a funzionare con quella di prima."
                  : "Ogni deploy prepara la nuova versione in una cartella sua e tiene pronta quella di prima. I file che l'app scrive, come un database SQLite o gli upload, restano in comune. Spento, il deploy compila nella cartella del progetto come prima."
              }
              isSelected={contract.rollback.enabled}
              onChange={(enabled) => patchContract({ rollback: { enabled } })}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField value={contract.healthcheck.path} onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, path: v } })}>
              <Label>Percorso</Label>
              <Input placeholder="/" className="font-mono text-sm" />
            </TextField>
            <TextField
              value={String(contract.healthcheck.startPeriodSec)}
              onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, startPeriodSec: Number.parseInt(v, 10) || 0 } })}
            >
              <Label>Attesa iniziale (s)</Label>
              <Input type="number" />
            </TextField>
            <TextField
              value={String(contract.healthcheck.timeoutSec)}
              onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, timeoutSec: Number.parseInt(v, 10) || 30 } })}
            >
              <Label>Tempo massimo (s)</Label>
              <Input type="number" />
            </TextField>
          </div>
        </>
      ) : (
        <p className="text-muted text-sm">
          Giusto per bot e worker senza pagine web. Per un sito, senza controllo un&apos;app che parte e muore un secondo
          dopo risulta comunque distribuita.
        </p>
      )}
    </Panel>
  );
}
