"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ListRow, RowMenu } from "@/components/ui/ListRow";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { useExpertMode } from "@/components/Providers";
import { ServerBadge } from "@/components/cluster/ServerBits";
import { useMe } from "@/lib/hooks/useMe";
import { useMemberApi, useServerHref } from "@/lib/hooks/useNode";
import { formatBytes } from "@/lib/format";
import type { Located } from "@/lib/cluster-merge";
import { DestinationForm, type DestinationDetail } from "./DestinationForm";
import { destinationIcon, technicalLine, whereItWrites, wherePlace } from "./destinations/kinds";
import type { DestinationView } from "@/components/backups/types";

type Row = Located<DestinationView>;

function usageLine(destination: DestinationView): string {
  const used = destination.usedBy ?? [];
  const count = destination.usedByCount ?? used.length;
  const policies =
    count === 0
      ? "Nessuna pianificazione la usa"
      : `La usa${count === 1 ? "" : "no"} ${used.map((p) => `«${p.name}»`).join(", ")}${count > used.length ? `${used.length ? " e " : ""}${count - used.length} di altri account` : ""}`;
  const archives = destination.archives ?? 0;
  return archives > 0
    ? `${policies} · ${archives} archivi${destination.archiveBytes ? ` (${formatBytes(destination.archiveBytes)})` : ""}`
    : policies;
}

/**
 * Where archives go: each destination, what writes to it, what it holds — and
 * check, edit, make default, delete.
 *
 * Deleting is the delicate one. A destination a policy writes to is refused
 * (the foreign key would take the policy with it); one that holds archives
 * asks for its name typed, because those archives stay where they are but the
 * panel stops knowing about them.
 */
export function DestinationsPanel({
  destinations,
  loaded,
  error,
  description,
  onChanged,
}: {
  destinations: Row[];
  loaded: boolean;
  error: string | null;
  description: string;
  onChanged: () => void;
}) {
  const memberApi = useMemberApi();
  const href = useServerHref();
  const router = useRouter();
  const me = useMe();
  const { expert } = useExpertMode();
  // The provider's own code and words: for whoever turned expert mode on.
  const technical = (text: string | null) => (expert && text ? text : undefined);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ row: Row; detail: DestinationDetail } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [defaulting, setDefaulting] = useState<{ row: Row; move: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function check(row: Row) {
    setBusy(`check:${row.id}`);
    try {
      const res = await fetch(memberApi(row.memberId, `/api/backups/destinations/${row.id}`), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Verifica non riuscita");
        return;
      }
      const detail = technical(body.detail ? `${body.code ?? ""} ${body.detail}`.trim() : null);
      if (body.ok && body.warning) toast.warning(body.message, { description: detail });
      else if (body.ok) toast.success(body.message);
      else toast.error(body.message ?? "Verifica non riuscita", { description: detail });
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  async function startEdit(row: Row) {
    setBusy(`edit:${row.id}`);
    try {
      const res = await fetch(memberApi(row.memberId, `/api/backups/destinations/${row.id}`));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? MSG.loadFailed);
        return;
      }
      setEditing({ row, detail: body as DestinationDetail });
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  async function makeDefault(row: Row, move: boolean) {
    const res = await fetch(memberApi(row.memberId, `/api/backups/destinations/${row.id}/default`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movePolicies: move }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.saveFailed);
      return false;
    }
    toast.success(
      body.movedPolicies > 0
        ? `«${row.name}» è la destinazione predefinita, e ${body.movedPolicies === 1 ? "una pianificazione salva" : `${body.movedPolicies} pianificazioni salvano`} lì da adesso.`
        : `«${row.name}» è la destinazione predefinita.`
    );
    onChanged();
  }

  async function remove(row: Row) {
    const archives = row.archives ?? 0;
    const query = archives > 0 ? `?confirm=${encodeURIComponent(row.name)}` : "";
    const res = await fetch(memberApi(row.memberId, `/api/backups/destinations/${row.id}${query}`), { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.deleteFailed);
      return false;
    }
    toast.success(
      `«${row.name}» eliminata.${body.newDefault ? ` Ora la predefinita è «${body.newDefault}».` : ""}`,
      body.orphanedArchives > 0
        ? { description: `I suoi ${body.orphanedArchives} archivi sono rimasti dov'erano, fuori dal pannello.` }
        : undefined
    );
    onChanged();
  }

  /** Policies of the same server that write somewhere else: what "sposta" would move. */
  const elsewhere = (row: Row) =>
    destinations
      .filter((d) => d.memberId === row.memberId && d.id !== row.id)
      .reduce((n, d) => n + (d.usedByCount ?? 0), 0);

  const deleteDialog = (() => {
    if (!deleting) return null;
    const used = deleting.usedByCount ?? 0;
    const archives = deleting.archives ?? 0;
    const close = (open: boolean) => !open && setDeleting(null);

    if (used > 0) {
      const first = deleting.usedBy?.[0];
      return (
        <ConfirmDialog
          isOpen
          onOpenChange={close}
          title={`«${deleting.name}» è ancora in uso`}
          description={
            <>
              <p>{usageLine(deleting)}.</p>
              <p className="mt-2">
                Eliminandola sparirebbero anche quelle pianificazioni. Apri ognuna e scegli un&apos;altra destinazione,
                oppure rendi predefinita un&apos;altra destinazione spostandoci le pianificazioni; poi riprova.
              </p>
            </>
          }
          confirmLabel={first ? `Apri «${first.name}»` : "Ho capito"}
          cancelLabel="Chiudi"
          onConfirm={() => {
            if (first) router.push(href(`/backups/policies/${first.id}`, deleting.memberId));
          }}
        />
      );
    }

    return (
      <ConfirmDialog
        isOpen
        onOpenChange={close}
        destructive
        title={`Eliminare «${deleting.name}»?`}
        confirmLabel="Elimina"
        confirmText={archives > 0 ? deleting.name : undefined}
        description={
          archives > 0 ? (
            <>
              <p>
                Qui ci sono {archives} archivi{deleting.archiveBytes ? ` (${formatBytes(deleting.archiveBytes)})` : ""}.
                Restano dove sono — {wherePlace(deleting)} —
                ma il pannello non li vedrà più: niente ripristino, download o pulizia automatica.
              </p>
              <p className="mt-2">Se ti servono, scaricali prima dalla Cronologia.</p>
            </>
          ) : (
            "Nessuna pianificazione la usa e non contiene archivi."
          )
        }
        onConfirm={() => remove(deleting)}
      />
    );
  })();

  return (
    <Panel padding="flush">
      <div className="p-4 sm:p-5">
        <PanelHeader
          title="Destinazioni"
          description={description}
          actions={
            <Button size="sm" variant="secondary" onPress={() => setAdding(true)}>
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Aggiungi
            </Button>
          }
        />
      </div>

      {error && !loaded ? (
        <LoadError what="le destinazioni" error={error} onRetry={onChanged} className="px-4 pb-4 sm:px-5" />
      ) : !loaded ? (
        <div className="space-y-2 px-4 pb-4 sm:px-5">
          <SkeletonBlock className="h-12" />
        </div>
      ) : destinations.length === 0 ? (
        <EmptyState
          icon="solar:folder-linear"
          title="Nessuna destinazione"
          description="Una destinazione è dove finiscono gli archivi: il disco di questo server, o fuori da qui — un archivio S3, un NAS, Google Drive."
          className="py-8"
        />
      ) : (
        <ul className="divide-border divide-y">
          {destinations.map((row) => (
            <li key={`${row.memberId}:${row.id}`}>
              <ListRow
                icon={destinationIcon(row.type)}
                title={row.name}
                badges={
                  <>
                    {row.isDefault && (
                      <Badge tone="accent" icon="solar:star-linear">
                        Predefinita
                      </Badge>
                    )}
                    <ServerBadge memberId={row.memberId} />
                  </>
                }
                description={
                  <>
                    {whereItWrites(row)}
                    <Technical>{technicalLine(row)}</Technical>
                  </>
                }
                meta={usageLine(row)}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => check(row)}
                    isPending={busy === `check:${row.id}`}
                  >
                    Verifica
                  </Button>
                }
                menu={
                  <RowMenu
                    label={`Altre azioni per ${row.name}`}
                    actions={[
                      ...(me.isOwner
                        ? [
                            {
                              id: "edit",
                              label: busy === `edit:${row.id}` ? "Apro…" : "Modifica",
                              icon: "solar:pen-linear",
                              disabled: busy === `edit:${row.id}`,
                              onAction: () => void startEdit(row),
                            },
                          ]
                        : []),
                      ...(me.isOwner && !row.isDefault
                        ? [
                            {
                              id: "default",
                              label: "Imposta come predefinita",
                              icon: "solar:star-linear",
                              onAction: () => setDefaulting({ row, move: row.type !== "local" && elsewhere(row) > 0 }),
                            },
                          ]
                        : []),
                      {
                        id: "delete",
                        label: "Elimina",
                        icon: "solar:trash-bin-trash-linear",
                        danger: true,
                        onAction: () => setDeleting(row),
                      },
                    ]}
                  />
                }
              />
            </li>
          ))}
        </ul>
      )}

      {/* Mounted only while open, so a cancelled form starts empty next time. */}
      {adding && (
        <DestinationForm isOpen onOpenChange={setAdding} onSaved={onChanged} canSetDefault={me.isOwner} isOwner={me.isOwner} />
      )}
      {editing && (
        <DestinationForm
          key={editing.detail.id}
          isOpen
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={onChanged}
          editing={editing.detail}
          archives={editing.row.archives ?? 0}
          apiFor={(path) => memberApi(editing.row.memberId, path)}
        />
      )}

      {deleteDialog}

      {defaulting && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => !open && setDefaulting(null)}
          title={`Usare «${defaulting.row.name}» come predefinita?`}
          confirmLabel="Imposta come predefinita"
          description={
            <>
              <p>
                Il backup notturno, le nuove pianificazioni e il backup di sicurezza di ogni ripristino salveranno qui.
                Gli archivi già fatti restano dove sono, e si possono ancora ripristinare.
              </p>
              {elsewhere(defaulting.row) > 0 && (
                <CheckboxField
                  className="mt-3"
                  isSelected={defaulting.move}
                  onChange={(move) => setDefaulting({ ...defaulting, move })}
                  label={`Sposta qui anche ${elsewhere(defaulting.row) === 1 ? "la pianificazione che oggi salva" : `le ${elsewhere(defaulting.row)} pianificazioni che oggi salvano`} altrove`}
                />
              )}
            </>
          }
          onConfirm={() => makeDefault(defaulting.row, defaulting.move)}
        />
      )}
    </Panel>
  );
}
