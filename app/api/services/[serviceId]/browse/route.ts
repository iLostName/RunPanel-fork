import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireService } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { browseRequestSchema } from "@/lib/validation";
import { isDockerAvailable } from "@/services/docker/cli";
import { BrowseBusyError, BrowseError, browse } from "@/services/db-browser";

type Params = { params: Promise<{ serviceId: string }> };

/**
 * The data browser of a database: its tables and their rows, a query with a
 * LIMIT, Redis keys, MongoDB documents. Read-only: services/db-browser says how.
 *
 * Reading rows is reading data, so this asks for what the console asks for —
 * operate on the service and the terminal right — and not for the read access
 * that shows the page. A POST although nothing changes: the statement, the
 * filter and the key travel in the body, out of URLs and of the access logs
 * that keep them. No API token may call it, of either kind, and no MCP tool
 * (`services/mcp/panel-api.ts`), where the rows would end up at an
 * assistant's provider: it is a page of the panel, not part of its API.
 *
 * Every read of data goes to the activity log under Terminale, beside the
 * console: what was read, and a typed statement as it was typed, cut short.
 * Never what came back. Listings of names (tables, collections, the Redis
 * databases) are not data and are not recorded.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { serviceId } = await params;
  const denied = await requireService(serviceId, "console");
  if (isDenied(denied)) return denied;
  // A page of the panel, not an endpoint of its API: a token is a credential
  // that lives in scripts and CI logs, and this one would read every table.
  if (denied.session.apiToken) {
    return NextResponse.json({ error: "Il browser dei dati si usa dal pannello, non con un token API." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = browseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const service = await db.selectFrom("services").selectAll().where("id", "=", serviceId).executeTakeFirst();
  if (!service) return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });

  if (!(await isDockerAvailable())) {
    return NextResponse.json({ error: "Docker non è raggiungibile" }, { status: 503 });
  }

  try {
    const outcome = await browse(service, parsed.data);
    const userId = denied.session.user.id;
    if (outcome.audit?.kind === "query") {
      await audit({
        userId,
        category: "terminal",
        action: "service.browse.query",
        scope: "service",
        scopeId: serviceId,
        detail: outcome.audit.detail,
        request,
      });
    } else if (outcome.audit) {
      await audit({
        userId,
        category: "terminal",
        action: "service.browse.read",
        scope: "service",
        scopeId: serviceId,
        detail: outcome.audit.detail,
        request,
      });
    }
    // Rows are nobody's to keep: not the browser's cache, not a proxy's.
    return NextResponse.json(outcome.body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof BrowseBusyError) return NextResponse.json({ error: err.message }, { status: 429 });
    if (err instanceof BrowseError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
    }
    // Anything else is the panel's own failure. Its message is neither sent
    // nor logged: next to the owner's data, nothing here is written down.
    return NextResponse.json({ error: "Lettura non riuscita" }, { status: 500 });
  }
}
