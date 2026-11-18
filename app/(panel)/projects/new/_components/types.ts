import type { Detection } from "@/lib/app-detect";

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  private: boolean;
  updated_at: string;
}

/** Where the code comes from, as chosen in step 1. Nothing exists on the server yet. */
export type PickedSource =
  | { kind: "github"; url: string; branch: string; repo: GhRepo | null }
  | { kind: "zip"; file: File };

/** What `POST /api/projects/detect` said, or is still saying. */
export type DetectState =
  | { status: "loading" }
  | { status: "ok"; detection: Detection }
  | { status: "unsupported"; reason: string }
  | { status: "error"; message: string };
