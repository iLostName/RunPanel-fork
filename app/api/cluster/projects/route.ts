import { isDenied, requireUser } from "@/lib/auth-guard";
import { json } from "@/services/cluster/aggregate";
import { aggregateWithLastSeen } from "@/services/cluster/last-seen";

/** GET /api/projects of every server, each row tagged with its server. */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return json(await aggregateWithLastSeen("projects", denied));
}
