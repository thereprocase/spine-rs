import type { ReactNode } from "react";
import { SPINE } from "./tokens";
import Icon from "./components/Icon";

interface BatchInspectorProps {
  count: number;
  width?: number;
  isReconciling?: boolean;
  reconcileProgress?: { done: number; total: number } | null;
  /** Keep the Set out of this presentation layer; caller passes the
   *  prepared callbacks bound to its own state. */
  onReconcileAll?: () => void;
  onRemoveAll?: () => void;
  onExportAll?: () => void;
  onClearSelection?: () => void;
}

// Right-pane variant shown when `selectedIds.size > 1`. Replaces the
// single-book Inspector with a batch-action surface — record count,
// big destructive-action buttons, ARIA-friendly prompts.
//
// Per code review note 5: destructive batch ops
// (Remove especially) reuse the existing single-book confirmation
// dialog with the count surfaced; the caller wires that.
//
// Per note 4: multi-book Reconcile MUST serialize SRU calls (max 2
// concurrent + 500ms gap) per ADR 005 LoC cache strategy. The
// caller's `onReconcileAll` enforces serialization; this component
// just shows the progress.
export default function BatchInspector({
  count,
  width = 340,
  isReconciling,
  reconcileProgress,
  onReconcileAll,
  onRemoveAll,
  onExportAll,
  onClearSelection,
}: BatchInspectorProps) {
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
      <div style={{ padding: "18px 18px 14px" }}>
        <div
          style={{
            fontFamily: SPINE.sans,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: SPINE.textFaint,
            marginBottom: 8,
          }}
        >
          Multi-select
        </div>
        <div
          style={{
            fontFamily: SPINE.serif,
            fontStyle: "italic",
            fontSize: 22,
            fontWeight: 600,
            color: SPINE.text,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count} books selected
        </div>
        <div
          style={{
            fontFamily: SPINE.sans,
            fontSize: 12,
            color: SPINE.textMid,
            marginTop: 6,
          }}
        >
          Apply an action to every book in the current selection.
        </div>
      </div>

      {/* Reconcile (primary action — non-destructive) */}
      <Section title="Reconcile">
        <div style={{ fontSize: 11, color: SPINE.textDim, marginBottom: 10 }}>
          Look each book up against id.loc.gov. SRU calls run serially with a
          short pause between hits per the LoC cache budget.
        </div>
        <button
          type="button"
          onClick={onReconcileAll}
          disabled={isReconciling || !onReconcileAll}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: isReconciling ? SPINE.surface : SPINE.accent,
            color: isReconciling ? SPINE.textMid : SPINE.inkInvert,
            border: "none",
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            fontWeight: 500,
            cursor: isReconciling || !onReconcileAll ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon name="loc" size={14} color={isReconciling ? SPINE.textMid : SPINE.inkInvert} />
          {isReconciling
            ? reconcileProgress
              ? `Reconciling… ${reconcileProgress.done}/${reconcileProgress.total}`
              : "Reconciling…"
            : `Reconcile ${count} books against id.loc.gov`}
        </button>
      </Section>

      {/* Export */}
      <Section title="Export">
        <button
          type="button"
          onClick={onExportAll}
          disabled={!onExportAll || isReconciling}
          style={{
            width: "100%",
            padding: "7px 12px",
            background: "transparent",
            color: SPINE.text,
            border: `1px solid ${SPINE.border}`,
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            cursor: !onExportAll || isReconciling ? "default" : "pointer",
            textAlign: "left",
          }}
        >
          Export {count} EPUBs to a folder…
        </button>
      </Section>

      {/* Destructive — clearly separated */}
      <Section title="Danger zone">
        <button
          type="button"
          onClick={onRemoveAll}
          disabled={!onRemoveAll || isReconciling}
          style={{
            width: "100%",
            padding: "7px 12px",
            background: "transparent",
            color: SPINE.alert,
            border: `1px solid ${SPINE.alert}`,
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            cursor: !onRemoveAll || isReconciling ? "default" : "pointer",
            textAlign: "left",
          }}
        >
          Remove {count} books from library…
        </button>
        <div style={{ fontSize: 10, color: SPINE.textFaint, marginTop: 6 }}>
          Requires confirmation. Files on disk are kept unless you opt to delete.
        </div>
      </Section>

      <div style={{ flex: 1 }} />

      <div style={{ padding: "12px 18px", borderTop: `1px solid ${SPINE.borderSoft}` }}>
        <button
          type="button"
          onClick={onClearSelection}
          style={{
            width: "100%",
            padding: "7px 12px",
            background: "transparent",
            color: SPINE.textDim,
            border: `1px solid ${SPINE.border}`,
            borderRadius: 3,
            fontFamily: SPINE.sans,
            fontSize: 12,
            cursor: onClearSelection ? "pointer" : "default",
          }}
        >
          Clear selection (Esc)
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "14px 18px", borderTop: `1px solid ${SPINE.borderSoft}` }}>
      <div
        style={{
          fontFamily: SPINE.sans,
          fontSize: 10,
          fontWeight: 600,
          color: SPINE.textDim,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
