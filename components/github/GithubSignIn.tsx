"use client";

import { Button } from "@heroui/react";
import { MSG } from "@/lib/copy";
import { GithubMark } from "./GithubMark";

/**
 * The pieces every page that leaves for GitHub shares: the sign-in page, an
 * invitation, the account page. The trip itself is `/api/auth/github/start`.
 */

export type GithubStart =
  | { intent: "login"; next?: string }
  | { intent: "link"; password: string }
  | { intent: "invite"; token: string };

export type GithubStartResult = { ok: true } | { ok: false; error: string; status: number; url?: string };

/**
 * Ask the panel for the GitHub URL of a new sign-in, and go there. On success
 * the page is already leaving: the caller keeps its button pending. `url` on a
 * failure is the panel's own sign-in page on the address GitHub knows, when
 * the browser is on another one.
 */
export async function startGithubFlow(body: GithubStart): Promise<GithubStartResult> {
  try {
    const res = await fetch("/api/auth/github/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown; code?: unknown };
    if (res.ok && typeof data.url === "string") {
      window.location.assign(data.url);
      return { ok: true };
    }
    return {
      ok: false,
      status: res.status,
      error: typeof data.error === "string" ? data.error : "Non è stato possibile andare su GitHub",
      url: data.code === "wrong_origin" && typeof data.url === "string" ? data.url : undefined,
    };
  } catch {
    return { ok: false, status: 0, error: MSG.unreachable };
  }
}

/** "oppure", between two ways of doing the same thing. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-border h-px flex-1" />
      <span className="text-muted text-xs">oppure</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** The full-width secondary button, with GitHub's mark. */
export function GithubButton({
  children,
  isPending,
  isDisabled,
  onPress,
}: {
  children: React.ReactNode;
  isPending?: boolean;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button type="button" variant="secondary" className="w-full" isPending={isPending} isDisabled={isDisabled} onPress={onPress}>
      <GithubMark />
      {children}
    </Button>
  );
}
