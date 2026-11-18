import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GLOBAL_PERMISSIONS, hasPermission, seesEverything } from "@/lib/authz";
import { loadPrincipal } from "@/lib/principal";
import { MeProvider } from "@/lib/hooks/useMe";
import { NodeProvider, type NodeInfo } from "@/lib/hooks/useNode";
import { clusterState, listMembers } from "@/services/cluster/state";
import { AppSidebar } from "@/components/AppSidebar";
import { MobileNav } from "@/components/MobileNav";
import { NavigationProgress } from "@/components/NavigationProgress";
import { PageAccess } from "@/components/PageAccess";
import { CommandPalette } from "@/components/CommandPalette";
import { TopBar } from "@/components/TopBar";
import { PollingProvider } from "@/lib/hooks/usePollingInterval";
import { PanelUpdateProvider } from "@/lib/hooks/usePanelUpdate";
import { UpdateBanner } from "@/components/UpdateBanner";
import { InboxProvider } from "@/components/notifications/InboxProvider";
import { InstallDialog } from "@/components/pwa/InstallDialog";
import { InstallHint } from "@/components/pwa/InstallHint";
import { panelRelease } from "@/services/panel-update/release";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  // The owner migrated from the single password signs in without an email and
  // sets one before anything else.
  if (!session.user.email) {
    redirect("/setup-email");
  }
  const principal = await loadPrincipal(session.user);
  const me = {
    id: session.user.id,
    email: session.user.email,
    isOwner: session.user.isOwner,
    permissions: GLOBAL_PERMISSIONS.filter((p) => hasPermission(principal, p)),
    seesEverything: seesEverything(principal),
  };

  // The other servers of the cluster, for the selector. Empty in solo mode.
  const cluster = await clusterState();
  const nodes: NodeInfo[] = cluster
    ? (await listMembers()).map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        role: m.role === "node" ? "node" : "panel",
        status: m.id === cluster.selfId ? "ok" : m.status === "ok" || m.status === "unreachable" ? m.status : "unknown",
        version: m.version,
      }))
    : [];

  const version = (await panelRelease()).label;

  return (
    <MeProvider me={me}>
    <NodeProvider nodes={nodes} selfId={cluster?.selfId ?? null}>
    <PollingProvider>
    <PanelUpdateProvider>
    <InboxProvider>
    <div className="min-h-dvh">
      {/* In its own boundary because it reads the query string; it draws
          nothing until a navigation takes long enough to need it. */}
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      {/* First in the tab order and invisible until focused: whoever navigates
          by keyboard skips the sidebar instead of tabbing through it on every
          page. Below the notch when there is one. */}
      <a
        href="#main"
        className="bg-accent text-accent-foreground sr-only z-[60] rounded-[var(--radius)] px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-[calc(var(--safe-top)+0.75rem)] focus:left-3"
      >
        Vai al contenuto
      </a>
      <AppSidebar version={version} />
      <MobileNav version={version} />
      {/* `overflow-x: clip` below `md` is the last line against a page wider
          than the phone: whatever is too wide scrolls inside its own box, and
          the page itself never pans sideways. `clip`, not `hidden`, so the
          sticky top bar keeps sticking. */}
      <div className="max-md:overflow-x-clip md:ml-64">
        <TopBar />
        {/* Under the bar and in the flow, never above it and never fixed. */}
        <UpdateBanner />
        {/* Capped so tables and lists do not stretch to absurd line lengths on
            a wide monitor, which is most of what makes a panel feel unplanned.

            The bottom padding below `md` clears the tab bar and the home
            indicator: without it the last row of every list sits underneath
            them, and on a long page that is the row you scrolled down to
            reach. The side padding keeps clear of the notch in landscape. */}
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1400px] pt-5 pr-[max(1rem,var(--safe-right))] pb-[calc(var(--tab-bar-height)+var(--safe-bottom)+1.5rem)] pl-[max(1rem,var(--safe-left))] outline-none sm:pr-[max(1.5rem,var(--safe-right))] sm:pl-[max(1.5rem,var(--safe-left))] md:pt-6 md:pb-6 lg:px-8"
        >
          <PageAccess>{children}</PageAccess>
        </main>
      </div>
      {/* Mounted once for the whole panel: it listens for Ctrl/Cmd+K and
          renders nothing until it is asked for. */}
      <CommandPalette />
      {/* "Installa l'app": the explanation where the browser has no button, and
          the one-time suggestion on a phone. Both render nothing until needed. */}
      <InstallDialog />
      <InstallHint />
    </div>
    </InboxProvider>
    </PanelUpdateProvider>
    </PollingProvider>
    </NodeProvider>
    </MeProvider>
  );
}
