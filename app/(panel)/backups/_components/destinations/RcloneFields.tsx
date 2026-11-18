"use client";

import { useMemo, useState } from "react";
import { Input, TextArea, TextField } from "@heroui/react";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { Badge } from "@/components/ui/Badge";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Advanced, Technical } from "@/components/ui/Technical";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { DEFAULT_REMOTE_FOLDER, remoteFolderProblem } from "@/lib/backup-remote";
import { RCLONE_PROVIDER_LABEL, parseRcloneSections, parseRcloneToken, type RcloneProvider } from "@/lib/rclone-config";
import { useDestinationTools, useReport } from "./hooks";
import type { KindFieldsProps } from "./types";

const GUIDED: Exclude<RcloneProvider, "expert">[] = ["drive", "onedrive", "dropbox"];

const text = (stored: Record<string, unknown> | null, key: string) => (typeof stored?.[key] === "string" ? (stored[key] as string) : "");

/**
 * Google Drive, OneDrive, Dropbox — and, for an expert, any remote rclone
 * supports — through the `rclone` program on this server.
 *
 * The services ask for a browser to authorize, which a server does not have:
 * the person runs `rclone authorize` on their own computer and pastes what it
 * prints. An expert pastes a section of their `rclone.conf` instead; that is
 * the owner's alone, because some of rclone's options act on this server's
 * files and programs.
 *
 * When rclone is missing, the form says how to install it and stops there:
 * the panel never runs sudo.
 */
export function RcloneFields({ stored, api, isOwner, onChange }: KindFieldsProps) {
  const tools = useDestinationTools(api);
  const storedProvider = (text(stored, "provider") || "drive") as RcloneProvider;
  const [provider, setProvider] = useState<RcloneProvider>(storedProvider);
  const [token, setToken] = useState("");
  const [sections, setSections] = useState("");
  const [remote, setRemote] = useState(text(stored, "remote"));
  const [folder, setFolder] = useState(stored ? text(stored, "folder") : DEFAULT_REMOTE_FOLDER);

  const sameProvider = Boolean(stored) && provider === storedProvider;
  const tokenResult = useMemo(() => (token.trim() ? parseRcloneToken(token) : null), [token]);
  const sectionsResult = useMemo(() => (sections.trim() ? parseRcloneSections(sections) : null), [sections]);
  const pastedRemotes = sectionsResult && "sections" in sectionsResult ? sectionsResult.sections : [];
  const storedRemotes = Array.isArray(stored?.remotes) ? (stored.remotes as { name: string; type: string }[]) : [];
  const remotes = pastedRemotes.length > 0 ? pastedRemotes.map((s) => ({ name: s.name, type: s.options.type })) : sameProvider ? storedRemotes : [];
  const chosenRemote = remotes.some((r) => r.name === remote) ? remote : (remotes[remotes.length - 1]?.name ?? "");
  const folderError = remoteFolderProblem(folder, { allowAbsolute: true });

  const credentialsReady =
    provider === "expert"
      ? (sectionsResult !== null && "sections" in sectionsResult) || (sameProvider && stored?.hasSections === true && !sections.trim())
      : (tokenResult !== null && "token" in tokenResult) || (sameProvider && stored?.hasToken === true && !token.trim());

  useReport(
    {
      config: {
        provider,
        folder: folder.trim(),
        ...(provider === "expert"
          ? { ...(sections.trim() ? { sections } : {}), ...(chosenRemote ? { remote: chosenRemote } : {}) }
          : token.trim()
            ? { token }
            : {}),
      },
      complete: credentialsReady && !folderError,
    },
    onChange
  );

  const authorize = `rclone authorize "${provider === "expert" ? "drive" : provider}"`;

  return (
    <>
      {!tools ? (
        <SkeletonBlock className="h-10" />
      ) : !tools.rclone.installed ? (
        <Hint tone="warn" title="rclone non è installato su questo server">
          <p>
            Serve il programma rclone, sul server dove gira il pannello. Installalo dal suo terminale con lo script
            ufficiale (chiede la password di amministratore: il pannello non installa niente da solo):
          </p>
          <CommandBlock className="mt-2" commands={["sudo -v ; curl https://rclone.org/install.sh | sudo bash"]} />
          <p className="mt-2">Oppure scarica il programma da rclone.org/downloads e mettilo in /usr/local/bin. Poi riapri questo modulo.</p>
        </Hint>
      ) : !tools.rclone.supported ? (
        <Hint tone="warn" title={`rclone ${tools.rclone.version ?? ""} è troppo vecchio`}>
          Serve almeno la versione {tools.rclone.minVersion}; quella delle distribuzioni spesso è più vecchia. Aggiornalo dal
          terminale del server con <Code>sudo -v ; curl https://rclone.org/install.sh | sudo bash</Code>.
        </Hint>
      ) : (
        <FieldHint className="mt-0">
          rclone {tools.rclone.version} è installato su questo server
          <Technical>{` (${tools.rclone.path})`}</Technical>.
        </FieldHint>
      )}

      <ChoiceGroup label="Servizio">
        <div className="grid gap-2 sm:grid-cols-2">
          {GUIDED.map((id) => (
            <ChoiceCard key={id} selected={provider === id} onSelect={() => setProvider(id)} title={RCLONE_PROVIDER_LABEL[id]} compact />
          ))}
          <ChoiceCard
            selected={provider === "expert"}
            onSelect={() => setProvider("expert")}
            title="Altro servizio (esperto)"
            isDisabled={!isOwner}
            compact
          />
        </div>
      </ChoiceGroup>
      {!isOwner && (
        <FieldHint className="-mt-2">Solo il proprietario può incollare una configurazione di rclone per gli altri servizi.</FieldHint>
      )}

      {provider !== "expert" ? (
        <>
          <ol className="text-muted list-decimal space-y-1 pl-5 text-meta leading-relaxed">
            <li>Sul tuo computer, non su questo server, installa rclone (rclone.org/downloads).</li>
            <li>Nel terminale del tuo computer lancia il comando qui sotto: si apre il browser, accedi e consenti.</li>
            <li>Il terminale stampa un testo tra ---&gt; e &lt;---End paste: copialo e incollalo qui.</li>
          </ol>
          <CommandBlock commands={[authorize]} />
          <Field
            label="Token"
            error={tokenResult && "error" in tokenResult ? tokenResult.error : undefined}
            hint={sameProvider && stored?.hasToken ? "Ce n'è uno salvato: incollane uno nuovo solo per sostituirlo." : undefined}
          >
            <TextField value={token} onChange={setToken} aria-label="Token di rclone authorize">
              <TextArea
                rows={4}
                placeholder={'Paste the following into your remote machine --->\n{"access_token":"…","refresh_token":"…"}\n<---End paste'}
                className="font-mono text-xs"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </TextField>
          </Field>
          {tokenResult && "token" in tokenResult && (
            <Badge tone="success" icon="solar:check-circle-linear">
              Token riconosciuto
            </Badge>
          )}
          {provider === "onedrive" && (
            <Hint tone="tip">
              Il pannello chiede a Microsoft quale unità OneDrive usare con il token appena creato: incollalo entro un&apos;ora.
            </Hint>
          )}
          {provider === "drive" && (
            <Advanced summary="limiti di Google Drive">
              <FieldHint className="mt-0">
                rclone usa un client ID condiviso da tutti i suoi utenti, che Google limita. Con archivi grandi o frequenti
                conviene crearne uno tuo nella Google Cloud Console e usare «Altro servizio (esperto)» con client_id e
                client_secret.
              </FieldHint>
            </Advanced>
          )}
        </>
      ) : (
        <>
          <Field
            label="Configurazione del remote"
            error={sectionsResult && "error" in sectionsResult ? sectionsResult.error : undefined}
            hint={
              sameProvider && stored?.hasSections
                ? "Ce n'è una salvata: incollane una nuova solo per sostituirla."
                : "Una o più sezioni di rclone.conf, come le stampa «rclone config show» sul computer dove le hai create."
            }
          >
            <TextField value={sections} onChange={setSections} aria-label="Sezioni di rclone.conf">
              <TextArea
                rows={6}
                placeholder={"[nas]\ntype = sftp\nhost = nas.esempio.it\nuser = backup\nkey_file = …"}
                className="font-mono text-xs"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </TextField>
          </Field>
          {remotes.length > 1 && (
            <SelectField
              label="Remote dove salvare"
              value={chosenRemote}
              onChange={setRemote}
              options={remotes.map((r) => ({ value: r.name, label: `${r.name} (${r.type})` }))}
            />
          )}
          {remotes.length === 1 && (
            <FieldHint className="mt-0">
              Remote <Code>{remotes[0].name}</Code>, di tipo {remotes[0].type}.
            </FieldHint>
          )}
          <FieldHint className="mt-0">
            Le opzioni che fanno eseguire un programma (ssh, …_command) non sono ammesse. Le password vanno lasciate offuscate
            come le scrive rclone.
          </FieldHint>
        </>
      )}

      <Field label="Cartella" error={folderError} hint="Dentro il servizio; creata dal primo backup.">
        <TextField value={folder} onChange={setFolder} aria-label="Cartella" isInvalid={Boolean(folderError)}>
          <Input placeholder={DEFAULT_REMOTE_FOLDER} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
        </TextField>
      </Field>

      <Hint tone="warn" title="Il token viene salvato cifrato">
        Con la chiave di questo pannello, come ogni altro segreto, e non finisce mai in un file di configurazione di rclone.
        Dà accesso all&apos;account: puoi revocarlo in qualsiasi momento dalle impostazioni di sicurezza del servizio.
      </Hint>
    </>
  );
}
