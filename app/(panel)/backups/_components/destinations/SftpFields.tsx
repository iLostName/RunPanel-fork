"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { CopyField } from "@/components/ui/CopyField";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Advanced, Technical } from "@/components/ui/Technical";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { MSG } from "@/lib/copy";
import { DEFAULT_REMOTE_FOLDER, remoteFolderProblem, sshHostProblem, sshUserProblem } from "@/lib/backup-remote";
import { useDestinationTools, useReport } from "./hooks";
import type { KindFieldsProps } from "./types";

type PresetId = "synology" | "qnap" | "hetzner" | "linux";

/** What changes from one kind of server to another: the port, a sensible folder, the steps to add the key. */
const PRESETS: Record<PresetId, { label: string; port: number; folder: string; host: string; user: string }> = {
  synology: { label: "NAS Synology", port: 22, folder: "/backup/runpanel", host: "192.168.1.20", user: "backup" },
  qnap: { label: "NAS QNAP", port: 22, folder: "/backup/runpanel", host: "192.168.1.30", user: "backup" },
  hetzner: { label: "Hetzner Storage Box", port: 23, folder: DEFAULT_REMOTE_FOLDER, host: "u123456.your-storagebox.de", user: "u123456" },
  linux: { label: "Un altro server (Linux, VPS)", port: 22, folder: DEFAULT_REMOTE_FOLDER, host: "backup.esempio.it", user: "backup" },
};

interface NewKey {
  publicKey: string;
  fingerprint: string;
  keyToken: string;
}

const text = (stored: Record<string, unknown> | null, key: string) => (typeof stored?.[key] === "string" ? (stored[key] as string) : "");

/**
 * An SFTP server or a NAS: where it is, who the panel logs in as, which
 * folder — and the key.
 *
 * The panel makes a key pair for this destination as soon as the type is
 * picked, and shows the public half: the line goes into the server's
 * `authorized_keys` before "Verifica" can pass, with the steps for the kind
 * of server chosen. Accounts without a shell (storage boxes, most NAS) work:
 * the panel only ever speaks SFTP.
 *
 * Editing never shows the private key. A new key can be generated (the old
 * one stops working once the new one is saved), and the pinned host key can
 * be forgotten, so the next check learns it again — after reinstalling the
 * server, say.
 */
export function SftpFields({ stored, api, archives, onChange }: KindFieldsProps) {
  const tools = useDestinationTools(api);
  const storedHost = text(stored, "host");
  const storedPort = typeof stored?.port === "number" ? stored.port : 22;
  const [preset, setPreset] = useState<PresetId>(storedHost.endsWith(".your-storagebox.de") ? "hetzner" : stored ? "linux" : "synology");
  const [host, setHost] = useState(storedHost);
  const [port, setPort] = useState(String(storedPort));
  const [username, setUsername] = useState(text(stored, "username"));
  const [folder, setFolder] = useState(stored ? text(stored, "folder") : PRESETS.synology.folder);
  const [key, setKey] = useState<NewKey | null>(null);
  const [keyStatus, setKeyStatus] = useState<"idle" | "loading" | "failed">(stored ? "idle" : "loading");
  const [forget, setForget] = useState(false);

  const generate = useCallback(async () => {
    try {
      const res = await fetch(api("/api/backups/destinations/ssh-key"), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.publicKey !== "string") {
        setKeyStatus("failed");
        return;
      }
      setKey(body as NewKey);
      setKeyStatus("idle");
    } catch {
      setKeyStatus("failed");
    }
  }, [api]);

  // A new destination gets its key right away: the person has to put it on
  // the server before anything else can work.
  const requested = useRef(false);
  useEffect(() => {
    if (stored || requested.current) return;
    requested.current = true;
    void generate();
  }, [stored, generate]);

  function regenerate() {
    setKeyStatus("loading");
    void generate();
  }

  function choosePreset(next: PresetId) {
    setPreset(next);
    // The port and folder follow the kind of server until they are typed.
    if (!stored) {
      setPort(String(PRESETS[next].port));
      setFolder(PRESETS[next].folder);
    }
  }

  const portNumber = Number(port);
  const portError = port.trim() && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) ? "Porta da 1 a 65535" : null;
  const hostError = host.trim() ? sshHostProblem(host) : null;
  const userError = username.trim() ? sshUserProblem(username) : null;
  const folderError = remoteFolderProblem(folder, { allowAbsolute: true });
  const publicKey = key?.publicKey ?? text(stored, "publicKey");
  const fingerprint = key?.fingerprint ?? text(stored, "keyFingerprint");
  const pinned = text(stored, "hostKeyFingerprint");
  const moved = Boolean(stored) && (host.trim() !== storedHost || portNumber !== storedPort);

  useReport(
    {
      config: {
        host: host.trim(),
        port: Number.isInteger(portNumber) ? portNumber : 22,
        username: username.trim(),
        folder: folder.trim(),
        ...(key ? { keyToken: key.keyToken } : {}),
        ...(forget && !moved ? { hostKey: "" } : {}),
      },
      complete:
        Boolean(host.trim() && username.trim() && port.trim()) &&
        !hostError &&
        !userError &&
        !portError &&
        !folderError &&
        Boolean(key || stored?.hasKey),
    },
    onChange
  );

  const p = PRESETS[preset];
  const who = `${username.trim() || p.user}@${host.trim() || p.host}`;

  return (
    <>
      {tools && !tools.ssh.installed && (
        <Hint tone="warn" title="Su questo server manca il programma ssh">
          Il pannello lo usa per parlare SFTP. Installalo dal terminale del server (su Debian e Ubuntu:{" "}
          <Code>sudo apt install openssh-client</Code>), poi verifica la destinazione.
        </Hint>
      )}

      <SelectField
        label="Che server è"
        value={preset}
        onChange={(value) => choosePreset(value as PresetId)}
        options={(Object.keys(PRESETS) as PresetId[]).map((id) => ({ value: id, label: PRESETS[id].label }))}
      />

      <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
        <Field label="Server" error={hostError} hint={preset === "hetzner" ? "Lo trovi nella pagina della Storage Box." : "Il nome o l'indirizzo IP."}>
          <TextField value={host} onChange={setHost} aria-label="Server" isInvalid={Boolean(hostError)}>
            <Input placeholder={p.host} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
        <Field label="Porta" error={portError}>
          <TextField value={port} onChange={setPort} aria-label="Porta" isInvalid={Boolean(portError)}>
            <Input inputMode="numeric" className="font-mono text-sm" />
          </TextField>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Utente" error={userError} hint="Meglio uno dedicato ai backup, senza privilegi.">
          <TextField value={username} onChange={setUsername} aria-label="Utente" isInvalid={Boolean(userError)}>
            <Input placeholder={p.user} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
        <Field
          label="Cartella"
          error={folderError}
          hint={preset === "synology" || preset === "qnap" ? "Comincia con una cartella condivisa che esiste già." : "Relativa alla cartella dell'utente; creata se manca."}
        >
          <TextField value={folder} onChange={setFolder} aria-label="Cartella" isInvalid={Boolean(folderError)}>
            <Input placeholder={p.folder} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground text-sm">Chiave del pannello</span>
          {stored && (
            <Button size="sm" variant="ghost" onPress={regenerate} isPending={keyStatus === "loading"}>
              <Icon icon="solar:key-linear" width={15} aria-hidden />
              Genera una nuova chiave
            </Button>
          )}
        </div>

        {keyStatus === "loading" && !publicKey ? (
          <SkeletonBlock className="h-10" />
        ) : keyStatus === "failed" && !publicKey ? (
          <Hint tone="warn" title="Non è stato possibile generare la chiave">
            <p>{MSG.unreachable}, o il server ha rifiutato la richiesta.</p>
            <Button size="sm" variant="secondary" className="mt-2" onPress={regenerate}>
              Riprova
            </Button>
          </Hint>
        ) : publicKey ? (
          <>
            <CopyField label="Riga da aggiungere ad authorized_keys" value={publicKey} />
            <Technical>
              <FieldHint className="mt-0 font-mono">{fingerprint}</FieldHint>
            </Technical>
            {key && stored && (
              <Hint tone="warn">
                Al salvataggio la chiave vecchia smette di servire: aggiungi questa sul server prima di verificare, e togli la
                vecchia da authorized_keys quando hai finito.
              </Hint>
            )}
            <SetupSteps preset={preset} publicKey={publicKey} who={who} />
          </>
        ) : null}
      </div>

      {stored && pinned && (
        <div className="space-y-2">
          <span className="text-foreground text-sm">Impronta del server</span>
          <p className="text-muted font-mono text-meta break-all">{pinned}</p>
          {moved ? (
            <FieldHint className="mt-0">Cambiando server o porta l&apos;impronta salvata viene dimenticata: quella nuova te la mostra la verifica.</FieldHint>
          ) : (
            <CheckboxField
              isSelected={forget}
              onChange={setForget}
              label="Dimentica l'impronta e accetta quella che il server mostra alla prossima verifica"
              description="Solo se hai reinstallato o sostituito il server: un'impronta che cambia da sola può voler dire che qualcuno si è messo in mezzo."
            />
          )}
        </div>
      )}

      {moved && archives > 0 && (
        <Hint tone="warn" title={`Qui ci sono già ${archives} archivi`}>
          Il pannello li cercherà sul nuovo server. Se non li sposti anche tu, non potrai più ripristinarli da qui.
        </Hint>
      )}

      <Hint tone="info">
        L&apos;impronta della chiave del server viene salvata alla prima verifica riuscita: da lì in poi un server che si
        presenta con un&apos;altra viene rifiutato. Il pannello carica ogni archivio con un nome provvisorio e lo rinomina
        solo quando è completo.
      </Hint>
    </>
  );
}

/** How to put the key on the kind of server chosen, in its own words. */
function SetupSteps({ preset, publicKey, who }: { preset: PresetId; publicKey: string; who: string }) {
  if (preset === "linux") {
    return (
      <div className="space-y-2">
        <FieldHint className="mt-0">Sul server di destinazione, come l&apos;utente che riceverà i backup:</FieldHint>
        <CommandBlock
          commands={[
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
            `echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
          ]}
        />
        <Advanced summary="limitare la chiave al solo SFTP">
          <FieldHint className="mt-0">
            Su un server con OpenSSH la riga può impedire alla chiave tutto tranne SFTP: niente shell, niente inoltri.
          </FieldHint>
          <CopyField value={`restrict,command="internal-sftp" ${publicKey}`} />
        </Advanced>
      </div>
    );
  }
  if (preset === "hetzner") {
    return (
      <div className="space-y-2">
        <ol className="text-muted list-decimal space-y-1 pl-5 text-meta leading-relaxed">
          <li>Nella Hetzner Console, nella pagina della Storage Box, attiva il supporto SSH.</li>
          <li>Dal tuo computer salva la riga in un file e caricala con ssh-copy-id: chiede la password della Storage Box una volta.</li>
        </ol>
        <CommandBlock commands={[`echo '${publicKey}' > runpanel.pub`, `ssh-copy-id -p 23 -s -f -i runpanel.pub ${who}`]} />
      </div>
    );
  }
  return (
    <ol className="text-muted list-decimal space-y-1 pl-5 text-meta leading-relaxed">
      {preset === "synology" ? (
        <>
          <li>Pannello di controllo › Servizi file › FTP: attiva il servizio SFTP.</li>
          <li>Pannello di controllo › Utente e gruppo › Avanzate: attiva il servizio home utente.</li>
          <li>Dai all&apos;utente lettura e scrittura sulla cartella condivisa dei backup.</li>
        </>
      ) : (
        <>
          <li>Pannello di controllo › Servizi di rete e file › Telnet/SSH: attiva «Consenti connessione SFTP».</li>
          <li>Dai all&apos;utente lettura e scrittura sulla cartella condivisa dei backup.</li>
        </>
      )}
      <li>
        Aggiungi la riga qui sopra al file <Code>.ssh/authorized_keys</Code> nella cartella home dell&apos;utente, con
        permessi 700 sulla cartella <Code>.ssh</Code> e 600 sul file.
      </li>
    </ol>
  );
}
