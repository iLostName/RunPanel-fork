"use client";

import { Input, Label, TextField } from "@heroui/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { FieldHint } from "@/components/ui/Hint";
import { HealthcheckHint } from "@/components/DeployHints";
import type { DeployForm } from "./useDeployForm";

/**
 * How a deploy is judged: the request the panel makes before calling it
 * done, and — for Docker — going back to the previous version when it fails.
 */
export function HealthcheckPanel({ form }: { form: DeployForm }) {
  const { values, patchContract } = form;
  const { contract, runtimeType } = values;
  const isDocker = runtimeType === "docker";

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
          {isDocker ? (
            <SettingToggle
              label="Se non risponde, rimetti online la versione precedente"
              description="La nuova versione resta come deploy fallito, da correggere; intanto l'app continua a funzionare con quella di prima."
              isSelected={contract.rollback.enabled}
              onChange={(enabled) => patchContract({ rollback: { enabled } })}
            />
          ) : (
            <FieldHint>
              Il ritorno automatico alla versione precedente, per ora, c&apos;è solo con il runtime Docker.
            </FieldHint>
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
