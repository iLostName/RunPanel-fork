/**
 * Reading MongoDB through one fixed mongosh script.
 *
 * The script is code the panel wrote; what the person chose — the collection,
 * the filter, the page — reaches it as JSON in an environment variable, so it
 * is never evaluated and is on no command line. It only ever calls
 * `getCollectionInfos`, `estimatedDocumentCount` and `find`: no aggregation, so
 * no `$out` or `$merge`, and nothing else that writes.
 *
 * The filter is a query document, which can still run JavaScript on the server
 * through three operators. Those are refused here, before anything is sent.
 * Documents are written as relaxed Extended JSON and cut in the shell, one at a
 * time from a small batch, so a collection of large documents costs the shell
 * one batch of memory and the panel a few kilobytes per document.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export const MONGO_REPLY_MARK = "RPB1";
/** The environment variable the script reads its arguments from. */
export const MONGO_ARGS_VAR = "RP_BROWSE_ARGS";

export const MONGO_PAGE_SIZE = 50;
export const MONGO_DOC_CAP = 20_000;
export const MONGO_FULL_CAP = 1_048_576;
export const MONGO_MAX_COLLECTIONS = 500;
export const MONGO_MAX_FILTER = 10_000;

export const MONGO_SCRIPT = `
(() => {
  const p = JSON.parse(process.env.${MONGO_ARGS_VAR});
  const answer = (value) => print("${MONGO_REPLY_MARK}" + JSON.stringify(value));
  const cut = (text, cap) => (text.length > cap ? { json: text.slice(0, cap), truncated: true } : { json: text, truncated: false });
  try {
    if (p.op === "collections") {
      const infos = db.getCollectionInfos({}, { nameOnly: false, authorizedCollections: true });
      infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const collections = infos.slice(0, p.limit).map((info) => {
        const type = info.type || "collection";
        let count = null;
        if (type === "collection") {
          try {
            count = db.getCollection(info.name).estimatedDocumentCount({ maxTimeMS: 2000 });
          } catch (e) {
            count = null;
          }
        }
        return { name: info.name, type, count: typeof count === "number" ? count : null };
      });
      return answer({ ok: true, collections, truncated: infos.length > p.limit });
    }
    if (p.op === "documents") {
      const filter = EJSON.parse(p.filter);
      let cursor = db.getCollection(p.collection).find(filter);
      if (p.sort === "newest") cursor = cursor.sort({ _id: -1 });
      cursor = cursor.skip(p.skip).limit(p.limit + 1).maxTimeMS(p.timeoutMs).batchSize(10);
      const docs = [];
      while (cursor.hasNext()) {
        const doc = cursor.next();
        const id = doc && doc._id !== undefined ? EJSON.stringify(doc._id, { relaxed: false }) : null;
        docs.push(Object.assign({ id }, cut(EJSON.stringify(doc, { relaxed: true }), p.cap)));
      }
      return answer({ ok: true, docs });
    }
    if (p.op === "document") {
      const found = db.getCollection(p.collection).find({ _id: EJSON.parse(p.id) }).limit(1).maxTimeMS(p.timeoutMs).toArray();
      const doc = found.length ? cut(EJSON.stringify(found[0], null, 2, { relaxed: true }), p.cap) : null;
      return answer({ ok: true, doc });
    }
    return answer({ ok: false, error: "op" });
  } catch (e) {
    return answer({ ok: false, error: String(e && e.message ? e.message : e) });
  }
})();
`;

/** Operators that run JavaScript on the server. */
const SCRIPT_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

function findOperator(value: unknown, depth: number): string | null {
  if (depth > 40) return "profondità";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOperator(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SCRIPT_OPERATORS.has(key)) return key;
      const found = findOperator(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export type FilterCheck = { ok: true; filter: string } | { ok: false; reason: string };

/** Whether a filter typed in the page may be sent, and in which form. Empty means everything. */
export function checkMongoFilter(text: string): FilterCheck {
  const trimmed = text.trim() || "{}";
  if (trimmed.length > MONGO_MAX_FILTER) {
    return { ok: false, reason: `Il filtro è troppo lungo: al massimo ${MONGO_MAX_FILTER.toLocaleString("it-IT")} caratteri.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'Il filtro deve essere JSON, con le virgolette doppie: { "stato": "attivo" }.' };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Il filtro è un oggetto tra graffe: { "campo": "valore" }.' };
  }
  const operator = findOperator(value, 0);
  if (operator === "profondità") return { ok: false, reason: "Il filtro è annidato troppo in profondità." };
  if (operator) {
    return { ok: false, reason: `${operator} esegue codice JavaScript sul server e non è ammesso nel browser: usa la console.` };
  }
  return { ok: true, filter: trimmed };
}

/** The script's answer, from among whatever else mongosh printed. Null when there is none. */
export function decodeMongoReply(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MONGO_REPLY_MARK)) continue;
    try {
      const value: unknown = JSON.parse(trimmed.slice(MONGO_REPLY_MARK.length));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}
