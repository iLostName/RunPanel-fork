/**
 * What the backup password must be. One definition for the route that saves
 * it, the keyring that stores it and the form that asks for it, so the form
 * never accepts what the server then refuses.
 *
 * No imports: the browser loads this too.
 */

/**
 * Long enough that the archive, once out of here, is not the weak point: it
 * can be attacked offline, as long as anyone likes, at the cost of one scrypt
 * per guess. A sentence of a few words passes easily.
 */
export const MIN_BACKUP_PASSWORD = 12;
export const MAX_BACKUP_PASSWORD = 1024;

/** Why a password cannot be the backup password, or null. */
export function backupPasswordProblem(password: string): string | null {
  if (password.length < MIN_BACKUP_PASSWORD) return `La password dei backup deve avere almeno ${MIN_BACKUP_PASSWORD} caratteri`;
  if (password.length > MAX_BACKUP_PASSWORD) return `La password dei backup può avere al massimo ${MAX_BACKUP_PASSWORD} caratteri`;
  // A space at either end is the one a copy and paste loses, years later.
  if (password.trim() !== password) return "La password non può iniziare o finire con uno spazio";
  return null;
}
