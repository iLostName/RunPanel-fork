"use client";

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Section } from "@/components/ui/Section";
import { Badge } from "@/components/ui/Badge";
import { Code, FieldHint } from "@/components/ui/Hint";
import { Tip, TipText } from "@/components/ui/Tooltip";
import { SHARED_VARS, envSourceLabel } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { useNodeApi } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";

export interface EnvSourceRef {
  kind: "own" | "group" | "inherited" | "database" | "panel";
  id?: string;
  name?: string;
  /** A group received through the project an environment inherits from. */
  via?: string;
  /** Whose own variable an inherited one is; `previews` for production's variables of its previews. */
  environment?: "production" | "staging" | "previews";
}

/** A row of `GET /api/projects/{id}/env/effective`. */
export interface EnvPreviewVar {
  key: string;
  source: EnvSourceRef;
  overridden: EnvSourceRef[];
  conflict: string[] | null;
  refs: string[];
  value: string | null;
  revealable: boolean;
  problem: string | null;
}

export interface EnvPreview {
  origin: "host" | "container";
  vars: EnvPreviewVar[];
  problems: number;
  /** Optional: a server on an older release does not send them. */
  inherits?: { id: string; name: string; environment: "production" | "staging" | "previews" }[];
  withheld?: { key: string; source: EnvSourceRef; reason: string }[];
}

const SOURCE_TONE = { own: "neutral", group: "accent", inherited: "accent", database: "warning", panel: "neutral" } as const;
const SOURCE_ICON = {
  own: "solar:folder-linear",
  group: "solar:key-square-linear",
  inherited: "solar:layers-minimalistic-linear",
  database: "solar:database-linear",
  panel: "solar:settings-linear",
} as const;

/**
 * What the app receives, as the deploy will hand it over: every variable once,
 * the one that wins, where it comes from, what it replaces, and — with its
 * references expanded — its value.
 *
 * Read-only and under the editor: the editor is where the project's own are
 * changed, the groups panel where groups are attached, and this is where to
 * check what all of it adds up to. Values stay hidden until asked for, one row
 * at a time, and only a row this account may read every part of can be shown;
 * the server decides that and sends the values only then.
 */
export function EnvEffective({ projectId, preview }: { projectId: string; preview: EnvPreview }) {
  const api = useNodeApi();
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [values, setValues] = useState<Map<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  // A new preview — after a save, a group attached — makes the values read
  // before it stale: they are asked for again. Adjusted during render, not in
  // an effect; the preview object only changes when its content does.
  const [seen, setSeen] = useState(preview);
  if (seen !== preview) {
    setSeen(preview);
    setValues(null);
    setShown(new Set());
  }

  // Problems first: they are why anyone opens this.
  const vars = useMemo(
    () => [...preview.vars].sort((a, b) => Number(Boolean(b.problem)) - Number(Boolean(a.problem)) || a.key.localeCompare(b.key)),
    [preview.vars]
  );

  async function toggle(key: string) {
    if (shown.has(key)) {
      setShown((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }
    if (!values) {
      setLoading(true);
      try {
        const res = await fetch(api(`/api/projects/${projectId}/env/effective?reveal=true`));
        const data = (await res.json().catch(() => null)) as EnvPreview | null;
        if (!res.ok || !data) throw new Error();
        setValues(new Map(data.vars.filter((v) => v.value !== null).map((v) => [v.key, v.value as string])));
      } catch {
        toast.error("Non è stato possibile leggere i valori");
        return;
      } finally {
        setLoading(false);
      }
    }
    setShown((current) => new Set(current).add(key));
  }

  const summary = [
    preview.vars.length === 1 ? "1 variabile" : `${preview.vars.length} variabili`,
    preview.problems > 0 && (preview.problems === 1 ? "1 da sistemare" : `${preview.problems} da sistemare`),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Section title="Cosa riceve l'app" summary={summary} defaultExpanded={preview.problems > 0}>
      <FieldHint className="mt-0">
        {SHARED_VARS.precedence} I riferimenti sono già risolti
        {preview.origin === "container" ? ", con gli indirizzi come li vede un container." : ", con gli indirizzi come li vede l'host."}
      </FieldHint>
      {(preview.withheld ?? []).length > 0 && (
        <ul className="border-warning/30 bg-warning/5 my-2 space-y-1.5 rounded-[var(--radius)] border p-3">
          {(preview.withheld ?? []).map((v) => (
            <li key={v.key} className="text-meta flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 leading-relaxed">
              <Code>{v.key}</Code>
              <span className="text-muted">{v.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="divide-separator divide-y">
        {vars.map((v) => (
          <EffectiveRow key={v.key} v={v} shown={shown.has(v.key)} value={values?.get(v.key) ?? null} busy={loading} onToggle={() => void toggle(v.key)} />
        ))}
      </ul>
    </Section>
  );
}

function EffectiveRow({
  v,
  shown,
  value,
  busy,
  onToggle,
}: {
  v: EnvPreviewVar;
  shown: boolean;
  value: string | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const losers = v.overridden.map(envSourceLabel);
  return (
    <li className="space-y-1.5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Code className={cn(v.problem && "text-danger")}>{v.key}</Code>
        <Badge tone={SOURCE_TONE[v.source.kind]} icon={SOURCE_ICON[v.source.kind]}>
          {envSourceLabel(v.source)}
        </Badge>
        {v.refs.length > 0 && (
          <TipText content={<>Legge {v.refs.join(", ")}</>}>
            <Badge icon="solar:link-round-linear">riferimento</Badge>
          </TipText>
        )}
        {v.conflict && (
          <TipText content={`Anche ${v.conflict.map((name) => `«${name}»`).join(", ")} la imposta: vince il gruppo più in basso nell'elenco.`}>
            <Badge tone="warning" icon="solar:danger-triangle-linear">
              {`anche in ${v.conflict.join(", ")}`}
            </Badge>
          </TipText>
        )}
      </div>

      {losers.length > 0 && !v.conflict && (
        <p className="text-muted text-meta">Sostituisce {losers.join(", ")}.</p>
      )}

      {v.problem ? (
        <p role="alert" className="text-danger text-meta leading-relaxed">
          {v.problem}
        </p>
      ) : (
        <div className="flex min-w-0 items-start gap-1">
          <span
            className={cn(
              "border-border bg-field min-h-8 min-w-0 flex-1 rounded-[var(--radius)] border px-3 py-1.5 font-mono text-sm break-all whitespace-pre-wrap",
              !(shown && value !== null) && "text-muted"
            )}
          >
            {/* Always eight: the length of a secret is part of the secret. */}
            {shown && value !== null ? value || <span className="font-sans italic">vuota</span> : "••••••••"}
          </span>
          {v.revealable ? (
            <Tip content={shown ? "Nascondi il valore" : "Mostra il valore"}>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                isDisabled={busy}
                aria-label={shown ? `Nascondi il valore di ${v.key}` : `Mostra il valore di ${v.key}`}
                onPress={onToggle}
              >
                <Icon icon={shown ? "solar:eye-closed-linear" : "solar:eye-linear"} width={16} aria-hidden />
              </Button>
            </Tip>
          ) : (
            <Tip content={lockedReason(v)}>
              <Button variant="ghost" size="sm" isIconOnly aria-label={`Perché il valore di ${v.key} non si può vedere`}>
                <Icon icon="solar:lock-keyhole-minimalistic-linear" width={16} className="text-muted" aria-hidden />
              </Button>
            </Tip>
          )}
        </div>
      )}
    </li>
  );
}

function lockedReason(v: EnvPreviewVar): string {
  if (v.source.kind === "database") return "Per vederlo serve il permesso di vedere le credenziali del database.";
  if (v.source.kind === "group") return "Per vederla serve il permesso «Variabili condivise», e di poter leggere quello che usa.";
  if (v.source.kind === "inherited") return "Per vederla serve il permesso di gestire il progetto di produzione.";
  if (v.refs.length > 0) return "Per vederla serve poter leggere ogni cosa che usa: i gruppi, i database, i progetti.";
  return "Per vederla serve il permesso di gestire il progetto.";
}
