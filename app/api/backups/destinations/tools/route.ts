import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { detectRclone } from "@/services/backup/destinations/rclone";
import { detectSsh } from "@/services/backup/destinations/ssh-transport";

/**
 * The programs the remote destinations run, as this server has them: `ssh`
 * for SFTP, `rclone` for Google Drive and the rest.
 *
 * Asked before a form is filled in, so a missing program is said with how to
 * install it rather than found by a failed check. The panel installs nothing
 * itself — that takes root, and it is the operator's call.
 */
export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const [ssh, rclone] = await Promise.all([detectSsh(), detectRclone()]);
  return NextResponse.json({ ssh, rclone: rclone.tool });
}
