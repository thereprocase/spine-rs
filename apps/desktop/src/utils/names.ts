// TODO: this duplicates Rust's `spine_meta::reconcile::clean_name` — two
// sources of truth for author-name normalisation. TECH_DEBT §3.4 tracks the
// unification; until then, any change to one side must mirror the other.
export function normalizeName(name: string): string {
  if (!name) return 'Unknown';
  let cleaned = name.trim().replace(/^[\.,\[\]\s]+|[\.,\[\]\s]+$/g, '');
  if (cleaned.includes(',')) {
    return cleaned;
  }
  const parts = cleaned.split(/\s+/);
  if (parts.length > 1) {
    const last = parts.pop();
    return `${last}, ${parts.join(' ')}`;
  }
  return cleaned;
}
