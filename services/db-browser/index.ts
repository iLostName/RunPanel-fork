import { createHash } from "crypto";
import type { ServicesTable } from "@/lib/db/schema";
import type { BrowseRequest } from "@/lib/validation";
import { serviceTarget } from "@/services/service-databases";
import { withBrowseSlot } from "./exec";
import { BrowseError, STOPPED } from "./errors";
import { pgCell, pgQuery, pgTablePage, pgTables } from "./postgres";
import { myCell, myQuery, myTablePage, myTables } from "./mysql";
import { redisKey, redisKeyspace, redisScan } from "./redis";
import { mongoCollections, mongoDocument, mongoDocuments } from "./mongo";

export { BrowseError } from "./errors";
export { BrowseBusyError } from "./exec";

/**
 * The data browser: what the database page's "Dati" tab asks for.
 *
 * Read-only from the first line to the last, and in layers, so that no single
 * mistake turns it into a writer: the route asks for the console permission
 * (reading rows is reading data); the typed query goes through
 * `lib/db-browser/sql-guard.ts`; every statement runs in a READ ONLY
 * transaction of a session that is read-only itself; the Redis and MongoDB
 * scripts are fixed and only read. Every call has a time limit in the engine
 * and another around the process, and a cap on what the panel reads back.
 *
 * What it returns besides the answer is the line for the activity log: what
 * was read, never what came back.
 */

export interface BrowseOutcome {
  body: unknown;
  /** Null for listings of names, which are not data. */
  audit: { kind: "read" | "query"; detail: string } | null;
}

const ENGINE_ACTIONS: Record<string, ReadonlySet<BrowseRequest["action"]>> = {
  postgresql: new Set(["tables", "rows", "cell", "query"]),
  mysql: new Set(["tables", "rows", "cell", "query"]),
  redis: new Set(["keyspace", "keys", "key"]),
  mongodb: new Set(["collections", "documents", "document"]),
};

/** What the log may say about text a person typed: its start, on one line. */
function excerpt(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A Redis key can be a credential of its own — `session:<token>` is the usual
 * shape — and the log is read by people who were not given the console. So it
 * records which key was read by fingerprint, the start of the SHA-256 of its
 * bytes: whoever has the key can match it (`printf %s KEY | sha256sum`), and
 * nobody can turn it back into the key.
 */
function fingerprint(raw: string): string {
  return createHash("sha256").update(Buffer.from(raw, "base64")).digest("hex").slice(0, 12);
}

function qualified(schema: string | null | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

export function browseSupported(type: string): boolean {
  return type in ENGINE_ACTIONS;
}

export async function browse(service: ServicesTable, input: BrowseRequest): Promise<BrowseOutcome> {
  const allowed = ENGINE_ACTIONS[service.type];
  if (!allowed) throw new BrowseError("Questo tipo di database non si può sfogliare dal pannello.", 400);
  if (!allowed.has(input.action)) throw new BrowseError("Questa lettura non vale per questo tipo di database.", 400);
  if (service.status !== "running") throw new BrowseError(STOPPED, 409);

  const target = serviceTarget(service);
  const sql = service.type === "postgresql";

  return withBrowseSlot(service.id, async (): Promise<BrowseOutcome> => {
    switch (input.action) {
      case "tables":
        return { body: sql ? await pgTables(target, input.database) : await myTables(target, input.database), audit: null };

      case "rows": {
        if (sql && !input.schema) throw new BrowseError("Indica lo schema della tabella.", 400);
        const body = sql
          ? await pgTablePage(target, input.database, input.schema ?? "", input.table, input.offset)
          : await myTablePage(target, input.database, input.table, input.offset);
        return {
          body,
          audit: { kind: "read", detail: `${input.database} · ${qualified(input.schema, input.table)} · dalla riga ${input.offset + 1}` },
        };
      }

      case "cell": {
        if (sql && !input.schema) throw new BrowseError("Indica lo schema della tabella.", 400);
        const body = sql
          ? await pgCell(target, input.database, input.schema ?? "", input.table, input.column, input.row)
          : await myCell(target, input.database, input.table, input.column, input.row);
        return {
          body,
          audit: { kind: "read", detail: `${input.database} · ${qualified(input.schema, input.table)} · valore completo di ${input.column}` },
        };
      }

      case "query": {
        const body = sql
          ? await pgQuery(target, input.database, input.sql, input.offset)
          : await myQuery(target, input.database, input.sql, input.offset);
        return { body, audit: { kind: "query", detail: `${input.database} · ${excerpt(input.sql)}` } };
      }

      case "keyspace":
        return { body: { databases: await redisKeyspace(target) }, audit: null };

      case "keys": {
        const body = await redisScan(target, input.database, input.pattern, input.cursor);
        return { body, audit: { kind: "read", detail: `db ${input.database} · chiavi ${excerpt(input.pattern || "*", 120)}` } };
      }

      case "key": {
        const body = await redisKey(target, input.database, input.key, input.full ?? false);
        return { body, audit: { kind: "read", detail: `db ${input.database} · chiave sha256:${fingerprint(input.key)}` } };
      }

      case "collections":
        return { body: await mongoCollections(target, input.database), audit: null };

      case "documents": {
        const body = await mongoDocuments(target, input.database, input.collection, input.filter, input.sort, input.offset);
        const filter = input.filter.trim() ? ` · filtro ${excerpt(input.filter, 200)}` : "";
        return { body, audit: { kind: "read", detail: `${input.database} · ${input.collection}${filter}` } };
      }

      case "document": {
        const body = await mongoDocument(target, input.database, input.collection, input.id);
        return { body, audit: { kind: "read", detail: `${input.database} · ${input.collection} · documento ${excerpt(input.id, 120)}` } };
      }
    }
  });
}
