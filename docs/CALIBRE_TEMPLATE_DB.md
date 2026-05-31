# CALIBRE_TEMPLATE_DB.md

`apps/desktop/src-tauri/resources/calibre-template.db` is a pristine empty
calibre library database shipped with Spine to bootstrap new libraries without
requiring an existing calibre install on the user's machine.

This document records the file's provenance and the procedure to regenerate it
when upstream calibre bumps its schema.

## Why a template instead of hand-written DDL

CLAUDE.md pins `metadata.db` byte-compatibility with upstream calibre as a
locked invariant. Two candidates existed:

1. Port calibre's `CREATE TABLE …` DDL into Rust as
   `calibre-db::bootstrap::create_schema()`.
2. Capture the canonical output of calibre's own library-create path as a
   binary asset and copy it on new-library creation.

(2) was chosen. The template is byte-identical to upstream by construction, so
the 40-plus-table surface — including FTS5 virtual tables (`annotations_fts`
and its `_data` / `_idx` / `_docsize` / `_stemmed_*` siblings), the
`books_pages_link_create_trigger` AFTER INSERT trigger, `tag_browser_*`
views, `custom_columns` scaffolding, and `preferences` / `meta` / `library_id`
machinery — comes in correct without a 500-line DDL port we would have to
re-diff on every upstream bump. Review surface reduces from "audit every
CREATE statement against `database2.py`" to "did the regeneration procedure
reproduce, and does the sha256 match a known-good source calibre install."

Template-by-construction was proposed during an architecture review on 2026-04-24; see internal design notes.

## Provenance

**Source calibre version:** `calibre 9.7` (Windows x64 system install).

Reproduce the source-version string:

```
"/path/to/calibredb.exe" --version
# calibredb.exe (calibre 9.7)
```

**Schema version (PRAGMA user_version):** `27`.

**File size:** `409,600` bytes.

**sha256:**
`cdb9aafc902eeef2fd0e5eb54770605ebc3496ba681f08be370e510644e42246`

**Seed `library_id.uuid`:** `7f71ade3-eb11-4d0b-ad22-f45f31e40d5d`.

This UUID is present in the checked-in template. The `create_library`
command **MUST** rotate it to a fresh v4 UUID on copy so every new Spine
library has a unique identity. See `apps/desktop/src-tauri/src/lib.rs`
implementation.

## Licensing

Calibre is GPL-3.0. This template is the deterministic *output* of calibre's
library-create code path, not a derivative of calibre's source.

The FSF's position on output from GPL programs:

> The output of a program is not, in general, covered by the copyright on the
> code of the program. So the license of the code of the program does not
> apply to the output, whether you pipe it into a file, make a screenshot,
> screencast, or video.
> — <https://www.gnu.org/licenses/gpl-faq.html#WhatCaseIsOutputGPL>

Spine is itself GPL-3.0, so even if the template were considered a
derivative (it isn't), the licenses would be compatible. Attribution to
upstream calibre is already recorded in `COPYRIGHT` and `NOTICE` per the
locked `metadata.db` compatibility invariant.

## Regeneration procedure

When upstream calibre bumps `PRAGMA user_version` (27 → 28+), or when we
otherwise need to refresh the template:

1. **Install / update calibre** to the target version. Record the exact
   version string from `calibredb --version`.

2. **Generate a fresh empty library**. Calibre creates `metadata.db` on the
   first invocation against an empty `--with-library` directory; `list` is
   the cheapest such invocation because it reads rather than writes:

   ```
   SEED_DIR="$(mktemp -d -t spine-seed-XXXXXX)"
   "/path/to/calibredb" --with-library "$SEED_DIR" list
   ```

   On Windows with calibre installed at the default location, from a WSL
   shell:

   ```
   SEED_DIR="/mnt/c/Users/$USER/AppData/Local/Temp/spine-seed-$$"
   WIN_SEED="C:\\Users\\$USER\\AppData\\Local\\Temp\\spine-seed-$$"
   mkdir -p "$SEED_DIR"
   "/mnt/c/Program Files/Calibre2/calibredb.exe" --with-library "$WIN_SEED" list
   ```

   The command prints the empty-library header (`id title authors`) and
   returns zero.

3. **Verify the output** before overwriting the checked-in template:

   ```
   sqlite3 "$SEED_DIR/metadata.db" "PRAGMA user_version;"
   # expect a single integer; note the value
   sqlite3 "$SEED_DIR/metadata.db" "SELECT COUNT(*) FROM books;"
   # expect 0
   sqlite3 "$SEED_DIR/metadata.db" "SELECT COUNT(*) FROM authors;"
   # expect 0
   sha256sum "$SEED_DIR/metadata.db"
   # record for the provenance update
   ```

4. **Replace the checked-in template**:

   ```
   cp "$SEED_DIR/metadata.db" apps/desktop/src-tauri/resources/calibre-template.db
   ```

5. **Update this file** with the new calibre version, new schema_version,
   new size, new sha256, and new seed UUID.

6. **Run the desktop test suite** to confirm `create_library` still
   produces an openable library.

## Tauri bundle

The template ships inside the packaged MSI / DMG / deb via
`apps/desktop/src-tauri/tauri.conf.json` → `bundle.resources`. At runtime
the `create_library` Tauri command resolves the resource path with
`app.path().resolve(..., BaseDirectory::Resource)` and copies it to the
user-chosen library directory as `metadata.db`.

## Related

- `apps/desktop/src-tauri/src/lib.rs` — `create_library` command implementation.
- `apps/desktop/src-tauri/resources/calibre-template.db` — the asset itself.
- `docs/TECH_DEBT.md` §4.15 — schema-bump migration path (filed alongside
  this doc; addresses libraries created from an older template when upstream
  calibre moves forward).
