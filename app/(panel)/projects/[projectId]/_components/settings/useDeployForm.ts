"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { normalizeContractInput, parseContractJson, type DeployContract } from "@/lib/deploy-contract";
import { useNodeApi } from "@/lib/hooks/useNode";
import type { Project, SettingsSectionId } from "../types";

type RawContract = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawContract {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the form should actually send: what was stored, plus only what changed.
 *
 * The form holds a contract from `parseContractJson`, which is `.parse()` — so
 * every field carrying a `.default()` is materialised whether or not anybody
 * chose it. Sending that object back wrote all of them into `builder_config`,
 * and since the panel's half WINS the merge, one press of Salva on an untouched
 * screen permanently pinned `packageManager: auto`, `timeoutSec: 900`, the whole
 * healthcheck block and the rest over whatever the repository's `runpanel.json`
 * or the detected preset had been contributing. The column is deliberately
 * sparse — see the comment on the PATCH route — and this is what keeps it sparse.
 *
 * Compared against the contract as it was LOADED, not against the schema's
 * defaults, so a value the operator genuinely typed is written even when it
 * happens to equal a default.
 */
function contractPatch(stored: string, loaded: DeployContract, current: DeployContract): RawContract {
  let raw: RawContract = {};
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    // Translated first: a row in the old shape has no `version`, so a patch of
    // the new shape laid over it would be read back as the old one, and refused.
    if (isPlainObject(parsed)) raw = normalizeContractInput(parsed);
  } catch {
    /* an unreadable column is replaced by what the form knows */
  }

  const walk = (base: RawContract, before: RawContract, after: RawContract): RawContract => {
    const out: RawContract = { ...base };
    for (const [key, next] of Object.entries(after)) {
      const previous = before[key];
      if (isPlainObject(previous) && isPlainObject(next)) {
        const nested = walk(isPlainObject(out[key]) ? out[key] : {}, previous, next);
        if (Object.keys(nested).length > 0) out[key] = nested;
        continue;
      }
      // Unchanged means nobody chose it, and a default nobody chose has no
      // business shadowing a repository that did choose.
      if (JSON.stringify(previous) !== JSON.stringify(next)) out[key] = next;
    }
    return out;
  };

  return walk(raw, loaded as unknown as RawContract, current as unknown as RawContract);
}

export interface FormValues {
  name: string;
  sourceType: "github" | "upload";
  sourceUrl: string;
  branch: string;
  port: string;
  runtimeType: string;
  contract: DeployContract;
}

function valuesOf(project: Project): FormValues {
  return {
    name: project.name,
    sourceType: project.source_type === "github" ? "github" : "upload",
    sourceUrl: project.source_url ?? "",
    branch: project.source_branch,
    port: project.port?.toString() ?? "",
    runtimeType: project.runtime_type,
    contract: parseContractJson(project.builder_config),
  };
}

/** Which settings section each value belongs to, for the dots in the side menu. */
function partsOf(v: FormValues): Partial<Record<SettingsSectionId, unknown>> {
  return {
    general: v.name,
    source: [v.sourceType, v.sourceUrl, v.branch],
    build: [v.runtimeType, v.contract.commands, v.contract.packageManager, v.contract.healthcheck],
    network: [v.port, v.contract.docker.network, v.contract.docker.hostname],
    resources: [v.contract.runtime, v.contract.build],
    advanced: v.contract.envFile,
  };
}

/**
 * The settings that save together, through the project's own PATCH.
 *
 * Shared by the sections of the side menu: the runtime lives under "Build e
 * avvio", the port under "Rete", the branch under "Sorgente", and one press of
 * Salva sends whatever changed in any of them. Only the changed fields are
 * sent: an unchanged branch used to travel with every save, and the source
 * fields need the host permission, so a manager without it could not save a
 * port.
 */
export function useDeployForm(project: Project, onSaved: (project: Project) => void) {
  const api = useNodeApi();
  const [values, setValues] = useState<FormValues>(() => valuesOf(project));
  const [saved, setSaved] = useState<FormValues>(() => valuesOf(project));

  /*
    Follow the row when it changes on the server (a rename from the header, a
    mount applied, a deploy that settled the port), for the fields nobody is
    editing. Adjusted during render, as React recommends for state derived from
    props; compared against the last row seen so an unchanged poll is a no-op.
  */
  const [seenRow, setSeenRow] = useState(project);
  if (project !== seenRow) {
    setSeenRow(project);
    const fresh = valuesOf(project);
    const before = valuesOf(seenRow);
    setValues((current) => {
      const next = { ...current };
      for (const key of Object.keys(fresh) as (keyof FormValues)[]) {
        const untouched = JSON.stringify(current[key]) === JSON.stringify(saved[key]);
        const moved = JSON.stringify(fresh[key]) !== JSON.stringify(before[key]);
        if (untouched && moved) (next as Record<string, unknown>)[key] = fresh[key];
      }
      return next;
    });
    setSaved((current) => {
      const next = { ...current };
      for (const key of Object.keys(fresh) as (keyof FormValues)[]) {
        if (JSON.stringify(fresh[key]) !== JSON.stringify(before[key])) (next as Record<string, unknown>)[key] = fresh[key];
      }
      return next;
    });
  }

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const patchContract = (patch: Partial<DeployContract>) =>
    setValues((v) => ({ ...v, contract: { ...v.contract, ...patch } }));

  const savedParts = partsOf(saved);
  const currentParts = partsOf(values);
  const dirtySections = (Object.keys(currentParts) as SettingsSectionId[]).filter(
    (id) => JSON.stringify(currentParts[id]) !== JSON.stringify(savedParts[id])
  );

  /** Resolves false when nothing was saved (the toast already said why). */
  async function save(): Promise<boolean> {
    const body: Record<string, unknown> = {};
    if (values.name.trim() !== saved.name) body.name = values.name.trim();
    if (values.sourceType !== saved.sourceType) body.sourceType = values.sourceType;
    const url = values.sourceType === "github" ? values.sourceUrl.trim() || null : null;
    if (url !== (saved.sourceType === "github" ? saved.sourceUrl.trim() || null : null)) body.sourceUrl = url;
    if (values.branch.trim() !== saved.branch) body.sourceBranch = values.branch.trim();
    const port = values.port.trim() ? Number.parseInt(values.port, 10) : null;
    if (values.port !== saved.port) body.port = port;
    if (values.runtimeType !== saved.runtimeType) body.runtimeType = values.runtimeType;
    if (JSON.stringify(values.contract) !== JSON.stringify(saved.contract)) {
      body.builderConfig = contractPatch(project.builder_config, parseContractJson(project.builder_config), values.contract);
    }
    if (Object.keys(body).length === 0) return true;

    try {
      const res = await fetch(api(`/api/projects/${project.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Details first: "Dati non validi" does not say which field.
        toast.error(data.details?.[0]?.message ?? data.error ?? MSG.saveFailed);
        return false;
      }
      if (data.webhookWarning) toast.warning(data.webhookWarning);
      setSaved(values);
      onSaved(data as Project);
      return true;
    } catch {
      toast.error(MSG.saveFailed);
      return false;
    }
  }

  return {
    values,
    set,
    patchContract,
    dirtySections,
    dirty: dirtySections.length > 0,
    save,
    reset: () => setValues(saved),
  };
}

export type DeployForm = ReturnType<typeof useDeployForm>;
