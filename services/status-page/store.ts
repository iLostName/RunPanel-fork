import { getSetting, setSetting } from "@/lib/settings";
import { STATUS_PAGE_SETTING, parseStatusPageConfig, type StatusPageConfig } from "@/lib/status-page";
import { invalidateStatusSnapshot } from "./snapshot";

/**
 * Where the public status page is kept: one JSON row in `settings`, like the
 * mail server. A singleton with a handful of fields and a short list needs
 * no table of its own, and the panel's backup already carries `settings`.
 *
 * Projects are referenced by id rather than by foreign key: a project on
 * another server has no row here to point at. A deleted one is simply left
 * off the page (`assembleSnapshot`) and off the list on the settings page.
 */

export async function readStatusPageConfig(): Promise<StatusPageConfig | null> {
  return parseStatusPageConfig(await getSetting(STATUS_PAGE_SETTING));
}

export async function writeStatusPageConfig(config: StatusPageConfig): Promise<void> {
  await setSetting(STATUS_PAGE_SETTING, JSON.stringify(config));
  // Whether the page answers, its title and its message are read on every
  // request; only the projects' figures are cached. Dropping them too means
  // the owner, opening the page right after saving, sees what was saved.
  invalidateStatusSnapshot();
}
