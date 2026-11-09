/**
 * What restoring a project's configuration changes about the code it runs.
 *
 * Pure, so `backup-secrets-unit` can hold it to the rules of
 * `PATCH /api/projects/:id`: moving a project to another source takes `host`,
 * and pointing it at another repository uses the panel's token, which takes
 * `github`. A restore that puts back the source already in place changes neither.
 */

export interface ProjectSource {
  source_type: string;
  source_url: string | null;
  source_branch: string;
}

export function configRestoreProblem(
  can: { host: boolean; github: boolean },
  current: ProjectSource,
  next: ProjectSource
): string | null {
  const repository = current.source_url !== next.source_url;
  const source =
    repository || current.source_type !== next.source_type || current.source_branch !== next.source_branch;

  if (source && !can.host) {
    return 'Serve il permesso "Accesso all\'host": cambiare il codice che il progetto esegue';
  }
  if (repository && !can.github) return "Per cambiare il repository serve il permesso GitHub";
  return null;
}
