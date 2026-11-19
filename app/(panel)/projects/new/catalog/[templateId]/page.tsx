"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCan } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { SUBPAGE_TITLES } from "@/lib/nav";
import { getTemplate, type CatalogInstallResponse } from "@/lib/app-catalog";
import { CatalogLocked } from "../_components/CatalogLocked";
import { InstallForm } from "../_components/InstallForm";
import { InstallResult } from "../_components/InstallResult";

/**
 * Installing one app: its questions, then the install as it happens.
 *
 * A refused install leaves the form as it was, with the reason next to the
 * field it is about. Once the project exists the form is gone for good:
 * pressing its button again would make a second one.
 */
export default function InstallAppPage() {
  const params = useParams<{ templateId: string }>();
  const template = getTemplate(typeof params?.templateId === "string" ? params.templateId : "");
  const href = useServerHref();
  const canCreate = useCan("projects.create");
  const canHost = useCan("host");
  const [result, setResult] = useState<CatalogInstallResponse | null>(null);
  useCrumbLabel(template?.id, template?.name);

  const back = { href: href("/projects/new/catalog"), label: `Torna a ${SUBPAGE_TITLES["/projects/new/catalog"]}` };

  if (!template) {
    return (
      <>
        <PageHeader title="App non trovata" back={back} />
        <EmptyState
          icon="solar:ghost-linear"
          title="Questa app non è nel catalogo"
          description="Il link potrebbe essere vecchio: torna al catalogo e scegline una."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Icon icon={template.icon} width={22} className="text-accent shrink-0" aria-hidden />
            {result ? `Installo «${result.project.name}»` : `Installa ${template.name}`}
          </span>
        }
        description={result ? "Il progetto c'è: ora il primo deploy" : template.description}
        back={result ? undefined : back}
      />

      {!canCreate || !canHost ? (
        <CatalogLocked missing={canCreate ? "host" : "projects.create"} />
      ) : result ? (
        <InstallResult template={template} result={result} />
      ) : (
        <InstallForm template={template} onInstalled={setResult} />
      )}
    </>
  );
}
