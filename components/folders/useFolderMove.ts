"use client";

import { useCallback } from "react";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { useMemberApi, useNode } from "@/lib/hooks/useNode";
import { moveFailureText, type FolderLike } from "@/lib/overview-groups";

type MoveTarget = FolderLike & { permission?: { level: string | null } };

/**
 * Filing a project or a service in a folder, or in none.
 *
 * Written on the server that holds the row, whatever server is on screen.
 * Resolves to whether it moved: a refusal has been said in a toast by then, in
 * the words of `moveFailureText`, so a caller only refreshes what it shows.
 * `folders` are the ones on screen, so the toast names the folder as it reads.
 */
export function useFolderMove(
  folders: readonly MoveTarget[]
): (kind: "projects" | "services", memberId: string, id: string, folderId: string | null) => Promise<boolean> {
  const memberApi = useMemberApi();
  const { isSolo, nameOf } = useNode();

  return useCallback(
    async (kind, memberId, id, folderId) => {
      let res: Response;
      try {
        res = await fetch(memberApi(memberId, `/api/${kind}/${id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        });
      } catch {
        toast.error(MSG.unreachable);
        return false;
      }
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      const error = typeof data.error === "string" ? data.error : undefined;
      const folder = folders.find((f) => f.id === folderId);
      toast.error(moveFailureText({ status: res.status, error }, { solo: isSolo, serverName: nameOf(memberId), folder }));
      return false;
    },
    [memberApi, isSolo, nameOf, folders]
  );
}
