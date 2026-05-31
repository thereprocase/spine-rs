import { SPINE } from "../tokens";

export interface StorageStats {
  spineDb: string;
  metadataDb: string;
  covers: string;
}

interface FooterProps {
  storage?: StorageStats | null;
}

// Sidebar footer — storage stats in Geist Mono 10px.
//
// Placeholder zeros when `storage` is null/undefined; plan §3 Open
// Decision tracks the `/api/v1/storage` endpoint as a soft-block, so
// callers that don't have live numbers yet ship with zeros + a TODO
// rather than blocking Step 3.
export default function Footer({ storage }: FooterProps) {
  const rows: [string, string][] = [
    ["spine.db", storage?.spineDb ?? "—"],
    ["metadata.db", storage?.metadataDb ?? "—"],
    ["covers", storage?.covers ?? "—"],
  ];
  return (
    <div
      style={{
        borderTop: `1px solid ${SPINE.border}`,
        padding: "10px 14px",
        fontFamily: SPINE.mono,
        fontSize: 10,
        color: SPINE.textFaint,
        lineHeight: 1.6,
        flexShrink: 0,
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{label}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}
    </div>
  );
}
