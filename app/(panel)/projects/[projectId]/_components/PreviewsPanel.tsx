"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Dropdown } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { formatBytes, formatRelative, formatWhen } from "@/lib/format";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, Hint } from "@/components/ui/Hint";
import { StatusBadge } from "@/components/StatusBadge";
import { ActionSheet, type SheetAction } from "@/components/ui/ActionSheet";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import type { PreviewRow, PreviewsResponse, Project } from "./types";

const STOPPED_TEXT = {
  limit: "Fermata per fare posto a un'altra: superato il limite di anteprime accese.",
  idle: "Fermata perché inattiva da troppi giorni.",
  manual: "Fermata a mano.",
} as const;

type Pending = { kind: "approve" | "delete"; preview: PreviewRow } | null;

/** The ⋯ of a row: a menu on a desktop, a sheet from the bottom on a phone, as everywhere else. */
function PreviewMenu({ label, actions }: { label: string; actions: SheetAction[] }) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const ordered = [...actions.filter((a) => !a.danger), ...actions.filter((a) => a.danger)];
  const trigger = (
    <Button size="sm" variant="ghost" isIconOnly aria-label={label} onPress={phone ? () => setOpen(true) : undefined}>
      <Icon icon="solar:menu-dots-linear" width={16} aria-hidden />
    </Button>
  );
  if (phone) {
    return (
      <>
        {trigger}
        <ActionSheet isOpen={open} onOpenChange={setOpen} title={label} actions={ordered} />
      </>
    );
  }
  return (
    <Dropdown>
      {trigger}
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={ordered.filter((a) => a.disabled).map((a) => a.id)}
          onAction={(key) => ordered.find((a) => a.id === key)?.onAction()}
        >
          {ordered.map((action) => (
            <Dropdown.Item key={action.id} id={action.id} textValue={action.label} className={cn(action.danger && "text-danger")}>
              {action.icon && <Icon icon={action.icon} width={14} aria-hidden />}
              {action.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * The previews of production's pull requests, on production's page: number,
 * title, author, commit, state, address, and what can be done to each.
 *
 * One quick action per row — open it, or approve a fork's commit — and the
 * rest in the menu. Approving and deleting ask first: one runs a stranger's
 * code on this server, the other removes containers and data. What the
 * previews take from the server is said above them: they share it.
 */
export function PreviewsPanel({ project }: { project: Project }) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const poll = usePollInterval(10000);
  const { data, refresh } = useResource<PreviewsResponse>(api(`/api/projects/${project.id}/previews`), { intervalMs: poll });
  const [pending, setPending] = useState<Pending>(null);
  const canOperate = project.permission?.level !== "read";
  const canManage = (project.permission?.level ?? "manage") === "manage";

  if (!data || (!data.settings.enabled && data.previews.length === 0)) return null;

  async function act(preview: PreviewRow, body: Record<string, unknown>, done: string) {
    const res = await fetch(api(`/api/projects/${project.id}/previews/${preview.id}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(out.error ?? "Operazione non riuscita");
    else toast.success(done);
    void refresh();
    return res.ok;
  }

  async function remove(preview: PreviewRow) {
    const res = await fetch(api(`/api/projects/${project.id}/previews/${preview.id}`), { method: "DELETE" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(out.error ?? "Eliminazione non riuscita");
    else toast.success(`Anteprima della PR #${preview.prNumber} eliminata`);
    void refresh();
    return res.ok;
  }

  const { usage, settings } = data;
  const usageText = [
    `${usage.running} di ${settings.maxPreviews} accese`,
    usage.memoryBytes !== null ? `${formatBytes(usage.memoryBytes)} di memoria` : null,
    usage.cpuPercent !== null ? `CPU ${usage.cpuPercent.toFixed(1)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Panel className="mt-6 space-y-3">
      <PanelHeader title="Anteprime delle pull request" description={`${usageText}. Le anteprime girano su questo server, accanto a produzione.`} />
      {data.transport.problem && <Hint tone="warn">{data.transport.problem}</Hint>}
      {data.previews.length === 0 ? (
        <p className="text-muted text-sm">Nessuna pull request aperta verso {project.source_branch}: la prossima avrà qui la sua anteprima.</p>
      ) : (
        <ul className="divide-separator divide-y">
          {data.previews.map((preview) => (
            <li key={preview.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={preview.url} target="_blank" rel="noreferrer" className="text-foreground text-sm font-medium hover:underline">
                    #{preview.prNumber} {preview.title}
                  </a>
                  {preview.project ? <StatusBadge status={preview.project.status} /> : <Badge tone="warning">Da approvare</Badge>}
                  {preview.fork && (
                    <Badge tone="warning" icon="solar:shield-warning-linear">
                      Da un fork
                    </Badge>
                  )}
                </div>
                <p className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span>{preview.author}</span>
                  <span aria-hidden>·</span>
                  <Code>{preview.headSha.slice(0, 7)}</Code>
                  <span className="font-mono">{preview.headRef}</span>
                  <span aria-hidden>·</span>
                  <span title={formatWhen(preview.lastActivityAt)}>{formatRelative(preview.lastActivityAt)}</span>
                  {preview.project?.url && (
                    <>
                      <span aria-hidden>·</span>
                      <a href={preview.project.url} target="_blank" rel="noreferrer" className="text-accent font-mono hover:underline">
                        {preview.project.url.replace(/^https?:\/\//, "")}
                      </a>
                    </>
                  )}
                </p>
                {preview.needsApproval && preview.project && (
                  <p className="text-warning text-meta">Nuovo commit da approvare: l&apos;anteprima mostra ancora quello approvato prima.</p>
                )}
                {preview.state === "stopped" && preview.stoppedReason && <p className="text-muted text-meta">{STOPPED_TEXT[preview.stoppedReason]}</p>}
                {preview.addressProblem && <p className="text-muted text-meta">Senza indirizzo: {preview.addressProblem}</p>}
                {preview.statusProblem && <p className="text-muted text-meta">{preview.statusProblem}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {preview.needsApproval && canManage ? (
                  <Button size="sm" variant="secondary" onPress={() => setPending({ kind: "approve", preview })}>
                    <Icon icon="solar:shield-check-linear" width={16} aria-hidden />
                    Approva
                  </Button>
                ) : preview.project?.url ? (
                  <a
                    href={preview.project.url}
                    target="_blank"
                    rel="noreferrer"
                    className="border-border bg-surface hover:bg-surface-hover text-foreground inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors"
                  >
                    <Icon icon="solar:global-linear" width={16} aria-hidden />
                    Apri
                  </a>
                ) : null}
                {canOperate && (
                  <PreviewMenu
                    label={`Altre azioni sull'anteprima della PR #${preview.prNumber}`}
                    actions={[
                      {
                        id: "redeploy",
                        label: "Ridistribuisci",
                        icon: "solar:refresh-linear",
                        disabled: preview.needsApproval,
                        onAction: () => void act(preview, { action: "redeploy" }, `Anteprima della PR #${preview.prNumber} ridistribuita`),
                      },
                      {
                        id: "stop",
                        label: "Ferma",
                        icon: "solar:stop-linear",
                        disabled: !preview.project || preview.state === "stopped",
                        onAction: () => void act(preview, { action: "stop" }, `Anteprima della PR #${preview.prNumber} fermata`),
                      },
                      {
                        id: "page",
                        label: "Pagina dell'anteprima",
                        icon: "solar:widget-2-linear",
                        disabled: !preview.project,
                        onAction: () => preview.project && router.push(href(`/projects/${preview.project.id}`)),
                      },
                      {
                        id: "delete",
                        label: "Elimina…",
                        icon: "solar:trash-bin-minimalistic-linear",
                        danger: true,
                        disabled: !canManage,
                        onAction: () => setPending({ kind: "delete", preview }),
                      },
                    ]}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted text-meta">
        Impostazioni in{" "}
        <Link href={href(`/projects/${project.id}?tab=settings&section=previews`)} className="text-accent hover:underline">
          Impostazioni › Anteprime
        </Link>
        .
      </p>

      <ConfirmDialog
        isOpen={pending?.kind === "approve"}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Approvare il commit ${pending?.preview.headSha.slice(0, 7) ?? ""}?`}
        description={
          pending ? (
            <>
              La PR #{pending.preview.prNumber} viene da un fork: il suo codice girerà su questo server con le
              variabili delle anteprime. Approvi solo il commit {pending.preview.headSha.slice(0, 7)} di {pending.preview.author}: un nuovo
              push andrà approvato di nuovo.
            </>
          ) : undefined
        }
        confirmLabel="Approva e distribuisci"
        onConfirm={async () => {
          if (!pending) return;
          await act(pending.preview, { action: "approve", commitSha: pending.preview.headSha }, `Commit approvato: anteprima della PR #${pending.preview.prNumber} in preparazione`);
          setPending(null);
        }}
      />
      <ConfirmDialog
        isOpen={pending?.kind === "delete"}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Eliminare l'anteprima della PR #${pending?.preview.prNumber ?? ""}?`}
        description="Container, file, indirizzo e database dell'anteprima vengono eliminati. Il prossimo push sulla pull request la ricrea."
        confirmLabel="Elimina"
        destructive
        onConfirm={async () => {
          if (!pending) return;
          await remove(pending.preview);
          setPending(null);
        }}
      />
    </Panel>
  );
}
