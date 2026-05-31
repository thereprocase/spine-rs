import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Users, Tag, BookMarked, Building2, Globe } from "lucide-react";
import { callApiJson, isApiError } from "./api/client";
import type { FacetCount } from "./types";

export type FacetKind = "authors" | "tags" | "series" | "publishers" | "languages";

const FACETS: { kind: FacetKind; label: string; Icon: typeof Users }[] = [
  { kind: "authors", label: "Authors", Icon: Users },
  { kind: "tags", label: "Tags", Icon: Tag },
  { kind: "series", label: "Series", Icon: BookMarked },
  { kind: "publishers", label: "Publishers", Icon: Building2 },
  { kind: "languages", label: "Languages", Icon: Globe }
];

export interface FacetBrowserProps {
  /** Called with a ready-to-use search query when a leaf is clicked.
   *  The library's existing client-side filter matches on authors,
   *  tags, publishers, and subjects so a plain-name query works for
   *  every facet kind; series uses the name directly too. */
  onSelectFacet: (kind: FacetKind, name: string) => void;
  /** Incremented by the parent whenever the underlying library changes
   *  (add / edit / remove) so caches can be invalidated. */
  refreshToken: number;
}

interface FacetState {
  expanded: boolean;
  loading: boolean;
  error: string | null;
  items: FacetCount[] | null;
}

export function FacetBrowser({ onSelectFacet, refreshToken }: FacetBrowserProps) {
  const [states, setStates] = useState<Record<FacetKind, FacetState>>(() => {
    const init: Record<FacetKind, FacetState> = {} as Record<FacetKind, FacetState>;
    for (const { kind } of FACETS) {
      init[kind] = { expanded: false, loading: false, error: null, items: null };
    }
    return init;
  });

  // Ref to the currently expanded tree so keyboard navigation can be scoped
  // (Tab is native; arrow keys are custom).
  const treeRef = useRef<HTMLDivElement | null>(null);

  const loadFacet = useCallback(async (kind: FacetKind) => {
    setStates(prev => ({
      ...prev,
      [kind]: { ...prev[kind], loading: true, error: null }
    }));
    try {
      const items = await callApiJson<FacetCount[]>("GET", `/api/v1/facet/${kind}`);
      setStates(prev => ({
        ...prev,
        [kind]: { expanded: true, loading: false, error: null, items }
      }));
    } catch (err) {
      const message = isApiError(err)
        ? err.status === 503
          ? "Library not loaded."
          : `Failed to load ${kind} (${err.status || "network"})`
        : `Failed to load ${kind}`;
      setStates(prev => ({
        ...prev,
        [kind]: { ...prev[kind], loading: false, error: message }
      }));
    }
  }, []);

  // When any expanded facet's refresh token changes, reload its list. We
  // only reload facets the user has actually opened — an idle panel stays
  // idle. New opens go through the expand path and fetch fresh.
  useEffect(() => {
    for (const { kind } of FACETS) {
      if (states[kind].expanded && states[kind].items !== null) {
        void loadFacet(kind);
      }
    }
    // Intentionally excludes `states` from deps; we only want to react to
    // refreshToken changes, not to our own state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, loadFacet]);

  const toggle = (kind: FacetKind) => {
    const state = states[kind];
    if (!state.expanded && state.items === null) {
      void loadFacet(kind);
      return;
    }
    setStates(prev => ({
      ...prev,
      [kind]: { ...prev[kind], expanded: !prev[kind].expanded }
    }));
  };

  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const focusables = treeRef.current?.querySelectorAll<HTMLElement>("[data-facet-focusable]");
    if (!focusables || focusables.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = Array.from(focusables).indexOf(active ?? focusables[0]);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusables[Math.min(focusables.length - 1, idx + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusables[Math.max(0, idx - 1)]?.focus();
    }
  };

  return (
    <div
      className="facet-browser"
      role="tree"
      aria-label="Browse by facet"
      ref={treeRef}
      onKeyDown={onTreeKeyDown}
    >
      {FACETS.map(({ kind, label, Icon }) => {
        const state = states[kind];
        const Chevron = state.expanded ? ChevronDown : ChevronRight;
        return (
          <div key={kind} className="facet-group" role="treeitem" aria-expanded={state.expanded}>
            <button
              type="button"
              className="facet-header"
              onClick={() => toggle(kind)}
              data-facet-focusable
              aria-label={`${state.expanded ? "Collapse" : "Expand"} ${label}`}
              aria-expanded={state.expanded}
            >
              <Chevron size={14} className="facet-chevron" aria-hidden="true" />
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </button>
            {state.expanded && (
              <div className="facet-items" role="group">
                {state.loading && <div className="facet-status">Loading...</div>}
                {state.error && (
                  <div className="facet-status facet-error" role="alert">
                    {state.error}{" "}
                    <button
                      type="button"
                      className="facet-retry"
                      onClick={() => void loadFacet(kind)}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {state.items && state.items.length === 0 && !state.loading && (
                  <div className="facet-status facet-empty">No entries.</div>
                )}
                {state.items && state.items.length > 0 && (
                  <ul className="facet-list">
                    {state.items.map(item => (
                      <li key={item.name}>
                        <button
                          type="button"
                          className="facet-item"
                          onClick={() => onSelectFacet(kind, item.name)}
                          data-facet-focusable
                          aria-label={`Filter by ${label.replace(/s$/, "").toLowerCase()}: ${item.name} (${item.bookCount} books)`}
                        >
                          <span className="facet-item-name" title={item.name}>{item.name || "(none)"}</span>
                          <span className="facet-item-count">{item.bookCount}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
