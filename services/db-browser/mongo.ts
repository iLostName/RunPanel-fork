import { execArgs, mongoShellCall, type ServiceTarget } from "@/lib/service-exec";
import {
  MONGO_ARGS_VAR,
  MONGO_DOC_CAP,
  MONGO_FULL_CAP,
  MONGO_MAX_COLLECTIONS,
  MONGO_PAGE_SIZE,
  MONGO_SCRIPT,
  checkMongoFilter,
  decodeMongoReply,
} from "@/lib/db-browser/mongo-wire";
import type { MongoCollection, MongoDocument, MongoDocumentFull, MongoDocumentPage } from "@/lib/db-browser/types";
import { runInContainer } from "./exec";
import { BrowseError, missingClient, runFailure } from "./errors";

/**
 * MongoDB, through `mongosh` in its own container and the one script in
 * `lib/db-browser/mongo-wire.ts`. The connection and the password are what
 * `mongoShellCall` already does for the console: mongosh reads the password
 * from its environment and is on no command line with it.
 *
 * Only mongosh. The `mongo` shell of MongoDB 5 and earlier has neither the
 * Extended JSON parser the filter needs nor a way to take the password
 * without putting it on argv, so on those images the browser says so.
 */

const QUERY_MS = 10_000;
/** mongosh is a Node program: it takes a second or two to start before it connects. */
const PROCESS_MS = 25_000;
const MAX_BYTES = 8 * 1024 * 1024;

async function mongosh(target: ServiceTarget, database: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const call = mongoShellCall(target, "mongosh", { database, script: MONGO_SCRIPT });
  const env = { ...call.env, [MONGO_ARGS_VAR]: JSON.stringify(args) };
  const argv = [...execArgs(target, env), ...call.argv];
  const run = await runInContainer(argv, { env, timeoutMs: PROCESS_MS, maxBytes: MAX_BYTES });
  if (missingClient(run)) {
    throw new BrowseError("Questo container non ha mongosh: il browser dei dati funziona con MongoDB 6 o successivo.", 501);
  }
  const reply = run.timedOut || run.overflow ? null : decodeMongoReply(run.stdout.toString("utf8"));
  if (!reply) throw runFailure(run, run.stderr.trim() || run.stdout.toString("utf8").trim().slice(0, 2000), PROCESS_MS / 1000);
  if (reply.ok !== true) {
    const said = typeof reply.error === "string" ? reply.error : "errore sconosciuto";
    throw new BrowseError(said.includes("operation exceeded time limit") ? "La lettura ha superato il tempo massimo ed è stata interrotta: restringi il filtro." : said, 422, said);
  }
  return reply;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export async function mongoCollections(target: ServiceTarget, database: string): Promise<{ collections: MongoCollection[]; truncated: boolean }> {
  const reply = await mongosh(target, database, { op: "collections", limit: MONGO_MAX_COLLECTIONS });
  const collections = list(reply.collections).flatMap((item) => {
    const entry = item as Record<string, unknown>;
    if (!entry || typeof entry.name !== "string") return [];
    return [{ name: entry.name, type: typeof entry.type === "string" ? entry.type : "collection", count: typeof entry.count === "number" ? entry.count : null }];
  });
  return { collections, truncated: reply.truncated === true };
}

function toDocument(item: unknown): MongoDocument | null {
  const entry = item as Record<string, unknown>;
  if (!entry || typeof entry.json !== "string") return null;
  return { id: typeof entry.id === "string" ? entry.id : null, json: entry.json, truncated: entry.truncated === true };
}

export async function mongoDocuments(
  target: ServiceTarget,
  database: string,
  collection: string,
  filterText: string,
  sort: "natural" | "newest",
  offset: number
): Promise<MongoDocumentPage> {
  const filter = checkMongoFilter(filterText);
  if (!filter.ok) throw new BrowseError(filter.reason, 400);
  const started = Date.now();
  const reply = await mongosh(target, database, {
    op: "documents",
    collection,
    filter: filter.filter,
    sort,
    skip: offset,
    limit: MONGO_PAGE_SIZE,
    cap: MONGO_DOC_CAP,
    timeoutMs: QUERY_MS,
  });
  const docs = list(reply.docs).flatMap((item) => {
    const doc = toDocument(item);
    return doc ? [doc] : [];
  });
  return {
    docs: docs.slice(0, MONGO_PAGE_SIZE),
    offset,
    hasMore: docs.length > MONGO_PAGE_SIZE,
    limit: MONGO_DOC_CAP,
    elapsedMs: Date.now() - started,
  };
}

export async function mongoDocument(target: ServiceTarget, database: string, collection: string, id: string): Promise<MongoDocumentFull> {
  const reply = await mongosh(target, database, { op: "document", collection, id, cap: MONGO_FULL_CAP, timeoutMs: QUERY_MS });
  const doc = toDocument(reply.doc);
  if (!doc) throw new BrowseError("Il documento non c'è più: è stato eliminato o il suo _id è cambiato.", 404);
  return { json: doc.json, truncated: doc.truncated, limit: MONGO_FULL_CAP };
}
