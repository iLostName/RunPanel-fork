import { decrypt, encrypt } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { openBuildEnv as open, openContractJson, sealContractJson } from "@/lib/build-env-seal";

/**
 * See `lib/build-env-seal.ts`. These bind it to a key of its own, derived from
 * the panel's for this use and this project: an `enc:v1:` written into a
 * contract by hand, a stored GitHub token or another project's argument, does
 * not open here, and a build cannot be used to print it.
 */
const purpose = (projectId: string) => `build-env:${projectId}`;

export const sealContract = (json: string, projectId: string): string =>
  sealContractJson(json, (text) => encrypt(text, purpose(projectId)));
export const openBuildEnv = (env: Record<string, string>, projectId: string): Record<string, string> =>
  open(env, (text) => decrypt(text, purpose(projectId)));
export const openContract = (json: string, projectId: string): string =>
  openContractJson(json, (text) => decrypt(text, purpose(projectId)));

/**
 * Seal what was stored before values were sealed: the projects' contracts and the
 * contract each deployment recorded. Idempotent, and cheap once done, so it runs
 * at every boot rather than as a migration, which has no key to encrypt with.
 */
export async function sealStoredBuildEnv(): Promise<number> {
  const db = await getDb();
  let sealed = 0;

  const projects = await db
    .selectFrom("projects")
    .select(["id", "builder_config"])
    .where("builder_config", "like", "%buildEnv%")
    .execute();
  for (const row of projects) {
    const next = sealContract(row.builder_config, row.id);
    if (next === row.builder_config) continue;
    await db.updateTable("projects").set({ builder_config: next }).where("id", "=", row.id).execute();
    sealed++;
  }

  const deployments = await db
    .selectFrom("deployments")
    .select(["id", "project_id", "resolved_contract"])
    .where("resolved_contract", "like", "%buildEnv%")
    .execute();
  for (const row of deployments) {
    if (!row.resolved_contract) continue;
    const next = sealContract(row.resolved_contract, row.project_id);
    if (next === row.resolved_contract) continue;
    await db.updateTable("deployments").set({ resolved_contract: next }).where("id", "=", row.id).execute();
    sealed++;
  }

  return sealed;
}
