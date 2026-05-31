import type { IconName } from "../components/Icon";

export interface Command {
  id: string;
  label: string;
  section: string;
  icon?: IconName;
  keyboard?: string;
  meta?: string;
  run: () => void;
}

// Handlers the palette dispatches. All optional so callers can scope
// down the command set (e.g. Bootstrap-phase palette has no
// "reconcile selected" until a book is selected).
export interface PaletteContext {
  onStartNew?: () => void;
  onAddFolder?: () => void;
  onOpenExisting?: () => void;
  onFocusSearch?: () => void;
  onReconcileSelected?: () => void;
  onSwitchLibrary?: () => void;
  onSwitchView?: (view: "grid" | "hybrid" | "list" | "graph" | "timeline") => void;
  onToggleFacets?: () => void;
  onRefresh?: () => void;
  onSyncCalibre?: () => void;
}

export function registerCommands(ctx: PaletteContext): Command[] {
  const commands: Command[] = [];

  if (ctx.onStartNew) {
    commands.push({
      id: "library.new",
      label: "Start a new library",
      section: "Library",
      icon: "books",
      run: ctx.onStartNew,
    });
  }
  if (ctx.onAddFolder) {
    commands.push({
      id: "library.add-folder",
      label: "Add a folder of EPUBs",
      section: "Library",
      icon: "add",
      run: ctx.onAddFolder,
    });
  }
  if (ctx.onOpenExisting) {
    commands.push({
      id: "library.open",
      label: "Open an existing calibre library",
      section: "Library",
      icon: "file",
      meta: "Legacy",
      run: ctx.onOpenExisting,
    });
  }
  if (ctx.onSwitchLibrary) {
    commands.push({
      id: "library.switch",
      label: "Switch library",
      section: "Library",
      icon: "chev",
      run: ctx.onSwitchLibrary,
    });
  }
  if (ctx.onFocusSearch) {
    commands.push({
      id: "nav.focus-search",
      label: "Focus search",
      section: "Go to",
      icon: "search",
      keyboard: "/",
      run: ctx.onFocusSearch,
    });
  }
  if (ctx.onReconcileSelected) {
    commands.push({
      id: "book.reconcile",
      label: "Reconcile selected book against id.loc.gov",
      section: "Selected book",
      icon: "loc",
      meta: "fetch BIBFRAME + MARCXML",
      run: ctx.onReconcileSelected,
    });
  }
  if (ctx.onSwitchView) {
    const viewSpecs: ReadonlyArray<{
      id: string;
      label: string;
      mode: "hybrid" | "grid" | "list" | "graph" | "timeline";
      icon: IconName;
      meta?: string;
    }> = [
      { id: "view.hybrid", label: "Switch to hybrid list (default)", mode: "hybrid", icon: "rows" },
      { id: "view.grid", label: "Switch to cover wall", mode: "grid", icon: "grid" },
      { id: "view.list", label: "Switch to dense table", mode: "list", icon: "list" },
      { id: "view.graph", label: "Switch to knowledge graph", mode: "graph", icon: "link", meta: "alternate view" },
      { id: "view.timeline", label: "Switch to chronological timeline", mode: "timeline", icon: "clock", meta: "alternate view" },
    ];
    for (const spec of viewSpecs) {
      const switchView = ctx.onSwitchView;
      commands.push({
        id: spec.id,
        label: spec.label,
        section: "View",
        icon: spec.icon,
        meta: spec.meta,
        run: () => switchView(spec.mode),
      });
    }
  }
  if (ctx.onToggleFacets) {
    commands.push({
      id: "view.facets",
      label: "Toggle facet browser",
      section: "View",
      icon: "filter",
      run: ctx.onToggleFacets,
    });
  }
  if (ctx.onRefresh) {
    commands.push({
      id: "library.refresh",
      label: "Refresh library",
      section: "Library",
      icon: "circle",
      run: ctx.onRefresh,
    });
  }
  if (ctx.onSyncCalibre) {
    commands.push({
      id: "library.sync-calibre",
      label: "Sync with calibre (advanced)",
      section: "Library",
      icon: "file",
      meta: "writes to metadata.db",
      run: ctx.onSyncCalibre,
    });
  }

  return commands;
}

// Simple substring scoring. Exact prefix beats containment beats
// anything else. Score is lower-is-better so results sort ascending.
export function scoreCommand(command: Command, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const label = command.label.toLowerCase();
  const section = command.section.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1 + label.indexOf(q);
  if (section.includes(q)) return 100 + section.indexOf(q);
  return Number.POSITIVE_INFINITY;
}
