/** What `/api/monitor` answers, as the page reads it. */

export interface ProcessInfo {
  running: boolean;
  pid?: number;
  memory?: number;
  /** Percent of one core, as Docker and PM2 report it. */
  cpu?: number;
  uptime?: number;
}

export interface ServiceInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  port: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
}

/** One container of a running Compose stack. */
export interface StackContainer {
  name: string;
  service: string;
  state: string;
  cpu?: number;
  memory?: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  runtimeType: string;
  status: string;
  port: number | null;
  process: ProcessInfo | null;
  services: ServiceInfo[];
  containers?: StackContainer[];
}

/** A container on the host that is not the panel's. */
export interface OtherContainer {
  name: string;
  state: string;
  stack: string | null;
  cpu?: number;
  memory?: number;
}

export interface MonitorData {
  server: {
    cpu: number;
    memory: { total: number; used: number };
    disk?: { total: number; used: number; free: number };
    uptime: number;
    loadAverage?: number[];
    /** Absent on a server that has not been updated yet: read as one core's worth of nothing. */
    cores?: number;
  };
  projects: ProjectInfo[];
  /** Services belonging to no project, which have no project row to nest under. */
  services: ServiceInfo[];
  others?: OtherContainer[];
}
