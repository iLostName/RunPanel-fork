/**
 * Folders, hosts and user names of the remote backup destinations — SFTP,
 * WebDAV, rclone — with one set of rules shared by the form, the request
 * schemas and the drivers.
 *
 * They are checked in three places for three reasons. The form says what is
 * wrong while it is being typed. The schema refuses it, because a value stored
 * encrypted is read back at 03:00 by a scheduler nobody is watching. And the
 * drivers rely on it: a host that starts with `-` is an option to `ssh`, and a
 * folder segment `..` resolves out of a WebDAV URL.
 *
 * Zero imports: validation.ts runs in the browser too, and the unit suites load
 * this file directly.
 */

/** Where archives go when the form is left alone. */
export const DEFAULT_REMOTE_FOLDER = "runpanel-backups";

export const MAX_REMOTE_FOLDER = 512;

/**
 * Why a folder is refused, or null.
 *
 * Spaces, quotes and accents are fine: nothing here goes through a shell, and
 * each driver encodes what its protocol needs. What is refused is what would
 * mean something else than a name — `.` and `..` segments, control characters
 * and backslashes, which some servers read as separators — and, where the
 * protocol has no notion of it, a leading slash.
 */
export function remoteFolderProblem(value: string, opts: { allowAbsolute: boolean }): string | null {
  if (value.length > MAX_REMOTE_FOLDER) return `La cartella può avere al massimo ${MAX_REMOTE_FOLDER} caratteri`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "La cartella contiene un carattere non valido";
  if (value.includes("\\")) return "Usa / per separare le cartelle, non \\";
  if (!opts.allowAbsolute && value.trim().startsWith("/")) return "Scrivi la cartella senza / all'inizio: è dentro l'indirizzo indicato";
  const segments = value.split("/").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "." || segment === "..")) return "La cartella non può contenere . o ..";
  return null;
}

/**
 * The folder as it is stored: trimmed, without empty segments or a trailing
 * slash, and with its leading slash only when absolute paths mean something.
 */
export function normalizeRemoteFolder(value: string, opts: { allowAbsolute: boolean }): string {
  const trimmed = value.trim();
  const absolute = opts.allowAbsolute && trimmed.startsWith("/");
  const segments = trimmed
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const joined = segments.join("/");
  return absolute ? `/${joined}` : joined;
}

/** `folder/name`, or `name` alone when the archives go to the top. */
export function joinRemote(folder: string, name: string): string {
  if (!folder) return name;
  if (folder === "/") return `/${name}`;
  return `${folder.replace(/\/+$/, "")}/${name}`;
}

/** The folder part of a stored ref: everything before the last slash. */
export function remoteParent(ref: string): string {
  const at = ref.lastIndexOf("/");
  if (at < 0) return "";
  return at === 0 ? "/" : ref.slice(0, at);
}

/** The name part of a stored ref. */
export function remoteBase(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/**
 * The name a file is written under until it is complete.
 *
 * Hidden on servers that hide dot files and ending in `.partial` everywhere
 * else, so an upload cut halfway never leaves something that looks like a
 * finished archive — neither to the panel, which only records the final name,
 * nor to a person browsing the folder.
 */
export function partialName(ref: string, nonce: string): string {
  return joinRemote(remoteParent(ref), `.${remoteBase(ref)}.${nonce}.partial`);
}

// --- SSH hosts and users -------------------------------------------------------

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})*\\.?$`);
const IPV6 = /^[0-9A-Fa-f:.]+(%[A-Za-z0-9_.-]+)?$/;

/** `[fe80::1]` as typed from a URL becomes `fe80::1`; anything else is only trimmed. */
export function normalizeSshHost(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]+)\]$/.exec(trimmed);
  return bracketed ? bracketed[1] : trimmed;
}

/**
 * Why a host is refused, or null.
 *
 * A name, an IPv4 or an IPv6 address — never a `user@host`, a `host:port` or a
 * URL, which are easy to paste by mistake, and never anything that starts with
 * `-`: on the `ssh` command line that would be an option, and `-oProxyCommand`
 * is a command.
 */
export function sshHostProblem(value: string): string | null {
  const host = normalizeSshHost(value);
  if (!host) return "Scrivi l'indirizzo del server";
  if (host.startsWith("-")) return "L'indirizzo non può iniziare con -";
  if (/^[a-z]+:\/\//i.test(host)) return "Scrivi solo il nome del server, senza sftp:// o https://";
  if (host.includes("@")) return "Scrivi l'utente nel suo campo, non nell'indirizzo";
  const colons = (host.match(/:/g) ?? []).length;
  if (colons === 1) return "Scrivi la porta nel suo campo, non dopo i due punti";
  if (colons >= 2) return IPV6.test(host) ? null : "Indirizzo IPv6 non valido";
  return HOSTNAME.test(host) ? null : "Indirizzo non valido: un nome come nas.casa.lan o un IP";
}

/**
 * Why a user name is refused, or null.
 *
 * Letters, digits and `. _ - @ +`, not starting with `-` — the names NAS,
 * storage boxes and Linux accounts actually use (`backup`, `u123456-sub1`).
 * OpenSSH itself refuses most shell metacharacters in a user name given on the
 * command line, and an error from here is clearer than one from there.
 */
export function sshUserProblem(value: string): string | null {
  const user = value.trim();
  if (!user) return "Scrivi il nome utente";
  if (user.length > 64) return "Il nome utente può avere al massimo 64 caratteri";
  if (user.startsWith("-")) return "Il nome utente non può iniziare con -";
  return /^[A-Za-z0-9._@+-]+$/.test(user) ? null : "Il nome utente può contenere lettere, numeri e . _ - @ +";
}

/** A host key as it is pinned: `type base64`, the types OpenSSH writes into known_hosts. */
export const SSH_HOST_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

// --- rclone remotes -------------------------------------------------------------

/** A remote's name in a pasted rclone configuration: `[gdrive]`, `[nas-crypt]`. */
export const RCLONE_REMOTE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
/** An option name in that configuration: `type`, `client_id`, `token`. */
export const RCLONE_OPTION_PATTERN = /^[a-z0-9_]{1,64}$/;
