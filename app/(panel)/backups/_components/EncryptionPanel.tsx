"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { MIN_BACKUP_PASSWORD, backupPasswordProblem } from "@/lib/backup-password";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { RowMenu } from "@/components/ui/ListRow";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { useMemberApi, useNode } from "@/lib/hooks/useNode";
import { formatWhen } from "@/lib/format";
import type { EncryptionStatus } from "@/components/backups/types";

/**
 * The backup password of a server: on or off, since when, and the actions on
 * it — set, change, check, turn off.
 *
 * One password per server, for every archive it writes (see
 * services/backup/keyring.ts for why not one per schedule). Setting it is the
 * moment to say the one thing that matters: the panel keeps it and opens its
 * own archives, but on the day the server is gone, the archive without the
 * password is nothing. So the dialog asks for it twice and for a tick that it
 * was saved somewhere else; there is no way to read it back afterwards, only
 * to check that a copy is right.
 */

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

/** Set the password, or replace it. */
export function BackupPasswordDialog({
  memberId,
  replacing,
  isOpen,
  onOpenChange,
  onSaved,
}: {
  memberId?: string | null;
  /** A password is already in use: say what happens to the archives it sealed. */
  replacing: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (status: EncryptionStatus) => void;
}) {
  const memberApi = useMemberApi();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [kept, setKept] = useState(false);

  // A fresh dialog starts empty: a password typed and abandoned is not one to
  // offer again. Adjusted during render, not in an effect.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setPassword("");
      setAgain("");
      setKept(false);
    }
  }

  const problem = password ? backupPasswordProblem(password) : null;
  const mismatch = again.length > 0 && again !== password;
  const ready = password.length > 0 && !problem && again === password && kept;

  async function submit() {
    const res = await fetch(memberApi(memberId, "/api/backups/encryption"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      toast.error(await readError(res, MSG.saveFailed));
      return false;
    }
    const status = (await res.json()) as EncryptionStatus;
    toast.success(replacing ? "Password dei backup cambiata: vale dal prossimo archivio" : "Cifratura attiva: il prossimo archivio sarà cifrato");
    onSaved(status);
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={replacing ? "Cambiare la password dei backup?" : "Cifrare i backup con una password"}
      submitLabel={replacing ? "Cambia password" : "Attiva la cifratura"}
      isSubmitDisabled={!ready}
      onSubmit={submit}
    >
      <p className="text-muted text-sm">
        Da adesso ogni nuovo archivio di questo server è cifrato con questa password: le pianificazioni, i backup avviati a
        mano e le copie di sicurezza prima di un ripristino.
      </p>

      <div>
        <TextField type="password" value={password} onChange={setPassword} isInvalid={Boolean(problem)} autoFocus>
          <Label>Password dei backup</Label>
          <Input autoComplete="new-password" spellCheck={false} />
        </TextField>
        <FieldHint>
          {problem ??
            `Almeno ${MIN_BACKUP_PASSWORD} caratteri. Una frase di qualche parola si ricorda meglio ed è più difficile da indovinare.`}
        </FieldHint>
      </div>
      <div>
        <TextField type="password" value={again} onChange={setAgain} isInvalid={mismatch}>
          <Label>Ripetila</Label>
          <Input autoComplete="new-password" spellCheck={false} />
        </TextField>
        {mismatch && <FieldHint className="text-danger">Le due password non coincidono</FieldHint>}
      </div>

      <Hint tone="warn" title="Senza la password, un archivio cifrato non si apre">
        Il pannello la conserva e apre da solo i suoi archivi. Ma se questo server si rompe, per ripristinare altrove servono
        l&apos;archivio e la password: nessuno, nemmeno RunPanel, può recuperarla. Tienila in un gestore di password, non su
        questo server.
      </Hint>
      {replacing && (
        <Hint tone="info">
          Gli archivi già creati restano cifrati con la password di prima. Qui il pannello continua ad aprirli; su un altro
          server servirà quella di prima, quindi conservala finché quegli archivi esistono.
        </Hint>
      )}

      <CheckboxField
        isSelected={kept}
        onChange={setKept}
        label="Ho salvato la password in un posto sicuro, fuori da questo server"
      />
    </FormDialog>
  );
}

/** "Is this the right one?", answered without ever showing it. */
function CheckPasswordDialog({
  memberId,
  isOpen,
  onOpenChange,
}: {
  memberId?: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const memberApi = useMemberApi();
  const [password, setPassword] = useState("");
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setPassword("");
  }

  async function submit() {
    const res = await fetch(memberApi(memberId, "/api/backups/encryption/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      toast.error(await readError(res, "Verifica non riuscita"));
      return false;
    }
    const { matches } = (await res.json()) as { matches: boolean };
    if (!matches) {
      toast.error("Non è questa: controlla maiuscole, spazi e accenti. Se non la ritrovi, impostane una nuova finché il server c'è.");
      return false;
    }
    toast.success("È la password giusta: con questa si aprono i nuovi archivi anche su un altro server");
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Verifica la password dei backup"
      submitLabel="Verifica"
      isSubmitDisabled={!password}
      onSubmit={submit}
    >
      <p className="text-muted text-sm">
        Scrivi la password che hai salvato: il pannello ti dice solo se è quella in uso, non la mostra mai.
      </p>
      <TextField type="password" value={password} onChange={setPassword} autoFocus>
        <Label>Password dei backup</Label>
        <Input autoComplete="off" spellCheck={false} />
      </TextField>
    </FormDialog>
  );
}

/** The panel on the Backup page. Acts on `memberId`'s server, this one by default. */
export function EncryptionPanel({ memberId }: { memberId?: string | null }) {
  const memberApi = useMemberApi();
  const me = useMe();
  const { isSolo, nameOf } = useNode();
  const { data, loading, error, refresh } = useResource<EncryptionStatus>(memberApi(memberId, "/api/backups/encryption"));
  const [dialog, setDialog] = useState<"set" | "check" | "disable" | null>(null);

  const where = isSolo || !memberId ? "" : ` su ${nameOf(memberId)}`;
  const close = (open: boolean) => !open && setDialog(null);

  async function disable() {
    const res = await fetch(memberApi(memberId, "/api/backups/encryption"), { method: "DELETE" });
    if (!res.ok) {
      toast.error(await readError(res, MSG.saveFailed));
      return false;
    }
    toast.success("Cifratura disattivata: i prossimi archivi saranno in chiaro");
    void refresh();
  }

  if (loading && !data) return <SkeletonBlock className="h-28" />;

  const on = Boolean(data?.enabled);
  const actions = me.isOwner && data && (
    <>
      {/* Secondary: the page's one primary is "Nuova pianificazione". */}
      <Button size="sm" variant="secondary" onPress={() => setDialog("set")}>
        <Icon icon={on ? "solar:key-linear" : "solar:lock-password-linear"} width={15} aria-hidden />
        {on ? "Cambia password" : "Imposta una password"}
      </Button>
      {on && (
        <RowMenu
          label="Altre azioni sulla cifratura"
          actions={[
            { id: "check", label: "Verifica la password…", icon: "solar:shield-check-linear", onAction: () => setDialog("check") },
            { id: "disable", label: "Disattiva…", icon: "solar:lock-unlocked-linear", danger: true, onAction: () => setDialog("disable") },
          ]}
        />
      )}
    </>
  );

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            Cifratura degli archivi
            {data && (on ? <Badge tone="success" icon="solar:lock-password-linear">attiva</Badge> : <Badge>non attiva</Badge>)}
          </span>
        }
        description={
          error && !data
            ? `Non riesco a leggere lo stato della cifratura: ${error}`
            : on
              ? `Ogni nuovo archivio${where} è cifrato con la password dei backup, impostata il ${formatWhen(data?.since)}. Il pannello la conserva e apre da solo i suoi archivi; su un altro server serve la password.`
              : `Gli archivi${where} non sono cifrati: chi ne ha una copia, in un bucket o su un disco portato via, legge database, volumi e codice. Con una password servono l'archivio e la password insieme.`
        }
        actions={actions}
      />

      {data?.unreadable && (
        <Hint tone="warn" className="mt-4" title="La password dei backup non si legge più">
          La chiave del pannello è cambiata e la password salvata non si decifra. I backup non partono finché non la imposti
          di nuovo: meglio nessun archivio che uno in chiaro fuori da qui.
        </Hint>
      )}
      {on && !data?.unreadable && (
        <p className="text-muted mt-3 text-xs">
          Se la perdi, gli archivi fuori da questo server non si possono più ripristinare.{" "}
          {data && data.previous > 0
            ? `Il pannello conserva anche ${data.previous === 1 ? "la password precedente" : `le ${data.previous} precedenti`}, per gli archivi già cifrati.`
            : ""}
          {!me.isOwner ? " La password la imposta il proprietario del pannello." : ""}
        </p>
      )}
      {!on && !me.isOwner && data && (
        <p className="text-muted mt-3 text-xs">La cifratura la attiva il proprietario del pannello.</p>
      )}

      <BackupPasswordDialog
        memberId={memberId}
        replacing={on}
        isOpen={dialog === "set"}
        onOpenChange={close}
        onSaved={() => void refresh()}
      />
      <CheckPasswordDialog memberId={memberId} isOpen={dialog === "check"} onOpenChange={close} />
      <ConfirmDialog
        isOpen={dialog === "disable"}
        onOpenChange={close}
        destructive
        title="Disattivare la cifratura?"
        description="I prossimi archivi saranno in chiaro: chi ne ha una copia potrà leggerli. Quelli già cifrati restano cifrati, e il pannello continua ad aprirli con la loro password."
        confirmLabel="Disattiva"
        onConfirm={disable}
      />
    </Panel>
  );
}
