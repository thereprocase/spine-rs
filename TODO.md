# TODO

Near-term, honest task list for picking Spine back up. Grouped by area, roughly
in priority order. This is a parked-mid-stream project, so a lot of these are
"finish what's started" rather than greenfield. The deeper backlog lives in
`docs/TECH_DEBT.md`.

## Core / backend (`core/`, `core/spine-srv`)

- [ ] Finish the **format-conversion pipeline** (a general `ebook-convert`-style
      any-format path): wire the conversion IR (`docs/ADR_017`) through a real
      any-format → EPUB path with the deterministic EPUB writer (`docs/ADR_018`).
- [ ] Close the **OpenAPI ↔ handler drift** so the generated client matches the
      live `spine-srv` surface.
- [ ] Bring the less-mature `spine-fmt-*` crates up to the EPUB crate's bar.
- [ ] Land the remaining `spine-bf` write-API correctness follow-ups (provenance
      on reconcile/promote paths).

## Native Android (`apps/mobile/android`) — highest bug density

- [ ] Stabilize the reader: paging/tap-zone/overlay-chrome bugs across device
      sizes and cutouts.
- [ ] Harden EPUB import + render error states (malformed OPF, missing resources).
- [ ] Reconcile reader progress/locator persistence with the core (Spine owns
      progress).
- [ ] On-device smoke pass on a range of real EPUBs, including a large book, to
      confirm the no-whole-book-in-memory guarantee holds.

## Desktop (`apps/desktop`)

- [ ] Daily-driver gaps: richer multi-select/batch ops, context menus, search
      query syntax (`author:…`), EPUB page counts.
- [ ] Big-library performance (list virtualization) — gated on measuring a
      real-world large library first.
- [ ] Widen automated (Vitest) coverage beyond happy paths.

## RN / Expo reader (`apps/mobile-reader`) — retired

- [ ] No new features. Optionally keep it building as a UI sandbox, or archive it.
      Its memory limitation on large books is by design and won't be fixed here.

## Project / repo hygiene

- [ ] Decide which `docs/` reference material to keep current vs. archive.
- [ ] CI: keep the workspace build + tests green; expand perf gates as the
      conversion pipeline lands.
