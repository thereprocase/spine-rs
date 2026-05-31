import { useState } from "react";
import { SPINE } from "../tokens";
import Cover from "../components/Cover";
import Badge from "../components/Badge";
import ReadMeter from "../components/ReadMeter";
import Icon from "../components/Icon";
import type { BookProjection } from "../projections";
import type { Density } from "../shell/Toolbar";

export type SelectMode = "replace" | "toggle" | "range";

interface HybridListProps {
  books: BookProjection[];
  selectedIds: Set<string>;
  /** When the selection has more than one book, this is the row that
   *  acts as the single-book affordance anchor (Inspector target). It
   *  renders with full accent emphasis; the rest of the set uses a
   *  softer treatment so the primary stays distinguishable. */
  primarySelectedId?: string | null;
  onSelect: (id: string, mode: SelectMode) => void;
  onOpen?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  emptyMessage?: string;
  density?: Density;
}

interface HybridDensitySpec {
  rowPaddingY: number;
  rowPaddingX: number;
  coverW: number;
  titleSize: number;
  authorSize: number;
  metaSize: number;
  showSubjects: boolean;
  rowGap: number;
}

const HYBRID_DENSITY: Record<Density, HybridDensitySpec> = {
  dense: {
    rowPaddingY: 5,
    rowPaddingX: 18,
    coverW: 36,
    titleSize: 12,
    authorSize: 11,
    metaSize: 10,
    showSubjects: false,
    rowGap: 2,
  },
  balanced: {
    rowPaddingY: 10,
    rowPaddingX: 18,
    coverW: 46,
    titleSize: 14,
    authorSize: 12,
    metaSize: 10,
    showSubjects: true,
    rowGap: 3,
  },
  relaxed: {
    rowPaddingY: 14,
    rowPaddingX: 22,
    coverW: 56,
    titleSize: 15,
    authorSize: 13,
    metaSize: 11,
    showSubjects: true,
    rowGap: 4,
  },
};

// Daily-driver library row. 10×18 padding, borderSoft bottom hairline.
// Rows:
//   1. 46px cover · serif italic title · mono date-pair · badges
//   2. 12px sans author
//   3. 10px mono meta (publisher · format · pages · spacer · progress)
//   4. subject chips (first 2 + +N overflow)
//
// Takes projected shape so the raw Book → projection mapping happens
// once in the parent. Selected row: `surface` bg + 2px accent left-border.
export default function HybridList({
  books,
  selectedIds,
  primarySelectedId,
  onSelect,
  onOpen,
  onContextMenu,
  emptyMessage = "No books in this view.",
  density = "balanced",
}: HybridListProps) {
  const d = HYBRID_DENSITY[density];
  // Cover hover-zoom: pausing on a row's small cover floats a 240px
  // popup near the cursor. Closes on row leave or list scroll.
  const [zoomedBook, setZoomedBook] = useState<{ book: BookProjection; y: number } | null>(null);
  if (books.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
          fontFamily: SPINE.sans,
          fontSize: 13,
          color: SPINE.textDim,
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        background: SPINE.canvas,
        fontFamily: SPINE.sans,
        position: "relative",
      }}
      onScroll={() => setZoomedBook(null)}
    >
      {books.map((book) => (
        <HybridRow
          key={book.id}
          book={book}
          isSelected={selectedIds.has(book.id)}
          isPrimary={primarySelectedId === book.id && selectedIds.size > 1}
          isMultiSelect={selectedIds.size > 1}
          onSelect={onSelect}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          density={d}
          onCoverEnter={(y) => setZoomedBook({ book, y })}
          onCoverLeave={() => setZoomedBook(null)}
        />
      ))}
      {zoomedBook && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: Math.min(Math.max(zoomedBook.y - 180, 60), window.innerHeight - 380),
            left: 248,
            zIndex: 800,
            padding: 6,
            background: SPINE.panel,
            border: `1px solid ${SPINE.borderHi}`,
            borderRadius: 4,
            boxShadow: SPINE.shadowModal,
            pointerEvents: "none",
          }}
        >
          <Cover
            title={zoomedBook.book.title}
            author={zoomedBook.book.author}
            instances={zoomedBook.book.instances}
            w={240}
            bookId={zoomedBook.book.id}
            hasCover={zoomedBook.book.hasCover}
          />
        </div>
      )}
    </div>
  );
}

interface HybridRowProps {
  book: BookProjection;
  isSelected: boolean;
  /** True when this row is BOTH selected AND the multi-select primary
   *  (Inspector anchor). False for single-selection or non-primary
   *  members of a multi-set. Drives the heavier accent treatment. */
  isPrimary: boolean;
  /** True iff the selection set has more than one row. Used to decide
   *  whether `isSelected && !isPrimary` should render with the dim
   *  accent (multi-set non-primary) or the full accent (single-select). */
  isMultiSelect: boolean;
  onSelect: (id: string, mode: SelectMode) => void;
  onOpen?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  density: HybridDensitySpec;
  onCoverEnter?: (clientY: number) => void;
  onCoverLeave?: () => void;
}

function HybridRow({ book, isSelected, isPrimary, isMultiSelect, onSelect, onOpen, onContextMenu, density, onCoverEnter, onCoverLeave }: HybridRowProps) {
  const datePair = formatDatePair(book.workDate, book.pubDate);
  const metaChunks = buildMetaChunks(book);
  const visibleSubjects = book.subjects.slice(0, 2);
  const overflowCount = Math.max(0, book.subjects.length - 2);

  return (
    <div
      data-book-id={book.id}
      onClick={(e) => {
        const mode: SelectMode = e.shiftKey ? "range" : (e.metaKey || e.ctrlKey) ? "toggle" : "replace";
        onSelect(book.id, mode);
      }}
      onDoubleClick={() => onOpen?.(book.id)}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(book.id, e.clientX, e.clientY);
      }}
      onMouseLeave={() => onCoverLeave?.()}
      style={{
        display: "flex",
        gap: 14,
        padding: `${density.rowPaddingY}px ${density.rowPaddingX}px`,
        borderBottom: `1px solid ${SPINE.borderSoft}`,
        background: isSelected ? SPINE.surface : "transparent",
        // Single-select always renders with the full accent so it reads at
        // the same emphasis as pre-Step-7. The dim arm is reserved for
        // non-primary members of a multi-select set.
        borderLeft: isPrimary
          ? `3px solid ${SPINE.accent}`
          : isSelected && isMultiSelect
          ? `2px solid ${SPINE.accentDim}`
          : isSelected
          ? `2px solid ${SPINE.accent}`
          : "2px solid transparent",
        cursor: "pointer",
        alignItems: "flex-start",
      }}
    >
      <div
        onMouseEnter={(e) => onCoverEnter?.(e.clientY)}
        style={{ flexShrink: 0 }}
      >
        <Cover
          title={book.title}
          author={book.author}
          instances={book.instances}
          w={density.coverW}
          bookId={book.id}
          hasCover={book.hasCover}
          style={{ marginTop: 2 }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: density.rowGap }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{
              fontFamily: SPINE.serif,
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: density.titleSize,
              color: SPINE.text,
              maxWidth: "60%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={book.title}
          >
            {book.title}
          </span>
          {datePair && (
            <span
              style={{
                fontFamily: SPINE.mono,
                fontSize: 10,
                color: SPINE.textFaint,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {datePair}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {book.status === "reconciled" ? (
            <Badge kind="reconciled" label={<Icon name="check" size={9} />} />
          ) : (
            <Badge kind="local" label="LOCAL" />
          )}
          {!book.hasFile && <Badge kind="missing" label="NO FILE" />}
        </div>

        <div
          style={{
            fontSize: density.authorSize,
            color: SPINE.textMid,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={book.authors.join(", ")}
        >
          {book.author}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: SPINE.mono,
            fontSize: density.metaSize,
            color: SPINE.textDim,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {metaChunks.map((chunk, idx) => (
            <span key={idx} style={{ display: "inline-flex", gap: 10, whiteSpace: "nowrap" }}>
              {idx > 0 && <span style={{ opacity: 0.6 }}>·</span>}
              <span>{chunk}</span>
            </span>
          ))}
          <div style={{ flex: 1 }} />
          {book.progress && <ReadMeter value={book.progress.pct / 100} width={70} />}
        </div>

        {density.showSubjects && (visibleSubjects.length > 0 || overflowCount > 0) && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            {visibleSubjects.map((subject) => (
              <SubjectChip key={subject} label={subject} />
            ))}
            {overflowCount > 0 && (
              <span style={{ fontSize: 10, color: SPINE.textFaint, fontFamily: SPINE.sans }}>
                +{overflowCount}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SubjectChip({ label }: { label: string }) {
  return (
    <span
      style={{
        padding: "1px 5px",
        borderRadius: 2,
        fontSize: 10,
        fontFamily: SPINE.sans,
        color: SPINE.textDim,
        background: SPINE.canvasAlt,
        border: `1px solid ${SPINE.borderSoft}`,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: 180,
      }}
      title={label}
    >
      {label}
    </span>
  );
}

function formatDatePair(workDate: string | undefined, pubDate: string | undefined): string {
  if (workDate && pubDate && workDate !== pubDate) return `${workDate} → ${pubDate}`;
  return workDate ?? pubDate ?? "";
}

function buildMetaChunks(book: BookProjection): string[] {
  const chunks: string[] = [];
  if (book.publisher) chunks.push(book.publisher);
  if (book.format) chunks.push(book.format);
  if (book.isbn) chunks.push(book.isbn);
  return chunks;
}
