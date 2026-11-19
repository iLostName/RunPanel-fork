import type { GlobalPermission } from "./authz";

/**
 * The panel's destinations, in one list.
 *
 * They were written out three times — the sidebar, the command palette, and the
 * breadcrumb's segment map — and the copies had already drifted: "Avvio" in one,
 * "Avvio automatico" in another, and "Overview" left in English in all three.
 * That last one is why this file exists: an English word in an Italian panel is
 * a small thing, but it was on every single screen, and fixing it meant editing
 * three files and hoping there was not a fourth.
 *
 * `label` is Italian. `slug` names are English because they are URLs, and a URL
 * is an identifier rather than something the reader is meant to read.
 *
 * Two levels. `NAV_PAGES` is every page, which is what the palette searches and
 * what the breadcrumb names. `NAV_ITEMS` is the sidebar: the things people work
 * on every day first (projects, databases, domains, backups), then two entries
 * that stand for a group of pages shown as tabs (`NAV_SECTIONS`): Salute, for
 * how the machine is doing, and Team, for who can do what. Settings sit at the
 * bottom. Domains used to be the fourth tab of "Sistema", although every
 * project needs one; health was split between a top-level Monitor and a
 * Diagnostica tab. Every URL stayed where it was: only the grouping changed.
 */

/** A permission, or a list of which any one is enough. */
export type NavPermission = GlobalPermission | readonly GlobalPermission[];

export interface NavPage {
  label: string;
  href: string;
  /** Iconify name. A literal, because the icon bundler greps for these. */
  icon: string;
  /**
   * The filled counterpart, shown while the destination is active. Also a
   * literal, and for the same reason.
   */
  iconActive: string;
  /** Extra path prefixes that also light this item up. */
  owns?: string[];
  /** Shortcut hint shown in the command palette. */
  keys?: string;
  /**
   * The panel-wide permission the page needs. Without it the entry is not
   * shown; the page itself is still refused by its API, this only keeps the
   * menu honest.
   */
  permission?: NavPermission;
}

/**
 * Which block of the sidebar an item sits in.
 *
 * `main` is the single unlabelled entry at the top, `footer` is pinned to the
 * bottom of the rail past a rule. The two in between carry a heading.
 */
export type NavGroupId = "main" | "infra" | "ops" | "footer";

export interface NavItem extends NavPage {
  /**
   * Deliberately not optional. An item with no group would type-check and then
   * silently fail to render, which is the one failure mode this file exists to
   * prevent.
   */
  group: NavGroupId;
}

const PAGE = {
  home: {
    label: "Panoramica",
    href: "/home",
    icon: "solar:widget-2-linear",
    iconActive: "solar:widget-2-bold-duotone",
  },
  projects: {
    label: "Progetti",
    href: "/projects",
    icon: "solar:folder-linear",
    iconActive: "solar:folder-bold-duotone",
    keys: "g p",
  },
  services: {
    label: "Database",
    href: "/services",
    icon: "solar:database-linear",
    iconActive: "solar:database-bold-duotone",
    keys: "g s",
  },
  // Next to the databases: both are things several projects draw on, and both
  // hand them variables. Each server keeps its own, like its projects.
  sharedVariables: {
    label: "Variabili condivise",
    href: "/shared-variables",
    permission: "variables",
    icon: "solar:key-square-linear",
    iconActive: "solar:key-square-bold-duotone",
  },
  backups: {
    label: "Backup",
    href: "/backups",
    permission: "backup",
    icon: "solar:archive-linear",
    iconActive: "solar:archive-bold-duotone",
    keys: "g b",
  },
  monitor: {
    label: "Monitor",
    href: "/monitor",
    permission: "monitor",
    icon: "solar:chart-2-linear",
    iconActive: "solar:chart-2-bold-duotone",
  },
  diagnostics: {
    label: "Diagnostica",
    href: "/diagnostics",
    permission: "diagnostics",
    icon: "solar:health-linear",
    iconActive: "solar:health-bold-duotone",
  },
  autostart: {
    label: "Avvio automatico",
    href: "/autostart",
    permission: "autostart",
    icon: "solar:power-linear",
    iconActive: "solar:power-bold-duotone",
  },
  updates: {
    label: "Aggiornamenti",
    href: "/updates",
    permission: "updates",
    icon: "solar:refresh-circle-linear",
    iconActive: "solar:refresh-circle-bold-duotone",
  },
  storage: {
    label: "Spazio disco",
    href: "/storage",
    permission: "storage",
    icon: "solar:ssd-square-linear",
    iconActive: "solar:ssd-square-bold-duotone",
  },
  servers: {
    label: "Server collegati",
    href: "/servers",
    permission: "nodes",
    icon: "solar:server-2-linear",
    iconActive: "solar:server-2-bold-duotone",
  },
  domains: {
    label: "Domini",
    href: "/domains",
    permission: "host",
    icon: "solar:global-linear",
    iconActive: "solar:global-bold-duotone",
  },
  users: {
    label: "Utenti",
    href: "/users",
    permission: "users.manage",
    icon: "solar:users-group-rounded-linear",
    iconActive: "solar:users-group-rounded-bold-duotone",
  },
  audit: {
    label: "Registro attività",
    href: "/audit",
    permission: "audit.view",
    icon: "solar:history-linear",
    iconActive: "solar:history-bold-duotone",
  },
  account: {
    label: "Account",
    href: "/account",
    icon: "solar:user-circle-linear",
    iconActive: "solar:user-circle-bold-duotone",
  },
  settings: {
    label: "Generale",
    href: "/settings",
    // The owner sees all of it; anyone else only the parts they may manage.
    permission: ["notifications", "registries"],
    icon: "solar:tuning-2-linear",
    iconActive: "solar:tuning-2-bold-duotone",
  },
  github: {
    label: "GitHub",
    href: "/github",
    permission: "github",
    icon: "solar:code-linear",
    iconActive: "solar:code-bold-duotone",
  },
  mcp: {
    label: "AI e API",
    href: "/mcp",
    icon: "solar:stars-linear",
    iconActive: "solar:stars-bold-duotone",
  },
} satisfies Record<string, NavPage>;

export type NavSectionId = "health" | "team" | "settings";

/**
 * The groups of pages that share a sidebar entry. Each page keeps its own URL;
 * the route group's layout draws the tabs above it (`SectionTabs`).
 */
export const NAV_SECTIONS: Record<NavSectionId, { label: string; href: string; tabs: NavPage[] }> = {
  health: {
    label: "Salute",
    href: "/health",
    tabs: [PAGE.monitor, PAGE.diagnostics, PAGE.autostart, PAGE.storage],
  },
  team: { label: "Team", href: "/team", tabs: [PAGE.users, PAGE.audit] },
  // "Generale" first: the owner opening Impostazioni means the panel's settings;
  // anyone without them lands on their own Account, the next tab.
  settings: {
    label: "Impostazioni",
    href: "/preferences",
    tabs: [PAGE.settings, PAGE.account, PAGE.github, PAGE.mcp, PAGE.updates, PAGE.servers],
  },
};

/** Every permission any tab of a section needs; any one shows the entry. */
function sectionPermission(id: NavSectionId): GlobalPermission[] | undefined {
  const tabs = NAV_SECTIONS[id].tabs;
  if (tabs.some((tab) => !tab.permission)) return undefined;
  return tabs.flatMap((tab) => [tab.permission ?? []].flat());
}

function sectionOwns(id: NavSectionId): string[] {
  return NAV_SECTIONS[id].tabs.map((tab) => tab.href);
}

/** Every page, for the command palette and the breadcrumb. */
export const NAV_PAGES: NavPage[] = Object.values(PAGE);

/** The sidebar. Ordered so the flat list reads the same as the grouped rail. */
export const NAV_ITEMS: NavItem[] = [
  { ...PAGE.home, group: "main" },
  { ...PAGE.projects, group: "infra" },
  { ...PAGE.services, group: "infra" },
  { ...PAGE.sharedVariables, group: "infra" },
  { ...PAGE.domains, group: "infra" },
  { ...PAGE.backups, group: "infra" },
  {
    label: "Salute",
    href: "/health",
    icon: "solar:pulse-2-linear",
    iconActive: "solar:pulse-2-bold-duotone",
    group: "ops",
    owns: sectionOwns("health"),
    permission: sectionPermission("health"),
  },
  {
    label: "Team",
    href: "/team",
    icon: "solar:users-group-two-rounded-linear",
    iconActive: "solar:users-group-two-rounded-bold-duotone",
    group: "ops",
    owns: sectionOwns("team"),
    permission: sectionPermission("team"),
  },
  {
    label: "Impostazioni",
    href: "/preferences",
    icon: "solar:settings-linear",
    iconActive: "solar:settings-bold-duotone",
    group: "footer",
    owns: sectionOwns("settings"),
  },
];

/**
 * The labelled blocks, in the order they are drawn. `footer` is absent on
 * purpose: it is pinned outside the scrolling list, so the sidebar reaches for
 * it separately rather than mapping over it here.
 */
export const NAV_GROUPS: { id: NavGroupId; label?: string }[] = [
  { id: "main" },
  { id: "infra", label: "Infrastruttura" },
  { id: "ops", label: "Amministrazione" },
];

/** `allowed` answers for the signed-in user; see `useAllowedNav` in lib/hooks/useMe. */
export const navItemsIn = (group: NavGroupId, allowed: (item: NavPage) => boolean = () => true): NavItem[] =>
  NAV_ITEMS.filter((item) => item.group === group && allowed(item));

/** Whether a set of granted permissions passes a `NavPermission`. */
export function passesNavPermission(
  permission: NavPermission | undefined,
  has: (p: GlobalPermission) => boolean
): boolean {
  if (!permission) return true;
  return typeof permission === "string" ? has(permission) : permission.some(has);
}

/**
 * Breadcrumb labels, derived from the same list plus the segments that are not
 * destinations of their own — a run id's parent, a wizard step.
 */
export const SEGMENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(NAV_PAGES.map((item) => [item.href.replace(/^\//, ""), item.label])),
  policies: "Pianificazioni",
  runs: "Esecuzioni",
  restore: "Ripristino",
  new: "Nuovo",
  // The pages' own titles. Raw, these were the phone's title and its back
  // button ("‹ catalog") as well as a crumb.
  catalog: "App pronte",
  upload: "Ripristina da un archivio",
  api: "Riferimento API",
  // Reached from the bell, not the sidebar: every account has one.
  notifications: "Notifiche",
};

/**
 * Paths that are a level of a URL but not a page. A crumb for one of these is
 * plain text: as a link it led to a 404.
 */
export const CRUMBS_WITHOUT_PAGE = new Set(["/backups/runs", "/backups/policies", "/backups/restore"]);

export function isActiveNav(pathname: string, item: NavPage): boolean {
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.owns ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The destination a path belongs to, detail pages included. */
export const pageAt = (pathname: string): NavPage | undefined => NAV_PAGES.find((page) => isActiveNav(pathname, page));
