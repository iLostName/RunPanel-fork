import { Badge } from "@/components/ui/Badge";
import { copiesLabel, countCopies } from "@/lib/backup-copies";
import { destinationPhrase, destinationsPhrase, type RunView } from "@/components/backups/types";

/**
 * A run's copies as the lists say them. A run from a server on an older
 * version has no `copies`, and reads as the one destination it names.
 */

/** Where the archive is, at the end of a list line: the copies that hold it. */
export function runWhere(run: RunView): string {
  const held = (run.copies ?? []).filter((copy) => copy.status === "done" && copy.destinationId);
  if (held.length === 0) return destinationPhrase(run.destinationType, run.destinationName);
  return destinationsPhrase(held.map((copy) => ({ destinationType: copy.destinationType, destinationName: copy.destinationName })));
}

/** What deleting the run deletes, for its confirmation. */
export function deleteWhere(run: RunView): string {
  const held = (run.copies ?? []).filter((copy) => copy.status === "done");
  if (held.length > 1) {
    return `Ogni copia dell'archivio viene cancellata: ${held.map((copy) => `«${copy.destinationName}»`).join(", ")}.`;
  }
  const only = held[0];
  const type = only?.destinationType ?? run.destinationType;
  const name = only?.destinationName ?? run.destinationName;
  return `L'archivio viene cancellato ${type && type !== "local" && name ? `anche da «${name}»` : "dal disco di questo server"}.`;
}

/**
 * How many copies a finished run has, next to its status — and how many it
 * should have had, in amber, when one did not arrive. Nothing for a run with
 * one destination: one copy is what a backup always was.
 */
export function CopiesBadge({ run }: { run: RunView }) {
  const copies = run.copies ?? [];
  if (copies.length < 2 || run.status === "running" || run.status === "failed") return null;
  const count = countCopies(copies);
  const title =
    count.inFlight > 0
      ? "Una copia è in corso"
      : count.failed > 0
        ? `${count.failed === 1 ? "Una copia non è arrivata" : `${count.failed} copie non sono arrivate`}: l'archivio è nelle altre. Si riprova dalla pagina del backup.`
        : `Una copia in ognuna delle ${count.total} destinazioni`;
  return (
    <span title={title} className="inline-flex">
      <Badge tone={count.failed > 0 ? "warning" : "neutral"} icon="solar:layers-linear">
        {copiesLabel(count)}
      </Badge>
    </span>
  );
}
