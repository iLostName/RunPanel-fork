"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageState, DetailSkeleton } from "@/components/ui/PageState";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { RowMenu } from "@/components/ui/ListRow";
import { FormDialog } from "@/components/ui/FormDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DangerZone } from "@/components/ui/DangerAction";
import { StatusBadge } from "@/components/StatusBadge";
import { useResource } from "@/lib/hooks/useResource";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { GROUP_NAME_PATTERN, GROUP_NAME_RULE } from "@/lib/env-refs";
import { MSG, SHARED_VARS } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { GroupVarsEditor, type SaveResult } from "../_components/GroupVarsEditor";

interface ProjectLink {
  id: string;
  name: string;
  slug: string;
  status: string;
  position?: number;
}

interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  vars: { key: string; value: string }[];
  unreadable: string[];
  usage: { attached: ProjectLink[]; referencing: ProjectLink[]; groups: string[]; hidden: number };
}

/** One group: its variables, who receives them, and what to do after a change. */
export default function SharedGroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const { isSolo, current } = useNode();
  const { data, loading, error, refresh } = useResource<GroupDetail>(api(`/api/env-groups/${groupId}?reveal=true`));
  useCrumbLabel(groupId, data?.name);
  const [editing, setEditing] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const [lastSave, setLastSave] = useState<SaveResult | null>(null);

  const affected = data ? data.usage.attached.length + data.usage.referencing.length + data.usage.hidden : 0;
  const back = { href: href("/shared-variables"), label: "Torna alle variabili condivise" };

  async function remove() {
    try {
      const res = await fetch(api(`/api/env-groups/${groupId}`), { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? MSG.deleteFailed);
        return;
      }
      toast.success(`Gruppo «${data?.name ?? ""}» eliminato`);
      router.push(back.href);
    } catch {
      toast.error(MSG.unreachable);
    }
  }

  async function redeploy(): Promise<boolean> {
    try {
      const res = await fetch(api(`/api/env-groups/${groupId}/redeploy`), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Deploy non avviati");
        return false;
      }
      const started = (body.started ?? []) as { name: string }[];
      const skipped = (body.skipped ?? []) as { name: string; reason: string }[];
      const title =
        started.length === 0 ? "Nessun deploy avviato" : started.length === 1 ? `Deploy avviato: ${started[0].name}` : `${started.length} deploy avviati`;
      const notes = [
        ...skipped.map((s) => `${s.name}: ${s.reason}`),
        ...(body.hidden > 0 ? [`${body.hidden} che non puoi vedere: saltati`] : []),
      ];
      const detail = notes.length > 0 ? { description: notes.join(" · ") } : undefined;
      if (started.length > 0) toast.success(title, detail);
      else toast.error(title, detail);
      setLastSave(null);
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <>
      <PageHeader
        back={back}
        title={data ? <span className="font-mono">{data.name}</span> : SHARED_VARS.title}
        description={data?.description || (data ? "Gruppo di variabili condivise" : undefined)}
        actions={
          data && (
            <>
              {affected > 0 && (
                <Button variant="outline" onPress={() => setRedeploying(true)}>
                  <Icon icon="solar:restart-linear" width={16} aria-hidden />
                  Ridistribuisci i progetti interessati
                </Button>
              )}
              <RowMenu
                label={`Azioni per ${data.name}`}
                actions={[{ id: "edit", label: "Rinomina o descrivi…", icon: "solar:pen-linear", onAction: () => setEditing(true) }]}
              />
            </>
          )
        }
      />

      <PageState loading={loading} error={error} hasData={data !== null} onRetry={() => void refresh()} what="il gruppo" back={back} skeleton={<DetailSkeleton />}>
        {data && (
          <div className="space-y-4">
            {/* The one notice of the page: after a change, what it takes for the projects to have it. */}
            {lastSave?.changed && lastSave.affected > 0 && (
              <Hint tone="tip" title="Le modifiche arrivano ai progetti al loro prossimo deploy o riavvio">
                <span className="block">
                  {lastSave.affected === 1 ? "Un progetto usa questo gruppo." : `${lastSave.affected} progetti usano questo gruppo.`} Puoi
                  ridistribuirli adesso: quelli fermi restano fermi.
                </span>
                <Button size="sm" variant="secondary" className="mt-2" onPress={() => setRedeploying(true)}>
                  Ridistribuisci i progetti interessati
                </Button>
              </Hint>
            )}

            {!isSolo && current && <Hint>{SHARED_VARS.serverScope(current.name)}</Hint>}

            {data.unreadable.length > 0 && (
              <Hint tone="warn" title="Valori che il pannello non riesce a leggere">
                {data.unreadable.join(", ")}: sono cifrati con la chiave di un altro pannello. Il deploy dei progetti che li ricevono
                si ferma finché non li riscrivi; salvando il gruppo vengono tolti.
              </Hint>
            )}

            <GroupVarsEditor
              key={data.id}
              groupId={data.id}
              initialVars={data.vars}
              onSaved={(result) => {
                setLastSave(result);
                void refresh();
              }}
            />

            <UsagePanel group={data} />

            <Panel className="space-y-2">
              <PanelHeader title="Come si usa" />
              <p className="text-muted text-xs leading-relaxed">
                Dalla scheda Variabili di un progetto, «Collega un gruppo»: il progetto riceve tutte queste variabili. Oppure un solo
                valore, con un riferimento: <Code>{`\${{ shared.${data.name}.${data.vars[0]?.key ?? "NOME"} }}`}</Code>.
              </p>
              <FieldHint className="mt-0">{SHARED_VARS.precedence}</FieldHint>
            </Panel>

            <DangerZone
              title="Elimina il gruppo"
              description="Le sue variabili vengono cancellate e il gruppo si scollega da ogni progetto."
              actionLabel="Elimina il gruppo"
              confirm={{
                title: `Eliminare «${data.name}»?`,
                description: (
                  <>
                    {data.usage.attached.length > 0
                      ? `Dal prossimo deploy o riavvio non ricevono più le sue variabili: ${data.usage.attached.map((p) => p.name).join(", ")}${data.usage.hidden > 0 ? ` e altri ${data.usage.hidden}` : ""}. `
                      : "Nessun progetto lo riceve. "}
                    Non si può annullare.
                  </>
                ),
                confirmText: data.name,
              }}
              onConfirm={remove}
            />
          </div>
        )}
      </PageState>

      {data && editing && <EditDialog group={data} onClose={() => setEditing(false)} onSaved={() => void refresh()} />}

      <ConfirmDialog
        isOpen={redeploying}
        onOpenChange={setRedeploying}
        title="Ridistribuire i progetti interessati?"
        description={
          <>
            Parte un deploy completo per ogni progetto che usa il gruppo ed è in esecuzione: ognuno si ricostruisce e riparte con
            le variabili nuove. Quelli fermi, e quelli mai distribuiti, non vengono toccati.
          </>
        }
        confirmLabel="Ridistribuisci"
        onConfirm={async () => ((await redeploy()) ? undefined : false)}
      />
    </>
  );
}

function UsagePanel({ group }: { group: GroupDetail }) {
  const href = useServerHref();
  const { attached, referencing, groups, hidden } = group.usage;
  const total = attached.length + referencing.length + hidden;

  const row = (project: ProjectLink, note: string) => (
    <li key={project.id} className="flex min-w-0 items-center gap-2 py-2">
      <StatusBadge status={project.status} variant="dot" />
      <Link href={href(`/projects/${project.id}?tab=env`)} className="text-foreground hover:text-accent min-w-0 truncate text-sm transition-colors">
        {project.name}
      </Link>
      <span className="text-muted shrink-0 text-meta">{note}</span>
    </li>
  );

  return (
    <Panel className="space-y-2">
      <PanelHeader
        title="Usato da"
        description={total === 0 ? "Nessun progetto lo usa, per ora" : total === 1 ? "1 progetto" : `${total} progetti`}
      />
      {(attached.length > 0 || referencing.length > 0) && (
        <ul className="divide-separator divide-y">
          {attached.map((p) => row(p, `collegato, ${(p.position ?? 0) + 1}° dei suoi gruppi`))}
          {referencing.map((p) => row(p, "con un riferimento o tramite un altro gruppo"))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-muted text-meta">{hidden === 1 ? "E un progetto che non puoi vedere." : `E ${hidden} progetti che non puoi vedere.`}</p>
      )}
      {groups.length > 0 && (
        <FieldHint className="mt-0">
          Lo leggono anche i gruppi {groups.map((name) => `«${name}»`).join(", ")}: cambiarlo cambia anche i loro progetti.
        </FieldHint>
      )}
    </Panel>
  );
}

function EditDialog({ group, onClose, onSaved }: { group: GroupDetail; onClose: () => void; onSaved: () => void }) {
  const api = useNodeApi();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const trimmed = name.trim();
  const invalid = trimmed !== "" && !GROUP_NAME_PATTERN.test(trimmed);

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rinomina o descrivi"
      submitLabel="Salva"
      isSubmitDisabled={!trimmed || invalid}
      onSubmit={async () => {
        try {
          const res = await fetch(api(`/api/env-groups/${group.id}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmed, description: description.trim() || null }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast.error(data.error ?? MSG.saveFailed);
            return false;
          }
          toast.success("Gruppo aggiornato");
          onSaved();
          onClose();
        } catch {
          toast.error(MSG.unreachable);
          return false;
        }
      }}
    >
      <TextField value={name} onChange={(next) => setName(next.toLowerCase())} isInvalid={invalid} autoFocus>
        <Label>Nome</Label>
        <Input className="font-mono" autoComplete="off" spellCheck={false} autoCapitalize="off" />
      </TextField>
      <FieldHint className={invalid ? "text-danger mt-0" : "mt-0"}>
        {invalid ? GROUP_NAME_RULE : "I riferimenti trovano il gruppo per nome: se qualcuno lo usa, il pannello te lo dice prima di rinominarlo."}
      </FieldHint>
      <TextField value={description} onChange={setDescription}>
        <Label>Descrizione (facoltativa)</Label>
        <Input />
      </TextField>
    </FormDialog>
  );
}
