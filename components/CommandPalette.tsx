"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { useExpertMode, useThemeMode } from "@/components/Providers";
import { cn } from "@/lib/utils";
import { NAV_PAGES } from "@/lib/nav";
import { useAllowedNav, useCan } from "@/lib/hooks/useMe";
import { serviceDisplayName } from "@/lib/service-name";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";

/**
 * Ctrl/Cmd+K: go anywhere, do the frequent things.
 *
 * It indexes what the panel already serves — projects and services — rather
 * than adding a search endpoint. That keeps it instant, adds no authenticated
 * surface, and means there is nothing new to keep in sync with the data.
 *
 * The lists are fetched the first time it opens, not on every page load: a
 * shortcut nobody presses should cost nothing.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  /** The hint is a keyboard chord: left out on a phone, which has no keyboard to type it on. */
  chord?: boolean;
  /** Matched by the search but not shown. */
  also?: string;
  icon: string;
  run: () => void | Promise<void>;
}


/** What the search button in the top bar sends: the palette is mounted once, in the layout. */
export const PALETTE_EVENT = "runpanel:palette";

/** Opens the palette from anywhere: the top bar's search, the phone's bottom bar. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

interface Indexed {
  projects: { id: string; name: string; slug: string; memberId?: string; memberName?: string }[];
  services: { id: string; name: string; type: string; memberId?: string; memberName?: string }[];
  /** The catalogue's apps, loaded with the rest so the layout's bundle does not carry it. */
  apps: { id: string; name: string; description: string; keywords: readonly string[]; icon: string }[];
}

export function CommandPalette() {
  const api = useNodeApi();
  const href = useServerHref();
  const { isSolo } = useNode();
  const router = useRouter();
  // The same destinations the sidebar shows, from the same list and filter.
  const allowed = useAllowedNav();
  const PAGES = useMemo(() => NAV_PAGES.filter(allowed), [allowed]);
  const canCreate = useCan("projects.create");
  const canHost = useCan("host");
  const canBackup = useCan("backup");
  const canAutostart = useCan("autostart");
  const { expert, setExpert } = useExpertMode();
  const { mode: themeMode, setMode: setThemeMode } = useThemeMode();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<Indexed>({ projects: [], services: [], apps: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const chord = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      // In a cluster, every server's projects and services, each with its server.
      const read = (url: string) =>
        fetch(url).then((res) => (res.ok ? res.json() : null)).then((body) => (Array.isArray(body) ? body : (body?.items ?? [])));
      const [projects, services, apps] = await Promise.all([
        read(isSolo ? api("/api/projects") : "/api/cluster/projects"),
        read(isSolo ? api("/api/services") : "/api/cluster/services"),
        import("@/lib/app-catalog").then(
          ({ CATALOG }) => CATALOG.map(({ id, name, description, keywords, icon }) => ({ id, name, description, keywords, icon })),
          () => []
        ),
      ]);
      setIndex({ projects, services, apps });
    } catch {
      /* the static pages are still worth offering */
    }
  }, [api, isSolo]);

  // Opening, and the `g x` chords. The guard matters: without it, typing "g"
  // into any field on any page would start a navigation chord.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
    };

    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          setOpen(false);
        } else {
          // Fetched here rather than in an effect: the index is a response to
          // the keypress, and a shortcut nobody presses should cost nothing.
          void load();
          setOpen(true);
        }
        return;
      }

      if (event.key === "Escape" && open) {
        setOpen(false);
        return;
      }

      if (open || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

      if (chord.current === "g") {
        chord.current = null;
        const page = PAGES.find((candidate) => candidate.keys === `g ${event.key.toLowerCase()}`);
        if (page) {
          event.preventDefault();
          router.push(href(page.href));
        }
        return;
      }

      if (event.key.toLowerCase() === "g") {
        chord.current = "g";
        // A chord that is never completed should not wait forever.
        setTimeout(() => (chord.current = null), 1500);
      }
    };

    // The visible way in: a button rather than a shortcut only some people know.
    const onOpenRequest = () => {
      void load();
      setOpen(true);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onOpenRequest);
    };
  }, [open, router, load, PAGES, href]);

  useEffect(() => {
    // Focus only: the input exists only once open is true, so this cannot be
    // done from the handler that opened it.
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = PAGES.map((page) => ({
      id: `page:${page.href}`,
      label: page.label,
      hint: page.keys,
      chord: true,
      icon: page.icon,
      run: () => router.push(href(page.href)),
    }));

    for (const project of index.projects) {
      list.push({
        id: `project:${project.memberId ?? ""}:${project.id}`,
        label: project.name,
        hint: `progetto · ${project.slug}${project.memberName ? ` · ${project.memberName}` : ""}`,
        icon: "solar:folder-linear",
        run: () => router.push(href(`/projects/${project.id}`, project.memberId)),
      });
    }

    for (const service of index.services) {
      list.push({
        id: `service:${service.memberId ?? ""}:${service.id}`,
        label: serviceDisplayName(service),
        hint: `database · ${service.type}${service.memberName ? ` · ${service.memberName}` : ""}`,
        also: service.name,
        icon: "solar:database-linear",
        run: () => router.push(href(`/services/${service.id}`, service.memberId)),
      });
    }

    list.push({
      id: "action:expert",
      label: expert ? "Disattiva la modalità esperto" : "Attiva la modalità esperto",
      hint: "preferenza",
      also: "dettagli tecnici avanzate",
      icon: "solar:code-scan-linear",
      run: () => {
        setExpert(!expert);
        toast.success(expert ? "Modalità esperto disattivata" : "Modalità esperto attivata");
      },
    });
    list.push({
      id: "action:theme",
      label: themeMode === "light" ? "Passa al tema scuro" : "Passa al tema chiaro",
      hint: "preferenza",
      also: "tema aspetto colori",
      icon: themeMode === "light" ? "solar:moon-linear" : "solar:sun-2-linear",
      run: () => setThemeMode(themeMode === "light" ? "dark" : "light"),
    });

    if (canCreate) {
      list.push({
        id: "action:new-project",
        label: "Nuovo progetto",
        hint: "azione",
        icon: "solar:add-circle-linear",
        run: () => router.push(href("/projects/new")),
      });
    }
    // The catalogue, and each of its apps by name: typing "wordpress" should
    // find the way to install it, not only the projects already called that.
    if (canCreate && canHost) {
      list.push({
        id: "action:catalog",
        label: "Installa un'app pronta",
        hint: "azione",
        also: "catalogo modello template app",
        icon: "solar:widget-add-linear",
        run: () => router.push(href("/projects/new/catalog")),
      });
      for (const app of index.apps) {
        list.push({
          id: `catalog:${app.id}`,
          label: `Installa ${app.name}`,
          hint: "app pronta",
          also: `${app.description} ${app.keywords.join(" ")}`,
          icon: app.icon,
          run: () => router.push(href(`/projects/new/catalog/${app.id}`)),
        });
      }
    }
    if (canBackup) {
      list.push({
        id: "action:new-backup",
        label: "Nuova pianificazione di backup",
        hint: "azione",
        icon: "solar:archive-linear",
        run: () => router.push(href("/backups/new")),
      });
    }
    if (canAutostart) {
      list.push({
        id: "action:reconcile",
        label: "Simula l'avvio automatico",
        hint: "azione",
        icon: "solar:power-linear",
        run: async () => {
          const res = await fetch(api("/api/autostart/reconcile"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dryRun: true }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast.error(body.error || "Simulazione non riuscita");
            return;
          }
          toast.success(
            `${(body.entries ?? []).filter((entry: { action: string }) => entry.action === "would-start").length} elementi verrebbero avviati`
          );
        },
      });
    }

    return list;
  }, [index, router, PAGES, api, href, canCreate, canHost, canBackup, canAutostart, expert, setExpert, themeMode, setThemeMode]);

  // Keeps the highlighted row in view while the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`palette-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 12);
    return commands
      .filter((command) =>
        `${command.label} ${command.hint ?? ""} ${command.also ?? ""}`.toLowerCase().includes(needle)
      )
      .slice(0, 12);
  }, [commands, query]);

  const choose = async (command: Command) => {
    setOpen(false);
    setQuery("");
    await command.run();
  };

  /*
    HeroUI's Modal, opened from state like ConfirmDialog: it brings the focus
    trap, Escape, the scroll lock and focus going back to whatever opened it.
    The hand-built overlay had none of them, so Tab walked out of the palette
    into the page underneath it.
  */
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Modal.Container placement="top">
      <Modal.Dialog aria-label="Cerca ed esegui" className="max-w-lg overflow-hidden p-0">
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Icon icon="solar:magnifier-linear" width={16} className="text-muted" aria-hidden />
          {/* A combobox over a listbox: the focus stays in the field, and
              aria-activedescendant tells a screen reader which row the arrows
              are on. The rows used to be plain buttons the reader never heard
              about while typing. */}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `palette-option-${active}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, filtered.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter" && filtered[active]) {
                event.preventDefault();
                void choose(filtered[active]);
              }
            }}
            placeholder="Cerca progetti, database, pagine, azioni…"
            className="text-foreground placeholder:text-muted h-11 flex-1 bg-transparent text-sm outline-none"
            aria-label="Cerca"
          />
          {/* A key hint means nothing on a phone, which has no Esc: there the
              way out is a button. */}
          <kbd className="text-muted border-border hidden rounded border px-1.5 py-0.5 text-meta sm:inline-block">
            esc
          </kbd>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted hover:text-foreground -mr-1 p-1 sm:hidden"
            aria-label="Chiudi"
          >
            <Icon icon="solar:close-circle-linear" width={18} aria-hidden />
          </button>
        </div>

        {filtered.length === 0 && (
          <p className="text-muted px-3 py-6 text-center text-sm">Nessun risultato.</p>
        )}
        <ul
          id="palette-list"
          role="listbox"
          aria-label="Risultati"
          // On a phone: rows a thumb's height, and as much list as the
          // keyboard leaves room for.
          className="max-h-80 overflow-y-auto overscroll-contain p-1 max-md:max-h-[min(60dvh,28rem)]"
        >
          {filtered.map((command, position) => (
            <li
              key={command.id}
              id={`palette-option-${position}`}
              role="option"
              aria-selected={position === active}
            >
              <div
                onClick={() => void choose(command)}
                onMouseEnter={() => setActive(position)}
                className={cn(
                  "max-md:touch-chrome flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-left text-sm max-md:min-h-11",
                  // The palette lists the same destinations as the sidebar, from
                  // the same array, with the same icons — so the highlighted row
                  // should look like the sidebar's, not like a grey rectangle.
                  position === active ? "selected text-foreground" : "text-muted"
                )}
              >
                <Icon
                  icon={command.icon}
                  width={16}
                  aria-hidden
                  className={cn(position === active && "text-accent")}
                />
                <span className="text-foreground flex-1 truncate">{command.label}</span>
                {command.hint && (
                  <span className={cn("text-muted text-xs", command.chord && "max-md:hidden")}>{command.hint}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="border-border text-muted hidden gap-3 border-t px-3 py-2 text-meta sm:flex">
          <span>↑↓ per scegliere</span>
          <span>Invio per aprire</span>
          <span className="ml-auto">Ctrl K ovunque</span>
        </p>
      </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
