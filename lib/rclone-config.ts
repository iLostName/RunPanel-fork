import { RCLONE_OPTION_PATTERN, RCLONE_REMOTE_PATTERN } from "./backup-remote";

/**
 * What an rclone destination stores, and how it becomes the environment rclone
 * runs with.
 *
 * rclone reads a remote from environment variables as well as from its config
 * file — `RCLONE_CONFIG_<REMOTE>_<OPTION>` — and with `RCLONE_CONFIG` set to
 * the null device it keeps its configuration in memory only. So the stored,
 * encrypted config becomes a set of variables for one process, and no
 * `rclone.conf` with a token in it is ever written to the disk.
 *
 * Two ways in. Guided, for Google Drive, OneDrive and Dropbox: the person runs
 * `rclone authorize "drive"` on a computer with a browser and pastes what it
 * prints. Expert: one or more sections of an `rclone.conf`, pasted as they
 * are, for every other service rclone supports.
 *
 * Zero imports beyond its sibling: the form previews a paste with these same
 * functions, in the browser.
 */

export const RCLONE_PROVIDERS = ["drive", "onedrive", "dropbox", "expert"] as const;
export type RcloneProvider = (typeof RCLONE_PROVIDERS)[number];
export type RcloneGuided = Exclude<RcloneProvider, "expert">;

export const RCLONE_PROVIDER_LABEL: Record<RcloneProvider, string> = {
  drive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  expert: "rclone",
};

/** The remote's name in the guided modes: `runpanel:` on the command line. */
export const GUIDED_REMOTE = "runpanel";

export interface RcloneConfig {
  provider: RcloneProvider;
  /** Guided: the token JSON, as rclone keeps it. */
  token?: string;
  /** OneDrive: which drive, looked up once when the token is pasted. */
  driveId?: string;
  driveType?: string;
  /** Expert: the pasted `rclone.conf` text. */
  sections?: string;
  /** Expert: the remote of that text the archives go to. */
  remote?: string;
  /** Inside the remote. */
  folder: string;
}

export interface RcloneSection {
  name: string;
  options: Record<string, string>;
}

/** Most `rclone.conf` sections are a few lines; a token is a couple of kilobytes. */
const MAX_SECTIONS = 10;
const MAX_OPTIONS = 64;
const MAX_VALUE = 8192;

/**
 * Options that make rclone run a program, refused even from the owner:
 * pasted from a guide on the internet, such a line would run on this server
 * at three in the morning. `ssh` is the sftp backend's external ssh command,
 * and every `…_command` option is a command line.
 */
export function isCommandOption(key: string): boolean {
  return key === "ssh" || key.endsWith("_command");
}

/** The variable rclone reads an option from: name and option upper-cased, `-` as `_`. */
export function rcloneEnvName(remote: string, option: string): string {
  return `RCLONE_CONFIG_${remote}_${option}`.toUpperCase().replace(/-/g, "_");
}

/**
 * The token out of whatever was pasted.
 *
 * `rclone authorize` prints it between `--->` and `<---End paste`, as JSON in
 * older versions and as base64 of `{"token": "…"}` in newer ones; people paste
 * the whole terminal output, or just the line. All of those are accepted. A
 * token without a refresh token expires within the hour, and the nightly
 * backup would find it dead: refused.
 */
export function parseRcloneToken(text: string): { token: string } | { error: string } {
  let body = text.trim();
  const start = body.indexOf("--->");
  const end = body.indexOf("<---");
  if (start >= 0 && end > start) body = body.slice(start + 4, end).trim();
  if (!body) return { error: "Incolla il token che ha stampato rclone authorize" };

  let parsed: unknown = null;
  const jsonStart = body.indexOf("{");
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(body.slice(jsonStart, body.lastIndexOf("}") + 1));
    } catch {
      parsed = null;
    }
  } else if (/^[A-Za-z0-9+/_-]+=*$/.test(body.replace(/\s+/g, ""))) {
    try {
      const decoded = typeof atob === "function" ? atob(body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")) : "";
      parsed = JSON.parse(decoded);
    } catch {
      parsed = null;
    }
  }

  // Newer rclone wraps the token: {"token": "{\"access_token\": …}"}.
  if (parsed && typeof parsed === "object" && typeof (parsed as { token?: unknown }).token === "string") {
    try {
      parsed = JSON.parse((parsed as { token: string }).token);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { error: "Non riconosco un token: incolla quello che rclone ha stampato tra ---> e <---End paste" };
  }
  const token = parsed as Record<string, unknown>;
  if (typeof token.access_token !== "string" || !token.access_token) {
    return { error: "Il testo incollato non contiene un access_token: rilancia rclone authorize e incolla il risultato" };
  }
  if (typeof token.refresh_token !== "string" || !token.refresh_token) {
    return { error: "Il token non contiene un refresh_token, e scadrebbe entro un'ora: rilancia rclone authorize" };
  }
  return { token: JSON.stringify(token) };
}

/** The access token inside a stored token, for the one lookup the panel makes itself (OneDrive's drive). */
export function accessTokenOf(token: string): string | null {
  try {
    const parsed = JSON.parse(token) as { access_token?: unknown };
    return typeof parsed.access_token === "string" ? parsed.access_token : null;
  } catch {
    return null;
  }
}

/**
 * Sections of a pasted `rclone.conf`, read the way rclone reads them: `[name]`
 * headers, `key = value` lines, `#` and `;` comments. Lines before any header
 * belong to a remote called `runpanel`.
 */
export function parseRcloneSections(text: string): { sections: RcloneSection[] } | { error: string } {
  const sections: RcloneSection[] = [];
  let current: RcloneSection | null = null;
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      if (!RCLONE_REMOTE_PATTERN.test(name)) return { error: `Riga ${index + 1}: «${name}» non è un nome di remote valido (lettere, numeri, - e _)` };
      if (sections.some((section) => rcloneEnvName(section.name, "x") === rcloneEnvName(name, "x"))) {
        return { error: `Riga ${index + 1}: il remote «${name}» compare due volte` };
      }
      current = { name, options: {} };
      sections.push(current);
      continue;
    }
    const at = line.indexOf("=");
    if (at <= 0) return { error: `Riga ${index + 1}: atteso «chiave = valore»` };
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (!RCLONE_OPTION_PATTERN.test(key)) return { error: `Riga ${index + 1}: «${key}» non è un'opzione di rclone` };
    if (isCommandOption(key)) return { error: `Riga ${index + 1}: l'opzione «${key}» farebbe eseguire un programma a rclone, e non è ammessa` };
    if (value.length > MAX_VALUE) return { error: `Riga ${index + 1}: valore troppo lungo` };
    if (!current) {
      current = { name: GUIDED_REMOTE, options: {} };
      sections.push(current);
    }
    current.options[key] = value;
    if (Object.keys(current.options).length > MAX_OPTIONS) return { error: `Il remote «${current.name}» ha troppe opzioni` };
  }

  if (sections.length === 0) return { error: "Incolla almeno una sezione di rclone.conf, con il suo «type = …»" };
  if (sections.length > MAX_SECTIONS) return { error: `Al massimo ${MAX_SECTIONS} remote` };
  for (const section of sections) {
    const type = section.options.type;
    if (!type) return { error: `Il remote «${section.name}» non ha «type = …»` };
    if (!/^[a-z0-9]+$/.test(type)) return { error: `Il remote «${section.name}» ha un tipo non valido: «${type}»` };
  }
  return { sections };
}

/** The values of a stored config that must never reach a log: for masking whatever rclone prints. */
export function rcloneSecrets(config: Partial<RcloneConfig>): string[] {
  const out: string[] = [];
  const collect = (json: string | undefined) => {
    if (!json) return;
    try {
      for (const value of Object.values(JSON.parse(json) as Record<string, unknown>)) if (typeof value === "string") out.push(value);
    } catch {
      out.push(json);
    }
  };
  collect(config.token);
  if (config.sections) {
    const parsed = parseRcloneSections(config.sections);
    if ("sections" in parsed) {
      for (const section of parsed.sections) {
        for (const [key, value] of Object.entries(section.options)) {
          if (key === "token") collect(value);
          else if (key !== "type") out.push(value);
        }
      }
    }
  }
  return out.filter((value) => value.length >= 6);
}

/**
 * The remote to write to and the variables that define it.
 *
 * Guided: a remote called `runpanel` of the chosen type, with the token (and
 * for OneDrive the drive). Google Drive with scope `drive`, which is what
 * `rclone authorize "drive"` asks for. Expert: every pasted section, under its
 * own name, so a `crypt` remote can still point at the remote below it.
 */
export function rcloneRemoteEnv(config: Partial<RcloneConfig>): { remote: string; env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  if (config.provider === "expert") {
    const parsed = parseRcloneSections(config.sections ?? "");
    if ("error" in parsed) return parsed;
    const remote = config.remote || parsed.sections[parsed.sections.length - 1].name;
    if (!parsed.sections.some((section) => section.name === remote)) return { error: `Il remote «${remote}» non è tra quelli incollati` };
    for (const section of parsed.sections) {
      for (const [key, value] of Object.entries(section.options)) env[rcloneEnvName(section.name, key)] = value;
    }
    return { remote, env };
  }

  if (!config.provider || !config.token) return { error: "Manca il token: rifai l'autorizzazione" };
  env[rcloneEnvName(GUIDED_REMOTE, "type")] = config.provider;
  env[rcloneEnvName(GUIDED_REMOTE, "token")] = config.token;
  if (config.provider === "drive") env[rcloneEnvName(GUIDED_REMOTE, "scope")] = "drive";
  if (config.provider === "onedrive") {
    if (!config.driveId || !config.driveType) return { error: "Manca l'unità OneDrive: incolla di nuovo il token" };
    env[rcloneEnvName(GUIDED_REMOTE, "drive_id")] = config.driveId;
    env[rcloneEnvName(GUIDED_REMOTE, "drive_type")] = config.driveType;
  }
  return { remote: GUIDED_REMOTE, env };
}

/**
 * `remote:folder/name`, the one form a path takes on rclone's command line.
 *
 * The remote's name is validated to start with a letter, a digit or `_`, so
 * the argument can never be read as an option; a folder that starts with `/`
 * keeps it, which on sftp-like remotes means the root rather than the home.
 */
export function rclonePath(remote: string, ref: string): string {
  return `${remote}:${ref}`;
}
