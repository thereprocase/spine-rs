import { useEffect, useRef, useState } from "react";
import { SPINE } from "../../tokens";
import { callApi, isApiError } from "../../api/client";
import { humanizeBackendError } from "../../utils/formatters";

// PUT /api/v1/book/:id/metadata wire shape per the project roadmap §S12 step 4
// + S12 recon (internal design notes).
// 8 D4_WRITE fields. Server normalises:
//   - splits authors / tags from comma-separated input client-side then
//     sends as arrays; backend re-validates
//   - empty string for series / publisher / pubdate / language is
//     written as null (clears the field)
//   - series_index is a parsed float; "1.5" / "1" both valid; blank
//     emits null
export interface EditMetadataPayload {
  title: string;
  authors: string[];
  tags: string[];
  series: string | null;
  series_index: number | null;
  pubdate: string | null;
  publisher: string | null;
  language: string;
}

export interface EditMetadataDrawerProps {
  bookId: string;
  bookTitle: string;
  initial: EditMetadataPayload;
  onClose: () => void;
  onSaved: (payload: EditMetadataPayload) => void;
}

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function joinList(items: readonly string[]): string {
  return items.join(", ");
}

export default function EditMetadataDrawer({
  bookId,
  bookTitle,
  initial,
  onClose,
  onSaved,
}: EditMetadataDrawerProps) {
  const [title, setTitle] = useState(initial.title);
  const [authors, setAuthors] = useState(joinList(initial.authors));
  const [tags, setTags] = useState(joinList(initial.tags));
  const [series, setSeries] = useState(initial.series ?? "");
  const [seriesIndex, setSeriesIndex] = useState(
    initial.series_index != null ? String(initial.series_index) : "",
  );
  const [pubdate, setPubdate] = useState(initial.pubdate ?? "");
  const [publisher, setPublisher] = useState(initial.publisher ?? "");
  const [language, setLanguage] = useState(initial.language || "eng");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSaving) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isSaving, onClose]);

  const handleSave = async () => {
    setValidationError(null);
    setSaveError(null);

    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setValidationError("Title cannot be blank.");
      return;
    }

    let parsedSeriesIndex: number | null = null;
    const idxRaw = seriesIndex.trim();
    if (idxRaw.length > 0) {
      const parsed = Number.parseFloat(idxRaw);
      if (!Number.isFinite(parsed)) {
        setValidationError("Series index must be a number (e.g. 1, 1.5).");
        return;
      }
      parsedSeriesIndex = parsed;
    }

    const seriesTrim = series.trim();
    const pubdateTrim = pubdate.trim();
    const publisherTrim = publisher.trim();
    const langTrim = language.trim();

    const payload: EditMetadataPayload = {
      title: trimmedTitle,
      authors: parseList(authors),
      tags: parseList(tags),
      series: seriesTrim.length > 0 ? seriesTrim : null,
      series_index: parsedSeriesIndex,
      pubdate: pubdateTrim.length > 0 ? pubdateTrim : null,
      publisher: publisherTrim.length > 0 ? publisherTrim : null,
      language: langTrim.length > 0 ? langTrim : "eng",
    };

    setIsSaving(true);
    try {
      await callApi("PUT", `/api/v1/book/${bookId}/metadata`, payload);
      onSaved(payload);
      onClose();
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 400) {
          setSaveError(`Validation failed: ${err.message}`);
        } else if (err.status === 404) {
          setSaveError("This book is no longer in the library.");
        } else if (err.status === 503) {
          setSaveError("Library not loaded.");
        } else {
          setSaveError(`Save failed: ${err.message}`);
        }
      } else {
        setSaveError(`Save failed: ${humanizeBackendError(err)}`);
      }
      setIsSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "rgba(0,0,0,0.2)",
    border: `1px solid ${SPINE.border}`,
    padding: "8px 10px",
    color: SPINE.text,
    borderRadius: 3,
    fontFamily: "inherit",
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: SPINE.textDim,
    marginBottom: 4,
  };

  const fieldRowStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit metadata for ${bookTitle}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "brightness(0.55) saturate(0.7)",
        WebkitBackdropFilter: "brightness(0.55) saturate(0.7)",
        zIndex: 1000,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          height: "100%",
          background: SPINE.panel,
          borderLeft: `1px solid ${SPINE.borderHi}`,
          padding: "20px 24px",
          overflowY: "auto",
          fontFamily: SPINE.sans,
          color: SPINE.text,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Edit metadata</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            style={{
              background: "transparent",
              border: "none",
              color: SPINE.textDim,
              fontSize: 20,
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 4px",
            }}
            aria-label="Close edit metadata drawer"
          >
            ×
          </button>
        </header>

        <p style={{ fontSize: 12, color: SPINE.textMid, margin: 0 }}>
          {bookTitle}
        </p>

        <div style={fieldRowStyle}>
          <label htmlFor="edit-title" style={labelStyle}>Title <span style={{ color: SPINE.alert }}>*</span></label>
          <input
            id="edit-title"
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isSaving}
            style={inputStyle}
          />
        </div>

        <div style={fieldRowStyle}>
          <label htmlFor="edit-authors" style={labelStyle}>Authors (comma-separated)</label>
          <input
            id="edit-authors"
            type="text"
            value={authors}
            onChange={(e) => setAuthors(e.target.value)}
            disabled={isSaving}
            style={inputStyle}
            placeholder="Last, First, Other"
          />
        </div>

        <div style={fieldRowStyle}>
          <label htmlFor="edit-tags" style={labelStyle}>Tags (comma-separated)</label>
          <input
            id="edit-tags"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            disabled={isSaving}
            style={inputStyle}
            placeholder="Sci-Fi, Anthology"
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <div style={fieldRowStyle}>
            <label htmlFor="edit-series" style={labelStyle}>Series</label>
            <input
              id="edit-series"
              type="text"
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              disabled={isSaving}
              style={inputStyle}
            />
          </div>
          <div style={fieldRowStyle}>
            <label htmlFor="edit-series-index" style={labelStyle}>Index</label>
            <input
              id="edit-series-index"
              type="text"
              value={seriesIndex}
              onChange={(e) => setSeriesIndex(e.target.value)}
              disabled={isSaving}
              style={inputStyle}
              placeholder="1 / 1.5"
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={fieldRowStyle}>
            <label htmlFor="edit-pubdate" style={labelStyle}>Pub date</label>
            <input
              id="edit-pubdate"
              type="text"
              value={pubdate}
              onChange={(e) => setPubdate(e.target.value)}
              disabled={isSaving}
              style={inputStyle}
              placeholder="YYYY or YYYY-MM-DD"
            />
          </div>
          <div style={fieldRowStyle}>
            <label htmlFor="edit-language" style={labelStyle}>Language</label>
            <input
              id="edit-language"
              type="text"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={isSaving}
              style={inputStyle}
              placeholder="eng"
            />
          </div>
        </div>

        <div style={fieldRowStyle}>
          <label htmlFor="edit-publisher" style={labelStyle}>Publisher</label>
          <input
            id="edit-publisher"
            type="text"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            disabled={isSaving}
            style={inputStyle}
          />
        </div>

        {validationError && (
          <p role="alert" style={{ fontSize: 12, color: SPINE.alert, margin: 0 }}>
            {validationError}
          </p>
        )}
        {saveError && (
          <p role="alert" style={{ fontSize: 12, color: SPINE.alert, margin: 0 }}>
            {saveError}
          </p>
        )}

        <div style={{ flex: 1 }} />

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: `1px solid ${SPINE.border}` }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            style={{
              padding: "7px 16px",
              background: "transparent",
              color: SPINE.textMid,
              border: `1px solid ${SPINE.border}`,
              borderRadius: 3,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            style={{
              padding: "7px 18px",
              background: SPINE.accent,
              color: SPINE.inkInvert,
              border: "none",
              borderRadius: 3,
              cursor: isSaving ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
