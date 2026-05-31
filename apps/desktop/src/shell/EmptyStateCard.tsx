import type { ReactNode } from "react";
import { SPINE } from "../tokens";

interface EmptyStateCardProps {
  /** Italic-serif heading. */
  heading?: string;
  /** Italic-serif body copy. */
  body: ReactNode;
  /** Primary CTA. Renders as a full-width accent-fill button. */
  primaryCta?: { label: string; onClick: () => void };
  /** Optional secondary CTA. Renders as outline button. */
  secondaryCta?: { label: string; onClick: () => void };
  /** Variant for soft prompts (canvasAlt bg w/ warn-dot header). */
  variant?: "card" | "callout";
  /** Top-of-card status row, e.g. "10 books · 0 reconciled". */
  status?: { dotTone: string; label: string };
}

// Reusable empty-state card used at the cold-start, 1-book, and
// N-unreconciled progressions. Locked in v2 sidebar bundle
// (SidebarColdStart, L1360).
export default function EmptyStateCard({
  heading,
  body,
  primaryCta,
  secondaryCta,
  variant = "card",
  status,
}: EmptyStateCardProps) {
  if (variant === "callout") {
    return (
      <div
        style={{
          margin: "4px 14px 10px",
          padding: "10px 11px",
          background: SPINE.canvasAlt,
          border: `1px solid ${SPINE.borderSoft}`,
          borderRadius: 3,
        }}
      >
        {status && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: status.dotTone,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: SPINE.sans,
                fontSize: 10.5,
                color: SPINE.text,
                fontWeight: 500,
              }}
            >
              {status.label}
            </span>
          </div>
        )}
        <div
          style={{
            fontFamily: SPINE.serif,
            fontStyle: "italic",
            fontSize: 11,
            color: SPINE.textDim,
            lineHeight: 1.4,
            marginBottom: 8,
          }}
        >
          {body}
        </div>
        {primaryCta && (
          <button
            type="button"
            onClick={primaryCta.onClick}
            style={{
              background: SPINE.accent,
              color: SPINE.inkInvert,
              border: 0,
              padding: "4px 10px",
              borderRadius: 2,
              fontFamily: SPINE.sans,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.4,
              cursor: "pointer",
            }}
          >
            {primaryCta.label}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        margin: "12px 14px 8px",
        padding: "14px 12px 13px",
        background: `linear-gradient(180deg, ${SPINE.surface} 0%, ${SPINE.canvasAlt} 100%)`,
        border: `1px solid ${SPINE.border}`,
        borderRadius: 3,
      }}
    >
      {heading && (
        <div
          style={{
            fontFamily: SPINE.serif,
            fontStyle: "italic",
            fontSize: 13,
            color: SPINE.text,
            fontWeight: 600,
            marginBottom: 6,
            lineHeight: 1.25,
          }}
        >
          {heading}
        </div>
      )}
      <div
        style={{
          fontFamily: SPINE.serif,
          fontStyle: "italic",
          fontSize: 11.5,
          color: SPINE.textDim,
          lineHeight: 1.45,
          marginBottom: primaryCta || secondaryCta ? 11 : 0,
        }}
      >
        {body}
      </div>
      {primaryCta && (
        <button
          type="button"
          onClick={primaryCta.onClick}
          style={{
            width: "100%",
            background: SPINE.accent,
            color: SPINE.inkInvert,
            border: 0,
            padding: "6px 10px",
            borderRadius: 2,
            fontFamily: SPINE.sans,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            cursor: "pointer",
            marginBottom: secondaryCta ? 5 : 0,
          }}
        >
          {primaryCta.label}
        </button>
      )}
      {secondaryCta && (
        <button
          type="button"
          onClick={secondaryCta.onClick}
          style={{
            width: "100%",
            background: "transparent",
            color: SPINE.textMid,
            border: `1px solid ${SPINE.border}`,
            padding: "6px 10px",
            borderRadius: 2,
            fontFamily: SPINE.sans,
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {secondaryCta.label}
        </button>
      )}
    </div>
  );
}
