import { SPINE } from "../tokens";
import Icon from "../components/Icon";

export interface FilterChip {
  id: string;
  facet: string;
  value: string;
}

interface FilterBarProps {
  chips: FilterChip[];
  onRemoveChip?: (id: string) => void;
  onClearAll?: () => void;
}

// Active-filter chip row below the toolbar. Renders null when no chips
// are active so callers don't need to conditional-render it themselves.
export default function FilterBar({ chips, onRemoveChip, onClearAll }: FilterBarProps) {
  if (chips.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        background: SPINE.bg,
        borderBottom: `1px solid ${SPINE.borderSoft}`,
        fontFamily: SPINE.sans,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <Icon name="filter" size={12} color={SPINE.textDim} />
      <span
        style={{
          color: SPINE.textDim,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginRight: 2,
        }}
      >
        Active filters
      </span>
      {chips.map((chip) => (
        <span
          key={chip.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 4px 2px 8px",
            background: SPINE.surface,
            color: SPINE.text,
            borderRadius: 2,
            border: `1px solid ${SPINE.border}`,
          }}
        >
          <span style={{ color: SPINE.textDim, fontSize: 10 }}>{chip.facet}</span>
          <span>·</span>
          <span>{chip.value}</span>
          <button
            type="button"
            onClick={() => onRemoveChip?.(chip.id)}
            aria-label={`Remove ${chip.facet} filter`}
            style={{
              width: 14,
              height: 14,
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: SPINE.textDim,
              cursor: "pointer",
              background: "transparent",
              border: "none",
              padding: 0,
            }}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        style={{
          color: SPINE.textDim,
          marginLeft: 8,
          fontSize: 11,
          cursor: "pointer",
          background: "transparent",
          border: "none",
          padding: 0,
          font: "inherit",
        }}
      >
        Clear all
      </button>
    </div>
  );
}
