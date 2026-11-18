import { processManager } from "./process-manager";
import { projectEvents } from "./events";

/**
 * Follows a project's process output and republishes it on the event bus.
 *
 * Reference-counted on purpose: three browser tabs watching the same project
 * must not spawn three `docker logs -f` processes. The tail starts on the first
 * subscriber and is torn down shortly after the last one leaves — with a short
 * grace period, so a page navigation does not thrash it.
 *
 * Re-armed when a new run starts. A `docker logs -f` follows one container,
 * and a deploy or a restart replaces it: the tail ended with the old one and
 * the live log went silent until every viewer left and came back. The tail is
 * now started again a few seconds after a run is announced (`process:reset`,
 * emitted just before the new process starts, so once more a little later in
 * case the container took longer), and when a deploy settles.
 */

interface Follower {
  stop: () => void;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
  slug: string;
  runtimeType: string;
  unsubscribe: () => void;
  rearmTimers: NodeJS.Timeout[];
}

const IDLE_GRACE_MS = 10_000;
/** After `process:reset`: by then the new process or container exists. */
const REARM_AFTER_RESET_MS = [3_000, 10_000];

class ProcessLogHub {
  private followers = new Map<string, Follower>();

  private follow(projectId: string, slug: string, runtimeType: string): () => void {
    try {
      return processManager.onOutput(slug, runtimeType, (line, stream) => {
        projectEvents.emit(projectId, { type: "process:log", line, stream });
      });
    } catch (err) {
      console.error(`[process-logs] Could not follow ${slug}:`, err);
      return () => {};
    }
  }

  /** Start the tail again, for a follower somebody is still watching. */
  private rearm(projectId: string): void {
    const follower = this.followers.get(projectId);
    if (!follower || follower.refs === 0) return;
    follower.stop();
    follower.stop = this.follow(projectId, follower.slug, follower.runtimeType);
  }

  private teardown(projectId: string, follower: Follower): void {
    if (follower.idleTimer) clearTimeout(follower.idleTimer);
    for (const timer of follower.rearmTimers) clearTimeout(timer);
    follower.unsubscribe();
    follower.stop();
    this.followers.delete(projectId);
  }

  attach(projectId: string, slug: string, runtimeType: string): () => void {
    let follower = this.followers.get(projectId);

    if (follower) {
      follower.refs++;
      if (follower.idleTimer) {
        clearTimeout(follower.idleTimer);
        follower.idleTimer = null;
      }
    } else {
      const created: Follower = {
        stop: this.follow(projectId, slug, runtimeType),
        refs: 1,
        idleTimer: null,
        slug,
        runtimeType,
        unsubscribe: () => {},
        rearmTimers: [],
      };
      created.unsubscribe = projectEvents.subscribe(projectId, (event) => {
        if (event.type === "process:reset") {
          for (const timer of created.rearmTimers) clearTimeout(timer);
          created.rearmTimers = REARM_AFTER_RESET_MS.map((ms) => setTimeout(() => this.rearm(projectId), ms));
        } else if (event.type === "deploy:status" && (event.status === "running" || event.status === "failed")) {
          this.rearm(projectId);
        }
      });
      follower = created;
      this.followers.set(projectId, follower);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.followers.get(projectId);
      if (!current) return;

      current.refs--;
      if (current.refs > 0) return;

      current.idleTimer = setTimeout(() => {
        const latest = this.followers.get(projectId);
        if (!latest || latest.refs > 0) return;
        this.teardown(projectId, latest);
      }, IDLE_GRACE_MS);
    };
  }

  /** Tear everything down — used when a project is deleted. */
  detachAll(projectId: string): void {
    const follower = this.followers.get(projectId);
    if (!follower) return;
    this.teardown(projectId, follower);
  }
}

const globalRef = globalThis as typeof globalThis & { __runpanelLogHub?: ProcessLogHub };

export const processLogHub = (globalRef.__runpanelLogHub ??= new ProcessLogHub());
