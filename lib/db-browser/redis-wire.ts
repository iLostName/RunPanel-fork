/**
 * Reading Redis through one fixed Lua script.
 *
 * `redis-cli` prints replies for a terminal: a key with a newline in it, or a
 * value that is not text, cannot be told apart in its output. So the browser
 * sends one script, always this one, and the script answers with a single
 * JSON document — SCAN, TYPE, PTTL and a bounded look at the value, in one
 * round trip. What varies (the pattern, the key) is not code: it reaches the
 * script as `ARGV[1]`, read by `redis-cli -x` from stdin, so it is on no
 * command line either.
 *
 * Read-only by construction — every command below is a read — and by the
 * server on Redis 7 and later, which runs it with `EVAL_RO` and refuses a write
 * from it. Bounded: a page looks at a limited number of keys, and every value
 * is cut in the script, before it leaves Redis. A pattern that matches almost
 * nothing costs a few thousand keys per page, never a walk of the keyspace,
 * which would stop Redis for everyone else while it ran.
 *
 * Bytes stay bytes. Redis keys and values are binary; JSON is text. Both ways,
 * each byte travels as the character with the same code (`latin1`): the cjson
 * in Redis writes and reads bytes above 0x7F as they are, and escapes the rest
 * as `\u00XX`. Only here, at the edge, are they decoded as UTF-8 for display.
 *
 * Zero imports (`Buffer` is a Node global): the unit suite loads this file directly.
 */

import type { BrowseBytes } from "./types";

/** What every answer of the script starts with, so that anything else reads as an error. */
export const REDIS_REPLY_MARK = "RPB1";

/** Keys per page, roughly: a SCAN round can return a few more. */
export const REDIS_PAGE_KEYS = 100;
/** Keys a page may look at before it stops and hands back the cursor. */
export const REDIS_SCAN_BUDGET = 20_000;
/** Items of a list, set, hash or sorted set shown. */
export const REDIS_ITEMS = 100;
/** Bytes of a single value, in the preview and when asked for in full. */
export const REDIS_VALUE_CAP = 2_000;
export const REDIS_STRING_CAP = 10_000;
export const REDIS_FULL_CAP = 1_048_576;
/** Longer key names are listed cut, and cannot be opened from here. */
export const REDIS_KEY_CAP = 4_096;

export const REDIS_SCRIPT = `
local p = cjson.decode(ARGV[1])
local function cut(s, cap)
  if type(s) ~= "string" then return {"", 0} end
  if #s > cap then return {string.sub(s, 1, cap), #s} end
  return {s, #s}
end
local function size(k, t)
  if t == "string" then return redis.call("STRLEN", k) end
  if t == "list" then return redis.call("LLEN", k) end
  if t == "set" then return redis.call("SCARD", k) end
  if t == "zset" then return redis.call("ZCARD", k) end
  if t == "hash" then return redis.call("HLEN", k) end
  if t == "stream" then return redis.call("XLEN", k) end
  return -1
end
local function ktype(k)
  return redis.call("TYPE", k)["ok"]
end
if p.op == "scan" then
  local cursor = p.cursor
  local count = p.count
  local keys = {}
  local examined = 0
  repeat
    local r = redis.call("SCAN", cursor, "MATCH", p.pattern, "COUNT", count)
    cursor = r[1]
    examined = examined + count
    local found = r[2]
    for i = 1, #found do
      local k = found[i]
      local t = ktype(k)
      keys[#keys + 1] = {cut(k, p.keycap), t, redis.call("PTTL", k), size(k, t)}
    end
    if #found == 0 and count < 5000 then count = count * 2 end
  until cursor == "0" or #keys >= p.limit or examined >= p.budget
  return "${REDIS_REPLY_MARK}" .. cjson.encode({c = cursor, k = keys, n = redis.call("DBSIZE"), e = examined})
end
if p.op == "key" then
  local k = p.key
  local t = ktype(k)
  local cap = p.cap
  local items = p.items
  local res = {t = t, ttl = redis.call("PTTL", k), n = size(k, t), v = {}}
  if t == "string" then
    res.v = cut(redis.call("GETRANGE", k, 0, p.strcap), p.strcap)
  elseif t == "list" then
    local r = redis.call("LRANGE", k, 0, items - 1)
    for i = 1, #r do res.v[i] = cut(r[i], cap) end
  elseif t == "set" then
    local r = redis.call("SSCAN", k, "0", "COUNT", items)[2]
    for i = 1, math.min(#r, items) do res.v[i] = cut(r[i], cap) end
  elseif t == "zset" then
    local r = redis.call("ZRANGE", k, 0, items - 1, "WITHSCORES")
    for i = 1, #r, 2 do res.v[#res.v + 1] = {cut(r[i], cap), r[i + 1]} end
  elseif t == "hash" then
    local r = redis.call("HSCAN", k, "0", "COUNT", items)[2]
    for i = 1, math.min(#r, items * 2), 2 do res.v[#res.v + 1] = {cut(r[i], cap), cut(r[i + 1], cap)} end
  elseif t == "stream" then
    local r = redis.call("XRANGE", k, "-", "+", "COUNT", math.min(items, 20))
    for i = 1, #r do
      local fields = {}
      local f = r[i][2]
      for j = 1, #f, 2 do fields[#fields + 1] = {cut(f[j], cap), cut(f[j + 1], cap)} end
      res.v[i] = {r[i][1], fields}
    end
  end
  return "${REDIS_REPLY_MARK}" .. cjson.encode(res)
end
return "${REDIS_REPLY_MARK}" .. cjson.encode({err = "op"})
`;

/** Bytes as the string of the same character codes, which JSON carries as they are. */
export function bytesToLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/** The script's argument, written as bytes on stdin. */
export function encodeRedisPayload(payload: Record<string, string | number | boolean>): Buffer {
  return Buffer.from(JSON.stringify(payload), "latin1");
}

export interface RedisScanPayload {
  cursor: string;
  pattern: string;
}

export function scanPayload({ cursor, pattern }: RedisScanPayload): Buffer {
  return encodeRedisPayload({
    op: "scan",
    cursor,
    pattern: bytesToLatin1(new TextEncoder().encode(pattern)),
    count: REDIS_PAGE_KEYS,
    limit: REDIS_PAGE_KEYS,
    budget: REDIS_SCAN_BUDGET,
    keycap: REDIS_KEY_CAP,
  });
}

export function keyPayload(key: Uint8Array, full: boolean): Buffer {
  return encodeRedisPayload({
    op: "key",
    key: bytesToLatin1(key),
    cap: REDIS_VALUE_CAP,
    strcap: full ? REDIS_FULL_CAP : REDIS_STRING_CAP,
    items: REDIS_ITEMS,
  });
}

/** The script's JSON, or null when what came back is something else, such as an error. */
export function decodeRedisReply(stdout: Buffer): unknown {
  const text = stdout.toString("latin1").trim();
  if (!text.startsWith(REDIS_REPLY_MARK)) return null;
  try {
    return JSON.parse(text.slice(REDIS_REPLY_MARK.length));
  } catch {
    return null;
  }
}

/** cjson writes an empty Lua table as `{}`: an empty list here. */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Control characters other than tab and newlines make a value binary rather than text. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

function asText(bytes: Uint8Array, cut: boolean): string | null {
  // A value cut by the script may end inside a character: up to three bytes
  // of it are dropped before deciding that it is not text.
  for (let drop = 0; drop <= (cut ? 3 : 0) && drop <= bytes.length; drop++) {
    try {
      const text = decoder.decode(bytes.subarray(0, bytes.length - drop));
      return hasControl(text) ? null : text;
    } catch {
      /* try one byte shorter */
    }
  }
  return null;
}

/** How redis-cli writes bytes that are not text: `\xHH`, with the usual escapes. */
export function escapeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** A `[bytes, length]` pair from the script, ready to show. */
export function describeBytes(value: unknown): BrowseBytes {
  const pair = Array.isArray(value) ? value : [value, undefined];
  const latin1 = typeof pair[0] === "string" ? pair[0] : "";
  const bytes = Buffer.from(latin1, "latin1");
  const length = typeof pair[1] === "number" ? pair[1] : bytes.length;
  const cut = length > bytes.length;
  const text = asText(bytes, cut);
  return {
    text: text ?? escapeBytes(bytes),
    raw: bytes.toString("base64"),
    binary: text === null,
    ...(cut ? { length } : {}),
  };
}

/** A key handed back by the page, as the bytes it names. Null when it is not base64. */
export function decodeKey(raw: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return null;
  return new Uint8Array(Buffer.from(raw, "base64"));
}
