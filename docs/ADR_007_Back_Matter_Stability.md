# ADR 007: Back-Matter Stability Contract

## Status
Proposed

## Context
Our S3/Tier 7 EPUB compatibility strategy injects metadata directly into the EPUB using three layers:
1. `META-INF/metadata.xml`
2. `OEBPS/content.opf`
3. `OEBPS/backmatter.xhtml` (RDFa)

The back-matter contains a human-readable catalog card with embedded RDFa. If a user modifies metadata in Spine, the central `spine.db` is updated. However, if they later export the EPUB, the back-matter in the EPUB file might be stale if it isn't regenerated. Conversely, if a user opens the EPUB in an editor (like Sigil) and modifies the back-matter manually, it diverges from `spine.db`.

## Decision
We enforce a strict **One-Way Regeneration Contract** for back-matter.

1. **Export-Time Regeneration:** Whenever an EPUB is exported from Spine or sent to a device, the `backmatter.xhtml` file is completely rebuilt from the current state of `spine.db`.
2. **Import-Time Extraction (One-Shot):** When an EPUB is imported *for the first time*, if it contains a Spine `backmatter.xhtml`, the RDFa is extracted to populate `spine.db`.
3. **No Bi-Directional Sync:** If the EPUB already exists in the Spine library, modifications made manually to the `backmatter.xhtml` file on disk are *ignored* unless the user explicitly triggers a "Re-ingest Metadata from File" action.
4. **No Third Truth:** The `backmatter.xhtml` inside the library folder's EPUB file is treated as a compiled projection of the database, just like `content.opf`. It is never the system of record for an already-ingested book.

## Consequences
- Guarantees the back-matter always reflects the true database state upon export.
- Prevents split-brain scenarios where the DB says one thing and the EPUB back-matter says another.
- May overwrite manual styling changes a user made to `backmatter.xhtml` using Calibre's "Edit Book" tool. This is acceptable, as the file is a machine-generated catalog page.
