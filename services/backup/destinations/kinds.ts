import os from "node:os";
import { decrypt, encrypt } from "@/lib/crypto";
import { DEFAULT_REMOTE_FOLDER } from "@/lib/backup-remote";
import { parseRcloneSections, parseRcloneToken } from "@/lib/rclone-config";
import {
  peerConfigInput,
  peerConfigSchema,
  rcloneConfigInput,
  rcloneConfigSchema,
  sftpConfigInput,
  sftpConfigSchema,
  webdavConfigInput,
  webdavConfigSchema,
} from "@/lib/validation";
import { clusterState, getMember } from "@/services/cluster/state";
import { lookupOneDrive, rcloneServiceLabel } from "./rclone";
import { fingerprintOf, generateSshKeyPair, keyComment, type SshKeyPair } from "./ssh-keys";

/**
 * What differs between the remote destination types once they reach the
 * routes: how what the form sent becomes a stored config, what the edit form
 * gets back, and what the list may show.
 *
 * One place, so the routes stay one code path for every type — and a type
 * added later (Telegram is next) adds an entry here instead of a branch in
 * each route. S3 and the local disk keep their own long-standing code in the
 * routes and are not repeated here.
 *
 * The rules every entry keeps:
 *  - a secret never goes back out — not in the list, not in the edit form —
 *    and an empty or absent secret in an edit keeps the stored one;
 *  - the merged config is validated whole before it is stored;
 *  - the list shows where a destination writes, never with which credentials.
 */

export type RemoteType = "sftp" | "webdav" | "rclone" | "peer";

export type Prepared = { ok: true; config: Record<string, unknown> } | { ok: false; error: string; status: number };

export interface PrepareOptions {
  /** The owner may paste an rclone configuration; others hold `backup` only. */
  isOwner: boolean;
}

export function isRemoteType(type: string): type is RemoteType {
  return type === "sftp" || type === "webdav" || type === "rclone" || type === "peer";
}

// --- SFTP key pairs, sealed for the round trip through the browser ----------------

/**
 * A key pair travels to the form and back sealed with a key of its own,
 * derived from the panel's for this use alone: the browser can show the public
 * half and send the token back, and nothing else sealed by the panel — a
 * secret from a store dump, say — can be passed off as one.
 */
const KEY_PURPOSE = "backup-ssh-key";
/** A pair generated and never used is worth nothing after a day. */
const KEY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function newSealedKeyPair(): SshKeyPair & { keyToken: string } {
  const pair = generateSshKeyPair(keyComment(os.hostname()));
  const keyToken = encrypt(JSON.stringify({ v: 1, privateKey: pair.privateKey, publicKey: pair.publicKey, at: Date.now() }), KEY_PURPOSE);
  return { ...pair, keyToken };
}

function unsealKeyPair(token: string): { privateKey: string; publicKey: string } | null {
  try {
    const parsed = JSON.parse(decrypt(token, KEY_PURPOSE)) as { v?: number; privateKey?: unknown; publicKey?: unknown; at?: unknown };
    if (parsed.v !== 1 || typeof parsed.privateKey !== "string" || typeof parsed.publicKey !== "string") return null;
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > KEY_TOKEN_TTL_MS) return null;
    return { privateKey: parsed.privateKey, publicKey: parsed.publicKey };
  } catch {
    return null;
  }
}

// --- Preparing what the form sent ---------------------------------------------------

const fail = (error: string, status = 400): Prepared => ({ ok: false, error, status });

function firstIssue(error: { issues: { message: string }[] }, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

/**
 * What the form sent, merged over `stored` (null when creating), completed
 * and validated whole: the config to encrypt and store, or why not.
 */
export async function prepareRemoteConfig(
  type: RemoteType,
  input: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  opts: PrepareOptions
): Promise<Prepared> {
  switch (type) {
    case "sftp":
      return prepareSftp(input, stored);
    case "webdav":
      return prepareWebdav(input, stored);
    case "rclone":
      return prepareRclone(input, stored, opts);
    case "peer":
      return preparePeer(input, stored);
  }
}

/**
 * A linked server: one of this cluster's members and not this server, with
 * its name as it is now — what the messages will call it should it ever be
 * revoked. Nothing secret is stored: the calls are signed with the cluster's
 * own secret, which is not the destination's to keep.
 */
async function preparePeer(input: Record<string, unknown>, stored: Record<string, unknown> | null): Promise<Prepared> {
  const parsed = peerConfigInput.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error, "Configurazione non valida"));
  const merged: Record<string, unknown> = { ...(stored ?? {}) };
  if (parsed.data.memberId !== undefined) merged.memberId = parsed.data.memberId.trim();
  if (!merged.memberId) return fail("Scegli il server che terrà le copie");

  const state = await clusterState();
  if (!state) return fail("Questo server non è collegato ad altri RunPanel: collegane uno da Impostazioni › Server collegati, poi torna qui.");
  if (merged.memberId === state.selfId) return fail("Scegli un altro server: una copia su questo stesso server non è fuori sede.");
  const member = typeof merged.memberId === "string" ? await getMember(merged.memberId) : null;
  if (!member) return fail("Il server scelto non è tra quelli collegati: aggiorna la pagina e scegline uno dalla lista.");
  merged.memberName = member.name;

  const valid = peerConfigSchema.safeParse(merged);
  if (!valid.success) return fail(firstIssue(valid.error, "Configurazione non valida"));
  return { ok: true, config: valid.data };
}

function prepareSftp(input: Record<string, unknown>, stored: Record<string, unknown> | null): Prepared {
  const parsed = sftpConfigInput.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error, "Configurazione SFTP non valida"));
  const form = parsed.data;
  const merged: Record<string, unknown> = { port: 22, folder: DEFAULT_REMOTE_FOLDER, ...(stored ?? {}) };

  if (form.host !== undefined) merged.host = form.host;
  if (form.port !== undefined) merged.port = form.port;
  if (form.username !== undefined) merged.username = form.username;
  if (form.folder !== undefined) merged.folder = form.folder;
  if (form.keyToken) {
    const pair = unsealKeyPair(form.keyToken);
    if (!pair) return fail("La chiave generata non è più valida: generane una nuova e aggiungila di nuovo sul server");
    merged.privateKey = pair.privateKey;
    merged.publicKey = pair.publicKey;
  }
  if (!merged.privateKey) return fail("Genera la chiave della destinazione e aggiungila sul server");

  // The pin belongs to the server it was learned on: another host or port is
  // a first contact again, unless "Verifica" just learned its key.
  const moved = stored !== null && (String(merged.host ?? "").trim() !== String(stored.host ?? "") || Number(merged.port) !== Number(stored.port));
  if (form.hostKey !== undefined) merged.hostKey = form.hostKey.trim() === "" ? null : form.hostKey.trim();
  else if (moved || stored === null) merged.hostKey = null;

  const valid = sftpConfigSchema.safeParse(merged);
  if (!valid.success) return fail(firstIssue(valid.error, "Configurazione SFTP non valida"));
  return { ok: true, config: valid.data };
}

function prepareWebdav(input: Record<string, unknown>, stored: Record<string, unknown> | null): Prepared {
  const parsed = webdavConfigInput.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error, "Configurazione WebDAV non valida"));
  const form = parsed.data;
  const merged: Record<string, unknown> = { folder: DEFAULT_REMOTE_FOLDER, ...(stored ?? {}) };
  if (form.url !== undefined) merged.url = form.url.trim();
  if (form.username !== undefined) merged.username = form.username.trim();
  if (form.password) merged.password = form.password;
  if (form.folder !== undefined) merged.folder = form.folder;
  const valid = webdavConfigSchema.safeParse(merged);
  if (!valid.success) return fail(firstIssue(valid.error, "Configurazione WebDAV non valida"));
  return { ok: true, config: valid.data };
}

async function prepareRclone(input: Record<string, unknown>, stored: Record<string, unknown> | null, opts: PrepareOptions): Promise<Prepared> {
  const parsed = rcloneConfigInput.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error, "Configurazione rclone non valida"));
  const form = parsed.data;
  const merged: Record<string, unknown> = { folder: DEFAULT_REMOTE_FOLDER, ...(stored ?? {}) };

  if (form.provider !== undefined && form.provider !== merged.provider) {
    // Another service: nothing of the previous one's credentials carries over.
    for (const key of ["token", "driveId", "driveType", "sections", "remote"]) delete merged[key];
    merged.provider = form.provider;
  }
  if (!merged.provider) return fail("Scegli il servizio");

  if (merged.provider === "expert") {
    // A pasted section runs as rclone on this server, and some of rclone's
    // options are command lines or local paths: the owner's call, the way
    // projects and terminals are.
    if (!opts.isOwner && (form.sections || stored === null)) {
      return fail("Solo il proprietario può incollare una configurazione di rclone: alcune opzioni agiscono sui file e sui programmi di questo server.", 403);
    }
    if (form.sections) merged.sections = form.sections;
    if (form.remote !== undefined) merged.remote = form.remote.trim() || undefined;
    const sections = parseRcloneSections(String(merged.sections ?? ""));
    if ("error" in sections) return fail(sections.error);
    if (!merged.remote) merged.remote = sections.sections[sections.sections.length - 1].name;
  } else if (form.token) {
    const token = parseRcloneToken(form.token);
    if ("error" in token) return fail(token.error);
    merged.token = token.token;
    delete merged.driveId;
    delete merged.driveType;
  }
  if (form.folder !== undefined) merged.folder = form.folder;

  if (merged.provider === "onedrive" && merged.token && !merged.driveId) {
    const drive = await lookupOneDrive(String(merged.token));
    if ("error" in drive) return fail(drive.error);
    merged.driveId = drive.driveId;
    merged.driveType = drive.driveType;
  }

  const valid = rcloneConfigSchema.safeParse(merged);
  if (!valid.success) return fail(firstIssue(valid.error, "Configurazione rclone non valida"));
  return { ok: true, config: valid.data };
}

// --- What goes back out -------------------------------------------------------------------

const text = (config: Record<string, unknown>, key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");

/** The edit form's view of a stored config: everything but the secrets, which become `has…` flags. */
export function remoteEditView(type: RemoteType, config: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "sftp": {
      const hostKey = text(config, "hostKey");
      return {
        host: text(config, "host"),
        port: typeof config.port === "number" ? config.port : 22,
        username: text(config, "username"),
        folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER,
        publicKey: text(config, "publicKey"),
        keyFingerprint: fingerprintOf(text(config, "publicKey")),
        hostKeyFingerprint: hostKey ? fingerprintOf(hostKey) : null,
        hasKey: text(config, "privateKey") !== "",
      };
    }
    case "webdav":
      return {
        url: text(config, "url"),
        username: text(config, "username"),
        folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER,
        hasPassword: text(config, "password") !== "",
      };
    case "rclone": {
      const parsed = parseRcloneSections(text(config, "sections"));
      return {
        provider: text(config, "provider"),
        folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER,
        remote: text(config, "remote") || null,
        // Names and types of the pasted remotes, never their options.
        remotes: "sections" in parsed ? parsed.sections.map((section) => ({ name: section.name, type: section.options.type })) : [],
        driveType: text(config, "driveType") || null,
        hasToken: text(config, "token") !== "",
        hasSections: text(config, "sections") !== "",
      };
    }
    case "peer":
      return { memberId: text(config, "memberId"), memberName: text(config, "memberName") || null };
  }
}

/** The members this server knows now, so a list names a linked server as it is called today. */
export type KnownMembers = ReadonlyMap<string, { name: string }>;

/** Where a destination writes, for the list anyone holding `backup` reads: never credentials, never a user name. */
export function remoteTarget(type: RemoteType, config: Record<string, unknown>, members?: KnownMembers): Record<string, unknown> {
  switch (type) {
    case "sftp": {
      const hostKey = text(config, "hostKey");
      return {
        host: text(config, "host"),
        port: typeof config.port === "number" ? config.port : 22,
        folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER,
        hostKeyFingerprint: hostKey ? fingerprintOf(hostKey) : null,
      };
    }
    case "webdav": {
      let host = "";
      try {
        host = new URL(text(config, "url")).host;
      } catch {
        host = "";
      }
      return { host, url: text(config, "url"), folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER };
    }
    case "rclone":
      return {
        provider: text(config, "provider"),
        service: rcloneServiceLabel(config),
        folder: typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER,
      };
    case "peer": {
      // Its name today when it is still linked, the one it had otherwise.
      const memberId = text(config, "memberId");
      const member = members?.get(memberId);
      return {
        memberId,
        memberName: member?.name ?? (text(config, "memberName") || null),
        linked: members ? Boolean(member) : null,
      };
    }
  }
}
