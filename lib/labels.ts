/**
 * How the panel's technical names read on screen.
 *
 * Cards showed `node · :3000` and `postgresql 16 · :15432` in monospace: true,
 * and the first thing someone who only wants a site online cannot read. These
 * are the words for the same things, kept in one place so every list, header
 * and form says them the same way. The raw token stays available in expert mode.
 *
 * Zero imports: the unit suite loads this file directly.
 */

const RUNTIME_LABELS: Record<string, string> = {
  node: "Node.js",
  static: "Sito statico",
  docker: "Docker",
  compose: "Docker Compose",
  custom: "Personalizzato",
};

/** "Node.js", "Sito statico"…; an unknown runtime keeps its own name. */
export function runtimeLabel(runtime: string | null | undefined): string {
  if (!runtime) return "Da configurare";
  return RUNTIME_LABELS[runtime] ?? runtime;
}

const ENGINE_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  redis: "Redis",
  mongodb: "MongoDB",
};

/** "PostgreSQL", "Redis"…; an unknown engine keeps its own name. */
export function engineLabel(type: string | null | undefined): string {
  if (!type) return "Database";
  return ENGINE_LABELS[type] ?? type;
}

/** "PostgreSQL 16": the engine as people say it, with its major version. */
export function engineWithVersion(type: string | null | undefined, version: string | null | undefined): string {
  const engine = engineLabel(type);
  return version ? `${engine} ${version}` : engine;
}

/** "1 deploy", "3 deploy": the noun does not change, the zero does. */
export function deployCountLabel(count: number): string {
  if (count <= 0) return "nessun deploy";
  return `${count} deploy`;
}
