"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { SelectField } from "@/components/ui/SelectField";
import { LinkButton } from "@/components/ui/LinkButton";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { PEER_FOLDER } from "@/lib/backup-peer";
import { useMe } from "@/lib/hooks/useMe";
import { useNode } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import type { EncryptionStatus } from "@/components/backups/types";
import { BackupPasswordDialog } from "../EncryptionPanel";
import { useReport } from "./hooks";
import type { KindFieldsProps } from "./types";

/**
 * Another RunPanel server of the cluster: which one. Nothing else to type —
 * the calls are signed with the cluster's own secret — and nothing to create
 * on the other side: the copies go into a folder of their own in its data
 * directory, and the room they may take is that server's owner's to set.
 *
 * With the backup password off, the archives would sit readable on a disk
 * someone else may administer: the form says so and offers to set one, as it
 * does for Telegram.
 */
export function PeerFields({ stored, api, archives, memberId, onChange }: KindFieldsProps) {
  const { nodes, selected } = useNode();
  const me = useMe();
  const here = memberId ?? selected;
  const others = nodes.filter((node) => node.id !== here);
  const storedId = typeof stored?.memberId === "string" ? stored.memberId : "";
  const storedName = typeof stored?.memberName === "string" ? stored.memberName : null;
  const [choice, setChoice] = useState(storedId || others[0]?.id || "");
  const encryption = useResource<EncryptionStatus>(api("/api/backups/encryption"));
  const [settingPassword, setSettingPassword] = useState(false);

  const chosen = others.find((node) => node.id === choice) ?? null;
  const name = chosen?.name ?? storedName ?? "il server scelto";
  const gone = Boolean(storedId) && choice === storedId && !chosen;
  const movesArchives = Boolean(stored) && archives > 0 && choice !== storedId;

  // A server the cluster no longer has cannot be saved: the server would refuse it.
  useReport({ config: { memberId: choice }, complete: Boolean(chosen) }, onChange);

  if (others.length === 0 && !storedId) {
    return (
      <Hint tone="info" title="Nessun altro server collegato">
        <p>
          Per mandare le copie a un altro server RunPanel, prima collegalo a questo: da quel momento lo trovi qui, e può
          tenere le copie di questo server come questo può tenere le sue.
        </p>
        <LinkButton href="/servers" variant="secondary" className="mt-2">
          <Icon icon="solar:server-path-linear" width={15} aria-hidden />
          Collega un server
        </LinkButton>
      </Hint>
    );
  }

  return (
    <>
      <SelectField
        label="Server"
        value={chosen ? choice : null}
        onChange={setChoice}
        placeholder={gone ? `«${storedName ?? storedId}», non più collegato` : "Scegli un server…"}
        options={others.map((node) => ({
          value: node.id,
          label: node.name,
          description: [node.role === "node" ? "solo nodo" : null, node.status === "unreachable" ? "non raggiungibile ora" : null, node.version]
            .filter(Boolean)
            .join(" · ") || undefined,
        }))}
      />
      <FieldHint className="-mt-2">
        Le copie vanno nei dati di {chosen ? `«${chosen.name}»` : "quel server"}, in <Code>{PEER_FOLDER}</Code>, in una
        cartella riservata a questo server e separata dai suoi backup. Quanto spazio possono prendere lo decide{" "}
        {chosen ? `«${chosen.name}»` : "lui"}, in Backup › Copie per altri server.
      </FieldHint>

      {gone && (
        <Hint tone="warn" title={`«${storedName ?? storedId}» non è più collegato`}>
          Le prossime copie non possono arrivare lì. Scegli un altro server, o elimina questa destinazione; le copie che ha
          già restano su quel server finché il suo proprietario non le elimina.
        </Hint>
      )}

      {movesArchives && (
        <Hint tone="warn" title={`Qui ci sono già ${archives} archivi`}>
          Restano sul server di prima, e il pannello li cercherà su quello nuovo: da qui non potrai più ripristinarli,
          scaricarli o farli scadere. Per scrivere altrove senza perderli di vista, aggiungi una destinazione nuova.
        </Hint>
      )}

      {encryption.data && !encryption.data.enabled && (
        <Hint tone="warn" title={`Chi amministra «${name}» può leggere gli archivi`}>
          <p>
            Senza la password dei backup gli archivi arrivano in chiaro sul disco dell&apos;altro server: dump dei database,
            volumi e codice. Con la password partono già cifrati, e lì restano illeggibili senza.
            {!me.isOwner && " La cifratura la attiva il proprietario del pannello."}
          </p>
          {me.isOwner && (
            <Button size="sm" variant="secondary" className="mt-2" onPress={() => setSettingPassword(true)}>
              <Icon icon="solar:lock-password-linear" width={15} aria-hidden />
              Imposta una password
            </Button>
          )}
        </Hint>
      )}
      {encryption.data?.enabled && (
        <FieldHint>Gli archivi partono cifrati con la password dei backup: sull&apos;altro server restano illeggibili senza.</FieldHint>
      )}

      <Hint tone="tip">
        Due server possono tenere ognuno la copia dell&apos;altro: fai lo stesso dall&apos;altro server verso questo, e
        ognuno avrà la sua copia fuori sede senza un account esterno.
      </Hint>

      <BackupPasswordDialog
        memberId={here}
        replacing={false}
        isOpen={settingPassword}
        onOpenChange={setSettingPassword}
        onSaved={() => void encryption.refresh()}
      />
    </>
  );
}
