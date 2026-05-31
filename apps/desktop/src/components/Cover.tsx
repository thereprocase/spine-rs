import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SPINE } from "../tokens";
import { coverPalette } from "../utils/formatters";

interface CoverProps {
  title: string;
  shortTitle?: string;
  author: string;
  instances?: number;
  w?: number;
  rounded?: number;
  style?: CSSProperties;
  /** Book UUID — when set together with `hasCover`, the component fetches
   *  real cover art from `/api/v1/book/:id/cover` and renders it in place
   *  of the deterministic placeholder. Falls back to placeholder on error
   *  or while the request is in flight, so first paint is never blank. */
  bookId?: string;
  hasCover?: boolean;
}

// Deterministic printed-book placeholder. Palette is hash(title|author),
// so the same book always gets the same cloth. For multi-instance Works
// (instances > 1), 1-2 ghost rectangles are drawn behind the primary
// cover with a ×N badge top-right.
//
// When `bookId` + `hasCover` are passed in, the placeholder shows
// immediately (zero-flash) and is replaced by the real cover image
// once the fetch resolves. Multi-instance stack + ×N badge stay
// regardless.
export default function Cover({
  title,
  shortTitle,
  author,
  instances = 1,
  w = 120,
  rounded = 2,
  style = {},
  bookId,
  hasCover = false,
}: CoverProps) {
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!bookId || !hasCover) {
      setCoverSrc(null);
      return;
    }
    let cancelled = false;
    invoke<string>("call_api", { method: "GET", path: `/api/v1/book/${bookId}/cover` })
      .then((base64Uri) => {
        if (!cancelled && base64Uri) setCoverSrc(base64Uri);
      })
      .catch(() => {
        // Backend has no cover or call failed; placeholder stays.
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, hasCover]);
  const displayTitle = shortTitle ?? title;
  const palette = coverPalette(displayTitle, author);
  const h = w * 1.5;
  const stackCount = Math.min(Math.max(instances - 1, 0), 3);
  const authorLast = author.split(",")[0];

  return (
    <div style={{ position: "relative", width: w, height: h, flexShrink: 0, ...style }}>
      {stackCount >= 2 && (
        <div
          style={{
            position: "absolute",
            left: 6,
            top: -4,
            width: w,
            height: h,
            background: SPINE.coverSpineFront,
            borderRadius: rounded,
            boxShadow: SPINE.shadowSoft,
            zIndex: 0,
          }}
        />
      )}
      {stackCount >= 1 && (
        <div
          style={{
            position: "absolute",
            left: 3,
            top: -2,
            width: w,
            height: h,
            background: SPINE.coverSpineBack,
            borderRadius: rounded,
            zIndex: 1,
          }}
        />
      )}

      {coverSrc ? (
        <img
          src={coverSrc}
          alt={`Cover of ${displayTitle}`}
          style={{
            position: "relative",
            width: w,
            height: h,
            objectFit: "cover",
            borderRadius: rounded,
            boxSizing: "border-box",
            boxShadow: `${SPINE.shadowSoft}, inset 0 0 0 1px ${SPINE.coverInsetRim}`,
            zIndex: 2,
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            position: "relative",
            width: w,
            height: h,
            background: `linear-gradient(90deg, rgba(0,0,0,.2) 0, rgba(0,0,0,0) 6%, rgba(0,0,0,0) 100%), ${palette.bg}`,
            borderRadius: rounded,
            boxSizing: "border-box",
            boxShadow: `${SPINE.shadowSoft}, inset 0 0 0 1px ${SPINE.coverInsetRim}`,
            color: palette.ink,
            padding: `${Math.max(8, w * 0.07)}px ${Math.max(7, w * 0.08)}px`,
            display: "flex",
            flexDirection: "column",
            fontFamily: SPINE.serif,
            zIndex: 2,
            overflow: "hidden",
          }}
        >
          <div style={{ height: 1, background: palette.rule, opacity: 0.6, marginBottom: w * 0.04 }} />
          <div
            style={{
              fontSize: Math.max(9, Math.round(w * 0.105)),
              lineHeight: 1.15,
              fontWeight: 600,
              letterSpacing: 0.1,
              fontStyle: "italic",
              textWrap: "balance",
              overflow: "hidden",
            }}
          >
            {displayTitle}
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: "40%", height: 1, background: palette.rule, opacity: 0.5 }} />
          </div>
          <div style={{ height: 1, background: palette.rule, opacity: 0.6, marginBottom: w * 0.04 }} />
          <div
            style={{
              fontSize: Math.max(7, Math.round(w * 0.075)),
              lineHeight: 1.2,
              opacity: 0.85,
              fontFamily: SPINE.sans,
              fontWeight: 400,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {authorLast}
          </div>
        </div>
      )}

      {stackCount >= 1 && (
        <div
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            background: SPINE.panel,
            color: SPINE.textMid,
            fontFamily: SPINE.mono,
            fontSize: 9,
            fontWeight: 500,
            padding: "1px 5px",
            borderRadius: 2,
            border: `1px solid ${SPINE.border}`,
            zIndex: 3,
          }}
        >
          ×{instances}
        </div>
      )}
    </div>
  );
}
