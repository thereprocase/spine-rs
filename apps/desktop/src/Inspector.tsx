import { useState, type ReactNode } from "react";
import { SPINE } from "./tokens";
import Cover from "./components/Cover";
import Badge from "./components/Badge";
import ReadMeter from "./components/ReadMeter";
import Icon, { type IconName } from "./components/Icon";
import { extractYear, relDate } from "./utils/formatters";
import { identifierUrl } from "./utils/identifiers";

// Reuses App.tsx's Book + ReadingProgress shapes structurally without
// importing them (App.tsx defines them locally; we keep this component
// independent so the structural type fits any caller that exposes the
// same fields).
export interface InspectorBook {
  id: string;
  title: string;
  authors: string[];
  legacyMetadata: {
    publisher?: string;
    pubDate?: string;
    series?: string;
    seriesIndex?: number;
    tags: string[];
    description?: string;
    hasCover?: boolean;
  };
  bibliographicGraph?: {
    workUri: string;
    instanceUri: string;
    work: {
      uri: string;
      title?: string;
      originDate?: string;
      subjects: { uri: string; label: string; source: string }[];
      creators: { uri: string; name: string; role: string }[];
      language?: string;
      lccn?: string;
      ddc?: string;
    };
    instances: {
      uri: string;
      format: string;
      publicationDate?: string;
      publisher?: string;
      isbn?: string;
      oclc?: string;
    }[];
  };
}

export interface InspectorProgress {
  progressFraction?: number;
  updatedAt?: string;
}

interface InspectorProps {
  book: InspectorBook;
  progress?: InspectorProgress;
  width?: number;
  hasFile?: boolean;
  addedAt?: string;
  onContinueRead?: () => void;
  onEdit?: () => void;
  onReconcile?: () => void;
  /** Legacy "drop to advanced view" — used when a popover item explicitly
   *  asks for the raw graph. Kept distinct from the ⋯ overflow popover. */
  onAdvancedView?: () => void;
  onRemove?: () => void;
  onExport?: () => void;
  onSearchAuthor?: (author: string) => void;
  onSearchSubject?: (label: string) => void;
  onSearchPublisher?: (publisher: string) => void;
  /** Open the "+ add subject" affordance — caller renders the modal. */
  onAddSubject?: () => void;
  /** Delete a subject from the Work. Caller routes to
   *  `DELETE /api/v1/book/:id/subject?uri=` or surfaces a "coming soon"
   *  toast if the backend handler hasn't shipped yet. */
  onDeleteSubject?: (label: string, uri?: string) => void;
  /** Open the "+ instance" affordance — caller renders AddInstanceDialog
   *  and routes to `POST /api/v1/book/:id/instance`. */
  onAddInstance?: () => void;
  /** Promote a non-primary Instance to primary. Caller routes to
   *  `PATCH /api/v1/book/:id/instance/:instance_uuid/primary`. Receives the
   *  full `instance.uri` so the caller decides how to encode the path
   *  segment (locally-minted urn:spine:instance:<uuid> → uuid tail; LoC
   *  URIs are deferred per ADR 014). */
  onSetPrimaryInstance?: (instanceUri: string) => void;
}

// 340px right-pane Inspector per spine-inspector.jsx. Seven stacked
// sections: hero · primary action row · Dublin+1 dates · identifiers ·
// LCSH subjects · W/I/I tree · reading meter. Renders read-only display
// from a Book + optional reading progress; mutation routes back through
// the parent via the handler props (Edit / Reconcile / Remove flow lives
// in App.tsx — this component stays presentation-only).
export default function Inspector({
  book,
  progress,
  width = 340,
  hasFile = true,
  addedAt,
  onContinueRead,
  onEdit,
  onReconcile,
  onAdvancedView,
  onRemove,
  onExport,
  onSearchAuthor,
  onSearchSubject,
  onSearchPublisher,
  onAddSubject,
  onDeleteSubject,
  onAddInstance,
  onSetPrimaryInstance,
}: InspectorProps) {
  const [showMore, setShowMore] = useState(false);
  const graph = book.bibliographicGraph;
  const work = graph?.work;
  const instances = graph?.instances ?? [];
  const primaryInstance = instances[0];
  const reconciled = !!graph;
  const author = book.authors[0] ?? "Unknown";

  const workDate = work?.originDate ?? undefined;
  const pubDate =
    primaryInstance?.publicationDate ?? extractYear(book.legacyMetadata.pubDate)?.toString() ?? undefined;

  const subjects = work?.subjects ?? [];
  const subjectsFromLegacy = book.legacyMetadata.tags ?? [];
  const visibleSubjects = subjects.length > 0 ? subjects : subjectsFromLegacy.map((label) => ({ uri: "", label, source: "calibre" }));

  const isbn = primaryInstance?.isbn ?? "—";
  const language = work?.language ?? "—";
  const publisher = primaryInstance?.publisher ?? book.legacyMetadata.publisher ?? "—";
  const format = primaryInstance?.format ?? "EPUB";
  const pages = "—";
  const size = "—";

  const progressFraction = progress?.progressFraction ?? 0;
  const inProgress = progressFraction > 0 && progressFraction < 1;
  const finished = progressFraction >= 1;
  const continueLabel = inProgress
    ? `Continue · ${Math.round(progressFraction * 100)}%`
    : finished
    ? "Re-read"
    : "Read";

  return (
    <div
      style={{
        width,
        background: SPINE.panel,
        borderLeft: `1px solid ${SPINE.border}`,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        fontFamily: SPINE.sans,
        color: SPINE.text,
      }}
    >
      {/* Hero — cover + title + author + status badges */}
      <div style={{ padding: "18px 18px 14px", display: "flex", gap: 14, alignItems: "flex-start" }}>
        <Cover
          title={book.title}
          author={author}
          instances={instances.length}
          w={84}
          bookId={book.id}
          hasCover={book.legacyMetadata.hasCover === true}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: SPINE.serif,
              fontSize: 17,
              fontWeight: 600,
              fontStyle: "italic",
              color: SPINE.text,
              lineHeight: 1.2,
              letterSpacing: -0.2,
              wordBreak: "break-word",
            }}
          >
            {book.title}
          </div>
          <div
            onClick={() => onSearchAuthor?.(author)}
            style={{
              fontFamily: SPINE.sans,
              fontSize: 12,
              color: SPINE.textMid,
              marginTop: 6,
              cursor: onSearchAuthor ? "pointer" : "default",
            }}
            title={onSearchAuthor ? `Search by ${author}` : undefined}
          >
            {author}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            {reconciled ? (
              <Badge
                kind="reconciled"
                label={
                  <>
                    <Icon name="check" size={9} />
                    <span>LoC</span>
                  </>
                }
              />
            ) : (
              <Badge kind="local" label="LOCAL ONLY" />
            )}
            {!hasFile && <Badge kind="missing" label="FILE MISSING" />}
            {instances.length > 1 && (
              <Badge kind="neutral" label={`${instances.length} editions`} mono />
            )}
          </div>
        </div>
      </div>

      {/* Primary action row */}
      <div style={{ padding: "0 18px 14px", display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={onContinueRead}
          style={{
            flex: 1,
            padding: "7px 10px",
            background: inProgress ? SPINE.accent : SPINE.surface,
            color: inProgress ? SPINE.inkInvert : SPINE.text,
            border: "none",
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {continueLabel}
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit metadata"
          style={{
            padding: "7px 10px",
            background: "transparent",
            color: SPINE.textMid,
            border: `1px solid ${SPINE.border}`,
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: SPINE.sans,
            fontSize: 11,
          }}
        >
          Edit
        </button>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={showMore}
            style={{
              padding: "7px 10px",
              background: showMore ? SPINE.surface : "transparent",
              color: SPINE.textMid,
              border: `1px solid ${showMore ? SPINE.borderHi : SPINE.border}`,
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: SPINE.sans,
              fontSize: 11,
            }}
          >
            ⋯
          </button>
          {showMore && (
            <div
              role="menu"
              onMouseLeave={() => setShowMore(false)}
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                minWidth: 180,
                background: SPINE.panel,
                border: `1px solid ${SPINE.borderHi}`,
                borderRadius: 3,
                padding: 4,
                zIndex: 50,
                boxShadow: "0 12px 32px rgba(0,0,0,.5)",
                fontFamily: SPINE.sans,
                fontSize: 12,
              }}
            >
              {onReconcile && (
                <MoreItem
                  label="Reconcile against id.loc.gov"
                  onClick={() => {
                    setShowMore(false);
                    onReconcile();
                  }}
                />
              )}
              {onAdvancedView && (
                <MoreItem
                  label="Show raw BIBFRAME graph"
                  onClick={() => {
                    setShowMore(false);
                    onAdvancedView();
                  }}
                />
              )}
              {onExport && (
                <MoreItem
                  label="Export EPUB…"
                  onClick={() => {
                    setShowMore(false);
                    onExport();
                  }}
                />
              )}
              {onRemove && (
                <MoreItem
                  label="Remove from library…"
                  danger
                  onClick={() => {
                    setShowMore(false);
                    onRemove();
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <Section title="Publication dates · Dublin+1">
        <div style={{ display: "flex", gap: 20 }}>
          <DateCell label="WORK · ORIGIN" value={workDate ?? "—"} predicate="bf:originDate" />
          <div style={{ width: 1, background: SPINE.border }} />
          <DateCell label="INSTANCE · PUB" value={pubDate ?? "—"} predicate="bf:publication/date" />
        </div>
      </Section>

      <Section title="Identifiers">
        <MetaRow label="Author" mono>
          {graph?.work.creators?.[0]?.uri ? (
            <a
              href={graph.work.creators[0].uri}
              onClick={(e) => {
                e.preventDefault();
                window.open(graph.work.creators[0].uri, "_blank");
              }}
              style={{
                color: SPINE.link,
                textDecoration: "underline",
                textDecorationStyle: "dotted",
              }}
            >
              {graph.work.creators[0].uri.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <span style={{ color: SPINE.textDim }}>{author}</span>
          )}
        </MetaRow>
        <MetaRow label="Work URI" mono>
          {graph?.workUri ? (
            <span style={{ color: reconciled ? SPINE.link : SPINE.warn }}>{graph.workUri}</span>
          ) : (
            <span style={{ color: SPINE.warn }}>local-only</span>
          )}
        </MetaRow>
        <MetaRow label="ISBN" mono>{isbn}</MetaRow>
        {work?.lccn && (
          <MetaRow label="LCCN" mono>
            <a
              href={identifierUrl("lccn", work.lccn) ?? "#"}
              onClick={(e) => {
                e.preventDefault();
                const url = identifierUrl("lccn", work.lccn ?? "");
                if (url) window.open(url, "_blank");
              }}
              style={{ color: SPINE.link, textDecoration: "underline", textDecorationStyle: "dotted" }}
            >
              {work.lccn}
            </a>
          </MetaRow>
        )}
        {work?.ddc && <MetaRow label="DDC" mono>{work.ddc}</MetaRow>}
        <MetaRow label="Language" mono>{language}</MetaRow>
      </Section>

      <Section
        title="Subjects · LCSH"
        action={onAddSubject ? "+ add" : undefined}
        onAction={onAddSubject}
      >
        {visibleSubjects.length === 0 ? (
          <span style={{ color: SPINE.textFaint, fontSize: 11 }}>No subjects assigned.</span>
        ) : (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {visibleSubjects.map((s) => (
              <SubjectChip
                key={s.uri || s.label}
                label={s.label}
                uri={s.uri}
                source={s.source}
                onClick={onSearchSubject ? () => onSearchSubject(s.label) : undefined}
                onDelete={
                  onDeleteSubject
                    ? () => onDeleteSubject(s.label, s.uri || undefined)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Work / Instance / Item"
        action={onAddInstance ? "+ instance" : undefined}
        onAction={onAddInstance}
      >
        <div style={{ fontFamily: SPINE.mono, fontSize: 11, color: SPINE.textMid, lineHeight: 1.7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="books" size={11} color={SPINE.accent} />
            <span style={{ color: SPINE.text, fontWeight: 500 }}>Work</span>
            <span style={{ color: SPINE.textFaint }}>— {book.title}</span>
          </div>
          <div style={{ paddingLeft: 16, borderLeft: `1px solid ${SPINE.border}`, marginLeft: 5 }}>
            {instances.length === 0 ? (
              <div style={{ color: SPINE.textDim, fontSize: 10 }}>No instances yet.</div>
            ) : (
              instances.map((inst, idx) => {
                const isPrimary = idx === 0;
                // Set-primary affordance is wired only for locally-minted
                // urn:spine:instance:<uuid> URIs. ADR 014 §5 defers a body-
                // based variant for LoC URIs; until then the backend rejects
                // path-segment-encoded LoC URIs with 400, so we don't expose
                // the action for those.
                const localUuid = inst.uri.startsWith("urn:spine:instance:")
                  ? inst.uri.slice("urn:spine:instance:".length)
                  : null;
                const canPromote =
                  !isPrimary && !!onSetPrimaryInstance && !!localUuid;
                return (
                  <div key={inst.uri} style={{ paddingTop: 4, paddingBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="file" size={11} color={SPINE.textDim} />
                      <span style={{ color: SPINE.text }}>Instance</span>
                      {isPrimary && (
                        <span
                          title="Primary edition"
                          aria-label="Primary edition"
                          style={{ color: SPINE.accent, fontWeight: 600 }}
                        >
                          ★
                        </span>
                      )}
                      {inst.publisher && (
                        <span style={{ color: SPINE.textFaint }}>· {inst.publisher}</span>
                      )}
                      {inst.publicationDate && (
                        <span style={{ color: SPINE.textFaint }}>· {inst.publicationDate}</span>
                      )}
                      {canPromote && (
                        <button
                          type="button"
                          onClick={() => onSetPrimaryInstance?.(inst.uri)}
                          title="Promote to primary edition"
                          style={{
                            marginLeft: "auto",
                            background: "transparent",
                            border: `1px solid ${SPINE.borderSoft}`,
                            color: SPINE.textDim,
                            padding: "1px 6px",
                            borderRadius: 3,
                            fontFamily: SPINE.sans,
                            fontSize: 9,
                            letterSpacing: 0.4,
                            textTransform: "uppercase",
                            cursor: "pointer",
                          }}
                        >
                          Make primary
                        </button>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        paddingLeft: 16,
                        color: SPINE.textFaint,
                        fontSize: 10,
                      }}
                    >
                      <Icon
                        name={hasFile ? "file" : "filemiss"}
                        size={10}
                        color={hasFile ? SPINE.textFaint : SPINE.alert}
                      />
                      <span>Item · {inst.format}</span>
                      {inst.isbn && <span>· {inst.isbn}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Section>

      <Section title="Reading">
        <MetaRow label="Progress">
          {progress ? <ReadMeter value={progressFraction} width={110} /> : <span style={{ color: SPINE.textFaint, fontSize: 11 }}>not started</span>}
        </MetaRow>
        {progress?.updatedAt && (
          <MetaRow label="Last opened">{relDate(progress.updatedAt)}</MetaRow>
        )}
        {addedAt && <MetaRow label="Added">{relDate(addedAt)}</MetaRow>}
        <MetaRow label="Pages" mono>{pages}</MetaRow>
        <MetaRow label="Size" mono>{size}</MetaRow>
      </Section>

      <Section title="Ingest">
        <MetaRow label="Format" mono>{format}</MetaRow>
        <MetaRow label="Publisher">
          <button
            type="button"
            onClick={() => publisher !== "—" && onSearchPublisher?.(publisher)}
            style={{
              background: "transparent",
              border: "none",
              color: SPINE.textMid,
              padding: 0,
              cursor: publisher !== "—" && onSearchPublisher ? "pointer" : "default",
              font: "inherit",
              textAlign: "left",
            }}
          >
            {publisher}
          </button>
        </MetaRow>
        {book.legacyMetadata.series && (
          <MetaRow label="Series">
            {book.legacyMetadata.series}
            {book.legacyMetadata.seriesIndex != null && ` · #${book.legacyMetadata.seriesIndex}`}
          </MetaRow>
        )}
      </Section>

      <div style={{ padding: "14px 18px 18px", display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onReconcile}
          aria-label="Reconcile against id.loc.gov"
          style={{
            flex: 1,
            padding: "7px 10px",
            background: reconciled ? "transparent" : SPINE.accent,
            color: reconciled ? SPINE.accent : SPINE.inkInvert,
            border: `1px solid ${reconciled ? SPINE.accent : "transparent"}`,
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <IconLoc />
          {reconciled ? "Re-reconcile" : "Reconcile against LoC"}
        </button>
      </div>
    </div>
  );
}

function SubjectChip({
  label,
  uri,
  source,
  onClick,
  onDelete,
}: {
  label: string;
  uri?: string;
  source?: string;
  onClick?: () => void;
  onDelete?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: onDelete ? "3px 4px 3px 7px" : "3px 7px",
        background: SPINE.surface,
        color: SPINE.text,
        fontFamily: SPINE.sans,
        fontSize: 11,
        borderRadius: 2,
        border: `1px solid ${SPINE.border}`,
        whiteSpace: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
      }}
      title={uri || source}
    >
      <Icon name="link" size={9} color={SPINE.textDim} />
      <button
        type="button"
        onClick={onClick}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          color: "inherit",
          cursor: onClick ? "pointer" : "default",
          font: "inherit",
          maxWidth: 180,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
      {onDelete && hovered && (
        <button
          type="button"
          aria-label={`Remove subject ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            width: 14,
            height: 14,
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            color: SPINE.textDim,
            cursor: "pointer",
            padding: 0,
            marginLeft: 2,
          }}
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  );
}

function MoreItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        background: "transparent",
        border: "none",
        color: danger ? SPINE.alert : SPINE.text,
        cursor: "pointer",
        fontFamily: SPINE.sans,
        fontSize: 12,
        borderRadius: 2,
      }}
    >
      {label}
    </button>
  );
}

function Section({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ padding: "14px 18px", borderTop: `1px solid ${SPINE.borderSoft}` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontFamily: SPINE.sans,
            fontSize: 10,
            fontWeight: 600,
            color: SPINE.textDim,
            letterSpacing: 0.8,
            textTransform: "uppercase",
          }}
        >
          {title}
        </div>
        {action && (
          <button
            type="button"
            onClick={onAction}
            style={{
              fontFamily: SPINE.sans,
              fontSize: 11,
              color: SPINE.accent,
              cursor: onAction ? "pointer" : "default",
              background: "transparent",
              border: "none",
              padding: 0,
            }}
          >
            {action}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function MetaRow({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 14, padding: "5px 0", alignItems: "baseline" }}>
      <div
        style={{
          fontFamily: SPINE.sans,
          fontSize: 10,
          fontWeight: 500,
          color: SPINE.textFaint,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          width: 92,
          flexShrink: 0,
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          fontFamily: mono ? SPINE.mono : SPINE.sans,
          fontSize: mono ? 11 : 12,
          color: SPINE.text,
          lineHeight: 1.5,
          wordBreak: "break-word",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function DateCell({ label, value, predicate }: { label: string; value: string; predicate: string }) {
  return (
    <div>
      <div style={{ fontFamily: SPINE.mono, fontSize: 10, color: SPINE.textFaint, marginBottom: 2 }}>{label}</div>
      <div
        style={{
          fontFamily: SPINE.serif,
          fontSize: 20,
          color: SPINE.text,
          fontWeight: 500,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontFamily: SPINE.sans, fontSize: 10, color: SPINE.textDim, marginTop: 2 }}>{predicate}</div>
    </div>
  );
}

function IconLoc() {
  // 14×14 LoC-ish glyph; reuses the Globe icon already mapped as `loc`.
  return <Icon name={"loc" as IconName} size={14} />;
}
