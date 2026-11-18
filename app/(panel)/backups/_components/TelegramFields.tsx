"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import type { EncryptionStatus } from "@/components/backups/types";
import { BackupPasswordDialog } from "./EncryptionPanel";
import { TelegramLink, accountName, type LinkedTelegram } from "./TelegramLink";

/** What `GET /api/backups/destinations/:id` says about a Telegram destination: never the session. */
export interface TelegramDetail {
  apiId: number | null;
  hasApiHash: boolean;
  linked: boolean;
  chat: "channel" | "saved";
  channelTitle: string | null;
  account: { name: string; username: string | null } | null;
}

export interface TelegramChoice {
  linked: LinkedTelegram | null;
  chat: "channel" | "saved";
  channelTitle: string;
}

/**
 * The Telegram part of the destination form: the account, where the archives
 * go, and the two things worth knowing before saving — that the session opens
 * the whole account, and that Telegram's cloud chats are not end-to-end
 * encrypted, so with the backup password off this is the place to turn it on.
 *
 * Editing keeps the chat: the archives already stored are in it. What can
 * change is the account, by linking it again — the usual reason being a
 * session closed from the app.
 */
export function TelegramFields({
  api,
  memberId,
  editing,
  value,
  onChange,
}: {
  api: (path: string) => string;
  memberId: string | null;
  /** The destination being edited, with what the server says about it. */
  editing?: { destinationId: string; detail: TelegramDetail | null };
  value: TelegramChoice;
  onChange: (next: TelegramChoice) => void;
}) {
  const me = useMe();
  const encryption = useResource<EncryptionStatus>(api("/api/backups/encryption"));
  const [settingPassword, setSettingPassword] = useState(false);
  const stored = editing?.detail ?? null;
  const [relinking, setRelinking] = useState(Boolean(editing) && !stored?.linked);

  const link = (linked: LinkedTelegram | null) =>
    onChange({
      ...value,
      linked,
      channelTitle: value.channelTitle || linked?.suggestedChannelTitle || "",
    });

  const where =
    stored?.chat === "channel" ? `nel canale «${stored.channelTitle ?? "senza nome"}»` : "nei Messaggi salvati";

  return (
    <>
      {editing ? (
        relinking ? (
          <div className="space-y-3">
            <TelegramLink
              api={api}
              relink={{ destinationId: editing.destinationId, apiId: stored?.apiId ?? null }}
              onLinked={link}
            />
            <FieldHint>
              Gli archivi restano {where}: se colleghi un altro account, deve poterlo vedere, altrimenti il pannello non accetta
              il cambio.
            </FieldHint>
          </div>
        ) : (
          <div className="border-border flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-3 py-2.5">
            <Icon icon="solar:plain-linear" width={20} className="text-muted shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">
                {stored?.account ? `Collegata a ${accountName(stored.account)}` : "Account collegato"}
              </p>
              <p className="text-muted text-xs">Gli archivi vanno {where}.</p>
            </div>
            <Button size="sm" variant="secondary" onPress={() => setRelinking(true)}>
              <Icon icon="solar:refresh-linear" width={15} aria-hidden />
              Ricollega l&apos;account
            </Button>
          </div>
        )
      ) : (
        <TelegramLink api={api} onLinked={link} />
      )}

      {!editing && value.linked && (
        <div className="space-y-3">
          <ChoiceGroup label="Dove salvare gli archivi" className="sm:grid-cols-2">
            <ChoiceCard
              selected={value.chat === "channel"}
              onSelect={() => onChange({ ...value, chat: "channel" })}
              icon="solar:hashtag-chat-linear"
              title="Un canale privato (consigliato)"
              description="Il pannello lo crea per questo server e lo vedi solo tu: gli archivi restano separati dalle tue chat."
            />
            <ChoiceCard
              selected={value.chat === "saved"}
              onSelect={() => onChange({ ...value, chat: "saved" })}
              icon="solar:bookmark-linear"
              title="Messaggi salvati"
              description="Nessun canale nuovo: gli archivi finiscono tra i tuoi messaggi salvati, insieme al resto."
            />
          </ChoiceGroup>
          {value.chat === "channel" && (
            <div>
              <TextField value={value.channelTitle} onChange={(channelTitle) => onChange({ ...value, channelTitle })}>
                <Label>Nome del canale</Label>
                <Input maxLength={128} />
              </TextField>
              <FieldHint>Viene creato quando salvi. Non eliminare né modificare i messaggi a mano: il pannello li cerca lì.</FieldHint>
            </div>
          )}
        </div>
      )}

      <Hint tone="warn" title="La sessione apre tutto l'account">
        Il pannello la salva cifrata con la sua chiave e la usa solo per i backup, ma chi la ottenesse potrebbe leggere e
        scrivere ogni chat. Se preferisci, usa un account Telegram dedicato ai backup. La chiudi quando vuoi da Telegram ›
        Impostazioni › Dispositivi, dove si chiama «RunPanel su» seguito dal nome di questo server.
      </Hint>

      {encryption.data && !encryption.data.enabled && (
        <Hint tone="warn" title="Le chat di Telegram non sono cifrate end-to-end">
          <p>
            Telegram può leggere quello che carichi in un canale o nei Messaggi salvati. Con la password dei backup gli archivi
            partono già cifrati, e lì restano illeggibili senza.
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
        <FieldHint>Gli archivi partono cifrati con la password dei backup: su Telegram restano illeggibili senza.</FieldHint>
      )}

      <BackupPasswordDialog
        memberId={memberId}
        replacing={false}
        isOpen={settingPassword}
        onOpenChange={setSettingPassword}
        onSaved={() => void encryption.refresh()}
      />
    </>
  );
}
