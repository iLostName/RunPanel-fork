"use client";

import { useState } from "react";
import { Input, Label, TextArea, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { useCan } from "@/lib/hooks/useMe";
import { parseDotenv } from "@/lib/dotenv-parse";
import { MAX_PREVIEWS_LIMIT, IDLE_DAYS_LIMIT, type PreviewSettings } from "@/lib/previews";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { SelectField } from "@/components/ui/SelectField";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonText } from "@/components/ui/Skeletons";
import { usePendingSave, type RegisterPendingSave } from "../pending-saves";
import type { PreviewsResponse, Project } from "../types";

const INSTANT = "__instant";

/**
 * "Anteprime delle pull request": off until somebody turns it on, and only
 * for a project whose pull request events can reach the panel.
 *
 * Saved by the page's bar like the other sections. Turning previews on
 * rewrites the GitHub webhook, so a refusal — the events could not arrive —
 * is said here, next to the switch that stays off. The previews' own
 * variables are a second part of the same section, saved with it.
 */
export function PreviewsSection({ project, registerPending }: { project: Project; registerPending: RegisterPendingSave }) {
  const api = useNodeApi();
  const canCreate = useCan("projects.create");
  const canGithub = useCan("github");
  const canHost = useCan("host");
  const { data, error, refresh } = useResource<PreviewsResponse>(api(`/api/projects/${project.id}/previews`));
  const { data: overrides, refresh: refreshOverrides } = useResource<{ vars: { key: string; value: string }[] }>(
    api(`/api/projects/${project.id}/previews/env?reveal=true`)
  );

  const [form, setForm] = useState<PreviewSettings | null>(null);
  const [stored, setStored] = useState<PreviewSettings | null>(null);
  if (data && (!stored || JSON.stringify(stored) !== JSON.stringify(data.settings)) && (!form || JSON.stringify(form) === JSON.stringify(stored))) {
    // A fresh read replaces the form only while it has no edits of its own.
    setStored(data.settings);
    setForm(data.settings);
  }
  const [problem, setProblem] = useState<string | null>(null);

  const storedText = (overrides?.vars ?? []).map((v) => `${v.key}=${v.value}`).join("\n");
  const [text, setText] = useState<string | null>(null);
  const envText = text ?? storedText;

  const dirty = Boolean(form && stored && JSON.stringify(form) !== JSON.stringify(stored));
  const envDirty = text !== null && text !== storedText;
  const parsed = parseDotenv(envText);

  async function save(): Promise<boolean> {
    if (!form) return true;
    const res = await fetch(api(`/api/projects/${project.id}/previews`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProblem(body.error ?? "Salvataggio non riuscito");
      return false;
    }
    setProblem(null);
    setStored(body.settings);
    setForm(body.settings);
    if (body.removed > 0) toast.success(`Anteprime spente: ${body.removed === 1 ? "eliminata 1 anteprima" : `eliminate ${body.removed} anteprime`}`);
    void refresh();
    return true;
  }

  async function saveEnv(): Promise<boolean> {
    if (parsed.invalid.length > 0) {
      toast.error(`Riga ${parsed.invalid[0].line}: ${parsed.invalid[0].reason}`);
      return false;
    }
    const res = await fetch(api(`/api/projects/${project.id}/previews/env`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vars: parsed.vars }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.details?.[0]?.message ?? body.error ?? "Salvataggio non riuscito");
      return false;
    }
    setText(null);
    void refreshOverrides();
    return true;
  }

  usePendingSave(registerPending, "previews", "Anteprime", dirty, save, () => {
    setForm(stored);
    setProblem(null);
  });
  usePendingSave(registerPending, "preview-env", "Variabili delle anteprime", envDirty, saveEnv, () => setText(null));

  if (error && !data) return <LoadError what="le anteprime" error={error} onRetry={() => void refresh()} />;
  if (!data || !form) return <SkeletonText className="w-full" />;

  const update = (patch: Partial<PreviewSettings>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const allowed = canCreate && canGithub && canHost;

  return (
    <div className="space-y-4">
      <Panel className="space-y-4">
        <PanelHeader
          title="Anteprime delle pull request"
          description="Per ogni pull request aperta verso il branch di produzione, un ambiente con il suo indirizzo, rimosso quando la pull request si chiude."
        />
        {!allowed && (
          <Hint>Le anteprime le attiva chi ha i permessi «Creare progetti», «GitHub» e «Accesso all&apos;host»: creano progetti da sole.</Hint>
        )}
        {data.transport.problem && !form.enabled && <Hint tone="warn">{data.transport.problem}</Hint>}
        <SettingToggle
          label="Anteprime delle pull request"
          description="Si applica al salvataggio: il webhook di GitHub riceve anche le pull request. Spegnendole, le anteprime esistenti vengono eliminate."
          isSelected={form.enabled}
          onChange={(enabled) => update({ enabled })}
          isDisabled={!allowed}
        />
        {problem && (
          <p role="alert" className="text-danger text-meta leading-relaxed">
            {problem}
          </p>
        )}

        {form.enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <TextField
                type="number"
                value={String(form.maxPreviews)}
                onChange={(value) => update({ maxPreviews: Math.min(MAX_PREVIEWS_LIMIT, Math.max(1, Number.parseInt(value, 10) || 1)) })}
              >
                <Label>Anteprime accese al massimo</Label>
                <Input min={1} max={MAX_PREVIEWS_LIMIT} />
              </TextField>
              <FieldHint className="mt-0">Oltre il limite si ferma quella inattiva da più tempo.</FieldHint>
            </div>
            <div className="space-y-1.5">
              <TextField
                type="number"
                value={String(form.idleDays)}
                onChange={(value) => update({ idleDays: Math.min(IDLE_DAYS_LIMIT, Math.max(1, Number.parseInt(value, 10) || 1)) })}
              >
                <Label>Ferma dopo giorni senza attività</Label>
                <Input min={1} max={IDLE_DAYS_LIMIT} />
              </TextField>
              <FieldHint className="mt-0">Un push o un deploy a mano la tiene accesa.</FieldHint>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <SelectField
                label="Indirizzo"
                value={form.domainId ?? INSTANT}
                onChange={(value) => update({ domainId: value === INSTANT ? null : value })}
                options={[
                  { value: INSTANT, label: "Indirizzo di prova (sslip.io, solo HTTP)" },
                  ...data.domains.map((d) => ({ value: d.id, label: `pr-<numero>.${d.name}` })),
                ]}
              />
              <FieldHint className="mt-0">
                Su un tuo dominio serve il record DNS jolly (*.dominio) verso questo server.
              </FieldHint>
            </div>
            <div className="sm:col-span-2">
              <CheckboxField
                isSelected={form.commitStatus}
                onChange={(commitStatus) => update({ commitStatus })}
                label={<span className="text-sm">Scrivi sulla pull request lo stato del commit, con l&apos;indirizzo dell&apos;anteprima</span>}
                description="Solo se il token GitHub lo consente (Commit statuses: Read and write): altrimenti si salta, e lo trovi scritto nell'elenco delle anteprime."
              />
            </div>
          </div>
        )}
        <Hint tone="warn" title="Le anteprime girano su questo server">
          Ognuna consuma come una copia dell&apos;app. Le pull request da un fork non partono mai da sole: eseguirebbero codice
          di altri sul server, quindi ogni loro commit va approvato dall&apos;elenco delle anteprime.
        </Hint>
      </Panel>

      <Panel className="space-y-3">
        <PanelHeader
          title="Variabili delle anteprime"
          description="Ricevute da ogni anteprima sopra quelle dello staging, o di produzione se non c'è. Nessuna anteprima riceve i database di produzione."
        />
        <TextField value={envText} onChange={setText} aria-label="Variabili delle anteprime, una per riga">
          <TextArea rows={4} className="font-mono text-sm" placeholder={"PAYMENTS_KEY=sk_test_…\nBANNER=anteprima"} />
        </TextField>
        {parsed.invalid.length > 0 ? (
          <p role="alert" className="text-danger text-meta">
            Riga {parsed.invalid[0].line}: {parsed.invalid[0].reason}
          </p>
        ) : (
          <FieldHint className="mt-0">Una per riga, come in un file .env. Valgono dal prossimo deploy di ogni anteprima.</FieldHint>
        )}
      </Panel>
    </div>
  );
}
