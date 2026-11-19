"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { FormDialog } from "@/components/ui/FormDialog";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonText } from "@/components/ui/Skeletons";
import type { EnvironmentsResponse, Project, StagingOffer } from "./types";

interface FormState {
  branch: string;
  withAddress: boolean;
  label: string;
  useProductionDatabases: boolean;
}

function initialForm(offer: StagingOffer): FormState {
  return {
    branch: offer.branch,
    withAddress: offer.address !== null,
    label: offer.address ? (offer.address.kind === "domain" ? offer.address.subdomain : offer.address.label) : "",
    useProductionDatabases: false,
  };
}

/**
 * Production's staging copy, in one step.
 *
 * What the panel can work out is already filled in: the branch (`staging` or
 * `develop`, whichever the repository has), an address next to production's.
 * What it will not decide alone is said and left off: production's databases,
 * which staging would write into — offered, unticked, with what that means.
 */
export function StagingDialog({
  project,
  isOpen,
  onOpenChange,
}: {
  project: Project;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const { data, error, refresh } = useResource<EnvironmentsResponse>(api(`/api/projects/${project.id}/environments?offer=staging`));
  const offer = data?.offer ?? null;

  // Filled once the proposal arrives, adjusted during render rather than in an effect.
  const [form, setForm] = useState<FormState | null>(null);
  if (offer && !form) setForm(initialForm(offer));
  const update = (patch: Partial<FormState>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const branch = form?.branch.trim() ?? "";
  const sameBranch = branch === project.source_branch;
  const unknownBranch = offer?.branches != null && branch !== "" && !offer.branches.includes(branch);
  const suffix = offer?.address ? offer.address.hostname.slice(offer.address.hostname.indexOf(".") + 1) : "";

  async function submit() {
    if (!offer || !form) return false;
    const address =
      form.withAddress && offer.address
        ? offer.address.kind === "domain"
          ? { kind: "domain", domainId: offer.address.domainId, subdomain: form.label.trim() }
          : { kind: "instant", label: form.label.trim() }
        : null;
    const res = await fetch(api(`/api/projects/${project.id}/environments`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "staging",
        branch,
        address,
        databaseIds: form.useProductionDatabases ? offer.databases.map((db) => db.id) : [],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.details?.[0]?.message ?? body.error ?? MSG.createFailed);
      return false;
    }
    toast.success(`Creato «${body.name}»: fai il primo deploy per metterlo online`);
    for (const warning of (body.warnings ?? []) as string[]) toast.warning(warning);
    router.push(href(`/projects/${body.id}`));
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Crea lo staging"
      description={
        <>
          Una copia di «{project.name}» che segue un altro branch, con il suo indirizzo e le sue risorse. Riceve le variabili di
          produzione: quelle che scrivi nello staging vincono. Produzione cambia solo quando promuovi.
        </>
      }
      submitLabel="Crea staging"
      isSubmitDisabled={!offer || !form || Boolean(offer.blocker) || !branch || sameBranch || (form.withAddress && !form.label.trim())}
      onSubmit={submit}
    >
      {error && !data && <LoadError what="la proposta" error={error} onRetry={() => void refresh()} />}
      {!data && !error && <SkeletonText className="w-full" />}
      {offer?.blocker && <Hint tone="warn">{offer.blocker}</Hint>}

      {offer && form && !offer.blocker && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <TextField value={form.branch} onChange={(value) => update({ branch: value })} autoFocus>
              <Label>Branch</Label>
              <Input className="font-mono" />
            </TextField>
            {sameBranch ? (
              <p role="alert" className="text-danger text-meta">
                Produzione segue già {project.source_branch}: scegli un altro branch.
              </p>
            ) : unknownBranch ? (
              <FieldHint className="mt-0">
                Il repository non ha ancora il branch <Code>{branch}</Code>: il primo deploy riuscirà quando lo crei.
              </FieldHint>
            ) : (
              <FieldHint className="mt-0">Di solito staging o develop. Produzione segue {project.source_branch}.</FieldHint>
            )}
          </div>

          {offer.address ? (
            <div className="space-y-2">
              <CheckboxField
                isSelected={form.withAddress}
                onChange={(value) => update({ withAddress: value })}
                label={<span className="text-sm">Dagli un indirizzo</span>}
              />
              {form.withAddress && (
                <div className="space-y-1.5">
                  <TextField value={form.label} onChange={(value) => update({ label: value })} aria-label="Nome dell'indirizzo">
                    <div className="flex items-center gap-1.5">
                      <Input className="min-w-0 flex-1 font-mono" />
                      <span className="text-muted shrink-0 font-mono text-sm">.{suffix}</span>
                    </div>
                  </TextField>
                  {offer.address.kind === "instant" && (
                    <FieldHint className="mt-0">Un indirizzo di prova, solo HTTP: per il lucchetto serve un tuo dominio.</FieldHint>
                  )}
                </div>
              )}
            </div>
          ) : (
            offer.addressNote && <FieldHint className="mt-0">{offer.addressNote}</FieldHint>
          )}

          {offer.databases.length > 0 && (
            <div className="space-y-2">
              <CheckboxField
                isSelected={form.useProductionDatabases}
                onChange={(value) => update({ useProductionDatabases: value })}
                label={
                  <span className="text-sm">
                    Usa{" "}
                    {offer.databases.length === 1
                      ? `il database di produzione «${offer.databases[0].name}»`
                      : `i ${offer.databases.length} database di produzione`}
                  </span>
                }
              />
              {form.useProductionDatabases ? (
                <Hint tone="warn" title="Lo staging scriverà nei dati di produzione">
                  Ogni prova fatta sullo staging cambia i dati veri. Le variabili {offer.databases.map((db) => db.envKey).join(", ")}{" "}
                  dello staging leggeranno i database di produzione: le trovi, e le puoi togliere, nella sua scheda Variabili.
                </Hint>
              ) : (
                <FieldHint className="mt-0">
                  Senza la spunta lo staging non tocca i database di produzione: collegagli un database suo dalla sua pagina.
                </FieldHint>
              )}
            </div>
          )}

          <Hint title="Cosa non viene copiato">
            Le cartelle montate, le attività pianificate e il webhook: lo staging ha i suoi. Le variabili non vengono copiate ma
            ereditate, e chi gestisce «{project.name}» gestisce anche lo staging.
          </Hint>
        </div>
      )}
    </FormDialog>
  );
}
