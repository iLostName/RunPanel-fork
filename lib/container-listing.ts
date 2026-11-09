/**
 * Listing a directory inside a container.
 *
 * `ls -la` cannot be parsed: a symlink comes back as `bin -> usr/bin`, and
 * splitting on whitespace folds the double space in `a  b` into one, so opening
 * that entry targets a path that does not exist. `find -printf` would solve it
 * but busybox has no `-printf`, and alpine images are as common as Debian ones.
 *
 * So this is a POSIX sh script using only what both have. The directory is
 * `$1`: an argument, never part of the script text.
 *
 * Output, in this order:
 *  - one `<kind>\t<name>\0` record per entry. NUL is the only byte a name cannot
 *    contain, and `test` follows links, so a link is whatever it points at: `d`
 *    a directory, `f` a regular file, `o` anything else, broken links included;
 *  - a `=\0` record;
 *  - the size of each `f` entry, in the same order, one number per line. One
 *    `stat` for two hundred of them, since one per entry takes too long in a
 *    directory with thousands of files, and so does a single list: every
 *    `set -- "$@"` copies the list so far, which is quadratic.
 *
 * Two loops because `stat` writes straight to the output: inside the first one
 * its numbers would land among the records.
 */
export const LIST_DIRECTORY_SCRIPT = String.raw`
CDPATH= cd -- "$1" || exit 66
shift $#
for f in * .[!.]* ..?*; do
  if [ -d "$f" ]; then k=d
  elif [ -f "$f" ]; then k=f
  elif [ -e "$f" ] || [ -L "$f" ]; then k=o
  else continue
  fi
  printf '%s\t%s\0' "$k" "$f"
done
printf '=\0'
for f in * .[!.]* ..?*; do
  [ -f "$f" ] || continue
  set -- "$@" "./$f"
  [ $# -lt 200 ] && continue
  stat -L -c %s -- "$@" 2>/dev/null
  shift $#
done
[ $# -eq 0 ] || stat -L -c %s -- "$@" 2>/dev/null
exit 0
`;

/** The script's exit code when the path cannot be entered. */
export const LIST_DIRECTORY_NOT_FOUND = 66;

export interface ContainerFileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
}

/**
 * The script's output as `FileManager` wants it, directories first like the
 * listing of a local checkout.
 *
 * Sizes are paired by position, so a count that does not match means `stat` was
 * missing or a file vanished halfway: no sizes at all, rather than wrong ones.
 */
export function parseDirectoryListing(stdout: string): ContainerFileEntry[] {
  const records = stdout.split("\0");
  const marker = records.indexOf("=");
  const heads = marker === -1 ? records : records.slice(0, marker);
  const tail = marker === -1 ? "" : records.slice(marker + 1).join("");

  const entries: ContainerFileEntry[] = [];
  const sized: ContainerFileEntry[] = [];

  for (const record of heads) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;

    const kind = record.slice(0, tab);
    const name = record.slice(tab + 1);
    if (!name || name === "." || name === "..") continue;

    const entry: ContainerFileEntry = { name, type: kind === "d" ? "dir" : "file", size: 0 };
    entries.push(entry);
    if (kind === "f") sized.push(entry);
  }

  const sizes = tail.split("\n").filter(Boolean).map(Number);
  if (sizes.length === sized.length && sizes.every(Number.isFinite)) {
    sized.forEach((entry, i) => {
      entry.size = sizes[i];
    });
  }

  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
