import { clip, PUSH_BODY_MAX, PUSH_TITLE_MAX } from "@/lib/push-rules";
import { bytes, duration, type NotifyEvent, type NotifyMessage } from "./messages";

/**
 * What a notification on a phone or a desktop says: a title and one or two
 * short sentences, in plain words.
 *
 * Written apart from the catalogue in `messages.ts` on purpose. A message to
 * Telegram carries the first line of an error, the last line a task printed,
 * a commit subject, a path: right for a chat the operator chose, wrong for a
 * lock screen anyone can glance at. Here there are only the names of things
 * and how they are — "Deploy fallito — api" — and the details stay behind the
 * tap, in the panel, where the reader's permissions apply. Nothing quoted from
 * a process or a remote service ever ends up in a push.
 *
 * A `switch` with no default over every event: adding an event to the
 * catalogue does not compile until it has its words here too.
 */

export interface PushText {
  title: string;
  body: string;
}

const TRIGGER: Record<string, string> = {
  manual: "Avviato a mano",
  webhook: "Deploy automatico da GitHub",
  poll: "Deploy automatico dal controllo periodico",
};

function percentOf(free: number, total: number): number {
  return total > 0 ? Math.round((free / total) * 100) : 0;
}

/** The words for one event. `message` is the catalogue's, whose title is reused where it already names the subject. */
export function describePush(event: NotifyEvent, message: Pick<NotifyMessage, "title">): PushText {
  const text = (title: string, body: string): PushText => ({ title: clip(title, PUSH_TITLE_MAX), body: clip(body, PUSH_BODY_MAX) });

  switch (event.key) {
    case "project.crashed":
      return text(`Progetto fermo — ${event.slug}`, "Non è più in esecuzione, e non è stato il pannello a fermarlo.");

    case "service.crashed":
      return text(
        `Database fermo — ${event.name}`,
        "Non è più in esecuzione, e non è stato il pannello a fermarlo. I progetti collegati probabilmente non riescono a connettersi."
      );

    case "restart.scheduled":
      return text(
        `${message.title} — ${event.name}`,
        event.ok
          ? `${event.kind === "project" ? "Il progetto" : "Il database"} è stato riavviato all'orario previsto.`
          : "Il riavvio non è riuscito e il pannello non riprova da solo: il motivo è nella sua pagina."
      );

    case "docker.down":
      return event.up
        ? text(message.title, "I container con una restart policy dovrebbero essere già tornati su.")
        : text(message.title, "Niente container, niente nuovi database, niente dump nei backup finché non torna.");

    case "disk.low": {
      const free = String(bytes(event.freeBytes));
      const total = String(bytes(event.totalBytes));
      if ("backup" in event) {
        return event.up
          ? text(message.title, `«${event.backup.policy}» ha di nuovo lo spazio che gli serve: ${free} liberi.`)
          : text(message.title, `«${event.backup.policy}»: servono circa ${String(bytes(event.backup.needBytes))}, liberi ${free}.`);
      }
      const percent = percentOf(event.freeBytes, event.totalBytes);
      const level = event.level ?? (event.up ? "ok" : "low");
      if (level === "ok") return text(message.title, `Di nuovo ${free} liberi su ${total} (${percent}%).`);
      if (level === "critical") {
        return text(message.title, `Restano ${free} su ${total} (${percent}%). I backup non partono più e un database può fermarsi: libera spazio adesso.`);
      }
      return text(message.title, `Restano ${free} su ${total} (${percent}%).`);
    }

    case "deploy.finished": {
      const how = TRIGGER[event.trigger] ?? "Deploy";
      const took = duration(event.durationMs);
      return event.ok
        ? text(message.title, `${how}${took ? `, in ${took}` : ""}: l'app risponde.`)
        : text(message.title, `${how}. Il motivo e il log sono nella pagina del progetto.`);
    }

    case "backup.finished": {
      const policy = event.policy ? `«${event.policy}»: ` : "";
      const failedCopies = event.copies?.failed.length ?? 0;
      if (event.status === "success") {
        return text(
          message.title,
          failedCopies > 0
            ? `${policy}l'archivio c'è, ma ${failedCopies === 1 ? "una copia non è arrivata" : `${failedCopies} copie non sono arrivate`} a destinazione.`
            : `${policy}${event.ok === 1 ? "1 elemento" : `${event.ok} elementi`}, ${String(bytes(event.bytes))}.`
        );
      }
      if (event.status === "partial") {
        return text(message.title, `${policy}${event.failed === 1 ? "1 elemento non è stato salvato" : `${event.failed} elementi non sono stati salvati`}.`);
      }
      return text(message.title, `${policy}il motivo è nella pagina dei backup.`);
    }

    case "panel.update":
      return text(
        message.title,
        `${event.behind === 1 ? "1 commit nuovo" : `${event.behind} commit nuovi`}. Si applica dalla pagina Aggiornamenti.`
      );

    case "panel.restarted":
      return text(
        message.title,
        event.afterUpdate ? `Ora è alla versione ${event.version}.` : `Versione ${event.version}. Se non l'hai riavviato tu, è caduto ed è ripartito.`
      );

    case "metrics.high":
      return event.up
        ? text(message.title, `Sotto l'80% da 5 minuti: ora è al ${event.percent}%.`)
        : text(message.title, "Sopra il 90% da almeno 5 minuti. In Salute › Monitor vedi chi la sta usando.");

    case "uptime.down":
      return event.up
        ? text(message.title, "Risponde di nuovo, da qualche minuto senza interruzioni.")
        : text(message.title, `Non ha risposto a due controlli di fila${event.cause ? `: ${event.cause.charAt(0).toLowerCase()}${event.cause.slice(1)}` : ""}.`);

    case "task.failed":
      return event.up
        ? text(message.title, `«${event.task}» di «${event.project}» è tornata a riuscire.`)
        : text(
            message.title,
            `«${event.task}» di «${event.project}» non è riuscita${event.exitCode !== null ? ` (codice di uscita ${event.exitCode})` : ""}${
              event.failures > 1 ? `, ${event.failures} volte di fila` : ""
            }.`
          );
  }
}

/** Several notifications held together while a burst lasted, as one: their titles, newest last. */
export function describePushDigest(titles: readonly string[], dropped: number): PushText {
  const count = titles.length + dropped;
  const listed = titles.slice(-3).join(" · ");
  const more = count - Math.min(3, titles.length);
  return {
    title: clip(`${count} avvisi da RunPanel`, PUSH_TITLE_MAX),
    body: clip(`${listed}${more > 0 ? ` e ${more === 1 ? "un altro" : `altri ${more}`}` : ""}.`, PUSH_BODY_MAX),
  };
}
