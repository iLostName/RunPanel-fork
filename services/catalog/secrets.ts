import crypto from "crypto";
import type { CatalogSecret } from "@/lib/app-catalog";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A password or key for a template, from the system's CSPRNG.
 *
 * `randomInt` per character rather than `randomBytes % 62`: the modulo would
 * make the first eight letters slightly likelier than the rest, which is the
 * kind of bias nobody notices until someone measures it. Hex comes straight
 * from bytes, where 16 divides 256 and there is nothing to correct.
 */
export function generateSecret(spec: Pick<CatalogSecret, "length" | "alphabet">): string {
  if (spec.alphabet === "hex") {
    return crypto.randomBytes(Math.ceil(spec.length / 2)).toString("hex").slice(0, spec.length);
  }
  let out = "";
  for (let i = 0; i < spec.length; i++) out += ALNUM[crypto.randomInt(ALNUM.length)];
  return out;
}
