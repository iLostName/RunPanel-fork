import fs from "fs";
import { dockerTry, isDockerAvailable, stripAnsi } from "../docker/cli";
import { defaultRouteInterfaces, parseDockerStats, parseNetDev, type ContainerReading } from "@/lib/metrics-math";

/**
 * The two readings the collector takes that are not already somewhere else in
 * the panel. Both answer null rather than throw: a tick that cannot read the
 * network still records the CPU.
 */

/**
 * Bytes in and out of the machine since boot, over the interfaces of the
 * default route. Linux only — `/proc` is the one source that needs no process;
 * elsewhere the host has no network series rather than one that costs a spawn.
 */
export async function readHostNetwork(): Promise<{ rx: number; tx: number } | null> {
  if (process.platform !== "linux") return null;
  try {
    const [route, dev] = await Promise.all([
      fs.promises.readFile("/proc/net/route", "utf8").catch(() => ""),
      fs.promises.readFile("/proc/net/dev", "utf8"),
    ]);
    return parseNetDev(dev, defaultRouteInterfaces(route));
  } catch {
    return null;
  }
}

/**
 * CPU, memory and network of every running container, from ONE
 * `docker stats --no-stream`.
 *
 * Never one call per container: the command costs a couple of seconds
 * whatever it is asked about, because the daemon waits for a second reading to
 * compute the CPU delta, and it answers for all of them at once. The streaming
 * collector behind the Monitor is no help here — it runs only while somebody
 * is looking, by design, and this runs when nobody is.
 */
export async function readContainerStats(): Promise<Map<string, ContainerReading> | null> {
  if (!(await isDockerAvailable())) return null;
  const result = await dockerTry(["stats", "--no-stream", "--format", "{{json .}}"], { timeout: 20_000 });
  // Cursor codes come even without a TTY, and even for a single cycle.
  return result ? parseDockerStats(stripAnsi(result.stdout)) : null;
}
