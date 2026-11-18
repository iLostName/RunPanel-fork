"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldHint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { SessionList } from "@/components/ui/SessionList";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import { formatWhen } from "@/lib/format";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";

/**
 * How another account signs in, for whoever may change it: whether the second
 * step is on, a way to turn it off for someone who lost the phone and the
 * recovery codes, and the devices signed in.
 *
 * Only rendered for an account the viewer may edit; the routes check again.
 */
export function UserSecurity({ userId, email }: { userId: string; email: string | null }) {
  const status = useResource<{ enabled: boolean; enabledAt: string | null }>(`/api/users/${userId}/two-factor`);
  const { isSolo } = useNode();
  const [confirm, setConfirm] = useState(false);

  async function reset(): Promise<boolean> {
    try {
      const res = await fetch(`/api/users/${userId}/two-factor`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Operazione non riuscita");
        return false;
      }
      toast.success("Verifica in due passaggi disattivata per questo account");
      await status.refresh();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <>
      <Panel className="space-y-3">
        <PanelHeader
          title="Verifica in due passaggi"
          description={
            status.data?.enabled && status.data.enabledAt
              ? `Attiva dal ${formatWhen(status.data.enabledAt)}`
              : "Il codice dal telefono, oltre alla password"
          }
          actions={
            status.data ? (
              status.data.enabled ? (
                <Badge tone="success" icon="solar:shield-check-linear">
                  Attiva
                </Badge>
              ) : (
                <Badge>Non attiva</Badge>
              )
            ) : undefined
          }
        />
        {status.error && !status.data ? (
          <LoadError what="la verifica in due passaggi" error={status.error} onRetry={() => void status.refresh()} />
        ) : !status.data ? (
          <SkeletonBlock className="h-10" />
        ) : status.data.enabled ? (
          <div className="space-y-2">
            <Button variant="secondary" size="sm" onPress={() => setConfirm(true)}>
              Disattiva per questo account
            </Button>
            <FieldHint>
              Solo se ha perso il telefono e i codici di recupero. Poi potrà entrare con la sola password, e riattivarla.
            </FieldHint>
          </div>
        ) : (
          <FieldHint>La attiva chi usa l&apos;account, dalla sua pagina Account.</FieldHint>
        )}
        {/* The accounts are the cluster's, the second step is each panel's own. */}
        {!isSolo && <FieldHint>Vale per questo server: sugli altri pannelli del cluster ha uno stato a parte.</FieldHint>}
      </Panel>

      <Section title="Dispositivi" summary="Dove questo account è entrato">
        <SessionList userId={userId} />
      </Section>

      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Disattivare la verifica in due passaggi?"
        description={`${email ?? "Questo account"} potrà entrare con la sola password. I codici di recupero e i dispositivi ricordati vengono cancellati; l'operazione resta nel registro attività.`}
        confirmLabel="Disattiva"
        destructive
        onConfirm={reset}
      />
    </>
  );
}
