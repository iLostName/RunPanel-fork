"use client";

import { useState } from "react";
import { Input, TextField } from "@heroui/react";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { Advanced } from "@/components/ui/Technical";
import { DEFAULT_REMOTE_FOLDER, remoteFolderProblem } from "@/lib/backup-remote";
import { useReport } from "./hooks";
import type { KindFieldsProps } from "./types";

type ServiceId = "nextcloud" | "owncloud" | "synology" | "koofr" | "pcloud-eu" | "pcloud-us" | "other";

/**
 * The WebDAV services people use, with the address each one wants.
 *
 * Nextcloud and ownCloud build it from the server and the user name, which
 * is the part people get wrong (`/remote.php/dav/files/<utente>/`); the rest
 * have one fixed address, or none.
 */
const SERVICES: Record<ServiceId, { label: string; server?: string; fixed?: string; password: string }> = {
  nextcloud: {
    label: "Nextcloud",
    server: "https://cloud.esempio.it",
    password: "Usa una password per app: Impostazioni personali › Sicurezza › Dispositivi e sessioni › Crea nuova password per app.",
  },
  owncloud: {
    label: "ownCloud",
    server: "https://owncloud.esempio.it",
    password: "Usa una password per app, da Impostazioni › Sicurezza.",
  },
  synology: {
    label: "NAS Synology (WebDAV Server)",
    server: "https://192.168.1.20:5006",
    password: "La password dell'utente del NAS. Installa il pacchetto WebDAV Server e usa la porta HTTPS (di solito 5006).",
  },
  koofr: { label: "Koofr", fixed: "https://app.koofr.net/dav/Koofr/", password: "Usa una password per app: Preferenze › Password › Genera una nuova password." },
  "pcloud-eu": { label: "pCloud (Europa)", fixed: "https://ewebdav.pcloud.com/", password: "La password del tuo account pCloud." },
  "pcloud-us": { label: "pCloud (Stati Uniti)", fixed: "https://webdav.pcloud.com/", password: "La password del tuo account pCloud." },
  other: { label: "Altro server WebDAV", password: "Se il servizio le offre, usa una password per app invece di quella dell'account." },
};

const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

function davUrl(service: ServiceId, server: string, username: string): string {
  const base = server.trim().replace(/\/+$/, "");
  if (service === "nextcloud" || service === "owncloud") {
    return base && username.trim() ? `${base}/remote.php/dav/files/${encodeURIComponent(username.trim())}/` : "";
  }
  if (service === "synology") return base ? `${base}/` : "";
  return SERVICES[service].fixed ?? "";
}

/** Which service a stored address belongs to, and the server part of it. */
function detect(url: string): { service: ServiceId; server: string } {
  const files = /^(.*)\/remote\.php\/dav\/files\/[^/]+\/?$/.exec(url);
  if (files) return { service: "nextcloud", server: files[1] };
  const fixed = SERVICE_IDS.find((id) => SERVICES[id].fixed === url);
  return fixed ? { service: fixed, server: "" } : { service: "other", server: "" };
}

const text = (stored: Record<string, unknown> | null, key: string) => (typeof stored?.[key] === "string" ? (stored[key] as string) : "");

/**
 * A WebDAV folder: Nextcloud, ownCloud, a Synology, Koofr, pCloud, any
 * server. The address, the user and an app password; the folder inside.
 *
 * The one limit the panel cannot lift is said up front: a reverse proxy in
 * front of the server may refuse large uploads.
 */
export function WebdavFields({ stored, archives, onChange }: KindFieldsProps) {
  const storedUrl = text(stored, "url");
  const initial = storedUrl ? detect(storedUrl) : { service: "nextcloud" as ServiceId, server: "" };
  const [service, setService] = useState<ServiceId>(initial.service);
  const [server, setServer] = useState(initial.server);
  const [username, setUsername] = useState(text(stored, "username"));
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState(stored ? text(stored, "folder") : DEFAULT_REMOTE_FOLDER);
  /**
   * Null while the address follows the service; a typed one stays as it is.
   * A stored address the service would not have produced (a Nextcloud user id
   * that differs from the login name) is kept as typed, never rewritten.
   */
  const [urlTyped, setUrlTyped] = useState<string | null>(() =>
    storedUrl && davUrl(initial.service, initial.server, text(stored, "username")) !== storedUrl ? storedUrl : null
  );

  const derived = davUrl(service, server, username);
  const url = (urlTyped ?? derived).trim();
  const needsServer = service === "nextcloud" || service === "owncloud" || service === "synology";
  const urlError =
    url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(url)
      ? "Serve https://, oppure http:// verso un indirizzo privato"
      : url && /^https?:\/\/[^/]*@/i.test(url)
        ? "Scrivi utente e password nei loro campi, non nell'indirizzo"
        : null;
  const folderError = remoteFolderProblem(folder, { allowAbsolute: false });
  const needsPassword = !stored?.hasPassword;
  const movesArchives = Boolean(stored) && archives > 0 && url !== storedUrl;

  useReport(
    {
      config: { url, username: username.trim(), folder: folder.trim(), ...(password ? { password } : {}) },
      complete: Boolean(url && username.trim()) && !urlError && !folderError && (!needsPassword || password.length > 0),
    },
    onChange
  );

  return (
    <>
      <SelectField
        label="Servizio"
        value={service}
        onChange={(value) => {
          setService(value as ServiceId);
          setUrlTyped(value === "other" ? (urlTyped ?? "") : null);
        }}
        options={SERVICE_IDS.map((id) => ({ value: id, label: SERVICES[id].label }))}
      />

      {needsServer && (
        <Field label="Indirizzo del server" hint="Quello con cui lo apri nel browser.">
          <TextField value={server} onChange={setServer} aria-label="Indirizzo del server">
            <Input placeholder={SERVICES[service].server} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
      )}
      {service === "other" && (
        <Field label="Indirizzo WebDAV" error={urlError} hint="L'indirizzo completo della cartella WebDAV, con https://.">
          <TextField value={urlTyped ?? ""} onChange={setUrlTyped} aria-label="Indirizzo WebDAV" isInvalid={Boolean(urlError)}>
            <Input placeholder="https://dav.esempio.it/backup/" className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Utente">
          <TextField value={username} onChange={setUsername} aria-label="Utente">
            <Input className="font-mono text-sm" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
        <Field label="Password" hint={needsPassword ? undefined : "Lasciala vuota per tenere quella salvata."}>
          <TextField type="password" value={password} onChange={setPassword} aria-label="Password">
            <Input className="font-mono text-sm" autoComplete="new-password" placeholder={needsPassword ? undefined : "invariata"} />
          </TextField>
        </Field>
      </div>
      <FieldHint className="-mt-2">{SERVICES[service].password}</FieldHint>

      <Field label="Cartella" error={folderError} hint="Dentro lo spazio dell'utente; creata se manca.">
        <TextField value={folder} onChange={setFolder} aria-label="Cartella" isInvalid={Boolean(folderError)}>
          <Input placeholder={DEFAULT_REMOTE_FOLDER} className="font-mono text-sm" autoComplete="off" spellCheck={false} />
        </TextField>
      </Field>

      {service !== "other" && (
        <Advanced summary="indirizzo WebDAV" defaultExpanded={urlTyped !== null || undefined}>
          <Field label="Indirizzo WebDAV" error={urlError} hint="Ricavato dal servizio; cambialo solo se serve.">
            <TextField value={url} onChange={setUrlTyped} aria-label="Indirizzo WebDAV" isInvalid={Boolean(urlError)}>
              <Input className="font-mono text-sm" autoComplete="off" spellCheck={false} />
            </TextField>
          </Field>
        </Advanced>
      )}

      {movesArchives && (
        <Hint tone="warn" title={`Qui ci sono già ${archives} archivi`}>
          Il pannello li cercherà al nuovo indirizzo. Se non li sposti anche tu, non potrai più ripristinarli da qui.
        </Hint>
      )}

      <Hint tone="warn" title="Archivi grandi e reverse proxy">
        Se davanti al server c&apos;è un reverse proxy (nginx, Apache, Cloudflare), può limitare la dimensione di un
        caricamento: un archivio più grande viene rifiutato con l&apos;errore 413, o la connessione si chiude a metà. Il
        pannello lo riconosce e te lo dice; il limite si alza sul server (in nginx è client_max_body_size; il piano
        gratuito di Cloudflare si ferma a 100 MB).
      </Hint>
    </>
  );
}
