# Welcome book

`welcome.epub` is a short introductory e-book that Spine seeds into
every fresh library created via the "Start a new library" bootstrap
entry point. The file gives first-time users something readable the
moment the library opens, so the desktop app demonstrates the
click-to-read flow end-to-end without any user-supplied content.

## Source of truth

`welcome.md` in this directory is the authored source. Edit the
markdown when you want to change the welcome content.

## Regenerating welcome.epub

Spine currently uses calibre's `ebook-convert` to produce the bundled
EPUB from the markdown source. This is convenient during pre-1.0
development because calibre is already a supported install on every
target platform. A future iteration will swap `ebook-convert` for
Spine's own EPUB 3.3 writer (`spine-fmt-epub`) once that ships.

From this directory:

```
"/path/to/ebook-convert" welcome.md welcome.epub \
    --title="Welcome to Spine" \
    --authors="The Spine Project" \
    --language=en \
    --publisher="Spine" \
    --tags="welcome,reference"
```

On Windows with calibre at the default install location, from a WSL
shell:

```
"/mnt/c/Program Files/Calibre2/ebook-convert.exe" welcome.md welcome.epub \
    --title="Welcome to Spine" \
    --authors="The Spine Project" \
    --language=en \
    --publisher="Spine" \
    --tags="welcome,reference"
```

## Licensing

`welcome.md` is original work authored for Spine and is licensed
GPL-3.0 along with the rest of the Spine project. No third-party
content is included.

## Bundle wiring

`welcome.epub` is registered in
`apps/desktop/src-tauri/tauri.conf.json` under `bundle.resources`.
The `seed_welcome_book` Tauri command resolves the bundled path,
copies the file into the active library directory as `welcome.epub`,
and dispatches an ingest job through the standard pipeline so the
book shows up in the library grid like any other.

## Related

- `apps/desktop/src-tauri/src/lib.rs` — `seed_welcome_book` command.
- `apps/desktop/src/App.tsx` — `startNewLibrary` frontend handler that
  chains `create_library` → `seed_welcome_book`.
