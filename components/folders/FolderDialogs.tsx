"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { useMemberApi, useNode } from "@/lib/hooks/useNode";
import type { Located } from "@/lib/cluster-merge";
import type { FolderLike } from "@/lib/overview-groups";

export type FolderDialogRequest<F extends FolderLike = FolderLike> =
  | { kind: "create" }
  | { kind: "rename" | "delete"; folder: Located<F> };

/**
 * Creating, renaming and deleting a folder: the same dialogs, words and rules
 * on the Overview and on the Projects page.
 *
 * Opened from state, so a page only says which dialog, for which folder, and
 * what to refresh afterwards. A folder is created on this panel whatever server
 * is on screen and reaches the others by itself; a rename or a delete goes to
 * the server whose copy was listed. `request.folder` carries the folder's real
 * name, not the one `distinctFolderNames` shows, so a rename starts from it.
 */
export function FolderDialogs<F extends FolderLike>({
  request,
  onClose,
  onSaved,
  onDeleted,
}: {
  request: FolderDialogRequest<F> | null;
  onClose: () => void;
  /** After a create or a rename, with the folder as the server answered it. */
  onSaved: (folder: FolderLike, created: boolean) => void | Promise<void>;
  /** After a delete. What the folder held is in no folder now, so every list carrying `folder_id` is stale too. */
  onDeleted: (folder: Located<F>) => void | Promise<void>;
}) {
  const memberApi = useMemberApi();
  const { isSolo, selfId } = useNode();
  const [name, setName] = useState("");

  // The last request, kept while the dialog animates out so its title does not
  // flip to "Nuova cartella" on the way. A new one starts from its folder's
  // name, not from what was typed in the last: adjusted during render, not in
  // an effect.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) {
    setShown(request);
    setName(request.kind === "rename" ? request.folder.name : "");
  }

  async function submitName() {
    const value = name.trim();
    if (!request || request.kind === "delete" || !value) return;
    const isRename = request.kind === "rename";
    // Created on this panel, whatever server is on screen: it reaches the others by itself.
    const memberId = isRename ? request.folder.memberId : selfId;
    const res = await fetch(memberApi(memberId, isRename ? `/api/folders/${request.folder.id}` : "/api/folders"), {
      method: isRename ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? (isRename ? "Rinomina non riuscita" : MSG.createFailed));
      // Keeps the dialog open on what was typed.
      return false;
    }
    const saved = await res.json().catch(() => null);
    await onSaved(saved && typeof saved.id === "string" ? saved : { id: "", name: value }, !isRename);
  }

  async function deleteFolder() {
    if (request?.kind !== "delete") return;
    const { folder } = request;
    const res = await fetch(memberApi(folder.memberId, `/api/folders/${folder.id}`), { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? MSG.deleteFailed);
      return;
    }
    await onDeleted(folder);
  }

  const renaming = shown?.kind === "rename" ? shown.folder : null;

  return (
    <>
      <FormDialog
        isOpen={request?.kind === "create" || request?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={renaming ? "Rinomina cartella" : "Nuova cartella"}
        submitLabel={renaming ? "Rinomina" : "Crea"}
        isSubmitDisabled={!name.trim() || (renaming !== null && name.trim() === renaming.name)}
        onSubmit={submitName}
      >
        <div className="space-y-4">
          <TextField value={name} onChange={setName} autoFocus>
            <Label>Nome</Label>
            <Input placeholder="Es. Clienti" maxLength={60} />
          </TextField>
          {shown?.kind === "create" && !isSolo && (
            <p className="text-muted text-xs">La cartella vale per tutti i server: può contenere progetti e database di qualunque server.</p>
          )}
        </div>
      </FormDialog>

      <ConfirmDialog
        isOpen={request?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Eliminare la cartella?"
        description={
          shown?.kind === "delete"
            ? `"${shown.folder.name}" sparisce dalla Panoramica e da Progetti${isSolo ? "" : " su tutti i server"}. I progetti e i database che contiene non vengono toccati: restano senza cartella.`
            : undefined
        }
        confirmLabel="Elimina"
        destructive
        onConfirm={deleteFolder}
      />
    </>
  );
}
