"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { ENVIRONMENT_LABEL } from "@/lib/environments";
import { ENVIRONMENTS } from "@/lib/copy";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useServerHref } from "@/lib/hooks/useNode";
import { PromoteDialog } from "./PromoteDialog";
import type { EnvironmentBrief, Family, Project } from "./types";

/**
 * The environments of a project, as a switch at the top of its page:
 * Produzione, Staging, and the previews of open pull requests.
 *
 * Each is a project of its own with its own page, so a member is a link and
 * the one open is marked as the current page — the switch moves between
 * pages, it does not filter this one. Shown only when there is something to
 * switch to: a project without environments keeps its page as it was.
 *
 * On a staging page the row also carries "Promuovi in produzione": the one
 * action that ever changes production from here, next to the two names it
 * moves code between.
 */
export function EnvironmentSwitch({ project, family }: { project: Project; family: Family | null }) {
  const href = useServerHref();
  const [promoteOpen, setPromoteOpen] = useState(false);
  if (!family) return null;

  const members: EnvironmentBrief[] = [family.production, ...(family.staging ? [family.staging] : []), ...family.previews];
  const isStaging = project.environment === "staging" && family.staging?.id === project.id;
  const canDeploy = project.permission?.level !== "read";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <nav aria-label="Ambienti del progetto" className="tab-strip max-w-full overflow-x-auto">
        <ul className="border-border bg-surface flex w-max items-center gap-0.5 rounded-[var(--radius)] border p-0.5">
          {members.map((member) => {
            const current = member.id === project.id;
            const meta = statusMeta(member.status);
            return (
              <li key={member.id}>
                <Link
                  href={href(`/projects/${member.id}`)}
                  aria-current={current ? "page" : undefined}
                  title={`${member.name} · ${meta.label}`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] px-2.5 py-1 text-sm whitespace-nowrap transition-colors max-md:min-h-9",
                    current ? "bg-surface-secondary text-foreground font-medium" : "text-muted hover:bg-surface-hover hover:text-foreground"
                  )}
                >
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[meta.tone], meta.active && "animate-pulse motion-reduce:animate-none")} />
                  {memberLabel(member)}
                  <span className="sr-only">, {meta.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {isStaging && canDeploy && (
        <>
          <Button size="sm" variant="secondary" onPress={() => setPromoteOpen(true)}>
            <Icon icon="solar:square-transfer-vertical-linear" width={16} aria-hidden />
            {ENVIRONMENTS.promote}
          </Button>
          {promoteOpen && <PromoteDialog stagingId={project.id} isOpen={promoteOpen} onOpenChange={setPromoteOpen} />}
        </>
      )}
    </div>
  );
}

function memberLabel(member: EnvironmentBrief): string {
  if (member.environment === "preview") return member.pr ? `PR #${member.pr.number}` : ENVIRONMENT_LABEL.preview;
  return ENVIRONMENT_LABEL[member.environment ?? "production"];
}
