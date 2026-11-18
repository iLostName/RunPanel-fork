import { NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { githubToken } from "@/lib/github";
import { onboardingItems, policyCoversVolumes, type OnboardingFacts } from "@/lib/onboarding";
import { autostartProbeCache } from "@/services/autostart/probe";
import { isConfigured, readConfig } from "@/services/notify";

/**
 * The first-run checklist on the Overview: which of the steps a server needs to
 * run on its own are done here (see lib/onboarding.ts).
 *
 * The owner's: configuring the server is theirs, and every step needs a
 * permission the owner has. Each fact is read on its own and a failure counts
 * as "not done" rather than failing the whole list, since the list is a hint
 * and never a gate.
 */
export async function GET() {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  const db = await getDb();

  const settle = async (read: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await read();
    } catch {
      return false;
    }
  };

  const [github, project, domain, backup, autostart, notifications] = await Promise.all([
    settle(async () => Boolean(await githubToken())),
    settle(async () =>
      Boolean(await db.selectFrom("projects").select("id").where("status", "=", "running").limit(1).executeTakeFirst())
    ),
    settle(async () => Boolean(await db.selectFrom("domains").select("id").limit(1).executeTakeFirst())),
    settle(async () => {
      const policies = await db
        .selectFrom("backup_policies")
        .select(["targets"])
        .where("enabled", "=", 1)
        .where("cron", "!=", "")
        .execute();
      return policies.some((p) => policyCoversVolumes(p.targets));
    }),
    settle(async () => {
      const probe = await autostartProbeCache.get();
      return probe.environment.containerised || probe.systemd.enabled || probe.cron.installed;
    }),
    settle(async () => isConfigured(await readConfig())),
  ]);

  const facts: OnboardingFacts = { github, project, domain, backup, autostart, notifications };
  return NextResponse.json({ items: onboardingItems(facts) }, { headers: { "Cache-Control": "no-store" } });
}
