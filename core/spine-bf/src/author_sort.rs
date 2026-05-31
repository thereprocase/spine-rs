//! Port of calibre's `author_to_author_sort()` algorithm — the
//! string transform that produces `authors.sort` and `books.author_sort`
//! values upstream calibre stores in `metadata.db`.
//!
//! Source of truth: `src/calibre/ebooks/metadata/__init__.py::author_to_author_sort`
//! in upstream calibre (§Q2 of an internal design review names the symbol;
//! line numbers drift across calibre versions). Spine round-trips
//! depend on bit-for-bit match for the common cases — divergence on
//! exotic input (multi-script names, non-ASCII suffixes) is flagged in
//! `docs/TECH_DEBT.md` rather than fixed here.
//!
//! Algorithm (simplified for the cases that round-trip cleanly):
//!
//! 1. Empty → empty.
//! 2. Already-comma form (caller-supplied "Last, First") → preserve.
//! 3. Single-token name (Cher, Madonna) → return as-is.
//! 4. Otherwise: split on whitespace, strip a trailing suffix from a
//!    known set (Jr/Sr/I/II/III/IV/V plus dotted variants), invert
//!    last-token-first, re-append suffix.
//!
//! What this implementation does NOT do (calibre upstream does):
//! - `tweaks['author_sort_copy_method']` toggle between "invert" /
//!   "copy" / "comma" / "nocomma". Spine hard-pins "invert" for
//!   D4 MVP per design review §recommendation 1; tweakability deferred.
//! - ICU `icu_lower` case-folding. The `authors.sort` column stores
//!   the inverted form *as-is* (Title-Case preserved); ICU-folded
//!   forms are sort-time concerns, not storage-time. The design review §Q2
//!   was conflating two concerns.
//! - Non-Latin script handling. Calibre punts these to the user
//!   (set sort manually); we do likewise — single-token return.

const SUFFIXES: &[&str] = &[
    "Jr", "Jr.", "Sr", "Sr.", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
];

/// Compute the calibre-compatible `authors.sort` value for an author
/// display name. Round-trips with `metadata.db` for ASCII Latin names;
/// see module docs for what's intentionally out of scope.
pub fn author_to_author_sort(author: &str) -> String {
    let trimmed = author.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains(',') {
        return trimmed.to_string();
    }
    let mut parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() <= 1 {
        return trimmed.to_string();
    }
    let last_token = parts.last().copied().unwrap_or("");
    let suffix = if SUFFIXES.iter().any(|s| *s == last_token) && parts.len() > 2 {
        Some(parts.pop().unwrap())
    } else {
        None
    };
    let last = parts.pop().unwrap();
    let rest = parts.join(" ");
    match suffix {
        Some(s) => format!("{last}, {rest} {s}"),
        None => format!("{last}, {rest}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_author_returns_empty() {
        assert_eq!(author_to_author_sort(""), "");
        assert_eq!(author_to_author_sort("   "), "");
    }

    #[test]
    fn already_comma_form_preserves_input() {
        assert_eq!(
            author_to_author_sort("Tolkien, J. R. R."),
            "Tolkien, J. R. R."
        );
        assert_eq!(
            author_to_author_sort("Le Guin, Ursula K."),
            "Le Guin, Ursula K."
        );
    }

    #[test]
    fn single_token_returns_as_is() {
        assert_eq!(author_to_author_sort("Cher"), "Cher");
        assert_eq!(author_to_author_sort("Madonna"), "Madonna");
    }

    #[test]
    fn two_token_inverts_last_first() {
        assert_eq!(
            author_to_author_sort("Mary Shelley"),
            "Shelley, Mary"
        );
        assert_eq!(author_to_author_sort("Joe Bloggs"), "Bloggs, Joe");
    }

    #[test]
    fn three_token_inverts_with_middle_after_comma() {
        assert_eq!(
            author_to_author_sort("J. R. R. Tolkien"),
            "Tolkien, J. R. R."
        );
        assert_eq!(
            author_to_author_sort("Mary Wollstonecraft Shelley"),
            "Shelley, Mary Wollstonecraft"
        );
    }

    #[test]
    fn suffix_retained_after_inversion() {
        assert_eq!(
            author_to_author_sort("Martin Luther King Jr."),
            "King, Martin Luther Jr."
        );
        assert_eq!(
            author_to_author_sort("John Smith III"),
            "Smith, John III"
        );
        // "Henry V" — only 2 tokens with V as suffix — falls back to
        // surname-first inversion treating V as a normal token; regnal
        // numerals on bare two-token names are out-of-scope for D4
        // (calibre upstream user-resolves these).
        assert_eq!(author_to_author_sort("Henry V"), "V, Henry");
    }

    #[test]
    fn whitespace_normalizes() {
        assert_eq!(
            author_to_author_sort("  Mary   Shelley  "),
            "Shelley, Mary"
        );
    }
}
