/**
 * The shell side of a task: how its command becomes a script, and the scripts
 * that start and stop it inside a container.
 *
 * Killing the `docker exec` client does not stop what it started. The client
 * is a proxy: the command is a process of the container, and it goes on after
 * the client is gone — which is how a task "stopped at its time limit" would
 * keep running, and the next night's run would start beside it. So the run
 * reports its own pid first, and stopping it is a second `docker exec` that
 * ends that process and everything under it, inside the container. A watchdog
 * in the container does the same at the limit, for the case of a panel that
 * is not there any more to do it.
 *
 * POSIX `sh` only, nothing an Alpine, a Debian slim or a BusyBox image lacks:
 * `/proc`, `read`, `kill`, `sleep`. Zero imports, so `tasks-unit` runs every
 * script here against a real `sh` and a real process tree.
 */

// --- The command ---------------------------------------------------------------

const POSIX_COMMENT = /^#/;
const CMD_COMMENT = /^(?:rem(?:\s|$)|::|#)/i;

function commandLines(command: string, comment: RegExp): string[] {
  return command
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !comment.test(line.trim()));
}

/** Whether a command field has anything to run once blank and comment lines are gone. */
export function hasRunnableLine(command: string): boolean {
  return commandLines(command, POSIX_COMMENT).length > 0;
}

/**
 * The command field as one POSIX script, with the meaning every command field
 * of the panel has: one command per line, in order, in the same shell, and the
 * first line that fails stops the rest with its exit code.
 *
 * Not `joinScript`'s `a && b && c`, which is that meaning on a single line —
 * and a line is where it breaks. A comment line turns every line after it into
 * the comment, so the run "succeeds" having done nothing; a trailing comment
 * does the same; a line ending in `&` is a syntax error. Here each line is a
 * group of its own, closed on the next line, so its comment ends with it:
 * `{ line` NEWLINE `} || exit $?`. A group runs in the shell itself, not in a
 * subshell, so a `cd` or a `source` on one line still holds on the next.
 * Comment and blank lines are dropped first — an empty group is a syntax error.
 */
export function posixScript(command: string): string {
  return commandLines(command, POSIX_COMMENT)
    .map((line) => `{ ${line}\n} || exit $?`)
    .join("\n");
}

/** The same for `cmd.exe`, which has no groups and no newlines in `/c`: `&&`, without the comment lines. */
export function cmdScript(command: string): string {
  return commandLines(command, CMD_COMMENT).join(" && ");
}

// --- On the host -----------------------------------------------------------------

/**
 * The wrapper a host run goes through on POSIX: `$1` the backstop in seconds,
 * `$2` the shell, `$3` the script, each an argument and never spliced in.
 *
 * Under GNU `timeout` when there is one (every Linux has it), set past the
 * panel's own limit: it only matters when the panel is gone — a host run is
 * its own process group, which a panel restarted under `KillMode=process`
 * does not take down with it. `exec` keeps the pid, so the group the panel
 * signals is still the run's, and GNU `timeout` signals the whole group when
 * it fires.
 */
export const HOST_WRAPPER = [
  `if command -v timeout >/dev/null 2>&1 && timeout -s KILL 5 true >/dev/null 2>&1; then exec timeout -s KILL "$1" "$2" -c "$3"; fi`,
  `exec "$2" -c "$3"`,
].join("\n");

export function hostRunArgs(shell: string, script: string, backstopSec: number): string[] {
  return ["-c", HOST_WRAPPER, "runpanel-task", String(Math.max(1, Math.ceil(backstopSec))), shell, script];
}

// --- In a container ----------------------------------------------------------------

/** Printed once, first thing, on stderr: the marker, then the pid. */
export const PID_MARKER_PREFIX = "__runpanel_task_pid_";

/**
 * The marker for one run. The nonce is what keeps a task from forging it: the
 * wrapper prints it before the command has even started, and only the first
 * line carrying it is read — by the time anything in the container could have
 * learnt the nonce, the real line has gone past.
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
 * The functions both container scripts share.
 *
 * `tree` lists `$root` and every process under it, read from
 * `/proc/<pid>/status` (`PPid:`), the one source every image has; it does not
 * descend into `$skip`, when one is set. `alive` keeps the pids of `$pids`
 * that still run — a zombie does not count, an app running as PID 1 may never
 * reap it.
 */
const TREE_FUNCTIONS = `tree() {
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
      [ "$p" = "$skip" ] && continue
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
}`;

/**
 * End `$root` and its tree, `$grace` seconds between TERM and KILL.
 *
 * Frozen with STOP first, then read again: a process that forked between the
 * first look and the freeze is caught by the second, and a frozen tree cannot
 * fork. Then TERM, CONT so it can act on it, and KILL for whatever is still
 * there once the grace is over. The list is fixed before anything dies: an
 * orphan is re-parented to the container's init and could not be found from
 * the root any more.
 */
const KILL_SEQUENCE = `pids=$(tree)
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

/**
 * The wrapper the command runs under: `$1` the marker, `$2` the watchdog's
 * limit in seconds, `$3` the script, which reaches the shell as an argument
 * and is never spliced into this one.
 *
 * The wrapper stays: it prints its own pid — the root of everything the run
 * starts, which is what the panel's stop ends — runs the command in the
 * background and waits for it, and leaves with its exit code. The watchdog
 * beside it ends the command's tree at the limit. Its limit is past the
 * panel's own: it only matters when the panel is not there to enforce that one
 * — restarted mid-run, the command would otherwise outlive its record by as
 * long as it liked.
 *
 * Waiting rather than `exec`, so the watchdog can trust the pid it watches:
 * until the wrapper has reaped it, a child's pid cannot be given to another
 * process, and the wrapper ends the watchdog as soon as it has. The watchdog
 * holds none of the run's output pipes, so the run ends when the command does.
 */
export const CONTAINER_WRAPPER = `printf '%s%s\\n' "$1" "$$" >&2
limit=$2
sh -c "$3" &
cmd=$!
${TREE_FUNCTIONS}
(
  waited=0
  while [ "$waited" -lt "$limit" ]; do
    sleep 5
    waited=$((waited + 5))
    kill -0 "$cmd" 2>/dev/null || exit 0
  done
  root=$cmd
  skip=""
  grace=5
  ${KILL_SEQUENCE.replace(/\n/g, "\n  ")}
) </dev/null >/dev/null 2>&1 &
dog=$!
wait "$cmd"
status=$?
kill "$dog" 2>/dev/null
exit "$status"`;

/** The panel's stop: `$1` the root pid, `$2` the grace. */
export const CONTAINER_KILL_TREE = `root=$1
grace=$2
skip=""
case "$root" in ''|*[!0-9]*) exit 2 ;; esac
[ "$root" -gt 1 ] || exit 2
case "$grace" in ''|*[!0-9]*) grace=5 ;; esac
${TREE_FUNCTIONS}
${KILL_SEQUENCE}`;

/** `docker exec` for a run: no stdin, no TTY, the container's own user and working directory. */
export function containerRunArgs(container: string, script: string, marker: string, limitSec: number): string[] {
  return ["exec", container, "sh", "-c", CONTAINER_WRAPPER, "runpanel-task", marker, String(Math.max(1, Math.ceil(limitSec))), script];
}

/**
 * `docker exec` for the stop, as the same user the command ran as — the
 * container's default, like the run itself.
 *
 * Not as root, deliberately. The pid comes from a line on the run's stderr,
 * and a process in the container running as that user could write to that
 * pipe: as root, the stop would hand it a way to end processes it cannot end
 * itself. As the same user it can only do what it already could. A command
 * that switched to another user is the one case this cannot reach.
 */
export function containerKillArgs(container: string, pid: number, graceSec: number): string[] {
  return ["exec", container, "sh", "-c", CONTAINER_KILL_TREE, "runpanel-kill", String(pid), String(graceSec)];
}
