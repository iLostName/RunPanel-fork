"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { toast } from "@/lib/toast";
import { Hint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { useResource } from "@/lib/hooks/useResource";
import { formatBytes, formatWhen } from "@/lib/format";
import type { ArtifactView, DestinationView, RunEncryption, TargetCatalog } from "./types";
import { serviceDisplayName } from "@/lib/service-name";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";

/**
 * The confirmation in front of the only operation that can destroy production
 * data.
 *
 * One dialog, everything in it. Every item starts selected — a restore is
 * nearly always "put it all back" — and each says, in a line, what happens to
 * what is there now. Where it goes defaults to where it came from, when that
 * still exists here; an archive from another panel names things this one has
 * never seen, and then each item asks. The confirmation is the *real name* of
 * what is about to be overwritten rather than a token like DELETE, because
 * muscle memory defeats a token. And the safety backup is on unless someone
 * goes out of their way to turn it off.
 */

export const KIND_LABELS: Record<string, string> = {
  "service-db": "Database",
  "panel-store": "Store del pannello",
  "project-config": "Configurazione",
  "project-volume": "Dati (volume)",
  "project-repo": "Codice (repository)",
};

/** What happens to what is there now, in one line per kind. */
function consequence(artifact: ArtifactView, target: string): string {
  switch (artifact.kind) {
    case "service-db":
      return artifact.meta?.engine === "redis"
        ? `I dati di ${target} vengono sostituiti; il database si ferma per qualche secondo.`
        : `I database di ${target} tornano come nel backup. Se un'app li usa, si ferma e riparte alla fine.`;
    case "project-volume":
      return `I file del volume di ${target} vengono sostituiti; il progetto si ferma durante la copia e riparte dopo.`;
    case "project-config":
      return `Impostazioni e variabili di ${target} tornano a quelle del backup; vale dal prossimo deploy.`;
    case "project-repo":
      return `I file del codice di ${target} vengono sovrascritti; quelli in più restano.`;
    case "panel-store":
      return "Lo store del pannello viene messo in servizio al prossimo riavvio, non adesso; quello attuale resta conservato accanto.";
    default:
      return "Quello che c'è adesso viene sostituito.";
  }
}

interface Choice {
  action: "restore" | "skip";
  targetId: string;
}

export function RestoreDialog({
  source,
  artifacts,
  isOpen,
  onOpenChange,
  preselect,
  fixedTargets,
  askPassword,
}: {
  /** A run of the catalogue, or an archive uploaded and checked. */
  source: { runId: string } | { uploadId: string };
  artifacts: ArtifactView[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only these start selected; all of them when absent. */
  preselect?: string[];
  /** Targets chosen by the page and not offered: restoring onto the database whose page this is. */
  fixedTargets?: Record<string, string>;
  /** The run's archive is encrypted with a password this panel no longer has: ask for it. */
  askPassword?: RunEncryption;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const catalog = useResource<TargetCatalog>(isOpen ? api("/api/backups/targets") : null);
  const destinations = useResource<{ destinations: DestinationView[] }>(isOpen ? api("/api/backups/destinations") : null);
  const fromUpload = "uploadId" in source;

  const restorable = useMemo(() => artifacts.filter((artifact) => artifact.status === "ok"), [artifacts]);

  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      restorable.map((artifact) => [
        artifact.id,
        {
          action: !preselect || preselect.includes(artifact.id) ? ("restore" as const) : ("skip" as const),
          // Where it came from, until the catalogue says whether that still exists.
          targetId: fixedTargets?.[artifact.id] ?? artifact.refId ?? "",
        },
      ])
    )
  );
  const [skipSafety, setSkipSafety] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");

  function optionsFor(artifact: ArtifactView) {
    if (artifact.kind === "service-db") {
      const engine = String(artifact.meta?.engine ?? "");
      return (catalog.data?.services ?? [])
        .filter((service) => !engine || service.type === engine)
        .map((service) => ({ id: service.id, label: `${serviceDisplayName(service)} (${service.type})` }));
    }
    if (artifact.kind.startsWith("project-")) {
      return (catalog.data?.projects ?? []).map((project) => ({ id: project.id, label: project.slug }));
    }
    return [];
  }

  /** The target, if it is one that exists here: an id from another panel is no target at all. */
  function targetOf(artifact: ArtifactView): string {
    const chosen = choices[artifact.id]?.targetId ?? "";
    if (artifact.kind === "panel-store") return "";
    if (fixedTargets?.[artifact.id]) return fixedTargets[artifact.id];
    if (!catalog.data) return chosen;
    return optionsFor(artifact).some((option) => option.id === chosen) ? chosen : "";
  }

  function targetLabel(artifact: ArtifactView): string {
    const id = targetOf(artifact);
    return optionsFor(artifact).find((option) => option.id === id)?.label ?? artifact.refName;
  }

  const selected = restorable.filter((artifact) => choices[artifact.id]?.action === "restore");
  const missingTarget = selected.filter((artifact) => artifact.kind !== "panel-store" && !targetOf(artifact));
  // The name the operator has to type: the first thing that will be overwritten.
  const requiredName = selected[0]?.refName ?? "";
  const confirmed = confirmText.trim() === requiredName;
  const safetyGoesTo = destinations.data?.destinations.find((destination) => destination.isDefault)?.name;

  async function submit() {
    if (selected.length === 0) {
      toast.error("Scegli almeno un elemento da ripristinare");
      return false;
    }
    if (missingTarget.length > 0) {
      toast.error(`Scegli dove ripristinare ${missingTarget[0].refName}`);
      return false;
    }
    if (!confirmed) {
      toast.error(`Per confermare, scrivi esattamente: ${requiredName}`);
      return false;
    }
    if (askPassword && !password) {
      toast.error("Scrivi la password dei backup di questo archivio");
      return false;
    }

    const res = await fetch(api("/api/backups/restore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...source,
        confirm: confirmText.trim(),
        skipSafetyBackup: skipSafety,
        ...(askPassword && password ? { password } : {}),
        targets: restorable.map((artifact) => {
          const target = targetOf(artifact);
          return {
            artifactId: artifact.id,
            action: choices[artifact.id]?.action ?? "skip",
            ...(target ? { targetId: target } : {}),
          };
        }),
      }),
    });

    const body = await res.json().catch(() => ({}));
    // Thrown rather than returned: FormDialog keeps the dialog open and the
    // choices intact when the submit rejects, which is the whole point of a
    // form that took a minute to fill in.
    if (!res.ok) {
      toast.error(body.error ?? "Avvio del ripristino non riuscito");
      throw new Error(body.error ?? "restore failed");
    }

    toast.success("Ripristino avviato");
    router.push(href(`/backups/restore/${body.restoreId}`));
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      wide
      destructive
      title={fromUpload ? "Ripristinare dall'archivio caricato" : "Ripristinare da questo backup"}
      submitLabel={selected.length > 1 ? `Ripristina ${selected.length} elementi` : "Ripristina"}
      isSubmitDisabled={!confirmed || selected.length === 0 || missingTarget.length > 0 || Boolean(askPassword && !password)}
      onSubmit={submit}
    >
      <>
        <p className="text-muted text-sm">
          Quello che c&apos;è adesso al posto scelto viene sostituito da quello del backup. Prima di toccare
          qualsiasi cosa il pannello controlla che l&apos;archivio sia integro e salva una copia di quello che
          sta per sovrascrivere.
        </p>

        {askPassword && (
          <div className="mt-4">
            <TextField type="password" value={password} onChange={setPassword}>
              <Label>Password dei backup</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
            <p className="text-muted mt-1 text-xs">
              L&apos;archivio è cifrato con una password che questo pannello non ha più
              {askPassword.keyCreatedAt ? `, impostata il ${formatWhen(askPassword.keyCreatedAt)}` : ""}: scrivila per
              aprirlo. Viene usata solo per questo ripristino.
            </p>
          </div>
        )}

        <ul className="border-border mt-4 divide-y divide-[var(--color-border)] rounded-[var(--radius)] border">
          {restorable.map((artifact) => {
            const choice = choices[artifact.id];
            const options = optionsFor(artifact);
            const on = choice?.action === "restore";
            const target = targetOf(artifact);
            const fixed = Boolean(fixedTargets?.[artifact.id]);

            return (
              <li key={artifact.id} className="p-3">
                <CheckboxField
                  isSelected={on}
                  onChange={(next) =>
                    setChoices((current) => ({
                      ...current,
                      [artifact.id]: {
                        action: next ? "restore" : "skip",
                        targetId: current[artifact.id]?.targetId ?? artifact.refId ?? "",
                      },
                    }))
                  }
                  label={
                    <span className="block min-w-0 flex-1">
                      <span className="text-foreground block truncate">{artifact.refName}</span>
                      <span className="text-muted text-xs">
                        {KIND_LABELS[artifact.kind] ?? artifact.kind} · {formatBytes(artifact.bytes)}
                      </span>
                    </span>
                  }
                />

                {on && options.length > 0 && !fixed && (
                  <div className="mt-2 pl-6">
                    <SelectField
                      ariaLabel={`Dove ripristinare ${artifact.refName}`}
                      value={target}
                      onChange={(targetId) =>
                        setChoices((current) => ({
                          ...current,
                          [artifact.id]: { action: "restore", targetId },
                        }))
                      }
                      isInvalid={!target}
                      options={[
                        { value: "", label: "— scegli dove ripristinarlo —" },
                        ...options.map((option) => ({ value: option.id, label: option.label })),
                      ]}
                    />
                  </div>
                )}
                {on && options.length === 0 && artifact.kind !== "panel-store" && catalog.data && (
                  <p className="text-danger mt-2 pl-6 text-xs">
                    {artifact.kind === "service-db"
                      ? `Su questo server non c'è un database ${String(artifact.meta?.engine ?? "")} in cui ripristinarlo: crealo prima.`
                      : "Su questo server non c'è un progetto in cui ripristinarlo: crealo prima."}
                  </p>
                )}

                {on && (target || artifact.kind === "panel-store") && (
                  <p className="text-muted mt-2 pl-6 text-xs">{consequence(artifact, targetLabel(artifact))}</p>
                )}
              </li>
            );
          })}
        </ul>

        <CheckboxField
          className="mt-4"
          isSelected={skipSafety}
          onChange={setSkipSafety}
          label="Procedi anche senza backup di sicurezza"
          description={`Di norma il pannello salva prima quello che sta per sovrascrivere${safetyGoesTo ? ` (su «${safetyGoesTo}»)` : ""}, e si ferma se non ci riesce. Togliere questa rete significa che un ripristino sbagliato non ha ritorno.`}
        />
        {skipSafety && (
          <Hint tone="warn" className="mt-2">
            Senza la copia di sicurezza, se il backup non è quello giusto quello che c&apos;è adesso è perso.
          </Hint>
        )}

        {selected.length > 0 && (
          <div className="mt-4">
            <TextField value={confirmText} onChange={setConfirmText}>
              <Label>
                Per confermare, scrivi <strong>{requiredName}</strong>
              </Label>
              <Input placeholder={requiredName} autoComplete="off" spellCheck={false} />
            </TextField>
            {selected.length > 1 && (
              <p className="text-muted mt-1 text-xs">
                Verranno sostituiti anche: {selected.slice(1).map((artifact) => artifact.refName).join(", ")}
              </p>
            )}
          </div>
        )}
      </>
    </FormDialog>
  );
}
