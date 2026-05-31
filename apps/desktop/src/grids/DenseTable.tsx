import type { ReactNode } from "react";
import { SPINE } from "../tokens";
import ReadMeter from "../components/ReadMeter";
import type { BookProjection } from "../projections";
import type { Density } from "../shell/Toolbar";

type SelectMode = "replace" | "toggle" | "range";

interface DenseTableProps {
  books: BookProjection[];
  selectedIds: Set<string>;
  /** Multi-select primary anchor — gets a heavier left rule than the
   *  rest of the set so the Inspector target stays visible at a glance. */
  primarySelectedId?: string | null;
  onSelect: (id: string, mode: SelectMode) => void;
  onOpen?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  emptyMessage?: string;
  density?: Density;
}

interface DenseDensitySpec {
  cellPadY: number;
  cellPadX: number;
  cellFont: number;
  titleFont: number;
}

const TABLE_DENSITY: Record<Density, DenseDensitySpec> = {
  dense: { cellPadY: 3, cellPadX: 8, cellFont: 10, titleFont: 11 },
  balanced: { cellPadY: 5, cellPadX: 10, cellFont: 11, titleFont: 12 },
  relaxed: { cellPadY: 8, cellPadX: 12, cellFont: 12, titleFont: 13 },
};

// Tufte librarian workstation. Fixed `table-layout`, sticky header,
// zebra rows (even = `canvasAlt`), 5×10 cell padding. Title column is
// the sole elastic column. Scent-dot cell signals status + multi-
// instance in a single 20px slot.
export default function DenseTable({
  books,
  selectedIds,
  primarySelectedId,
  onSelect,
  onOpen,
  onContextMenu,
  emptyMessage = "No books in this view.",
  density = "balanced",
}: DenseTableProps) {
  const d = TABLE_DENSITY[density];
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
    <div style={{ flex: 1, overflow: "auto", background: SPINE.canvas }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 20 }} />
          <col />
          <col style={{ width: 160 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 70 }} />
          <col style={{ width: 90 }} />
        </colgroup>
        <thead>
          <tr>
            <TH />
            <TH>Title / Work</TH>
            <TH>Author</TH>
            <TH right>Work</TH>
            <TH right>Pub</TH>
            <TH>Publisher</TH>
            <TH>Fmt</TH>
            <TH right>Pages</TH>
            <TH>Read</TH>
          </tr>
        </thead>
        <tbody>
          {books.map((book, i) => {
            const isSelected = selectedIds.has(book.id);
            const isMultiSelect = selectedIds.size > 1;
            const isPrimary = isSelected && primarySelectedId === book.id && isMultiSelect;
            const rowBg = isSelected
              ? SPINE.surface
              : i % 2 === 0
                ? SPINE.canvasAlt
                : "transparent";
            // Single-select keeps the full accent rule; accentDim is
            // reserved for non-primary members of a multi-set.
            const leftRule = isPrimary
              ? `3px solid ${SPINE.accent}`
              : isSelected && isMultiSelect
              ? `2px solid ${SPINE.accentDim}`
              : isSelected
              ? `2px solid ${SPINE.accent}`
              : undefined;
            return (
              <tr
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
                style={{
                  background: rowBg,
                  borderBottom: `1px solid ${SPINE.borderSoft}`,
                  borderLeft: leftRule,
                  cursor: "pointer",
                }}
              >
                <TD pad={d}>
                  <span style={{ display: "inline-flex", gap: 2 }}>
                    {book.status === "local" && <TableDot color={SPINE.warn} title="local only" />}
                    {!book.hasFile && <TableDot color={SPINE.alert} title="file missing" />}
                    {book.instances > 1 && (
                      <TableDot color={SPINE.accent} title="multiple editions" />
                    )}
                  </span>
                </TD>
                <TD pad={d}>
                  <span
                    style={{
                      fontFamily: SPINE.serif,
                      fontStyle: "italic",
                      fontWeight: 600,
                      fontSize: d.titleFont,
                    }}
                  >
                    {book.title}
                  </span>
                  {book.instances > 1 && (
                    <span
                      style={{
                        fontFamily: SPINE.mono,
                        fontSize: 9,
                        color: SPINE.textFaint,
                        marginLeft: 6,
                      }}
                    >
                      ×{book.instances}
                    </span>
                  )}
                </TD>
                <TD pad={d} dim>{book.author}</TD>
                <TD pad={d} mono right color={SPINE.text}>
                  {book.workDate ?? ""}
                </TD>
                <TD pad={d} mono right dim>
                  {book.pubDate ?? ""}
                </TD>
                <TD pad={d} dim>{book.publisher ?? ""}</TD>
                <TD pad={d} mono dim>
                  {book.format ?? ""}
                </TD>
                <TD pad={d} mono right dim>
                  {/* Pages — placeholder em-dash until spine-fmt-epub
                      surfaces page counts; the column itself follows
                      design's 9-column spec so it doesn't reflow when
                      data lands. */}
                  —
                </TD>
                <TD pad={d}>
                  {book.progress ? (
                    <ReadMeter value={book.progress.pct / 100} width={48} />
                  ) : (
                    <span style={{ fontFamily: SPINE.mono, fontSize: 10, color: SPINE.textFaint }}>
                      —
                    </span>
                  )}
                </TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TH({ children, right }: { children?: ReactNode; right?: boolean }) {
  return (
    <th
      style={{
        padding: "5px 10px",
        textAlign: right ? "right" : "left",
        fontFamily: SPINE.sans,
        fontSize: 10,
        fontWeight: 600,
        color: SPINE.textDim,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        borderBottom: `1px solid ${SPINE.border}`,
        background: SPINE.bg,
        position: "sticky",
        top: 0,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

interface TDProps {
  children?: ReactNode;
  mono?: boolean;
  right?: boolean;
  dim?: boolean;
  color?: string;
  pad?: DenseDensitySpec;
}

function TD({ children, mono, right, dim, color, pad }: TDProps) {
  const cellPadY = pad?.cellPadY ?? 5;
  const cellPadX = pad?.cellPadX ?? 10;
  const cellFont = pad?.cellFont ?? 11;
  return (
    <td
      style={{
        padding: `${cellPadY}px ${cellPadX}px`,
        fontFamily: mono ? SPINE.mono : SPINE.sans,
        fontSize: cellFont,
        color: color ?? (dim ? SPINE.textDim : SPINE.text),
        textAlign: right ? "right" : "left",
        fontVariantNumeric: mono ? "tabular-nums" : "normal",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </td>
  );
}

function TableDot({ color, title }: { color: string; title: string }) {
  return (
    <span
      title={title}
      style={{
        width: 5,
        height: 5,
        borderRadius: 3,
        background: color,
        display: "inline-block",
      }}
    />
  );
}
