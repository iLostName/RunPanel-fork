import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";

/**
 * The card of the pages outside the panel: signing in, an invitation or a
 * reset link, the first email.
 *
 * A desktop gets a card in the middle of the page. On a phone that card was a
 * box with a margin all round, and the margin and the card's own padding took
 * 80px from the fields on the screens that have the least width, for a border
 * around the only thing on screen. Below `sm` the card runs edge to edge
 * instead, as an app's sign-in screen does: no border, no corners and no
 * surface of its own, with the content 16px from the edges.
 *
 * These pages have no top bar to keep them clear of the notch, the status bar
 * of the installed app and the home indicator, so on a phone the page keeps
 * clear of them itself: the safe areas are added to the gutters (globals.css),
 * and they are zero wherever there is nothing to avoid. The fields are 16px
 * there already, from the same file, so iOS does not zoom into them.
 */
export function AuthCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <main
      className={cn(
        "flex min-h-dvh items-center justify-center p-4",
        "max-sm:pt-[calc(var(--safe-top)+2rem)] max-sm:pr-[max(1rem,var(--safe-right))] max-sm:pb-[calc(var(--safe-bottom)+2rem)] max-sm:pl-[max(1rem,var(--safe-left))]"
      )}
    >
      <Panel
        className={cn(
          "w-full max-w-md p-6 sm:p-8",
          "max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none",
          className
        )}
      >
        {children}
      </Panel>
    </main>
  );
}
