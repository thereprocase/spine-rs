import { useCallback, useEffect, useState } from "react";
import { callApiJson } from "../../api/client";
import type { IconName } from "../../components/Icon";
import type { SidebarItem, SidebarSection } from "../../shell/Sidebar";

export type FacetName = "author" | "tag" | "series" | "publisher" | "language";

export interface FacetLeaf {
  value: string;
  count: number;
}

const FACET_ORDER: FacetName[] = ["author", "tag", "series", "publisher", "language"];
const FACET_SET = new Set<FacetName>(FACET_ORDER);

const FACET_TITLES: Record<FacetName, string> = {
  author: "Authors",
  tag: "Tags",
  series: "Series",
  publisher: "Publishers",
  language: "Languages",
};

const FACET_ICONS: Record<FacetName, IconName> = {
  author: "author",
  tag: "tag",
  series: "series",
  publisher: "books",
  language: "loc",
};

interface FacetState {
  leaves: FacetLeaf[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
}

function emptyState(): FacetState {
  return { leaves: [], loaded: false, loading: false, error: false };
}

interface UseFacetBrowserArgs {
  /** The currently-active sidebar id (e.g. `browse:author:Pratchett`).
   *  The hook renders the matching leaf as selected and dots up the
   *  ancestor branch when collapsed. */
  activeId: string;
  /** Click handler fired when a leaf is selected. The host wires this
   *  to the search bar (typically `setSearchQuery(`${facet}:${value}`)`).
   *  Field-prefix parsing in the backend (project roadmap §S12 step 4 stretch)
   *  interprets it as a typed filter; older backends fall back to
   *  substring search per the "never drop on bad input" principle. */
  onFacetSelect: (facet: FacetName, value: string) => void;
}

interface UseFacetBrowserResult {
  section: SidebarSection;
  /** Sidebar onSelect handler. Returns true when the click was handled by
   *  the BROWSE section (so the host can early-return); false otherwise. */
  handleClick: (id: string) => boolean;
}

// Sidebar BROWSE section per the project roadmap §S13 step 1. Five top-level
// facets (author / tag / series / publisher / language) lazily fetch
// their leaves on first expand. Endpoint per the S13 spec:
//   GET /api/v1/library/facets?facet=<name> → [{ value, count }]
//
// 404 from the endpoint is non-fatal — the section renders the
// expanded-but-empty state with a "facets endpoint not deployed" hint.
// Once the S13 backend lands, the same wire just works.
export function useFacetBrowserSection({
  activeId,
  onFacetSelect,
}: UseFacetBrowserArgs): UseFacetBrowserResult {
  const [expanded, setExpanded] = useState<Set<FacetName>>(new Set());
  const [byFacet, setByFacet] = useState<Record<FacetName, FacetState>>(() => ({
    author: emptyState(),
    tag: emptyState(),
    series: emptyState(),
    publisher: emptyState(),
    language: emptyState(),
  }));
  const [endpointMissing, setEndpointMissing] = useState(false);

  const fetchFacet = useCallback(async (facet: FacetName) => {
    setByFacet((prev) => ({ ...prev, [facet]: { ...prev[facet], loading: true, error: false } }));
    try {
      const list = await callApiJson<FacetLeaf[]>(
        "GET",
        `/api/v1/library/facets?facet=${encodeURIComponent(facet)}`,
      );
      setByFacet((prev) => ({
        ...prev,
        [facet]: { leaves: list ?? [], loaded: true, loading: false, error: false },
      }));
      setEndpointMissing(false);
    } catch (err) {
      const apiErr = err as { status?: number };
      if (apiErr?.status === 404) {
        setEndpointMissing(true);
        setByFacet((prev) => ({
          ...prev,
          [facet]: { leaves: [], loaded: true, loading: false, error: false },
        }));
        return;
      }
      setByFacet((prev) => ({
        ...prev,
        [facet]: { ...prev[facet], loading: false, error: true },
      }));
    }
  }, []);

  useEffect(() => {
    for (const facet of expanded) {
      const state = byFacet[facet];
      if (!state.loaded && !state.loading) {
        void fetchFacet(facet);
      }
    }
    // Intentional: only re-run when the expanded set changes; fetchFacet
    // updates byFacet, which would otherwise cause re-fetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleClick = useCallback(
    (id: string): boolean => {
      if (!id.startsWith("browse:")) return false;
      const rest = id.slice("browse:".length);
      const colon = rest.indexOf(":");

      if (colon === -1) {
        const facet = rest as FacetName;
        if (!FACET_SET.has(facet)) return false;
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(facet)) next.delete(facet);
          else next.add(facet);
          return next;
        });
        return true;
      }

      const facet = rest.slice(0, colon) as FacetName;
      const value = rest.slice(colon + 1);
      if (!FACET_SET.has(facet)) return false;
      if (value.startsWith("_")) return true;
      onFacetSelect(facet, value);
      return true;
    },
    [onFacetSelect],
  );

  const items: SidebarItem[] = [];

  for (const facet of FACET_ORDER) {
    const state = byFacet[facet];
    const isExpanded = expanded.has(facet);
    const branchId = `browse:${facet}`;
    const ancestorActive = activeId.startsWith(`${branchId}:`);

    items.push({
      id: branchId,
      label: FACET_TITLES[facet],
      icon: FACET_ICONS[facet],
      caret: isExpanded ? "down" : "right",
      ancestorActive: !isExpanded && ancestorActive,
      count: state.loaded ? state.leaves.length : undefined,
    });

    if (isExpanded) {
      if (state.loading) {
        items.push({
          id: `${branchId}:_loading`,
          label: "Loading…",
          indent: 1,
          italic: true,
          treeGuide: true,
          lastInGroup: true,
        });
      } else if (state.error) {
        items.push({
          id: `${branchId}:_error`,
          label: "Could not load",
          indent: 1,
          italic: true,
          treeGuide: true,
          lastInGroup: true,
        });
      } else if (state.leaves.length === 0) {
        items.push({
          id: `${branchId}:_empty`,
          label: endpointMissing ? "Facets endpoint not deployed" : "No values",
          indent: 1,
          italic: true,
          treeGuide: true,
          lastInGroup: true,
        });
      } else {
        state.leaves.forEach((leaf, idx) => {
          items.push({
            id: `${branchId}:${leaf.value}`,
            label: leaf.value,
            count: leaf.count,
            indent: 1,
            treeGuide: true,
            lastInGroup: idx === state.leaves.length - 1,
            italic: facet === "tag" || facet === "language",
          });
        });
      }
    }
  }

  const section: SidebarSection = {
    title: "BROWSE",
    items,
  };

  return { section, handleClick };
}
