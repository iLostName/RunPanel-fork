/**
 * The three commands of a deploy contract, edited without touching the rest.
 *
 * The app form shows install, build and start and nothing else. It used to send
 * a contract made of those three alone, and the PATCH route stores what it is
 * sent: on a project that was already configured, one press of the button
 * dropped its health check, container options, mounts and build variables
 * without a word. These helpers lay the commands over the contract as it was
 * stored, so everything the form does not show stays as it was.
 *
 * Zero imports: the unit suite loads this file directly. The caller passes the
 * stored contract already in the current shape (`normalizeContractInput`).
 */

export type CommandSlot = "install" | "build" | "start";
export type Commands = Record<CommandSlot, string>;
export type RawContract = Record<string, unknown>;

const SLOTS: readonly CommandSlot[] = ["install", "build", "start"];

export const isPlainObject = (value: unknown): value is RawContract =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The commands a stored contract carries, as the form's fields start out. */
export function commandsOf(stored: RawContract): Partial<Commands> {
  const commands = stored.commands;
  if (!isPlainObject(commands)) return {};
  const out: Partial<Commands> = {};
  for (const slot of SLOTS) {
    if (typeof commands[slot] === "string") out[slot] = commands[slot];
  }
  return out;
}

/**
 * The stored contract with the form's commands laid over it, or null when they
 * are what was stored and no preset asks to be applied (the route lays a preset
 * under the contract it is sent, so one has to be sent with it).
 *
 * An emptied field removes its command, so the repository's own, or the one
 * the panel detects, applies again. Other keys of `commands` (`release`) and
 * every other part of the contract are kept as they were.
 */
export function contractWithCommands(stored: RawContract, next: Commands, applyingPreset: boolean): RawContract | null {
  const before = isPlainObject(stored.commands) ? stored.commands : {};
  const commands: RawContract = { ...before };
  for (const slot of SLOTS) {
    const value = next[slot].trim();
    if (value) commands[slot] = value;
    else delete commands[slot];
  }

  const same = SLOTS.every((slot) => commands[slot] === before[slot]);
  if (same && !applyingPreset) return null;

  const out: RawContract = { ...stored, version: 1 };
  if (Object.keys(commands).length > 0) out.commands = commands;
  else delete out.commands;
  return out;
}
