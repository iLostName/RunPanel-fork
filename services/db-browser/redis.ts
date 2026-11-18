import { execArgs, type ServiceTarget } from "@/lib/service-exec";
import { parseRedisKeyspace } from "@/lib/db-browser/output";
import {
  REDIS_FULL_CAP,
  REDIS_SCRIPT,
  REDIS_STRING_CAP,
  REDIS_VALUE_CAP,
  asList,
  decodeKey,
  decodeRedisReply,
  describeBytes,
  keyPayload,
  scanPayload,
} from "@/lib/db-browser/redis-wire";
import type { RedisKeyDetail, RedisKeyItem, RedisKeyPage, RedisKeyspaceEntry, RedisValue } from "@/lib/db-browser/types";
import { runInContainer, type EngineRun } from "./exec";
import { BrowseError, missingClient, runFailure } from "./errors";

/**
 * Redis, through `redis-cli` in its own container and the one script in
 * `lib/db-browser/redis-wire.ts`. Never KEYS, which walks the whole keyspace
 * in one go and stops the server for everyone while it does; SCAN, a bounded
 * slice at a time, with the cursor handed back to the page.
 *
 * The password travels as REDISCLI_AUTH, like the console's and the backup's.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * `EVAL_RO` from Redis 7, where the server itself refuses a write from the
 * script; plain `EVAL` before it. Remembered per container, so a Redis 6 pays
 * for the question once.
 */
const globalRef = globalThis as typeof globalThis & { __runpanelBrowseEval?: Map<string, string> };
const evalCommand = (globalRef.__runpanelBrowseEval ??= new Map<string, string>());

function authEnv(target: ServiceTarget): Record<string, string> {
  return target.credentials.password ? { REDISCLI_AUTH: target.credentials.password } : {};
}

function failure(run: EngineRun): BrowseError {
  const said = `${run.stdout.toString("utf8")}\n${run.stderr}`.trim();
  if (missingClient(run)) return new BrowseError("redis-cli non è disponibile nel container.", 501);
  return runFailure(run, said.replace(/^\(error\)\s*/, ""), TIMEOUT_MS / 1000);
}

export async function redisKeyspace(target: ServiceTarget): Promise<RedisKeyspaceEntry[]> {
  const env = authEnv(target);
  const args = [...execArgs(target, env), "redis-cli", "--no-auth-warning", "--raw", "INFO", "keyspace"];
  const run = await runInContainer(args, { env, timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024 });
  const text = run.stdout.toString("utf8");
  if (run.code !== 0 || run.timedOut || run.overflow || !text.includes("# Keyspace")) throw failure(run);
  return parseRedisKeyspace(text);
}

async function evalScript(target: ServiceTarget, database: string, payload: Buffer): Promise<Record<string, unknown>> {
  const env = authEnv(target);
  const known = evalCommand.get(target.containerName);
  for (const command of known ? [known] : ["EVAL_RO", "EVAL"]) {
    const args = [
      ...execArgs(target, env, { interactive: true }),
      "redis-cli", "-n", database, "--no-auth-warning", "--raw",
      // The payload is the last argument, read from stdin: on no command line.
      "-x", command, REDIS_SCRIPT, "0",
    ];
    const run = await runInContainer(args, { env, input: payload, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    const reply = decodeRedisReply(run.stdout);
    if (reply && typeof reply === "object" && !Array.isArray(reply)) {
      evalCommand.set(target.containerName, command);
      return reply as Record<string, unknown>;
    }
    const said = `${run.stdout.toString("utf8")} ${run.stderr}`;
    if (command === "EVAL_RO" && !known && /unknown command/i.test(said)) continue;
    throw failure(run);
  }
  throw new BrowseError("Redis non ha risposto come previsto.", 502);
}

const toNumber = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export async function redisScan(target: ServiceTarget, database: string, pattern: string, cursor: string): Promise<RedisKeyPage> {
  const reply = await evalScript(target, database, scanPayload({ cursor, pattern: pattern || "*" }));
  const keys: RedisKeyItem[] = asList(reply.k).map((entry) => {
    const [key, type, ttl, size] = asList(entry);
    const n = toNumber(size, -1);
    return { key: describeBytes(key), type: String(type ?? "none"), ttlMs: toNumber(ttl, -1), size: n >= 0 ? n : null };
  });
  const next = typeof reply.c === "string" ? reply.c : "0";
  return { cursor: next, done: next === "0", keys, dbSize: toNumber(reply.n, 0), examined: toNumber(reply.e, 0) };
}

export async function redisKey(target: ServiceTarget, database: string, raw: string, full: boolean): Promise<RedisKeyDetail> {
  const key = decodeKey(raw);
  if (!key) throw new BrowseError("Chiave non valida: ricarica l'elenco.", 400);
  const reply = await evalScript(target, database, keyPayload(key, full));
  const type = String(reply.t ?? "none");
  const size = toNumber(reply.n, -1);
  const items = asList(reply.v);

  let value: RedisValue;
  switch (type) {
    case "string": {
      const shown = describeBytes(reply.v);
      // The script cut at what it fetched; the length that matters is the real one.
      value = { kind: "string", value: size > 0 && shown.length !== undefined ? { ...shown, length: size } : shown };
      break;
    }
    case "list":
    case "set":
      value = { kind: type, items: items.map((item) => describeBytes(item)) };
      break;
    case "zset":
      value = { kind: "zset", items: items.map((pair) => ({ member: describeBytes(asList(pair)[0]), score: String(asList(pair)[1] ?? "") })) };
      break;
    case "hash":
      value = { kind: "hash", items: items.map((pair) => ({ field: describeBytes(asList(pair)[0]), value: describeBytes(asList(pair)[1]) })) };
      break;
    case "stream":
      value = {
        kind: "stream",
        items: items.map((entry) => ({
          id: String(asList(entry)[0] ?? ""),
          fields: asList(asList(entry)[1]).map((pair) => ({ field: describeBytes(asList(pair)[0]), value: describeBytes(asList(pair)[1]) })),
        })),
      };
      break;
    case "none":
      value = { kind: "none" };
      break;
    default:
      value = { kind: "other" };
  }

  return {
    key: describeBytes([Buffer.from(key).toString("latin1"), key.length]),
    type,
    ttlMs: toNumber(reply.ttl, -2),
    size: size >= 0 ? size : null,
    value,
    shown: type === "string" ? 1 : items.length,
    limit: type === "string" ? (full ? REDIS_FULL_CAP : REDIS_STRING_CAP) : REDIS_VALUE_CAP,
  };
}
