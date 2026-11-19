import { NextResponse } from "next/server";
import { getSession, isFirstRun } from "@/lib/auth";
import { githubLoginAvailable } from "@/lib/github-login";
import { clusterState, listMembers } from "@/services/cluster/state";
import { setupTokenHint } from "@/lib/setup-hint";

export async function GET() {
  const session = await getSession();
  const firstRun = await isFirstRun();
  const cluster = await clusterState();

  // A managed node has no sign-in of its own: the page shows where to go.
  const managedBy =
    cluster?.role === "node"
      ? (await listMembers()).filter((m) => m.role === "panel" && m.id !== cluster.selfId).map((m) => ({ name: m.name, url: m.url }))
      : undefined;

  return NextResponse.json({
    authenticated: session !== null,
    firstRun,
    emailRequired: session !== null && session.user.email === null,
    role: cluster?.role ?? null,
    // Whether the sign-in page offers "Accedi con GitHub" (lib/github-login.ts).
    github: !firstRun && cluster?.role !== "node" && (await githubLoginAvailable()),
    ...(managedBy ? { managedBy } : {}),
    // Where the setup token is, while there is one to find.
    ...(firstRun ? { setupHint: setupTokenHint() } : {}),
  });
}
