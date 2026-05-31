import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SPINE } from "./tokens";
import Icon from "./components/Icon";
import { scoreCommand, type Command } from "./palette/registerCommands";
import type { BookProjection } from "./projections";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  books?: BookProjection[];
  onSelectBook?: (id: string, openInReader?: boolean) => void;
}

// Lower score = better match; mirrors scoreCommand semantics so we can
// merge command + book scoring into a single ranked list.
function scoreBook(book: BookProjection, query: string): number {
  if (!query) return Number.POSITIVE_INFINITY; // books only show with a query
  const q = query.toLowerCase();
  const title = book.title.toLowerCase();
  const author = book.author.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (author.startsWith(q)) return 5;
  if (title.includes(q)) return 10 + title.indexOf(q);
  if (author.includes(q)) return 50 + author.indexOf(q);
  for (const subj of book.subjects) {
    if (subj.toLowerCase().includes(q)) return 200;
  }
  return Number.POSITIVE_INFINITY;
}

// ⌘K / Ctrl-K palette. 620px wide, top: 140px, vertically stacked as
// input + scrollable results + footer. Backdrop dims the rest of the
// workspace via brightness(0.5) saturate(0.7) on a sibling overlay.
//
// Keyboard: ↑↓ navigate, ⏎ run, ESC close, ⌘1–9 jump to that result.
// Results are scored by `scoreCommand` — substring + section fallback.
export default function CommandPalette({
  isOpen,
  onClose,
  commands,
  books = [],
  onSelectBook,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filtered commands + matching books, merged into one selection list
  // so ↑↓/⏎ flow through both. Books only appear when the user has typed
  // a query — empty palette is action-first per design.
  const { commandResults, bookResults } = useMemo(() => {
    const cmds = !query
      ? commands
      : commands
          .map((command) => ({ command, score: scoreCommand(command, query) }))
          .filter((entry) => Number.isFinite(entry.score))
          .sort((a, b) => a.score - b.score)
          .map((entry) => entry.command);
    const bks = !query
      ? []
      : books
          .map((book) => ({ book, score: scoreBook(book, query) }))
          .filter((entry) => Number.isFinite(entry.score))
          .sort((a, b) => a.score - b.score)
          .slice(0, 12)
          .map((entry) => entry.book);
    return { commandResults: cmds, bookResults: bks };
  }, [commands, books, query]);

  // Single flat list ordering: commands first, books second. Used for
  // arrow-key cursor + ⌘N jump.
  const flatResults = useMemo(
    () => [
      ...commandResults.map((c) => ({ kind: "command" as const, command: c })),
      ...bookResults.map((b) => ({ kind: "book" as const, book: b })),
    ],
    [commandResults, bookResults]
  );


  // Reset selection when the result set changes; keeps the cursor
  // on a valid index instead of pointing past the end of the list.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, flatResults.length]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const runFlat = (idx: number) => {
    const entry = flatResults[idx];
    if (!entry) return false;
    if (entry.kind === "command") {
      entry.command.run();
    } else if (entry.kind === "book") {
      onSelectBook?.(entry.book.id, false);
    }
    onClose();
    return true;
  };

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (flatResults.length === 0 ? 0 : (i + 1) % flatResults.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (flatResults.length === 0 ? 0 : (i - 1 + flatResults.length) % flatResults.length));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const entry = flatResults[selectedIndex];
        if (!entry) return;
        if (entry.kind === "book" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          // ⏎ alone opens the book in the inspector; modifier opens the reader.
          onSelectBook?.(entry.book.id, true);
          onClose();
        } else {
          runFlat(selectedIndex);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (runFlat(idx)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, flatResults, selectedIndex, onClose, onSelectBook]);

  if (!isOpen) return null;

  const grouped = groupBySection(commandResults);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: SPINE.overlay,
          backdropFilter: "brightness(0.85) saturate(0.7)",
          WebkitBackdropFilter: "brightness(0.85) saturate(0.7)",
          zIndex: 1000,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          position: "fixed",
          top: 140,
          left: "50%",
          transform: "translateX(-50%)",
          width: 620,
          background: SPINE.panel,
          border: `1px solid ${SPINE.borderHi}`,
          borderRadius: 4,
          boxShadow: SPINE.shadowModal,
          overflow: "hidden",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: `1px solid ${SPINE.border}`,
            background: SPINE.panel,
          }}
        >
          <Icon name="cmd" size={16} color={SPINE.accent} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: SPINE.text,
              fontFamily: SPINE.sans,
              fontSize: 15,
              padding: 0,
            }}
          />
          <span
            style={{
              fontFamily: SPINE.mono,
              fontSize: 10,
              color: SPINE.textFaint,
              padding: "2px 6px",
              border: `1px solid ${SPINE.border}`,
              borderRadius: 2,
            }}
          >
            ESC
          </span>
        </div>

        <div style={{ maxHeight: 420, overflow: "auto" }}>
          {flatResults.length === 0 ? (
            <div
              style={{
                padding: "28px 18px",
                fontFamily: SPINE.sans,
                fontSize: 12,
                color: SPINE.textDim,
                textAlign: "center",
              }}
            >
              {query ? "No matching commands or books." : "Type to search commands and books…"}
            </div>
          ) : (
            <>
              {grouped.map(({ section, items }) => (
                <div key={section}>
                  <SectionHeader>{section}</SectionHeader>
                  {items.map((command) => {
                    const flatIndex = commandResults.indexOf(command);
                    const isSelected = flatIndex === selectedIndex;
                    return (
                      <button
                        key={command.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                        onClick={() => runFlat(flatIndex)}
                        style={paletteRowStyle(isSelected)}
                      >
                        {command.icon && (
                          <Icon
                            name={command.icon}
                            size={14}
                            color={isSelected ? SPINE.accent : SPINE.textDim}
                          />
                        )}
                        <span style={{ fontFamily: SPINE.sans, fontSize: 13, color: SPINE.text, flex: 1 }}>
                          {command.label}
                        </span>
                        {command.meta && (
                          <span style={{ fontFamily: SPINE.mono, fontSize: 10, color: SPINE.textFaint }}>
                            {command.meta}
                          </span>
                        )}
                        {command.keyboard && (
                          <span
                            style={{
                              fontFamily: SPINE.mono,
                              fontSize: 10,
                              color: SPINE.textDim,
                              padding: "1px 5px",
                              border: `1px solid ${SPINE.border}`,
                              borderRadius: 2,
                            }}
                          >
                            {command.keyboard}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {bookResults.length > 0 && (
                <div>
                  <SectionHeader>Books</SectionHeader>
                  {bookResults.map((book, idxWithinBooks) => {
                    const flatIndex = commandResults.length + idxWithinBooks;
                    const isSelected = flatIndex === selectedIndex;
                    return (
                      <button
                        key={book.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                        onClick={() => runFlat(flatIndex)}
                        style={paletteRowStyle(isSelected)}
                      >
                        <Icon name="books" size={14} color={isSelected ? SPINE.accent : SPINE.textDim} />
                        <span
                          style={{
                            fontFamily: SPINE.serif,
                            fontStyle: "italic",
                            fontSize: 13,
                            color: SPINE.text,
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {book.title}
                        </span>
                        <span
                          style={{
                            fontFamily: SPINE.sans,
                            fontSize: 11,
                            color: SPINE.textMid,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 160,
                          }}
                        >
                          {book.author}
                        </span>
                        {book.workDate && (
                          <span
                            style={{
                              fontFamily: SPINE.mono,
                              fontSize: 10,
                              color: SPINE.textFaint,
                            }}
                          >
                            {book.workDate}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "8px 14px",
            background: SPINE.canvas,
            borderTop: `1px solid ${SPINE.border}`,
            fontFamily: SPINE.mono,
            fontSize: 10,
            color: SPINE.textFaint,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Icon name="up" size={10} />
            <Icon name="down" size={10} /> navigate
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Icon name="return" size={10} /> run
          </span>
          <span>⌘1–9 jump</span>
          <div style={{ flex: 1 }} />
          <span>
            {commandResults.length} command{commandResults.length === 1 ? "" : "s"}
            {bookResults.length > 0 && ` · ${bookResults.length} book${bookResults.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>
    </>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 14px 4px",
        fontFamily: SPINE.sans,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: SPINE.textFaint,
      }}
    >
      {children}
    </div>
  );
}

function paletteRowStyle(isSelected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 14px",
    background: isSelected ? SPINE.surface : "transparent",
    borderLeft: isSelected ? `2px solid ${SPINE.accent}` : "2px solid transparent",
    borderTop: "none",
    borderRight: "none",
    borderBottom: "none",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    font: "inherit",
    color: "inherit",
  };
}

function groupBySection(commands: Command[]): { section: string; items: Command[] }[] {
  const order: string[] = [];
  const map = new Map<string, Command[]>();
  for (const command of commands) {
    if (!map.has(command.section)) {
      map.set(command.section, []);
      order.push(command.section);
    }
    map.get(command.section)!.push(command);
  }
  return order.map((section) => ({ section, items: map.get(section)! }));
}
