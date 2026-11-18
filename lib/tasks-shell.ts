/**
 * The two shell scripts a task needs inside a container, and how to call them.
 *
 * Killing the `docker exec` client does not stop what it started. The client
 * is a proxy: the command is a process of the container, and it goes on after
 * the client is gone — which is how a task "stopped at its time limit" would
 * keep running, and the next night's run would start beside it. So the run
 * reports its own pid first, and stopping it is a second `docker exec` that
 * ends that process and everything under it, inside the container.
 *
 * POSIX `sh` only, nothing an Alpine, a Debian slim or a BusyBox image lacks:
 * `/proc`, `read`, `kill`, `sleep`. Zero imports, so `tasks-unit` runs both
 * scripts against a real `sh` and a real process tree.
 */

/** Printed once, first thing, on stderr: the marker, then the pid. */
export const PID_MARKER_PREFIX = "__runpanel_task_pid_";

/**
 * The marker for one run. The nonce is what keeps a task from forging it: it
 * lives only in the wrapper's argv, which the `exec` below replaces before the
 * task's own code runs — and only the first line carrying it is read.
 */
export function pidMarker(nonce: string): string {
  return `${PID_MARKER_PREFIX}${nonce}__=`;
}

/** The pid in a marker line, or null for anything else — including pid 1, never ours to kill. */
export function parsePidMarker(line: string, marker: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(marker)) return null;
  const value = trimmed.slice(marker.length);
  if (!/^\d{1,10}$/.test(value)) return null;
  const pid = Number(value);
  return pid > 1 ? pid : null;
}

/**
 * The wrapper the command runs under.
 *
 * `$1` the marker, `$2` the in-container limit in seconds, `$3` the command,
 * which reaches the shell as an argument and is never spliced into a script.
 *
 * `exec` keeps the pid: the process that printed it IS the root of the tree.
 * Under `timeout` when the image has one that works the modern way (`-s`
 * before the duration; BusyBox before 1.30 wanted `-t`, so it is tried
 * first): that limit is set past the panel's own and only matters when the
 * panel is not there to enforce it — restarted mid-run, the command would
 * otherwise outlive its record by as long as it liked.
 */
export const CONTAINER_WRAPPER = [
  `printf '%s%s\\n' "$1" "$$" >&2`,
  `if command -v timeout >/dev/null 2>&1 && timeout -s KILL 5 true >/dev/null 2>&1; then exec timeout -s KILL "$2" sh -c "$3"; fi`,
  `exec sh -c "$3"`,
].join("\n");

/**
 * End a process and every process under it.
 *
 * `$1` the root pid, `$2` the grace in seconds between TERM and KILL.
 *
 * The tree is read from `/proc/<pid>/status` (`PPid:`), the one source every
 * image has. It is frozen with STOP first, then read again: a process that
 * forked between the first look and the freeze is caught by the second, and
 * a frozen tree cannot fork. Then TERM, CONT so it can act on it, and KILL
 * for whatever is still there once the grace is over. The list is fixed
 * before anything dies: an orphan is re-parented to the container's init and
 * could not be found from the root any more. Zombies do not count as alive —
 * an app running as PID 1 may never reap them.
 */
export const CONTAINER_KILL_TREE = `root=$1
grace=$2
case "$root" in ''|*[!0-9]*) exit 2 ;; esac
[ "$root" -gt 1 ] || exit 2
case "$grace" in ''|*[!0-9]*) grace=5 ;; esac
tree() {
  pairs=""
  for d in /proc/[0-9]*; do
    p=\${d#/proc/}
    pp=""
    while read -r k v rest; do
      if [ "$k" = "PPid:" ]; then pp=$v; break; fi
    done 2>/dev/null < "$d/status"
    [ -n "$pp" ] && pairs="$pairs $p:$pp"
  done
  found=" $root "
  more=1
  while [ "$more" = 1 ]; do
    more=0
    for pair in $pairs; do
      p=\${pair%%:*}
      pp=\${pair#*:}
      case "$found" in *" $p "*) continue ;; esac
      case "$found" in *" $pp "*) found="$found$p "; more=1 ;; esac
    done
  done
  echo $found
}
alive() {
  out=""
  for p in $pids; do
    state=""
    while read -r k v rest; do
      if [ "$k" = "State:" ]; then state=$v; break; fi
    done 2>/dev/null < "/proc/$p/status"
    if [ -n "$state" ] && [ "$state" != "Z" ]; then out="$out $p"; fi
  done
  echo $out
}
pids=$(tree)
kill -STOP $pids 2>/dev/null
pids=$(tree)
kill -STOP $pids 2>/dev/null
kill -TERM $pids 2>/dev/null
kill -CONT $pids 2>/dev/null
i=0
while [ "$i" -lt "$grace" ]; do
  [ -n "$(alive)" ] || exit 0
  sleep 1
  i=$((i + 1))
done
kill -KILL $pids 2>/dev/null
exit 0`;

/** `docker exec` for a run: no stdin, no TTY, the container's own user and working directory. */
export function containerRunArgs(container: string, command: string, marker: string, limitSec: number): string[] {
  return ["exec", container, "sh", "-c", CONTAINER_WRAPPER, "runpanel-task", marker, String(Math.max(1, Math.ceil(limitSec))), command];
}

/**
 * `docker exec` for the stop, as the same user the command ran as — the
 * container's default, like the run itself.
 *
 * Not as root, deliberately. The pid comes from a line on the run's stderr,
 * and a process in the container running as that user could write to that
 * pipe: as root, the stop would hand it a way to end processes it cannot end
 * itself. As the same user it can only do what it already could. A command
 * that switched to another user is the one case this cannot reach, and the
 * in-container `timeout` of the wrapper still ends it, a minute past its limit.
 */
export function containerKillArgs(container: string, pid: number, graceSec: number): string[] {
  return ["exec", container, "sh", "-c", CONTAINER_KILL_TREE, "runpanel-kill", String(pid), String(graceSec)];
}
