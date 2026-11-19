"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageState } from "@/components/ui/PageState";
import { Panel } from "@/components/ui/Panel";
import { ListRow } from "@/components/ui/ListRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormDialog } from "@/components/ui/FormDialog";
import { Badge } from "@/components/ui/Badge";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { useResource } from "@/lib/hooks/useResource";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { GROUP_NAME_PATTERN, GROUP_NAME_RULE } from "@/lib/env-refs";
import { MSG, SHARED_VARS } from "@/lib/copy";
import { formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  keys: string[];
  projectCount: number;
  updatedAt: string;
}

/**
 * Variabili condivise: named, encrypted sets of variables that several
 * projects receive, changed in one place.
 *
 * A page about one server, like Avvio automatico: groups are kept by the
 * server their projects run on, so in a cluster the server is chosen above
 * and the page says whose groups these are.
 */
export default function SharedVariablesPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const { isSolo, current } = useNode();
  const { data, loading, error, refresh } = useResource<GroupRow[]>(api("/api/env-groups"));
  const [creating, setCreating] = useState(false);
  const groups = Array.isArray(data) ? data : [];

  return (
    <>
      <PageHeader
        title={SHARED_VARS.title}
        description="Gruppi di variabili cifrate che più progetti ricevono insieme: si cambiano in un posto solo"
        actions={
          <Button onPress={() => setCreating(true)}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuovo gruppo
          </Button>
        }
      />

      {!isSolo && current && <Hint className="mb-4">{SHARED_VARS.serverScope(current.name)}</Hint>}

      <PageState
        loading={loading}
        error={error}
        hasData={data !== null}
        onRetry={() => void refresh()}
        what="i gruppi"
        empty={
          groups.length === 0 && (
            <Panel>
              <EmptyState
                icon="solar:key-square-linear"
                title="Nessun gruppo"
                description="Un gruppo tiene le variabili che più progetti usano uguali — le credenziali SMTP, una chiave di Stripe — e le porta a tutti. Lo colleghi dalla scheda Variabili di ogni progetto."
                action={
                  <Button size="sm" onPress={() => setCreating(true)}>
                    Crea un gruppo
                  </Button>
                }
              />
            </Panel>
          )
        }
      >
        <Panel padding="flush" className="divide-separator divide-y">
          {groups.map((group) => (
            <ListRow
              key={group.id}
              href={href(`/shared-variables/${group.id}`)}
              icon="solar:key-square-linear"
              title={<span className="font-mono">{group.name}</span>}
              badges={<Badge>{group.keys.length === 1 ? "1 variabile" : `${group.keys.length} variabili`}</Badge>}
              description={group.description || (group.keys.length > 0 ? group.keys.join(", ") : "Vuoto")}
              meta={`${group.projectCount === 0 ? "Non ancora usato" : group.projectCount === 1 ? "Usato da 1 progetto" : `Usato da ${group.projectCount} progetti`} · modificato ${formatRelative(group.updatedAt)}`}
            />
          ))}
        </Panel>
      </PageState>

      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const trimmed = name.trim();
  const invalid = trimmed !== "" && !GROUP_NAME_PATTERN.test(trimmed);

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Nuovo gruppo"
      submitLabel="Crea"
      isSubmitDisabled={!trimmed || invalid}
      onSubmit={async () => {
        try {
          const res = await fetch(api("/api/env-groups"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmed, description: description.trim() || null }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast.error(data.error ?? MSG.createFailed);
            return false;
          }
          toast.success(`Gruppo «${data.name}» creato`, { description: "Aggiungi le variabili, poi collegalo ai progetti." });
          router.push(href(`/shared-variables/${data.id}`));
        } catch {
          toast.error(MSG.unreachable);
          return false;
        }
      }}
    >
      <TextField value={name} onChange={(next) => setName(next.toLowerCase())} isInvalid={invalid} autoFocus>
        <Label>Nome</Label>
        <Input placeholder="smtp" className="font-mono" autoComplete="off" spellCheck={false} autoCapitalize="off" />
      </TextField>
      <FieldHint className={invalid ? "text-danger mt-0" : "mt-0"}>
        {invalid ? GROUP_NAME_RULE : (
          <>
            È il nome che usano i riferimenti: <Code>{`\${{ shared.${trimmed || "smtp"}.NOME }}`}</Code>.
          </>
        )}
      </FieldHint>
      <TextField value={description} onChange={setDescription}>
        <Label>Descrizione (facoltativa)</Label>
        <Input placeholder="Server di posta per le email transazionali" />
      </TextField>
    </FormDialog>
  );
}
