import { useRef, useState } from "react";
import { SPINE } from "../tokens";
import Cover from "../components/Cover";
import type { BookProjection } from "../projections";
import type { Density } from "../shell/Toolbar";

type SelectMode = "replace" | "toggle" | "range";

interface CoverGridProps {
  books: BookProjection[];
  selectedIds: Set<string>;
  /** When the selection has more than one book, the primary cell renders
   *  with a heavier accent border + a small accent dot top-right. The
   *  rest of the set uses a softer (accentDim) outline. */
  primarySelectedId?: string | null;
  onSelect: (id: string, mode: SelectMode) => void;
  onOpen?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  coverWidth?: number;
  gap?: number;
  emptyMessage?: string;
  density?: Density;
}

const COVER_DENSITY: Record<Density, { coverW: number; gap: number; rowGap: number; pad: number }> = {
  dense: { coverW: 84, gap: 14, rowGap: 26, pad: 7 },
  balanced: { coverW: 104, gap: 20, rowGap: 34, pad: 8 },
  relaxed: { coverW: 130, gap: 26, rowGap: 42, pad: 9 },
};

// Visual-first cover wall. CSS grid with `auto-fill, <coverWidth>px`.
// Scent-dots at cover bottom-left signal status; 2px accent progress
// bar across the bottom when in-progress. Selection and hover states draw
// inside a fixed padded tile so covers never jump or crowd adjacent cells.
export default function CoverGrid({
  books,
  selectedIds,
  primarySelectedId,
  onSelect,
  onOpen,
  onContextMenu,
  coverWidth,
  gap,
  emptyMessage = "No books in this view.",
  density = "balanced",
}: CoverGridProps) {
  const d = COVER_DENSITY[density];
  const cw = coverWidth ?? d.coverW;
  const cgap = gap ?? d.gap;
  const tilePad = d.pad;
  const tileW = cw + tilePad * 2;
  // Hover-zoom is a daily-driver UX nicety on dense (88px) cells where
  // the cover thumbnail is too small to read. At balanced/relaxed the
  // cover is already legible — skip the popup to avoid pointless reflows.
  const zoomEnabled = cw < 110;
  const [zoomedBook, setZoomedBook] = useState<{ book: BookProjection; x: number; y: number } | null>(null);
  const zoomTimerRef = useRef<number | null>(null);
  const clearZoomIntent = () => {
    if (zoomTimerRef.current !== null) {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
  };
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
        padding: "20px 22px 28px",
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, ${tileW}px)`,
        gap: `${d.rowGap}px ${cgap}px`,
        alignContent: "start",
        justifyContent: "start",
        position: "relative",
      }}
      onScroll={() => {
        clearZoomIntent();
        setZoomedBook(null);
      }}
    >
      {books.map((book) => {
        const isSelected = selectedIds.has(book.id);
        const isMultiSelect = selectedIds.size > 1;
        const isPrimary = isSelected && primarySelectedId === book.id && isMultiSelect;
        const datePair = formatDatePair(book.workDate, book.pubDate);
        const inProgress = book.progress && !book.progress.finished && book.progress.pct > 0;
        return (
          <div
            key={book.id}
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
            className={[
              "cover-grid-cell",
              isSelected ? "is-selected" : "",
              isPrimary ? "is-primary" : "",
              isSelected && isMultiSelect && !isPrimary ? "is-secondary-selected" : "",
            ].filter(Boolean).join(" ")}
            aria-selected={isSelected}
            style={{
              width: tileW,
              cursor: "pointer",
              padding: tilePad,
              background: isSelected ? "rgba(200, 161, 90, 0.04)" : "transparent",
              border: `1px solid ${isSelected ? (isMultiSelect && !isPrimary ? SPINE.accentDim : SPINE.accent) : "transparent"}`,
              borderRadius: 4,
              position: "relative",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              boxShadow: isSelected
                ? isPrimary
                  ? "inset 0 0 0 1px rgba(200, 161, 90, 0.36)"
                  : "inset 0 0 0 1px rgba(200, 161, 90, 0.16)"
                : "none",
            }}
          >
            <div
              className="cover-grid-cover-frame"
              style={{
                position: "relative",
                width: cw,
                borderRadius: 4,
              }}
              onMouseEnter={(e) => {
                if (!zoomEnabled) return;
                clearZoomIntent();
                const x = e.clientX;
                const y = e.clientY;
                zoomTimerRef.current = window.setTimeout(() => {
                  setZoomedBook({ book, x, y });
                  zoomTimerRef.current = null;
                }, 1000);
              }}
              onMouseLeave={() => {
                if (!zoomEnabled) return;
                clearZoomIntent();
                setZoomedBook(null);
              }}
            >
              <Cover
                title={book.title}
                author={book.author}
                instances={book.instances}
                w={cw}
                bookId={book.id}
                hasCover={book.hasCover}
              />
              <div style={{ position: "absolute", bottom: 4, left: 4, display: "flex", gap: 3 }}>
                {book.status === "local" && <ScentDot color={SPINE.warn} title="needs reconcile" />}
                {!book.hasFile && <ScentDot color={SPINE.alert} title="file missing" />}
                {book.progress?.finished && <ScentDot color={SPINE.ok} title="finished" />}
              </div>
              {inProgress && book.progress && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 2,
                    background: "rgba(0,0,0,.4)",
                  }}
                >
                  <div
                    style={{
                      width: `${book.progress.pct}%`,
                      height: "100%",
                      background: SPINE.accent,
                    }}
                  />
                </div>
              )}
              {isPrimary && (
                <span
                  aria-hidden
                  title="Primary selection"
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: SPINE.accent,
                    border: `1px solid ${SPINE.canvas}`,
                    zIndex: 4,
                  }}
                />
              )}
            </div>
            <div
              style={{
                fontFamily: SPINE.sans,
                fontSize: 11,
                color: SPINE.text,
                fontWeight: 500,
                marginTop: 9,
                lineHeight: 1.25,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                textWrap: "pretty",
                width: cw,
              }}
            >
              {book.title}
            </div>
            <div
              style={{
                fontFamily: SPINE.sans,
                fontSize: 10,
                color: SPINE.textDim,
                marginTop: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                width: cw,
              }}
            >
              {book.author}
            </div>
            {datePair && (
              <div
                style={{
                  fontFamily: SPINE.mono,
                  fontSize: 10,
                  color: SPINE.textFaint,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                  width: cw,
                }}
              >
                {datePair}
              </div>
            )}
          </div>
        );
      })}
      {zoomedBook && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: Math.min(Math.max(zoomedBook.y - 180, 60), window.innerHeight - 380),
            left: Math.min(zoomedBook.x + 24, window.innerWidth - 280),
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

function ScentDot({ color, title }: { color: string; title: string }) {
  return (
    <span
      title={title}
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: color,
        boxShadow: "0 0 0 1.5px rgba(0,0,0,.4)",
      }}
    />
  );
}

function formatDatePair(workDate: string | undefined, pubDate: string | undefined): string {
  if (workDate && pubDate && workDate !== pubDate) return `${workDate} → ${pubDate}`;
  return workDate ?? pubDate ?? "";
}
