import { useState } from "react";
import { SPINE } from "../tokens";
import Icon from "../components/Icon";
import ShelfMark from "./ShelfMark";
import ShelfInlineEditor from "./ShelfInlineEditor";
import ShelfContextMenu, { type ShelfContextMenuItem } from "./ShelfContextMenu";
import {
  defaultLetterFor,
  loadShelves,
  nextShelfId,
  nextShelfTone,
  saveShelves,
  type Shelf,
} from "./ShelvesData";
import type { SidebarItem, SidebarSection } from "./Sidebar";

interface ContextMenuState {
  shelfId: string;
  x: number;
  y: number;
}

interface RenamingState {
  shelfId: string;
}

const CONTEXT_ITEMS: ShelfContextMenuItem[] = [
  { id: "rename", label: "Rename", icon: "add", kbd: "F2" },
  { id: "pin", label: "Pin to top", icon: "star" },
  { id: "moveUp", label: "Move up", icon: "up", kbd: "⌘↑" },
  { id: "moveDown", label: "Move down", icon: "down", kbd: "⌘↓" },
  { divider: true, id: "_d1", label: "" },
  { id: "hide", label: "Hide", icon: "x" },
  { id: "delete", label: "Delete shelf", icon: "x", danger: true },
];

// Build the SHELVES section. Shape mirrors `Sidebar.tsx`'s
// SidebarSection so the parent can splice it into the sections array
// without special-casing.
//
// State is entirely local + persisted to localStorage. The Sprint M3
// backend (`spine-bf::shelves` + `/api/v1/shelf/*`) replaces this
// with real RDF triples; the prop shape stays compatible. See
// `docs/research/SIDEBAR_IMPLEMENTATION_LOCKED.md` § M3.
export function useShelvesSection({
  activeId,
  onShelfSelect,
}: {
  activeId: string;
  onShelfSelect: (shelfId: string) => void;
}): SidebarSection {
  const [shelves, setShelves] = useState<Shelf[]>(() => loadShelves());
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const persist = (next: Shelf[]) => {
    setShelves(next);
    saveShelves(next);
  };

  const handleCreate = (input: { label: string; letter: string; tone: Shelf["tone"] }) => {
    const next: Shelf[] = [
      ...shelves,
      {
        id: nextShelfId(),
        label: input.label,
        letter: input.letter,
        tone: input.tone,
        parentId: null,
        order: shelves.length,
        memberIds: [],
      },
    ];
    persist(next);
    setCreating(false);
  };

  const handleRename = (shelfId: string, input: { label: string; letter: string; tone: Shelf["tone"] }) => {
    persist(
      shelves.map((s) =>
        s.id === shelfId ? { ...s, label: input.label, letter: input.letter, tone: input.tone } : s,
      ),
    );
    setRenaming(null);
  };

  const handleContextAction = (shelfId: string, action: string) => {
    if (action === "rename") {
      setRenaming({ shelfId });
      return;
    }
    if (action === "delete") {
      persist(shelves.filter((s) => s.id !== shelfId));
      return;
    }
    if (action === "hide") {
      persist(shelves.map((s) => (s.id === shelfId ? { ...s, hidden: true } : s)));
      return;
    }
    if (action === "pin") {
      // Pin = move to order 0, push everyone else down.
      const target = shelves.find((s) => s.id === shelfId);
      if (!target) return;
      const others = shelves.filter((s) => s.id !== shelfId);
      persist([
        { ...target, order: 0 },
        ...others.map((s, i) => ({ ...s, order: i + 1 })),
      ]);
      return;
    }
    if (action === "moveUp" || action === "moveDown") {
      const sorted = [...shelves].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((s) => s.id === shelfId);
      if (idx === -1) return;
      const swapWith = action === "moveUp" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= sorted.length) return;
      const a = sorted[idx];
      const b = sorted[swapWith];
      persist(
        shelves.map((s) => {
          if (s.id === a.id) return { ...s, order: b.order };
          if (s.id === b.id) return { ...s, order: a.order };
          return s;
        }),
      );
      return;
    }
  };

  const visibleShelves = shelves
    .filter((s) => !s.hidden)
    .sort((a, b) => a.order - b.order);

  const items: SidebarItem[] = visibleShelves.map((s) => ({
    id: `shelf:${s.id}`,
    label: s.label,
    count: s.memberIds.length || undefined,
    mark: <ShelfMark letter={s.letter} tone={s.tone} />,
    onContextMenu: (e) => {
      e.preventDefault();
      setContextMenu({ shelfId: s.id, x: e.clientX, y: e.clientY });
    },
  }));

  // Rendered below the items: the active inline-edit (rename), the
  // create-new editor, the "+ New shelf" trigger, and the floating
  // context menu (when open). All sit in the section's `footer` slot
  // so they ride along with the section's vertical layout.
  const renamingShelf = renaming
    ? shelves.find((s) => s.id === renaming.shelfId)
    : null;

  const sectionFooter = (
    <>
      {renamingShelf && (
        <ShelfInlineEditor
          initialLabel={renamingShelf.label}
          initialLetter={renamingShelf.letter}
          initialTone={renamingShelf.tone}
          onCommit={(input) => handleRename(renamingShelf.id, input)}
          onCancel={() => setRenaming(null)}
        />
      )}
      {creating && (
        <ShelfInlineEditor
          initialLabel=""
          initialLetter={defaultLetterFor("Shelf")}
          initialTone={nextShelfTone(shelves)}
          onCommit={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}
      {!creating && !renaming && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "6px 12px 4px",
            padding: "5px 8px 5px 18px",
            borderRadius: 3,
          }}
        >
          <Icon name="add" size={11} color={SPINE.textFaint} />
          <span
            style={{
              fontFamily: SPINE.sans,
              fontSize: 11.5,
              color: SPINE.textFaint,
              fontStyle: "italic",
            }}
          >
            New shelf
          </span>
        </button>
      )}
      {contextMenu && (
        <ShelfContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={CONTEXT_ITEMS}
          onSelect={(action) => handleContextAction(contextMenu.shelfId, action)}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </>
  );

  void activeId;
  void onShelfSelect;

  return {
    title: "Shelves",
    count: visibleShelves.length || undefined,
    action: creating || renaming
      ? undefined
      : { label: "+ new", onClick: () => setCreating(true) },
    items,
    footer: sectionFooter,
  };
}
