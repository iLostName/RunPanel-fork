/**
 * `buildEnv` values encrypted at rest. Zero imports: the cipher is passed in, so
 * the unit suite runs this file directly with a fake one.
 *
 * Variables live encrypted in their own table; the build arguments typed into a
 * project's contract sat in `builder_config` in the clear, which is in the store
 * and in every dump of it. Sealed where the column is written, opened only where a
 * build needs them, so the deployment's recorded contract stays sealed too.
 *
 * A sealed value is a marked string, so a contract read back and sent again (the
 * settings form does exactly that) is not sealed twice, and a contract from a
 * repository, which never went through here, is read as it is.
 */

export const SEALED_PREFIX = "enc:v1:";

type Cipher = (text: string) => string;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/** The contract JSON with every plain `buildEnv` value sealed, or itself if there was none. */
export function sealContractJson(json: string, encrypt: Cipher): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed) || !isRecord(parsed.buildEnv)) return json;

  let changed = false;
  const sealed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.buildEnv)) {
    if (typeof value === "string" && !isSealed(value)) {
      sealed[key] = SEALED_PREFIX + encrypt(value);
      changed = true;
    } else {
      sealed[key] = value;
    }
  }
  return changed ? JSON.stringify({ ...parsed, buildEnv: sealed }) : json;
}

/** The values, readable. Throws naming the key whose value this panel cannot open. */
export function openBuildEnv(env: Record<string, string>, decrypt: Cipher): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSealed(value)) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = decrypt(value.slice(SEALED_PREFIX.length));
    } catch {
      throw new Error(
        `Il build arg "${key}" è cifrato con la chiave di un altro pannello: riscrivilo nel contratto.`
      );
    }
  }
  return out;
}

/** The contract JSON with `buildEnv` readable, for a document that is encrypted whole. */
export function openContractJson(json: string, decrypt: Cipher): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed) || !isRecord(parsed.buildEnv)) return json;
  const env = Object.fromEntries(
    Object.entries(parsed.buildEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  try {
    return JSON.stringify({ ...parsed, buildEnv: openBuildEnv(env, decrypt) });
  } catch {
    return json;
  }
}
