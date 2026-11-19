"use client";

import { Input, Label, TextField } from "@heroui/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Badge } from "@/components/ui/Badge";
import { Advanced, Technical } from "@/components/ui/Technical";
import { DRAIN_MAX_SEC, ZERO_DOWNTIME_BLOCKERS, zeroDowntimeBlockers } from "@/lib/zero-downtime";
import type { Project } from "../types";
import type { DeployForm } from "./useDeployForm";

/**
 * "Deploy senza interruzioni" (lib/zero-downtime.ts).
 *
 * Shown with its switch only where it can work — Docker, an address nginx
 * serves, the health check on — and judged on what the form holds now, so
 * turning the health check off or changing the runtime says at once what that
 * costs. Elsewhere the panel says why instead of offering a switch that would
 * do nothing. A switch already on stays reachable even when the project no
 * longer qualifies, with the reason, so it can be turned off.
 */
export function ZeroDowntimePanel({ form, project }: { form: DeployForm; project: Project }) {
  const { values, patchContract } = form;
  const { contract } = values;
  const settings = contract.zeroDowntime;
  const port = values.port.trim() ? Number.parseInt(values.port, 10) : null;

  const blockers = zeroDowntimeBlockers({
    runtimeType: values.runtimeType,
    network: contract.docker.network,
    healthcheck: { enabled: contract.healthcheck.enabled, port: contract.healthcheck.port ?? null },
    port: Number.isInteger(port) ? port : null,
    restricted: project.access?.mode === "restricted",
    singleInstance: contract.runtime.singleInstance,
    // The names nginx serves it on, twins that only redirect and names an apply left out excluded.
    servedHosts: project.hosts?.length ?? 0,
    proxyReady: project.zeroDowntime?.proxyReady ?? false,
  });
  const available = blockers.length === 0;
  const reasons = blockers.map((blocker) => ZERO_DOWNTIME_BLOCKERS[blocker]).join(" ");
  const setEnabled = (enabled: boolean) => patchContract({ zeroDowntime: { ...settings, enabled } });

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title={
          <span className="inline-flex items-center gap-2">
            Deploy senza interruzioni
            <Badge tone="accent">Nuovo</Badge>
          </span>
        }
        description="La nuova versione parte accanto a quella online e prende il suo posto solo quando risponde"
        actions={
          available || settings.enabled ? (
            <SettingToggle label="Attivo" isSelected={settings.enabled} onChange={setEnabled} className="w-auto" />
          ) : undefined
        }
      />

      {!available && !settings.enabled && <FieldHint>Non disponibile per questo progetto. {reasons}</FieldHint>}

      {!available && settings.enabled && (
        <Hint tone="warn">Acceso, ma per ora non si applica e il prossimo deploy sarà normale, con una breve interruzione. {reasons}</Hint>
      )}

      {available && !settings.enabled && (
        <p className="text-muted text-sm">
          A ogni deploy il pannello avvia la nuova versione su una porta interna sua e ne controlla la salute; solo allora nginx
          passa a lei, con una configurazione verificata prima di essere caricata. La versione di prima finisce le richieste
          in corso e poi si ferma. Se la nuova non risponde, o nginx rifiuta il passaggio, quella online non viene toccata.
        </p>
      )}

      {settings.enabled && (
        <>
          <Hint tone="warn">
            Per qualche secondo girano due copie dell&apos;app. Se scrivono negli stessi volumi o nelle stesse cartelle montate
            devono poterlo fare insieme: un database SQLite in un volume, o un&apos;app che tiene un file tutto per sé, non lo
            sopporta (in quel caso la nuova versione non parte e il deploy fallisce senza toccare quella online). Anche le
            migrazioni del comando di release girano con la versione precedente ancora online: devono andare bene pure per lei.
          </Hint>
          <FieldHint>
            {port ? `Sul server l'app non è più aperta sulla porta ${port}: si raggiunge dai suoi indirizzi.` : null} Riavvii
            e ritorni alla versione precedente ricreano il container con una breve interruzione: senza interruzioni sono i
            deploy. Si applica dal prossimo deploy.
          </FieldHint>
          {project.live_port ? (
            <Technical>
              <FieldHint>
                In questo momento nginx la raggiunge su <Code>127.0.0.1:{project.live_port}</Code>.
              </FieldHint>
            </Technical>
          ) : null}
          <Advanced summary="attesa per le richieste in corso">
            <div className="max-w-xs">
              <TextField
                value={String(settings.drainSec)}
                onChange={(v) => {
                  const seconds = Number.parseInt(v, 10);
                  patchContract({
                    zeroDowntime: {
                      ...settings,
                      drainSec: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), DRAIN_MAX_SEC) : 0,
                    },
                  });
                }}
              >
                <Label>Attesa prima di fermare la versione precedente (s)</Label>
                <Input type="number" min={0} max={DRAIN_MAX_SEC} />
              </TextField>
              <FieldHint>
                Il tempo che la versione di prima ha per finire le richieste che stava servendo, da 0 a {DRAIN_MAX_SEC}{" "}
                secondi. Le connessioni ancora aperte dopo, come un WebSocket, si chiudono e il browser si ricollega alla nuova.
              </FieldHint>
            </div>
          </Advanced>
        </>
      )}
    </Panel>
  );
}
