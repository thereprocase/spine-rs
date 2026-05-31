# Calibre Feature Inventory

Exhaustive categorization of calibre's feature surface, organized by user visibility. Built to inform the Spine rewrite scope.

**How to use this document.** Each feature has three parts:
- **Skim** — one line of what it does for a user.
- **Sketch** — data shape / flow / key primitives, enough to reason about the rewrite without reading code.
- **Source** — path inside the calibre source tree. Resolve against a local checkout of the upstream calibre source tree (pinned `9e257ec`, 2026-04-20); fall back to `github.com/kovidgoyal/calibre/blob/master/` when a newer revision is needed.
**Buckets.**
1. **Advertised / Popular** — what calibre is known for. Feature parity here is table stakes.
2. **Front of GUI** — visible without any click. Users expect muscle-memory parity.
3. **2–4 click GUI** — submenus, context menus, bulk ops, preferences panes. Skippable for MVP, regression-risk for v1.
4. **Other** — CLI tools, plugin hooks, niche UI, experimental.
5. **Back-end only** — internals never surfaced directly but load-bearing for behavior.

**Source root convention.** Paths are relative to the upstream calibre repo root; resolve them against a local calibre checkout. To fetch latest: prefix with `github.com/kovidgoyal/calibre/blob/master/` via WebFetch. When a feature spans many files, the pointer is the main entry or the package `__init__.py`. All paths below verified against the local clone at commit `9e257ec`.

---

## 1. Advertised / Popular

What calibre's README and home page sell.

### Library management (central metadata DB + multi-format storage)
- **Skim:** One DB per library, one folder per book with all its formats + `metadata.opf` + `cover.jpg`.
- **Sketch:** SQLite `metadata.db` at library root. Tables: `books`, `authors`, `tags`, `series`, `publishers`, `data` (format→file map), `identifiers`, `comments`, `custom_column_N` (user columns), plus join tables. Folder layout: `<Author>/<Title> (id)/<files>`. Cache of views materialized in `db.cache.Cache`.
- **Source:** `src/calibre/db/` (cache, legacy, tables, schema_upgrades), `src/calibre/library/__init__.py`, `resources/metadata_sqlite.sql`.

### Format conversion (any→any)
- **Skim:** EPUB/MOBI/AZW3/PDF/DOCX/HTML/TXT/RTF/FB2/LIT/LRF/PDB/CHM/ODT in, any of those out.
- **Sketch:** Pipeline = Input plugin → OEB (intermediate Open E-Book DOM) → transforms (CSS flatten, heuristics, structure detection, TOC) → Output plugin. One `Plumber` object orchestrates. Each format has `InputFormatPlugin` / `OutputFormatPlugin`.
- **Source:** `src/calibre/ebooks/conversion/plumber.py`, `src/calibre/ebooks/conversion/plugins/*.py` (per-format), `src/calibre/ebooks/oeb/` (intermediate repr), `src/calibre/customize/conversion.py` (plugin base classes).

### E-reader device sync
- **Skim:** Plug in Kindle/Kobo/Nook/Sony/Pocketbook, calibre auto-detects and syncs books.
- **Sketch:** `DevicePlugin` subclasses in `src/calibre/devices/`. USB VID/PID match + MTP fallback. Per-device quirks: Kindle collections JSON, Kobo KePub conversion, Sony `media.xml`. Detection loop runs in main thread; transfer runs in worker.
- **Source:** `src/calibre/devices/` (70+ drivers), `src/calibre/devices/interface.py` (base `DevicePlugin`), `src/calibre/devices/usbms/driver.py` (USB mass storage generic), `src/calibre/devices/kindle/`, `src/calibre/devices/kobo/`.

### Metadata fetching (from online sources)
- **Skim:** Right-click → download metadata and covers from Google/Amazon/ISFDB/Goodreads/etc.
- **Sketch:** `Source` base class, each source implements `identify(log, result_queue, abort, title, authors, identifiers)` → yields `Metadata` objects. Parallel query, merge by confidence, user picks. Covers separate via `download_cover`.
- **Source:** `src/calibre/ebooks/metadata/sources/` (base.py, google.py, amazon.py, openlibrary.py, edelweiss.py, search_engines.py, google_images.py, covers.py, identify.py). Note: `isbndb.py` / `ozon.py` were removed in earlier refactors; modern sources rely on search-engine scraping and openlibrary.

### Content server (browse + read in browser, OPDS)
- **Skim:** Run `calibre-server` or click Connect/Share → library available at `http://host:8080` with a web reader and OPDS feed.
- **Sketch:** Async HTTP server (tornado-derived, now custom). REST-ish endpoints for books, covers, formats. In-browser viewer (JS) for EPUB. OPDS 1.x feed for e-reader apps. Optional user accounts with per-user library restrictions.
- **Source:** `src/calibre/srv/` (loop.py, http_request.py, handler.py, books.py, opds.py, code.py, auth.py), `src/calibre/srv/embedded.py` (launcher).

### News downloading (→ e-book)
- **Skim:** Scheduled fetch of news sites/RSS → assembled EPUB/MOBI, optionally emailed to Kindle.
- **Sketch:** Python "recipe" per source subclasses `BasicNewsRecipe`. Recipe defines `feeds` / `parse_index` / `print_version`. Engine fetches, cleans, downloads images, packages as EPUB via `oeb`.
- **Source:** `src/calibre/web/feeds/` (news.py, recipes/*.recipe — 1,500+ recipes shipped), `src/calibre/web/feeds/news.py` (`BasicNewsRecipe` base).

### E-book editor
- **Skim:** Full EPUB source editor: file tree, code panel, live preview, live CSS, search/replace.
- **Sketch:** Qt-based IDE. Loads EPUB into in-memory container (`Container`), tree view of spine + resources. Edits write back through container on save. Checkpoints = snapshot of container state.
- **Source:** `src/calibre/gui2/tweak_book/` (boss.py, ui.py, editor/*, preview.py, search.py, check.py), `src/calibre/ebooks/oeb/polish/container.py`.

### E-book viewer
- **Skim:** Read EPUB/PDF/CBZ/CBR/AZW3 in calibre's own viewer with highlights, bookmarks, TTS.
- **Sketch:** QtWebEngine rendering EPUB as a single scrolling doc or paginated. Reading state (position, bookmarks, highlights) stored per-book in `annotations` JSON. PDF via native renderer (poppler/pdfium wrapper).
- **Source:** `src/calibre/gui2/viewer/` (ui.py, main.py, overlay.py, annotations.py), JS viewer in `src/pyj/read_book/` (RapydScript → JS).

### DRM removal (not shipped; third-party plugin ecosystem)
- **Skim:** Not official. Users install `DeDRM_tools` plugin to strip Kindle/Kobo/Adobe DRM on import.
- **Sketch:** Plugin hooks into `FileTypePlugin` preprocess. Not part of upstream.
- **Source:** Not in calibre; `github.com/noDRM/DeDRM_tools`. Spine: same plugin-hook pattern, don't ship.

### Cross-platform (Win/macOS/Linux) single binary
- **Skim:** One installer per OS; portable mode available.
- **Sketch:** Python + Qt frozen via custom `py2app`/PyInstaller-ish pipeline. Portable mode = `calibre-portable.exe` that treats its dir as `CALIBRE_CONFIG_DIRECTORY`.
- **Source:** `setup/install.py`, `setup/build.py`, `bypy/` (kovid's custom bundler repo).

---

## 2. Front of GUI

Visible in the main window without any click. Muscle-memory surface.

### Main toolbar buttons
Each is a `QToolButton` backed by an `InterfaceAction`. All register via `src/calibre/gui2/actions/__init__.py` ↔ `gui2.ui.Main`.

| Button | Skim | Source |
|---|---|---|
| Add books | File picker / ISBN / empty / from archive | `src/calibre/gui2/actions/add.py` |
| Edit metadata | Single or bulk editor dialog | `src/calibre/gui2/actions/edit_metadata.py` |
| Convert books | Conversion dialog → `Plumber` job | `src/calibre/gui2/actions/convert.py` |
| View | Launch e-book viewer on selected | `src/calibre/gui2/actions/view.py` |
| Send to device | Dispatch to connected device driver | `src/calibre/gui2/actions/device.py` |
| Fetch news | Open recipes scheduler / download now | `src/calibre/gui2/actions/fetch_news.py` |
| Library | Switch / create / rename / remove / random pick / maintenance | `src/calibre/gui2/actions/choose_library.py` |
| Save to disk | Export w/ folder/filename templates | `src/calibre/gui2/actions/save_to_disk.py` |
| Connect/Share | Start content server, email setup, connect to folder | `src/calibre/gui2/preferences/server.py` (server config), `src/calibre/gui2/actions/device.py` (connect-to-folder), start wired into `src/calibre/gui2/ui.py`. No dedicated `actions/server.py`. |
| Remove books | Delete from library and/or disk | `src/calibre/gui2/actions/delete.py` |
| Help | Open online manual | `src/calibre/gui2/actions/help.py` |
| Preferences | Open preferences dialog | `src/calibre/gui2/actions/preferences.py` |

### Search bar (persistent)
- **Skim:** Live-filter the book list via a DSL (field:value, and/or/not, regex, date predicates).
- **Sketch:** Parser in `src/calibre/library/caches.py` / `src/calibre/db/search.py`. Grammar: `<field>:[=|~|^]<value>`, combinators `and|or|not`, parens. Field names: title/author/tag/series/publisher/rating/date/pubdate/identifiers/comments/format/size/cover/ondevice/marked/vl/in_tag_browser/<custom>. Date ops: `> < >= <= = !=`, tokens `today/yesterday/thismonth/Ndaysago`. Template search: `template:"(tpl)#@#:(t|d|n|b):(value)"`. Saved searches live in `metadata.db`.
- **Source:** `src/calibre/db/search.py`, `src/calibre/utils/search_query_parser.py`, `src/calibre/gui2/search_box.py`.

### Book list (central table view)
- **Skim:** Sortable, columnar, multi-select table of every book in the library.
- **Sketch:** `QTableView` → `BooksModel` → `db.view`. Columns: title, author, series, series_index, rating, publisher, date, pubdate, format, size, tags, comments, languages, identifiers, plus every user-defined custom column. Click sort, drag reorder, right-click show/hide. Drag books onto tag browser to tag/reauthor.
- **Source:** `src/calibre/gui2/library/models.py`, `src/calibre/gui2/library/views.py`, `src/calibre/gui2/library/delegates.py`.

### Tag browser (left sidebar)
- **Skim:** Hierarchical browsable index of every author/tag/series/publisher/identifier/custom-category.
- **Sketch:** `QTreeView` over `TagsModel`. Categories are lazy: each top-level `Authors/Tags/Series/Publisher/Formats/Languages/Identifiers/Rating/News/Saved searches/User categories`. Hierarchy via "." in tag names or explicit user-categories. Click to filter book list; drag-drop books onto items to assign.
- **Source:** `src/calibre/gui2/tag_browser/model.py`, `src/calibre/gui2/tag_browser/view.py`, `src/calibre/gui2/tag_browser/ui.py`.

### Book details pane (right sidebar)
- **Skim:** Cover + metadata + format buttons for the selected book.
- **Sketch:** `QWebEngineView` rendering a templated HTML fragment (`src/calibre/gui2/book_details.py::render_html`). Links for authors/tags/series/publishers go back through the gui's navigate-to-search machinery. Format buttons open external viewer; right-click exposes per-format ops.
- **Source:** `src/calibre/gui2/book_details.py`.

### Cover grid / cover browser / bookshelf (view-mode switcher)
- **Skim:** Alternative visualizations of the library: grid of covers, iTunes-style coverflow, faux bookshelf.
- **Sketch:** Three sibling widgets toggled via layout button. Cover grid = `QListView` with grid mode + cover delegate. Cover browser / coverflow and grid all live in `alternate_views.py`. Bookshelf = `bookshelf_view.py` (custom painter grouping by author/date/rating/etc with spine rendering).
- **Source:** `src/calibre/gui2/library/alternate_views.py` (grid + coverflow), `src/calibre/gui2/library/bookshelf_view.py` (bookshelf).

### Jobs indicator (bottom right)
- **Skim:** Live count of running background jobs; click to see log, double-click completed to read.
- **Sketch:** `ThreadedJobServer` spawns OS processes for long jobs (conversion, metadata download, news). UI polls `job_manager` signals. Job objects carry `log_path`, `result`, `exception`.
- **Source:** `src/calibre/gui2/jobs.py`, `src/calibre/utils/ipc/job.py`, `src/calibre/utils/ipc/server.py`.

### Status bar
- **Skim:** Book count, current virtual library, active filters, selection count.
- **Sketch:** `QStatusBar` with labels updated via Qt signals from `BooksModel.count_changed` and `Main.vl_tabs` state. No dedicated file — assembled inline in `ui.py`/`layout.py`.
- **Source:** `src/calibre/gui2/ui.py`, `src/calibre/gui2/layout.py`.

### Virtual library tabs
- **Skim:** Tabs above the book list, each a saved-query filter on the whole library.
- **Sketch:** VLs = `{name: search_expr}` JSON in `metadata.db` prefs. Switching = applying the search under the hood. Temporary VL (`Ctrl+*`) is a non-persistent tab.
- **Source:** `src/calibre/gui2/dialogs/saved_search_editor.py`, `src/calibre/gui2/library/views.py`, and VL-tab UI in `src/calibre/gui2/layout.py`.

### Layout / toggle buttons
- **Skim:** Show/hide tag browser, book details, cover grid, cover browser, bookshelf, jobs, search bar.
- **Sketch:** Each pane registered as a toggleable widget in `LayoutMixin`. State persisted per-library in `gui.json`.
- **Source:** `src/calibre/gui2/layout.py`, `src/calibre/gui2/init.py`.

### Donate button
- **Skim:** Opens donation page in browser.
- **Sketch:** Direct `QDesktopServices.openUrl`.
- **Source:** `src/calibre/gui2/ui.py` (`Main.donate`).

---

## 3. Two-to-four click GUI

Reachable from submenus, right-click context menus, preferences pages. Skippable for MVP, huge regression surface for "parity" users.

### Add Books submenu
- Add from a single folder / folders+subfolders / archive / ISBN / empty book / clipboard / additional files to existing records.
- **Sketch:** `AddAction` dispatches to `adder.Adder` which runs in worker; dedup against hashes; recursive folder walk with format filter.
- **Source:** `src/calibre/gui2/actions/add.py`, `src/calibre/gui2/add.py`, `src/calibre/db/adding.py`.

### Edit Metadata submenu
- Individual editor (full form + format-editor + cover fetch) / bulk editor / download metadata+covers / copy metadata / paste metadata / merge records / manage extra data files / configure metadata sources.
- **Sketch:** Single dialog = `src/calibre/gui2/metadata/single.py`; bulk = `src/calibre/gui2/dialogs/metadata_bulk.py` (batched updates via `db.cache`). Merge = move formats + combine custom columns; rules in `src/calibre/gui2/dialogs/confirm_merge.py`.
- **Source:** `src/calibre/gui2/metadata/`, `src/calibre/gui2/actions/edit_metadata.py`.

### Convert submenu
- Convert individually / bulk convert / **Create catalog** (emit a new e-book that is itself an index of the library, in CSV/BibTeX/XML/EPUB/MOBI/AZW3).
- **Sketch:** Catalog = a conversion-like job that generates an OEB and routes through output plugin. Same `Plumber` machinery.
- **Source:** `src/calibre/gui2/convert/`, `src/calibre/library/catalogs/` (catalog generators per format).

### Polish books (submenu of Convert)
- Embed fonts / subset embedded fonts / smarten punctuation / remove unused CSS / compress images / upgrade book internals / update metadata in file / add preserve-aspect cover / download metadata into file.
- **Sketch:** Operates on a mounted `Container` in-place (EPUB/AZW3). Each polish op is a transform on the container.
- **Source:** `src/calibre/ebooks/oeb/polish/` (main.py, container.py, cover.py, fonts.py, jacket.py, css.py, images.py, toc.py, embed.py, upgrade.py), `src/calibre/gui2/actions/polish.py` (action wiring), `src/calibre/gui2/tweak_book/polish.py` (editor-side integration).

### Check book
- EPUB integrity validation: missing files, broken internal links, malformed XHTML/CSS, encoding issues.
- **Sketch:** Ruleset over a loaded Container; emits `Error` / `Warning` with file+line.
- **Source:** `src/calibre/ebooks/oeb/polish/check/` (main.py, parsing.py, links.py, css.py, fonts.py, images.py, opf.py, base.py).

### Compare books
- Side-by-side diff of two copies of a book (after edit / vs. format-converted version).
- **Sketch:** Diff two `Container` snapshots, rendered in Qt diff view.
- **Source:** `src/calibre/gui2/tweak_book/diff/` (main diff UI, used both standalone and from editor).

### Edit Table of Contents
- Dedicated GUI to build/modify a book's TOC independently of the full editor.
- **Sketch:** Tree widget backed by `toc.py` model; persist back to `toc.ncx` / nav doc.
- **Source:** `src/calibre/gui2/toc/`, `src/calibre/ebooks/oeb/polish/toc.py`.

### Search & Replace (bulk in library)
- Regex-driven bulk metadata mutation across selected books.
- **Sketch:** Each row = `{field, search_re, replace, flags}`; dry-run preview; commit via `db.cache.set_field`.
- **Source:** `src/calibre/gui2/dialogs/metadata_bulk.py`.

### Virtual libraries
- Save current search as a tab / manage / additional restrictions on top of a VL.
- **Source:** `src/calibre/gui2/dialogs/saved_search_editor.py`.

### Saved searches
- Persist a search expression under a name, reusable via `search:"name"` or tag browser.
- **Source:** `src/calibre/gui2/dialogs/search.py`, saved in `metadata.db` prefs.

### Custom columns (user-defined metadata)
- Add a user column with type: text / comments / date / int / float / bool / rating / enumeration / composite template / series-like / set-of-tags.
- **Sketch:** Each new column = a `custom_column_N` row in `custom_columns` table + a paired data table `custom_column_N_data` and optional link table. Template columns evaluate at read time.
- **Source:** `src/calibre/db/schema_upgrades.py` (column creation), `src/calibre/gui2/preferences/create_custom_column.py`, `src/calibre/library/custom_columns.py`.

### User categories (hierarchical groupings in tag browser)
- Create synthetic category trees that group tags/authors under custom labels.
- **Source:** `src/calibre/gui2/dialogs/tag_categories.py`, persisted in DB prefs.

### Send by email / "Send to Kindle"
- SMTP-based delivery; can target Kindle personal email for automatic device sync.
- **Sketch:** SMTP config per-account; scheduled via `smtp.py`; optionally converts to MOBI/AZW3 per recipient prefs.
- **Source:** `src/calibre/utils/smtp.py`, `src/calibre/gui2/email.py`, `src/calibre/gui2/preferences/emailp.py` (prefs UI).

### Auto-add from folder
- Watch a folder; any new file dropped in → imported to library.
- **Sketch:** Polling `AutoAdder` (`QTimer`), dedupe by hash, move imported file to subfolder `added/`.
- **Source:** `src/calibre/gui2/auto_add.py`, prefs in `Preferences → Adding books → Automatic adding`.

### Store search (aggregate e-book stores)
- Search across 20+ stores (Amazon, Kobo, B&N, Project Gutenberg, etc.) from inside calibre.
- **Sketch:** Each store = `StorePlugin` implementing `search(query, max_results) -> iter SearchResult`. Results unified in dialog.
- **Source:** `src/calibre/gui2/store/`, `src/calibre/gui2/store/stores/` (per-store plugins).

### Get Books (`G` shortcut) / "Get plugins"
- Two separate dialogs: search e-book stores, and browse calibre's own plugin index.
- **Source:** `src/calibre/gui2/actions/store.py`, `src/calibre/gui2/dialogs/plugin_updater.py`.

### Preferences dialog (mega-surface)
Every panel below is a `ConfigWidget` registered via `src/calibre/gui2/preferences/__init__.py`.

**Interface**
- Look & feel — colors, cover grid sizing, book details template, tag browser layout, quickview options, categories-with-hierarchical-items. `gui2/preferences/look_feel.py`.
- Behavior — preferred output format, viewer format priorities, restart options. `gui2/preferences/behavior.py`.
- Toolbars & menus — add/remove buttons per-location (main, context, device). `gui2/preferences/toolbar.py`.
- Searching — case sensitivity, unaccented char matching, punctuation ignore, default search field. `gui2/preferences/search.py`.
- Input options / Output options — per-format knobs for conversions. `gui2/preferences/conversion.py`, per-format widgets in `gui2/convert/`.
- Keyboard shortcuts — every action rebindable. `gui2/preferences/keyboard.py`.
- Tweaks — raw Python dict of ~100 obscure knobs with docstrings. `gui2/preferences/tweaks.py`, `resources/default_tweaks.py`.

**Import/Export**
- Adding books — filename regex for metadata, read-metadata-from-content, cover extraction policy. `gui2/preferences/adding.py`.
- Saving books to disk — folder/filename template, format preference order. `gui2/preferences/saving.py`.
- Sending books to devices — per-device format preference, collection rules, template. `gui2/preferences/sending.py`.
- Metadata sources — enable/disable each source, set credentials. `gui2/preferences/metadata_sources.py`.
- Plugin metadata download rules — assign priority. `gui2/preferences/metadata_sources.py`.

**Sharing**
- Content server — port, auth, user accounts, restrictions. `gui2/preferences/server.py`.
- Email — SMTP accounts, per-recipient format. `gui2/preferences/emailp.py`.

**Advanced**
- Plugins — enable/disable/add/remove/update. `gui2/preferences/plugins.py`.
- Miscellaneous — debug dir, library check cadence, crash reporting. `gui2/preferences/misc.py`.
- Template functions — user-defined Python for templates. `gui2/preferences/template_functions.py`.

### Library maintenance
- Check library (vs on-disk), restore DB from OPFs, compact DB, rebuild FTS, move library, backup now.
- **Source:** `src/calibre/library/check_library.py`, `src/calibre/library/restore.py`, `src/calibre/db/backup.py`.

### Context menus
Every surface has one. Highlights:
- **Book list row** — all toolbar actions + "Copy to library", "Mark book", "Show in Quickview".
- **Book list column header** — show/hide, configure, Quickview, sort.
- **Tag browser item** — Hide, Rename, Manage…, Create note, Edit note, icon customization, sub-category assignment.
- **Book details pane** — per-format delete/save/open-with/compare; author → create/edit note; cover → change/open-with; background → re-index for FTS.
- **Cover in grid** — same as book details.
- **Source:** menus assembled in each widget's `contextMenuEvent`, actions from `gui2/actions/__init__.py`.

### Notes for authors/tags/series/publishers
- Rich-text markdown notes attached to a metadata value (author, tag, series, publisher).
- **Sketch:** Stored in `notes_db` SQLite sidecar. Linked to value by `(category, name)`. Rendered in book details panel when the value is present.
- **Source:** `src/calibre/db/notes/` (connect.py, exim.py, schema_upgrade.py — package, not single file), `src/calibre/gui2/dialogs/edit_category_notes.py`, `src/calibre/gui2/library/notes.py` (browse UI).

### Browse Annotations (`B`)
- Global view of highlights/bookmarks across all books.
- **Sketch:** Reads `annotations_db` (`annotations.db`, SQLite). Entries: `(book_id, format, type, content, timestamp, cfi)`.
- **Source:** `src/calibre/gui2/library/annotations.py`, `src/calibre/db/annotations.py`.

### Browse Notes (`Ctrl+Shift+N`)
- Searchable list of all notes.
- **Source:** `src/calibre/gui2/library/notes.py`.

### Quickview (`Q`)
- Popup / dock panel: click a cell in book list → see all books that share that value (same author/tag/series/etc.).
- **Source:** `src/calibre/gui2/dialogs/quickview.py`.

### Mark books
- Non-persistent tag you can toggle with `Ctrl+M` and search with `marked:true`. Useful for temporary workflows.
- **Source:** `src/calibre/gui2/actions/mark_books.py`.

### Pick random book
- **Source:** `src/calibre/gui2/actions/random.py` (yes it's its own action).

### Welcome wizard
- First-run: pick library location, e-reader device, interface language.
- **Source:** `src/calibre/gui2/wizard/`.

### Debug mode
- Relaunch with verbose logging; log window opens on exit.
- **Source:** `src/calibre/gui2/main.py::main` (`--debug` flag), `src/calibre/debug.py`.

### Template language (Preferences → Advanced → Template Functions)
- Inline expression language for composing strings from metadata (used in filenames, book details, composite columns, send-to-device templates).
- **Sketch:** Lexer+parser in `src/calibre/utils/formatter.py`. Grammar: `{field:|prefix|suffix}`, functions `{function(args)}`, control flow via builtin funcs (`assign`, `contains`, `ifempty`, `switch`, etc.). User-defined Python functions via preferences.
- **Source:** `src/calibre/utils/formatter.py`, `src/calibre/utils/formatter_functions.py`.

### AI / LLM integration ("Ask AI about selected books", viewer chat)
- **Skim:** `Ctrl+Alt+A` from the main library runs a user-configured LLM against selected books; the viewer has an inline chat/ask panel. Multi-provider backend lets the user plug in OpenAI, Google, OpenRouter, Ollama, LM Studio, GitHub models, or any OpenAI-compatible endpoint.
- **Sketch:** Provider abstraction in `src/calibre/ai/` — one subpackage per provider (`openai/`, `google/`, `ollama/`, `lm_studio/`, `open_router/`, `github/`, `openai_compatible/`). Each provider implements an ask/chat interface against its API. Config lives in `ai/config.py` + `ai/prefs.py`. GUI touches: library-side action (`gui2/actions/llm_book.py`) opens a dialog (`gui2/dialogs/llm_book.py`); viewer-side integration lives at `gui2/viewer/llm.py`.
- **Scope note for Spine:** Recent addition to calibre, post-dates the bulk of its architecture. Decision point for Spine: (a) ship an equivalent, (b) skip until post-MVP, (c) delegate to an external provider-router like LiteLLM and keep only the prompt-and-context plumbing in-tree. Pending `PLAN.md` updates.
- **Source:** `src/calibre/ai/` (providers + config), `src/calibre/gui2/actions/llm_book.py`, `src/calibre/gui2/dialogs/llm_book.py`, `src/calibre/gui2/viewer/llm.py`.

---

## 4. Other

CLI tools, plugin hooks, rare UI, experimental.

### Command-line tools
All in `src/calibre/<tool>/cli.py` or dedicated modules; dispatched from `setup.py console_scripts`.

| Tool | Purpose | Source |
|---|---|---|
| `calibre` | Launch GUI | `src/calibre/gui2/main.py` |
| `calibredb` | Library CRUD from CLI (add, remove, list, set_metadata, export, backup_metadata, check_library, clone, custom_columns, add_custom_column, remove_custom_column, add_format, remove_format, show_metadata, set_custom, set_metadata, list_categories, saved_searches, fts_index, fts_search, embed_metadata) | `src/calibre/db/cli/main.py` |
| `ebook-convert` | Headless conversion | `src/calibre/ebooks/conversion/cli.py` |
| `ebook-edit` | Launch editor headless-open | `src/calibre/gui2/tweak_book/main.py` |
| `ebook-viewer` | Launch viewer headless | `src/calibre/gui2/viewer/main.py` |
| `ebook-meta` | Read/write metadata in one file | `src/calibre/ebooks/metadata/cli.py` |
| `ebook-polish` | Polish op from CLI | `src/calibre/ebooks/oeb/polish/main.py` |
| `fetch-ebook-metadata` | One-off metadata source query | `src/calibre/ebooks/metadata/sources/cli.py` |
| `calibre-server` | Standalone content server | `src/calibre/srv/standalone.py` |
| `calibre-smtp` | Send via SMTP | `src/calibre/utils/smtp.py` |
| `calibre-debug` | Swiss-army: run recipes, drop into REPL, show config, etc. | `src/calibre/debug.py` |
| `calibre-customize` | CLI plugin management | `src/calibre/customize/ui.py` |
| `markdown-calibre` | Render Markdown → HTML (used internally, exposed; verify presence in `setup/install.py` `console_scripts`) | `src/calibre/ebooks/txt/markdownml.py`, `src/calibre/gui2/markdown_editor.py` — no dedicated `src/calibre/ebooks/markdown/` wrapper dir |
| `lrf2lrs` / `lrs2lrf` | Legacy Sony LRF format tools | `src/calibre/ebooks/lrf/` |
| `web2disk` | Crawl a site into a dir (recipe helper) | `src/calibre/web/fetch/simple.py` |

### Plugin types (public API)
Every plugin subclasses a `Plugin` base and is registered via `initialize()`.
- `FileTypePlugin` — preprocess on add / postprocess on save. `src/calibre/customize/__init__.py`.
- `MetadataReaderPlugin` / `MetadataWriterPlugin` — per-format. `src/calibre/customize/builtins.py`.
- `CatalogPlugin` — new catalog output formats. `src/calibre/customize/__init__.py`.
- `InputFormatPlugin` / `OutputFormatPlugin` — conversion pipeline endpoints.
- `MetadataSource` — online metadata providers.
- `CoverDownload` — online cover providers.
- `InterfaceActionBase` — new toolbar buttons / menu entries.
- `PreferencesPlugin` — new preferences pane.
- `Store` — e-book store search backend.
- `DevicePlugin` — new device driver.
- `ViewerPlugin` — extend the viewer.
- `EditBookToolPlugin` — extend the editor.
- **Source:** `src/calibre/customize/` (base classes), `src/calibre/customize/ui.py` (registry), `src/calibre/customize/zipplugin.py` (zip plugin loader).

### Recipe editor
- GUI to build a news recipe by example (pick feed URL, preview, tweak).
- **Source:** `src/calibre/gui2/dialogs/custom_recipes.py`.

### Annotations sync (device + viewer)
- Pull highlights/bookmarks off a Kindle; push viewer state to content server.
- **Sketch:** Kindle annotations stored on device as JSON + clippings.txt; parsed by device driver. Content server sync endpoint: `/interface-data/book-sync`.
- **Source:** `src/calibre/devices/kindle/apnx.py` (+ Kindle annotation fetcher), `src/calibre/srv/books.py`, `src/calibre/gui2/viewer/annotations.py`.

### Heuristic processing (conversion option)
- Detect italics, unwrap lines, detect chapter boundaries, remove headers/footers, fix unbalanced HTML.
- **Sketch:** Rule engine with toggleable heuristics; each is a regex or structural pass over OEB.
- **Source:** `src/calibre/ebooks/conversion/utils.py`, `src/calibre/ebooks/conversion/preprocess.py`.

### Structure detection (conversion option)
- Detect chapter breaks, page breaks, TOC, insert breaks/TOC at detected points.
- **Source:** `src/calibre/ebooks/conversion/plumber.py::StructureDetector`.

### Content server advanced
- Per-user libraries, restrict-to-virtual-library per user, change/reset password from CLI, run as systemd/launchd service, reverse-proxy mode, offline PWA mode.
- **Source:** `src/calibre/srv/users.py`, `src/calibre/srv/manage_users_cli.py`, `src/calibre/srv/code.py`.

### Export/import all calibre data
- Pack libraries + config + plugins into a single tarball for migration.
- **Source:** `src/calibre/gui2/dialogs/exim.py`, `src/calibre/utils/exim.py`.

### Template tester
- Dialog to test a template expression against an arbitrary book record.
- **Source:** `src/calibre/gui2/dialogs/template_dialog.py`.

### Full-text search
- Separate FTS5 SQLite index; incrementally built; searchable from search bar with `fts:"query"`.
- **Sketch:** `full_text_search.db` alongside `metadata.db`. Indexer extracts plaintext via per-format extractors. Search results surface as a ranked dialog.
- **Source:** `src/calibre/db/fts/`, `src/calibre/gui2/fts/` (query UI).

### Book file hash (dedup)
- SHA-256 of format file on import to catch exact duplicates.
- **Source:** `src/calibre/db/adding.py`, `src/calibre/utils/filenames.py`.

### Font subsetting
- On polish/convert, subset embedded fonts to only used glyphs.
- **Source:** `src/calibre/utils/fonts/subset.py`, `src/calibre/utils/fonts/sfnt/`.

### OPDS feed generator
- Atom-based OPDS 1.x catalog for e-reader apps.
- **Source:** `src/calibre/srv/opds.py`.

### DOCX / ODT / RTF / PDF / FB2 / LIT / LRF / CHM / PDB / PML / RB / SNB / TCR parsers
- Each format has its own reader and (most) a writer.
- **Source:** `src/calibre/ebooks/<format>/`.

### Comic archives (CBZ/CBR/CB7)
- Image-based books; also rendered in viewer.
- **Source:** `src/calibre/ebooks/comic/`, unrar via `unrarlib`.

### Translation / i18n
- ~50 languages; `.po` files compiled to `.mo` at install.
- **Source:** `src/calibre/translations/`, `setup/translations.py`.

### Log files / crash reports
- Per-session log in config dir; crash handler dumps stack + environment.
- **Source:** `src/calibre/constants.py` (`CONFIG_DIR_MODE`, config dir resolution), `src/calibre/gui2/main.py` (exception hook).

---

## 5. Back-end only

Internals with no direct UI, but mandatory for parity behavior.

### `metadata.db` schema (SQLite)
- **Sketch:** Tables: `books`, `authors`, `tags`, `series`, `publishers`, `languages`, `books_authors_link`, `books_tags_link`, `books_series_link`, `books_publishers_link`, `books_languages_link`, `data`, `comments`, `identifiers`, `custom_columns`, `custom_column_N`, `custom_column_N_link`, `ratings`, `feeds`, `library_id`, `preferences`. Triggers maintain `sort` columns (`authors.sort`, `books.sort`, `books.series_index`). FTS handled in sidecar DB.
- **Invariants:** Spine must stay byte-compatible here — no schema changes.
- **Source:** `resources/metadata_sqlite.sql`, `src/calibre/db/schema_upgrades.py`.

### OEB intermediate format
- **Sketch:** All conversion flows through this. In-memory tree: `Manifest` (items), `Spine` (ordered reading), `Guide`, `TOC`, `Metadata`. Items are XHTML/CSS/images/fonts. The conversion pipeline = a series of `OEBBook → OEBBook` transforms.
- **Source:** `src/calibre/ebooks/oeb/base.py`, `src/calibre/ebooks/oeb/reader.py`, `src/calibre/ebooks/oeb/writer.py`.

### Container model (for editor + polish)
- **Sketch:** Thin abstraction over EPUB/AZW3 zip. `Container.parsed(name)` returns XML etree or str; `Container.dirty(name)` marks for writeback; `Container.commit()` rewrites zip.
- **Source:** `src/calibre/ebooks/oeb/polish/container.py`.

### CSS flattening / simplification
- **Sketch:** External + inline CSS merged into per-item style; rule cascade resolved at preprocess time to reduce viewer/device divergence.
- **Source:** `src/calibre/ebooks/oeb/transforms/flatcss.py`, `src/calibre/ebooks/oeb/stylizer.py`.

### Character encoding detection
- **Sketch:** `chardet` wrapper with a retry ladder: declared encoding → BOM → chardet → fallback. Needed for legacy HTML/TXT sources.
- **Source:** `src/calibre/ebooks/chardet.py`.

### Headless browser scraper (news + metadata fetch substrate)
- **Sketch:** Modern JS-heavy news sites and some metadata endpoints can't be fetched with a plain HTTP client. `src/calibre/scraper/` runs an embedded QtWebEngine worker in a separate process, renders the page, and returns the rendered DOM. Called by news recipes that declare themselves JS-dependent, and by metadata sources that scrape search-engine result pages.
- **Files:** `simple.py` (plain requests fallback), `qt.py` + `qt_backend.py` (QtWebEngine host), `webengine_backend.py` (renderer worker).
- **Source:** `src/calibre/scraper/`. Also used via `src/calibre/ebooks/metadata/sources/search_engines.py`.

### XML / HTML / CSS parsers
- **Sketch:** `lxml` for XML; `html5-parser` (kovid's fork of html5lib) for HTML; `tinycss`/`css_parser` (maintained fork of `cssutils`) for CSS. Wrapped for error-tolerance.
- **Source:** `src/calibre/ebooks/oeb/parse_utils.py`, vendored html5-parser, `src/calibre/ebooks/css_transform_rules.py`.

### Identifier parsers
- **Sketch:** ISBN-10/13 normalize+validate, Amazon ASIN, Google Books volume ID, Goodreads, ISFDB, DOI, etc. Each has parser + canonicalizer + URL resolver.
- **Source:** `src/calibre/ebooks/metadata/sources/base.py` (schemes), `src/calibre/ebooks/metadata/sources/identify.py::urls_from_identifiers` (URL registry).

### Author/title sort generation
- **Sketch:** Rules: "Smith, John" from "John Smith"; "The Lord of the Rings" → "Lord of the Rings, The"; configurable in prefs.
- **Source:** `src/calibre/ebooks/metadata/__init__.py::author_to_author_sort`, `title_sort`.

### Cover generation (from metadata)
- **Sketch:** Pillow compose title+author+series on gradient or pattern background. Used when no cover is present.
- **Source:** `src/calibre/ebooks/covers.py`.

### Thumbnail cache
- **Sketch:** Per-book thumbnails at grid-size / details-size, stored under `<library>/.calibre-cover-thumbnails/` keyed by book id + mtime.
- **Source:** `src/calibre/db/cache.py::thumbnail_cache`, `src/calibre/utils/img.py`.

### Image processing
- **Sketch:** Pillow wrapper for covers, Qt image for in-memory manipulation; PNG optimization via `optipng` (optional).
- **Source:** `src/calibre/utils/img.py`.

### Archive handling
- **Sketch:** ZIP (stdlib + custom), RAR (`unrarlib`), 7z (`py7zr`/plugin), TAR (stdlib), GZIP/BZIP2 (stdlib).
- **Source:** `src/calibre/utils/zipfile.py` (custom ZIP with fixes), `src/calibre/utils/unrar.py`.

### IPC (worker processes)
- **Sketch:** Main process spawns Python workers via `multiprocessing` variant for each long-running job (convert, news, metadata fetch). Communication over pipes with pickled payloads. Enables GUI responsiveness + graceful cancellation.
- **Source:** `src/calibre/utils/ipc/` (server.py, simple_worker.py, launch.py, pool.py, job.py).

### Config resolution
- **Sketch:** `CONFIG_DIR` resolution (Windows: AppData, macOS: ~/Library/Preferences, Linux: ~/.config), portable mode override, per-library `metadata.db` prefs, global `~/.config/calibre/*.json` prefs.
- **Source:** `src/calibre/constants.py`, `src/calibre/utils/config.py`, `src/calibre/utils/config_base.py`.

### Database backup daemon
- **Sketch:** On schedule (every N hours), dump metadata.db to OPFs next to each book + a plain-text DB dump. Reverse-direction = library restore.
- **Source:** `src/calibre/db/backup.py`, `src/calibre/library/restore.py`.

### Saved-search + VL search compilation
- **Sketch:** Search DSL compiled to SQL predicates against `books` + join tables. Complex searches (regex, templates) fall back to in-Python filter over cached view rows.
- **Source:** `src/calibre/db/search.py`.

### Job log collection
- **Sketch:** Each IPC worker writes to a log file; job object carries path. GUI tails on demand.
- **Source:** `src/calibre/utils/ipc/job.py`.

### Qt resource bundling
- **Sketch:** Icons, translations, HTML templates packed into a Qt resource system at build time.
- **Source:** `resources/`, `setup/resources.py`.

### USB/MTP transport layer
- **Sketch:** Per-platform backend (libusb on Linux/macOS, winusb/Win32 on Windows). MTP layer is a Python wrapper around platform APIs. Timeout + reconnect logic lives here.
- **Source:** `src/calibre/devices/mtp/`, `src/calibre/devices/usbms/`.

### Kindle APNX (page numbers)
- **Sketch:** Generate Amazon's page-number sidecar (`.apnx`) so Kindle shows real page numbers for sideloaded MOBI.
- **Source:** `src/calibre/devices/kindle/apnx.py`.

### Kobo KePub transformation
- **Sketch:** Kobo devices want EPUB spans wrapped in `<span class="koboSpan">` for position tracking; driver injects these on send.
- **Source:** `src/calibre/devices/kobo/books.py`, `src/calibre/devices/kobo/kobotouch_config.py`.

### Font metric extraction
- **Sketch:** Parse sfnt tables directly (kovid wrote it from scratch) to get ascent/descent/cmap/glyph widths. Used for subsetting + font-face emission.
- **Source:** `src/calibre/utils/fonts/sfnt/`, `src/calibre/utils/fonts/metadata.py`.

### Regex engine wrapper
- **Sketch:** Prefers the `regex` module (PCRE-ish, 3rd-party, imported directly) over stdlib `re` for Unicode class support used by templates + search. No central wrapper — imports are per-callsite.
- **Source:** `import regex` scattered across `src/calibre/db/search.py`, `src/calibre/utils/search_query_parser.py`, `src/calibre/utils/formatter.py` and others. No dedicated helper module.

### BeautifulSoup / html5-parser
- **Sketch:** Vendored forks with calibre-specific fixes. Used everywhere HTML needs tolerant parsing.
- **Source:** vendored under `src/calibre/ebooks/BeautifulSoup.py` (old), `html5-parser` is a separate kovid C extension.

### Translation loader
- **Source:** `src/calibre/utils/localization.py`.

### Preferences sync primitives
- **Sketch:** JSON-typed config with per-key validators + change signals.
- **Source:** `src/calibre/utils/config_base.py::Config`.

### Crash recovery
- **Sketch:** `.calibre-recovery.json` at shutdown with open library + search state; on next launch restore.
- **Source:** `src/calibre/gui2/main.py`, `src/calibre/gui2/init.py`.

### Update check
- **Sketch:** Weekly background HTTP GET to calibre-ebook.com/latest; compares semver; notifies via tray icon.
- **Source:** `src/calibre/gui2/update.py`.

### Coffee / SCSS / RapydScript build pipeline
- **Sketch:** Viewer + content-server UI authored in RapydScript (Python-ish → JS), compiled at build time. Not user-facing but needed to build calibre.
- **Source:** `src/pyj/` (RapydScript sources), `src/calibre/utils/rapydscript.py` (compiler wrapper), `resources/rapydscript/` (runtime).

---

## Open questions for Spine scope

Things to resolve before locking the Spine feature list:

1. **Catalogs.** Calibre can emit a whole e-book that catalogs the library. Niche but beloved. Cut from MVP?
2. **Store search.** 20+ store plugins, mostly stale. Probably drop entirely.
3. **News recipes.** 1,500+ recipes is a maintenance burden. Offer as optional subsystem or cut?
4. **Heuristic processing.** Extremely fiddly, frequent support-question source. Ship off by default or skip?
5. **Comic rendering.** CBZ/CBR in the viewer is used but competing standalone apps exist. MVP or later?
6. **Plugin API surface.** Calibre has 13 plugin types. Spine has to pick a minimum viable subset. My guess: `MetadataSource`, `FileType` (import preprocess), `DevicePlugin`, `InterfaceAction` as phase-1 targets; the rest phase-2+.
7. **Full-text search.** Separate DB, separate indexer. MVP or later? (Probably MVP — users expect it.)
8. **Editor.** Entire IDE subsystem. Defer to phase 3+?
9. **Template language.** Calibre's template language is load-bearing for filenames, book details, custom columns, send-to-device paths. Do we port it, pick a different DSL, or eliminate the use cases?
10. **Cover generation from metadata.** Pillow dependency. Nice-to-have or MVP?

---

## How to use this against `PLAN.md`

- Each item in **Advertised / Popular** should map to a named phase in `PLAN.md`.
- **Front of GUI** items need UI spec before Phase 2 (desktop MVP).
- **2–4 click GUI** is the largest bucket — most of it should be gated behind "post-MVP" and reviewed item by item.
- **Other** items mostly reduce to "do we expose a CLI and a plugin system, and if yes, which surface."
- **Back-end only** is where the porting effort lives — every format parser, every conversion transform, every device quirk. The tech-debt register should track these as porting backlog.
