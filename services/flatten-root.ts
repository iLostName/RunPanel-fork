import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * A zip made from a folder unpacks as `project-main/…`. Lift that one level so
 * the repo root is where every builder expects it.
 *
 * The folder is swapped in whole rather than emptied child by child, because
 * the children can collide with it: `mysite/mysite/settings.py`, which is every
 * Django project, asked to rename `mysite/mysite` onto its own parent. Going
 * through a name outside `destDir` also leaves no state with half the children
 * moved: at every step the tree is in one piece, and a failure puts it back.
 */
export async function flattenSingleRoot(destDir: string): Promise<void> {
  const entries = await fs.promises.readdir(destDir, { withFileTypes: true });
  const only = entries.length === 1 ? entries[0] : null;
  if (!only?.isDirectory()) return;

  const root = path.join(destDir, only.name);
  const lifted = `${destDir}.root-${crypto.randomBytes(4).toString("hex")}`;

  await fs.promises.rename(root, lifted);
  try {
    await fs.promises.rmdir(destDir);
    await fs.promises.rename(lifted, destDir);
  } catch (err) {
    await fs.promises.mkdir(destDir, { recursive: true }).catch(() => {});
    // `lifted` is outside the folder the caller cleans up, so it cannot stay.
    await fs.promises
      .rename(lifted, root)
      .catch(() => fs.promises.rm(lifted, { recursive: true, force: true }))
      .catch(() => {});
    throw err;
  }
}
