import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { CSV_BOM, DEFAULT_SEPARATOR, csvLine, exportFileName, localTimestamp, type CsvSeparator } from "@/lib/audit-csv";
import { exportAudit } from "@/lib/audit-export";
import { ACTION_LABEL, CATEGORY_LABEL, SCOPE_LABEL } from "@/lib/audit-labels";
import { isValidTimeZone } from "@/lib/cron";
import { getSetting } from "@/lib/settings";
import { auditFiltersFrom } from "../filters";

/**
 * The activity log as a CSV file, with the same filters as the page and the
 * same rule as the page for which entries a reader gets (`audit.view` to ask,
 * then entry by entry). Streamed a page at a time.
 *
 * `;` by default, the separator a spreadsheet set to Italian expects;
 * `?separator=comma` for the RFC's. Dates in the panel's time zone, the way
 * the page shows them, plus the exact UTC instant in a column of its own.
 */

export async function GET(request: NextRequest) {
  const denied = await requirePermission("audit.view");
  if (isDenied(denied)) return denied;

  const sp = request.nextUrl.searchParams;
  const separator: CsvSeparator = sp.get("separator") === "comma" ? "," : DEFAULT_SEPARATOR;
  const stored = await getSetting("timezone");
  const timeZone = stored && isValidTimeZone(stored) ? stored : "UTC";
  const filters = auditFiltersFrom(sp);
  const rows = exportAudit(denied.principal, filters);
  const encoder = new TextEncoder();

  // A copy of the log leaving the panel is itself worth a line in it.
  const described = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "audit.export",
    detail: described || "nessun filtro",
    request,
  });

  const header = csvLine(
    [
      `Data e ora (${timeZone})`,
      "UTC",
      "Utente",
      "Azione",
      "Codice azione",
      "Categoria",
      "Tipo di risorsa",
      "Risorsa",
      "ID risorsa",
      "Dettaglio",
      "Indirizzo IP",
    ],
    separator
  );

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_BOM + header));
    },
    async pull(controller) {
      try {
        const next = await rows.next();
        if (next.done) {
          controller.close();
          return;
        }
        const text = next.value
          .map((e) =>
            csvLine(
              [
                localTimestamp(e.at, timeZone),
                e.at,
                e.email ?? (e.userId ? "account eliminato" : "il pannello"),
                ACTION_LABEL[e.action] ?? e.action,
                e.action,
                CATEGORY_LABEL[e.category]?.label ?? e.category,
                e.scope === "permission" ? "area del pannello" : e.scope ? (SCOPE_LABEL[e.scope] ?? e.scope) : "",
                e.scopeName ?? e.scopeId,
                e.scopeId,
                e.detail,
                e.ip,
              ],
              separator
            )
          )
          .join("");
        controller.enqueue(encoder.encode(text));
      } catch (err) {
        // Headers are gone by now: a cut file is the only way left to say it failed.
        console.error("[audit] Export failed:", err instanceof Error ? err.message : err);
        controller.error(err);
      }
    },
    async cancel() {
      await rows.return(undefined);
    },
  });

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName()}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
