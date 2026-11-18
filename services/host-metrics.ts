import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows } from "./env-utils";

const exec = promisify(execFile);

export interface HostMetrics {
  cpu: number;
  memory: { total: number; used: number; free: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
  loadAverage: number[];
  /** Logical CPUs: what a process's `cpu` (a percent of one core) is divided by to become a share of the host. */
  cores: number;
}

/**
 * Host CPU, measured as a delta.
 *
 * `os.cpus()` returns tick counters accumulated since boot. Averaging them —
 * which is what the old metrics endpoint did — yields the machine's lifetime
 * average, a number that barely moves and tells you nothing about now. The
 * only way to get current usage is to compare two samples.
 */
export interface CpuSample {
  idle: number;
  total: number;
  at: number;
}

/**
 * The tick counters now. Exported for the metrics collector, which keeps its
 * own previous sample: sharing this module's would make its reading the usage
 * since whichever page last asked, three seconds ago, rather than over the
 * thirty seconds the chart point stands for.
 */
export function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total, at: Date.now() };
}

let previous: CpuSample | null = null;

/** Shortest gap that yields a meaningful delta rather than counter noise. */
const MIN_SAMPLE_GAP_MS = 200;
let lastUsage = 0;

async function cpuUsage(): Promise<number> {
  const now = sampleCpu();

  if (previous && now.at - previous.at >= MIN_SAMPLE_GAP_MS) {
    lastUsage = percentBetween(previous, now);
    previous = now;
    return lastUsage;
  }

  // Two requests closer together than a useful sampling window — /api/metrics
  // and /api/monitor arrive together on every dashboard load. Returning the
  // last computed figure is both correct (nothing measurable changed in a few
  // milliseconds) and free; sleeping here put 200ms on the critical path of
  // every page.
  if (previous) return lastUsage;

  // First call of the process: there is no earlier sample to diff against, so
  // this one has to take a short reading itself.
  await new Promise((r) => setTimeout(r, MIN_SAMPLE_GAP_MS));
  const second = sampleCpu();
  previous = second;
  lastUsage = percentBetween(now, second);
  return lastUsage;
}

export function percentBetween(a: CpuSample, b: CpuSample): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  const used = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.max(0, Math.min(100, used)) * 10) / 10;
}

export interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

let diskCache: { value: DiskUsage; at: number } | null = null;
let diskRefresh: Promise<DiskUsage> | null = null;
const DISK_TTL_MS = 30_000;

/**
 * Disk usage for the volume RunPanel lives on.
 *
 * Served stale-while-revalidate. The previous implementation used `execSync`,
 * blocking the event loop on every poll; even async, spawning PowerShell costs
 * hundreds of milliseconds on Windows, which is a lot to put on the critical
 * path of a dashboard request for a number that changes by the minute. After
 * the first reading the caller never waits.
 */
export async function diskUsage(): Promise<DiskUsage> {
  const fresh = diskCache && Date.now() - diskCache.at < DISK_TTL_MS;
  if (fresh) return diskCache!.value;

  if (!diskRefresh) {
    diskRefresh = measureDisk().finally(() => {
      diskRefresh = null;
    });
  }

  // Nothing cached yet — the very first caller has to wait for a real reading.
  if (!diskCache) return diskRefresh;

  // Otherwise hand back what we have and let the refresh land in the background.
  return diskCache.value;
}

/**
 * The same three numbers `df` prints, from one `statfs` call.
 *
 * The metrics collector reads the disk every thirty seconds for the life of
 * the panel, which is where spawning `df` — or PowerShell, at hundreds of
 * milliseconds a time — stops being a detail. Same volume as before: `/`, or
 * the drive the panel runs from. Null when the call is not available or
 * answers nonsense, and the process below is asked instead.
 */
async function statfsDisk(): Promise<DiskUsage | null> {
  try {
    const root = isWindows ? `${process.cwd().charAt(0)}:\\` : "/";
    const stat = await fs.promises.statfs(root);
    const block = Number(stat.bsize);
    const total = block * Number(stat.blocks);
    if (!Number.isFinite(total) || total <= 0) return null;
    // `df`'s columns: used is what is taken, free what an ordinary process can
    // still write. They do not add up to the total — the rest is root's reserve.
    return { total, used: total - block * Number(stat.bfree), free: block * Number(stat.bavail) };
  } catch {
    return null;
  }
}

async function measureDisk(): Promise<DiskUsage> {
  const empty: DiskUsage = { total: 0, used: 0, free: 0 };
  let value = empty;

  const quick = await statfsDisk();
  if (quick) {
    diskCache = { value: quick, at: Date.now() };
    return quick;
  }

  try {
    if (isWindows) {
      const drive = process.cwd().charAt(0);
      const { stdout } = await exec(
        "powershell",
        ["-NoProfile", "-Command", `Get-PSDrive ${drive} | Select-Object Used,Free | ConvertTo-Json`],
        { timeout: 10_000, windowsHide: true }
      );
      const data = JSON.parse(stdout) as { Used?: number; Free?: number };
      const used = data.Used ?? 0;
      const free = data.Free ?? 0;
      value = { used, free, total: used + free };
    } else {
      const { stdout } = await exec("df", ["-B1", "/"], { timeout: 10_000 });
      const parts = stdout.trim().split("\n")[1]?.split(/\s+/) ?? [];
      value = {
        total: Number.parseInt(parts[1], 10) || 0,
        used: Number.parseInt(parts[2], 10) || 0,
        free: Number.parseInt(parts[3], 10) || 0,
      };
    }
  } catch {
    value = empty;
  }

  diskCache = { value, at: Date.now() };
  return value;
}

export async function hostMetrics(): Promise<HostMetrics> {
  const [cpu, disk] = await Promise.all([cpuUsage(), diskUsage()]);
  const total = os.totalmem();
  const free = os.freemem();

  return {
    cpu,
    memory: { total, used: total - free, free },
    disk,
    uptime: os.uptime(),
    loadAverage: os.loadavg(),
    cores: Math.max(1, os.cpus().length),
  };
}
