import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { CATEGORY_LABEL, type CatalogTemplate } from "@/lib/app-catalog";

/** One app of the gallery: what it is for, and the one thing to know before choosing it. */
export function AppCard({ template, href }: { template: CatalogTemplate; href: string }) {
  return (
    <Link href={href} className="block h-full rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Panel interactive padding="compact" className="flex h-full flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="bg-surface-secondary text-accent grid size-10 shrink-0 place-items-center rounded-lg">
            <Icon icon={template.icon} width={22} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm font-medium">{template.name}</p>
            <p className="text-muted truncate text-xs">{CATEGORY_LABEL[template.category]}</p>
          </div>
          <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted shrink-0" aria-hidden />
        </div>
        <p className="text-muted text-sm">{template.description}</p>
        {(template.databases.length > 0 || template.address === "required") && (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
            {template.databases.map((database) => (
              <Badge key={database.service} icon="solar:database-linear">
                {database.engine} compreso
              </Badge>
            ))}
            {template.address === "required" && (
              <Badge tone="warning" icon="solar:lock-keyhole-linear">
                Serve un dominio
              </Badge>
            )}
          </div>
        )}
      </Panel>
    </Link>
  );
}
