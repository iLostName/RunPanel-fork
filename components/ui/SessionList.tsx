"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadError } from "@/components/ui/LoadError";
import { formatRelative } from "@/lib/format";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { SkeletonBlock } from "./Skeletons";

interface Session {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** The session this page is open in. */
  current?: boolean;
}

/** A user agent string is unreadable; this is the part anyone cares about. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo sconosciuto";

  const os =
    /Windows/i.test(userAgent) ? "Windows"
    : /Android/i.test(userAgent) ? "Android"
    : /iPhone|iPad|iOS/i.test(userAgent) ? "iOS"
    : /Mac OS X|Macintosh/i.test(userAgent) ? "macOS"
    : /Linux/i.test(userAgent) ? "Linux"
    : null;

  const browser =
    /Edg\//i.test(userAgent) ? "Edge"
    : /OPR\/|Opera/i.test(userAgent) ? "Opera"
    : /Firefox\//i.test(userAgent) ? "Firefox"
    : /Chrome\//i.test(userAgent) ? "Chrome"
    : /Safari\//i.test(userAgent) ? "Safari"
    : null;

  if (browser && os) return `${browser} su ${os}`;
  return browser ?? os ?? userAgent.slice(0, 40);
}

/**
 * Signed-in devices, with a way to revoke one, or all but this one.
 *
 * Sessions became per-device but there was no way to see or end them
 * individually — the only lever was changing the password, which ends all of
 * them at once. The device this page is open on is marked and has no button:
 * disconnecting it is "Esci", in the user menu.
 *
 * With `userId`, another account's devices, for whoever manages it (the API
 * decides); "every other device" is only offered for one's own.
 */
export function SessionList({ userId }: { userId?: string } = {}) {
  const url = userId ? `/api/sessions?userId=${encodeURIComponent(userId)}` : "/api/sessions";
  const { data, loading, error: loadError, refresh } = useResource<{ sessions: Session[] }>(url);
  const [confirmOthers, setConfirmOthers] = useState(false);
  // The current device first: it is the one the list is read from.
  const sessions = [...(data?.sessions ?? [])].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
  const others = sessions.filter((s) => !s.current).length;

  async function revoke(id: string) {
    try {
      const res = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Dispositivo disconnesso");
      refresh();
    } catch {
      toast.error("Disconnessione non riuscita");
    }
  }

  async function revokeOthers(): Promise<boolean> {
    try {
      const res = await fetch("/api/sessions?others=1", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Disconnessione non riuscita");
        return false;
      }
      toast.success(body.closed === 1 ? "1 dispositivo disconnesso" : `${body.closed ?? 0} dispositivi disconnessi`);
      await refresh();
      return true;
    } catch {
      toast.error("Disconnessione non riuscita");
      return false;
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }, (_, i) => (
          <SkeletonBlock key={i} className="h-14" />
        ))}
      </div>
    );
  }

  if (!data && loadError) {
    return <LoadError what="le sessioni" error={loadError} onRetry={() => void refresh()} />;
  }

  if (sessions.length === 0) {
    return <p className="text-muted text-sm">Nessuna sessione attiva.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-border divide-y">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Icon icon="solar:monitor-linear" width={18} className="text-muted shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-foreground flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate">{describeDevice(session.user_agent)}</span>
                {session.current && <Badge tone="accent">Questo dispositivo</Badge>}
              </p>
              <p className="text-muted mt-0.5 truncate text-xs">
                {session.ip ? <span className="font-mono">{session.ip}</span> : "IP sconosciuto"}
                {" · attivo "}
                {formatRelative(session.last_seen_at)}
              </p>
            </div>
            {!session.current && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Disconnetti questo dispositivo"
                onPress={() => revoke(session.id)}
              >
                Disconnetti
              </Button>
            )}
          </li>
        ))}
      </ul>

      {!userId && others > 0 && (
        <div className="border-border border-t pt-3">
          <Button variant="secondary" size="sm" onPress={() => setConfirmOthers(true)}>
            <Icon icon="solar:logout-2-linear" width={15} aria-hidden />
            Esci da tutti gli altri dispositivi
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmOthers}
        onOpenChange={setConfirmOthers}
        title="Uscire da tutti gli altri dispositivi?"
        description={`${others === 1 ? "L'altro dispositivo viene disconnesso" : `Gli altri ${others} dispositivi vengono disconnessi`} subito: per rientrare serviranno di nuovo email e password. Questo resta collegato.`}
        confirmLabel="Esci dagli altri"
        destructive
        onConfirm={revokeOthers}
      />
    </div>
  );
}
