import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import type { CatalogTemplate } from "@/lib/app-catalog";

/** What the app is, and the three things worth knowing before installing it. */
export function AboutApp({ template }: { template: CatalogTemplate }) {
  return (
    <Panel className="space-y-3">
      <p className="text-foreground text-sm">{template.about}</p>
      <ul className="space-y-1.5">
        {template.databases.map((database) => (
          <Fact key={database.service} icon="solar:database-linear">
            Il database {database.engine} è compreso: gira accanto all&apos;app ed è già collegato.
          </Fact>
        ))}
        <Fact icon="solar:archive-linear">
          I dati restano sul server, in {template.volumes.length === 1 ? "un volume" : `${template.volumes.length} volumi`}: un
          nuovo deploy li ritrova come li aveva lasciati.
        </Fact>
        {template.secrets.length > 0 && (
          <Fact icon="solar:key-minimalistic-linear">
            Le password e le chiavi interne le genero io: te le mostro alla fine, una volta sola.
          </Fact>
        )}
      </ul>
      <a
        href={template.website}
        target="_blank"
        rel="noreferrer"
        className="text-accent inline-flex items-center gap-1 text-sm hover:underline"
      >
        Documentazione di {template.name}
        <Icon icon="solar:arrow-right-up-linear" width={14} aria-hidden />
      </a>
    </Panel>
  );
}

function Fact({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <li className="text-muted flex items-start gap-2 text-sm">
      <Icon icon={icon} width={16} className="text-accent mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
