"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Hint } from "@/components/ui/Hint";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import type { Project } from "./types";

/**
 * A copy of the project, for a staging twin or a second instance.
 *
 * The dialog says what does not come along, because those are exactly the
 * things that would make two projects step on each other: the databases, the
 * addresses, the mounted folders, the webhook.
 */
export function DuplicateDialog({
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
  const [name, setName] = useState(`${project.name}-copia`);
  const [includeEnv, setIncludeEnv] = useState(true);

  async function submit() {
    const res = await fetch(api(`/api/projects/${project.id}/duplicate`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), includeEnv }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? "Copia non riuscita");
      return false;
    }
    toast.success(`Creato «${data.name}»: fai il primo deploy per metterlo online`);
    router.push(href(`/projects/${data.id}`));
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Duplica il progetto"
      submitLabel="Duplica"
      isSubmitDisabled={!name.trim()}
      onSubmit={submit}
    >
      <TextField value={name} onChange={setName} autoFocus>
        <Label>Nome della copia</Label>
        <Input />
      </TextField>
      <CheckboxField
        isSelected={includeEnv}
        onChange={setIncludeEnv}
        label={<span className="text-sm">Copia anche le variabili</span>}
      />
      <Hint tone="info" title="Cosa non viene copiato">
        I database collegati, gli indirizzi, le cartelle montate e gli aggiornamenti automatici: la copia ha i suoi. La porta
        sarà la prima libera{project.source_type === "upload" ? ", e i file caricati vengono copiati senza le dipendenze" : ""}.
      </Hint>
    </FormDialog>
  );
}
