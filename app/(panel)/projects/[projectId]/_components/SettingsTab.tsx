"use client";

import { useCallback, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import type { LogLine } from "@/components/ui/LogViewer";
import { SelectField } from "@/components/ui/SelectField";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { AccessPanel } from "@/components/users/AccessPanel";
import { Hint } from "@/components/ui/Hint";
import { LinkButton } from "@/components/ui/LinkButton";
import { useServerHref } from "@/lib/hooks/useNode";
import { useUrlTab } from "@/lib/hooks/useUrlTab";
import { cn } from "@/lib/utils";
import { BackupSection } from "./BackupSection";
import { DomainSection } from "./DomainSection";
import type { PendingSave, RegisterPendingSave } from "./pending-saves";
import { BuildSection } from "./settings/BuildSection";
import { DangerSection } from "./settings/DangerSection";
import { AdvancedSection, AutomationsSection, GeneralSection } from "./settings/MoreSections";
import { NetworkSection } from "./settings/NetworkSection";
import { ResourcesSection } from "./settings/ResourcesSection";
import { SourceSection } from "./settings/SourceSection";
import { useDeployForm } from "./settings/useDeployForm";
import type { Project, SettingsSectionId } from "./types";

const SECTIONS: { id: SettingsSectionId; label: string; icon: string }[] = [
  { id: "general", label: "Generale", icon: "solar:widget-2-linear" },
  { id: "source", label: "Sorgente", icon: "solar:code-linear" },
  { id: "build", label: "Build e avvio", icon: "solar:play-circle-linear" },
  { id: "addresses", label: "Indirizzi", icon: "solar:global-linear" },
  { id: "network", label: "Rete", icon: "solar:routing-linear" },
  { id: "resources", label: "Risorse", icon: "solar:cpu-bolt-linear" },
  { id: "automations", label: "Automazioni", icon: "solar:calendar-linear" },
  { id: "backup", label: "Backup", icon: "solar:safe-square-linear" },
  { id: "advanced", label: "Avanzate", icon: "solar:tuning-square-linear" },
  { id: "permissions", label: "Permessi", icon: "solar:users-group-rounded-linear" },
  { id: "danger", label: "Zona pericolosa", icon: "solar:danger-circle-linear" },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Which menu entry a section that saves on its own (see pending-saves.ts) belongs to. */
const PENDING_SECTION: Record<string, SettingsSectionId> = { backup: "backup", "one-time": "build" };

/**
 * Project settings: a side menu, one section at a time, one save bar.
 *
 * This was one scroll of a dozen boxes and around thirty controls. Each
 * section now answers one question (where the code comes from, how it builds,
 * where it answers…), and they stay mounted while hidden, so an edit in one
 * survives a look at another and the bar saves them all together. The menu
 * marks the sections with unsaved edits.
 *
 * Settings that act at once keep their own buttons, as before: the access
 * restriction (it restarts the app), the addresses, the mounts, the schedule.
 */
export function SettingsTab({
  project,
  onProjectChange,
  onRefresh,
  onDeploy,
  operationLines,
}: {
  project: Project;
  /** Takes an updater: sections save one after another from the same press. */
  onProjectChange: (update: Project | ((prev: Project) => Project)) => void;
  /** Re-read the project from the server, after an action that changed it there. */
  onRefresh: () => void;
  onDeploy: () => void;
  /** What a files move or a mount apply is saying, live. */
  operationLines: LogLine[];
}) {
  const href = useServerHref();
  const [section, setSection] = useUrlTab(SECTION_IDS, "general", "section");
  const [saving, setSaving] = useState(false);
  // Merged rather than replaced: the save answers with the row, and what only
  // the GET works out — the names nginx serves, whether nginx can take a
  // switch, the version folders — would otherwise vanish until the next load,
  // and the settings would say a deploy without downtime cannot work here.
  const form = useDeployForm(project, (updated) => onProjectChange((prev) => ({ ...prev, ...updated })));

  /** Sections with unsaved edits that save through their own endpoint. */
  const [pending, setPending] = useState<Record<string, PendingSave>>({});
  const registerPending = useCallback<RegisterPendingSave>((id, entry) => {
    setPending((prev) => {
      if (!entry) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: entry };
    });
  }, []);
  const pendingIds = Object.keys(pending);
  const dirtyMenu = new Set<SettingsSectionId>([
    ...form.dirtySections,
    ...pendingIds.map((id) => PENDING_SECTION[id]).filter(Boolean),
  ]);
  const unsavedParts = [
    ...SECTIONS.filter((s) => form.dirtySections.includes(s.id)).map((s) => s.label),
    ...pendingIds.map((id) => pending[id].label),
  ];

  /*
    One press, every part with edits. The sections go first, each to its own
    endpoint, and the form last: the PATCH answers with the whole row, so the
    page ends on a copy that includes what the sections wrote. A part that
    fails does not stop the others; the toast names it.
  */
  async function saveAll() {
    setSaving(true);
    const failed: string[] = [];
    try {
      for (const id of pendingIds) {
        if (!(await pending[id].save())) failed.push(pending[id].label);
      }
      if (form.dirty && !(await form.save())) failed.push("Impostazioni");
    } finally {
      setSaving(false);
    }
    if (failed.length === 0) toast.success("Impostazioni salvate");
    else if (!(failed.length === 1 && failed[0] === "Impostazioni")) {
      toast.error(`Non salvato: ${failed.join(", ")}. Il motivo è accanto ai campi.`);
    }
  }

  function resetAll() {
    form.reset();
    for (const id of pendingIds) pending[id].reset();
  }

  const show = (id: SettingsSectionId) => ({ hidden: section !== id });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      {/* A select on phones, a sticky list beside the content from lg up. */}
      <div className="lg:hidden">
        <SelectField
          label="Sezione"
          value={section}
          onChange={(value) => setSection(value as SettingsSectionId)}
          options={SECTIONS.map((s) => ({ value: s.id, label: `${s.label}${dirtyMenu.has(s.id) ? " •" : ""}` }))}
        />
      </div>
      <nav aria-label="Sezioni delle impostazioni" className="hidden lg:block">
        <ul className="sticky top-4 space-y-0.5">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-left text-sm transition-colors",
                  section === s.id ? "bg-surface-secondary text-foreground font-medium" : "text-muted hover:bg-surface-hover hover:text-foreground",
                  s.id === "danger" && "text-danger hover:text-danger"
                )}
              >
                <Icon icon={s.icon} width={16} aria-hidden />
                <span className="flex-1">{s.label}</span>
                {dirtyMenu.has(s.id) && <span className="bg-warning size-2 rounded-full" aria-label="modifiche non salvate" />}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 max-w-3xl">
        <div {...show("general")}>
          <GeneralSection form={form} project={project} />
        </div>
        <div {...show("source")}>
          <SourceSection form={form} project={project} onDeploy={onDeploy} onUploaded={onRefresh} />
        </div>
        <div {...show("build")}>
          <BuildSection form={form} project={project} registerPending={registerPending} onProjectChange={onProjectChange} onRefresh={onRefresh} />
        </div>
        <div {...show("addresses")}>
          <DomainSection projectId={project.id} />
        </div>
        <div {...show("network")}>
          <NetworkSection form={form} project={project} onProjectChange={onProjectChange} />
        </div>
        <div {...show("resources")}>
          <ResourcesSection form={form} project={project} onRefresh={onRefresh} operationLines={operationLines} />
        </div>
        <div {...show("automations")}>
          <AutomationsSection project={project} onProjectChange={onProjectChange} />
        </div>
        <div {...show("backup")}>
          <BackupSection
            project={project}
            onSaved={(backupSettings) => onProjectChange((prev) => ({ ...prev, backup_settings: backupSettings }))}
            registerPending={registerPending}
          />
        </div>
        <div {...show("advanced")}>
          <AdvancedSection form={form} project={project} onRefresh={onRefresh} operationLines={operationLines} />
        </div>
        <div {...show("permissions")}>
          {/* An environment's grants are production's: lib/principal.ts reads them, never its own. */}
          {project.environment_of ? (
            <Hint icon="solar:users-group-rounded-linear" title="Permessi del progetto di produzione">
              <p>Questo ambiente segue i permessi del progetto di produzione: chi può gestire quel progetto gestisce anche questo.</p>
              <LinkButton
                href={href(`/projects/${project.environment_of}?tab=settings&section=permissions`)}
                variant="secondary"
                size="sm"
                className="mt-2"
              >
                Apri i permessi di produzione
              </LinkButton>
            </Hint>
          ) : (
            <AccessPanel kind="project" id={project.id} />
          )}
        </div>
        <div {...show("danger")}>
          <DangerSection project={project} />
        </div>

        <StickySaveBar
          isDirty={unsavedParts.length > 0}
          isPending={saving}
          onSave={() => void saveAll()}
          onReset={resetAll}
          message={`Modifiche non salvate: ${unsavedParts.join(", ")}`}
        />
      </div>
    </div>
  );
}
