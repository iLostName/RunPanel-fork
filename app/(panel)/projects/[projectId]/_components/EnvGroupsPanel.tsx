"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint } from "@/components/ui/Hint";
import { RowMenu } from "@/components/ui/ListRow";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { SelectField } from "@/components/ui/SelectField";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { MSG, SHARED_VARS } from "@/lib/copy";
import { toast } from "@/lib/toast";

/** A group as `GET /api/projects/{id}/env-groups` lists it: names, never values. */
export interface AttachedGroup {
  id: string;
  name: string;
  description: string | null;
  position: number;
  keys: string[];
}

interface GroupOption {
  id: string;
  name: string;
  description: string | null;
  keys: string[];
}

/**
 * The shared groups this project receives, first to last.
 *
 * Each change applies at once, as switching a database link does: the order is
 * the precedence (the later group wins), so moving one is a decision of its
 * own, not a field of the variables form. They reach the app from the next
 * deploy or restart, which the toast says.
 *
 * Attaching is offered only to who may read groups — the app would receive
 * their values, and whoever manages the project could read them through it.
 * Taking one off, or moving it, only needs the project.
 */
export function EnvGroupsPanel({
  projectId,
  groups,
  canManage,
  canAttach,
  onChanged,
}: {
  projectId: string;
  groups: readonly AttachedGroup[];
  canManage: boolean;
  canAttach: boolean;
  onChanged: () => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AttachedGroup | null>(null);

  async function save(ids: string[], done: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/projects/${projectId}/env-groups`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIds: ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? MSG.saveFailed);
        return false;
      }
      toast.success(done, { description: "Vale dal prossimo deploy o riavvio." });
      onChanged();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const ids = groups.map((g) => g.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    void save(next, `«${groups[from].name}» spostato`);
  };

  return (
    <Panel className="space-y-3">
      <PanelHeader
        title={SHARED_VARS.title}
        description={
          groups.length > 0
            ? "Gruppi che il progetto riceve, dal primo all'ultimo"
            : "Gruppi di variabili che più progetti ricevono insieme, cambiati in un posto solo"
        }
        actions={
          canAttach && (
            <Button variant="outline" size="sm" isDisabled={busy} onPress={() => setAdding(true)}>
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Collega un gruppo
            </Button>
          )
        }
      />

      {groups.length > 0 && (
        <ol className="divide-separator divide-y">
          {groups.map((group, i) => (
            <li key={group.id} className="flex min-w-0 items-center gap-3 py-2.5">
              <span className="text-muted w-5 shrink-0 text-right font-mono text-meta" aria-label={`Posizione ${i + 1}`}>
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {canAttach ? (
                    <Link href={href(`/shared-variables/${group.id}`)} className="text-foreground hover:text-accent min-w-0 truncate font-mono text-sm transition-colors">
                      {group.name}
                    </Link>
                  ) : (
                    <span className="text-foreground min-w-0 truncate font-mono text-sm">{group.name}</span>
                  )}
                  <span className="text-muted shrink-0 text-meta">
                    {group.keys.length === 1 ? "1 variabile" : `${group.keys.length} variabili`}
                  </span>
                </div>
                <p className="text-muted truncate text-meta">{group.description || group.keys.join(", ") || "Nessuna variabile"}</p>
              </div>
              {canManage && (
                <RowMenu
                  label={`Azioni per ${group.name}`}
                  actions={[
                    { id: "up", label: "Sposta su", icon: "solar:arrow-up-linear", disabled: busy || i === 0, onAction: () => move(i, i - 1) },
                    {
                      id: "down",
                      label: "Sposta giù",
                      icon: "solar:arrow-down-linear",
                      disabled: busy || i === groups.length - 1,
                      onAction: () => move(i, i + 1),
                    },
                    { id: "remove", label: "Scollega dal progetto", icon: "solar:link-broken-linear", danger: true, onAction: () => setRemoving(group) },
                  ]}
                />
              )}
            </li>
          ))}
        </ol>
      )}

      <FieldHint className="mt-0">
        {groups.length > 1 ? `${SHARED_VARS.precedence} ` : groups.length === 1 ? "Le variabili del progetto vincono su quelle del gruppo. " : ""}
        Un valore può anche leggerne uno di un gruppo senza collegarlo tutto: <Code>{"${{ shared.gruppo.NOME }}"}</Code>.
        {!canAttach && canManage && <> {SHARED_VARS.attachNeedsPermission}</>}
      </FieldHint>

      {adding && <AttachDialog attached={ids} onClose={() => setAdding(false)} onAttach={(id, name) => save([...ids, id], `«${name}» collegato`)} />}

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Scollegare «${removing?.name ?? ""}»?`}
        description={
          <>
            Il gruppo resta. Dal prossimo deploy o riavvio il progetto non riceve più{" "}
            {removing?.keys.length === 1 ? "la sua variabile" : `le sue ${removing?.keys.length ?? 0} variabili`}
            {removing && removing.keys.length > 0 && (
              <>
                {" "}
                (<Code>{removing.keys.slice(0, 4).join(", ")}</Code>
                {removing.keys.length > 4 ? "…" : ""})
              </>
            )}
            .
          </>
        }
        confirmLabel="Scollega"
        onConfirm={async () => {
          if (!removing) return;
          const ok = await save(
            ids.filter((id) => id !== removing.id),
            `«${removing.name}» scollegato`
          );
          return ok ? undefined : false;
        }}
      />
    </Panel>
  );
}

/** The groups of the project's server not attached yet, one to pick. */
function AttachDialog({
  attached,
  onClose,
  onAttach,
}: {
  attached: readonly string[];
  onClose: () => void;
  onAttach: (id: string, name: string) => Promise<boolean>;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const { data, error, loading } = useResource<GroupOption[]>(api("/api/env-groups"));
  const options = (Array.isArray(data) ? data : []).filter((g) => !attached.includes(g.id));
  const [picked, setPicked] = useState<string | null>(null);
  const choice = options.find((g) => g.id === picked) ?? null;

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Collega un gruppo"
      description="Il progetto riceve tutte le variabili del gruppo, dopo quelli già collegati: dove un nome si ripete, vince l'ultimo."
      submitLabel="Collega"
      isSubmitDisabled={!choice}
      onSubmit={async () => {
        if (!choice) return false;
        const ok = await onAttach(choice.id, choice.name);
        if (!ok) return false;
        onClose();
      }}
    >
      {loading && !data ? (
        <p className="text-muted text-sm">Carico i gruppi…</p>
      ) : error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : options.length === 0 ? (
        <p className="text-muted text-sm">
          {Array.isArray(data) && data.length > 0 ? "Il progetto ha già tutti i gruppi di questo server." : "Su questo server non c'è ancora nessun gruppo."}{" "}
          <Link href={href("/shared-variables")} className="text-accent hover:underline">
            Vai alle variabili condivise
          </Link>
        </p>
      ) : (
        <>
          <SelectField
            label="Gruppo"
            value={picked}
            onChange={setPicked}
            placeholder="Scegli un gruppo"
            options={options.map((g) => ({ value: g.id, label: g.name, description: g.description ?? undefined }))}
          />
          {choice && (
            <FieldHint className="mt-0">
              {choice.keys.length === 0 ? (
                "Il gruppo è vuoto."
              ) : (
                <>
                  {choice.keys.length === 1 ? "Porta 1 variabile" : `Porta ${choice.keys.length} variabili`}:{" "}
                  <Code>{choice.keys.slice(0, 8).join(", ")}</Code>
                  {choice.keys.length > 8 ? "…" : ""}
                </>
              )}
            </FieldHint>
          )}
        </>
      )}
    </FormDialog>
  );
}
