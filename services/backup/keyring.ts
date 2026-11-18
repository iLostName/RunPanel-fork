import crypto from "crypto";
import { backupPasswordProblem } from "@/lib/backup-password";
import { decrypt, encrypt } from "@/lib/crypto";
import { getDb, nowIso, rowCount } from "@/lib/db";
import {
  createArchiveOpener,
  prepareSeal,
  type ArchiveSeal,
  type ZipOpener,
} from "./archive-crypto";

/**
 * The backup password, as the panel keeps it.
 *
 * One per server, not one per schedule. Every archive the server writes goes
 * through it — schedules, "Esegui backup ora", and the safety copy a restore
 * takes first, which carries exactly the data being restored and goes to the
 * default destination, often a bucket. A per-schedule switch would have left
 * those two in clear, and a disaster recovery would ask "which password was
 * that schedule's?" of someone who no longer has the panel to look.
 *
 * The password is stored encrypted with the panel key, so this panel opens its
 * own archives without asking. Replacing it keeps the old one: the archives it
 * sealed — on this disk, in a bucket, in a download — stay restorable here,
 * found by the key id each one carries in its header. On another server, the
 * person types the password the header says was in use (by its date).
 *
 * Only the owner changes it (the routes say so): like the default destination,
 * it decides what happens to everyone's archives.
 */

const PURPOSE = "backup-password";

export interface EncryptionStatus {
  /** New archives are encrypted. */
  enabled: boolean;
  /** When the password in use was set. */
  since: string | null;
  /** Older passwords kept, so the archives they sealed stay readable here. */
  previous: number;
  /**
   * The password in use cannot be read: the panel key changed underneath it.
   * New backups fail rather than go out in clear; setting it again fixes it.
   */
  unreadable: boolean;
}

export class BackupPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPasswordError";
  }
}

function reveal(secret: string): string | null {
  try {
    return decrypt(secret, PURPOSE);
  } catch {
    return null;
  }
}

async function keyRows() {
  const db = await getDb();
  return db.selectFrom("backup_keys").selectAll().orderBy("created_at", "desc").execute();
}

/** The newest password still in use. Two can only exist after a race; the newest wins. */
async function currentRow() {
  return (await keyRows()).find((row) => row.retired_at === null) ?? null;
}

export async function encryptionStatus(): Promise<EncryptionStatus> {
  const rows = await keyRows();
  const current = rows.find((row) => row.retired_at === null) ?? null;
  return {
    enabled: current !== null,
    since: current?.created_at ?? null,
    previous: rows.filter((row) => row !== current).length,
    unreadable: current !== null && reveal(current.secret) === null,
  };
}

/**
 * A new password for every archive from now on. The previous one is retired,
 * not deleted, in the same transaction.
 */
export async function setBackupPassword(password: string): Promise<EncryptionStatus> {
  const problem = backupPasswordProblem(password);
  if (problem) throw new BackupPasswordError(problem);

  const db = await getDb();
  const now = nowIso();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("backup_keys").set({ retired_at: now }).where("retired_at", "is", null).execute();
    await trx
      .insertInto("backup_keys")
      .values({ id: crypto.randomBytes(8).toString("hex"), secret: encrypt(password, PURPOSE), created_at: now, retired_at: null })
      .execute();
  });
  return encryptionStatus();
}

/** New archives in clear again. The passwords stay, for the archives they sealed. */
export async function disableEncryption(): Promise<boolean> {
  const db = await getDb();
  const result = await db.updateTable("backup_keys").set({ retired_at: nowIso() }).where("retired_at", "is", null).executeTakeFirst();
  return rowCount(result) > 0;
}

/**
 * Whether `password` is the one in use: so a person can make sure the copy
 * they keep is the right one while the panel can still tell them. Null when
 * there is no password in use. Compared as digests, so neither its length nor
 * where it differs shows in the time taken.
 */
export async function checkBackupPassword(password: string): Promise<boolean | null> {
  const current = await currentRow();
  if (!current) return null;
  const stored = reveal(current.secret);
  if (stored === null) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value.normalize("NFC"), "utf8").digest();
  return crypto.timingSafeEqual(digest(stored), digest(password));
}

/**
 * The seal for the archive about to be written, or null when encryption is
 * off. Throws when it is on but the password cannot be read: an archive that
 * silently went out in clear is the failure this feature exists to prevent.
 */
export async function sealForNewArchive(): Promise<ArchiveSeal | null> {
  const current = await currentRow();
  if (!current) return null;
  const password = reveal(current.secret);
  if (password === null) {
    throw new BackupPasswordError(
      "La password dei backup non si legge più: la chiave del pannello è cambiata. Impostala di nuovo da Backup › Cifratura; " +
        "fino ad allora i backup non partono, invece di finire fuori da qui in chiaro."
    );
  }
  return prepareSeal({ password, keyId: current.id, keyCreatedAt: current.created_at });
}

/** The stored password of a key, if the panel has it and can read it. */
async function passwordOf(keyId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.selectFrom("backup_keys").select("secret").where("id", "=", keyId).executeTakeFirst();
  return row ? reveal(row.secret) : null;
}

/**
 * How every reader in the panel opens an archive: a plain zip as it is, an
 * encrypted one with the password its header names, then with `extra` — what
 * a person typed for an archive from another server.
 */
export function panelArchiveOpener(extra: readonly string[] = []): ZipOpener {
  return createArchiveOpener(async (header) => {
    const own = await passwordOf(header.keyId);
    return own ? [own, ...extra] : [...extra];
  });
}

/** For the run list: which keys exist here, and whether each still opens its archives. */
export async function keyAvailability(): Promise<Map<string, { createdAt: string; usable: boolean }>> {
  const rows = await keyRows();
  return new Map(rows.map((row) => [row.id, { createdAt: row.created_at, usable: reveal(row.secret) !== null }]));
}
