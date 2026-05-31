# ADR 023: Plugin Architecture

## Status

Draft — pending review and lock.
Drafted 2026-04-25 (Sprint 9 doc-lane prep).
Inputs: the plugin-doctrine architecture design; cataloging-side inputs from an internal design review; the `InputFormat`/`OutputFormat`/`PolishOp` trait sketch; `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2` (formats refused first-party, plugin-pathable).

This ADR carries the plugin-extensibility doctrine that has been threading through Sprint 8 conversations into a durable artifact. It does NOT itself ship a plugin system — it locks the architectural shape so Sprint 14-17 implementers do not foreclose it by accident.

## Context

The motivating principle, ratified by the project roadmap's v3 §4.2 amendment cluster:

> *"Spine ships first-class plugin support so users can extend it for formats / devices / workflows the project explicitly refuses or defers. Refused-by-Spine is not refused-by-the-ecosystem."*

`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2` enumerates eight format families Spine will not write first-party (MOBI 6, LIT, LRF, iBA, RB, TCR, SNB, PML, eReader, PalmDOC variants, OEB/OPF 1.x). Six of those are flagged "Yes — community plugin candidate" in the §4.2 table. Without a sanctioned plugin path, the ecosystem either forks Spine or carries patches forever. With a sanctioned plugin path, niche-format users get served and the project's first-party scope stays clean.

The same logic extends to four other extension surfaces beyond format converters: metadata reconcilers (sources beyond `id.loc.gov` / LCSH), reader engines (foliate-js is the default; other-renderer plugins are conceivable), interface actions (Inspector tabs, Convert-to dropdown additions, Send-to-device targets), and settings panels.

CLAUDE.md locks the constraint:

> *"Don't bypass `spine-bf` and write directly to the triples table. Every graph mutation goes through `spine-bf`'s validated API so SHACL shapes stay enforced and provenance (`bf:AdminMetadata`) stays consistent."*

A plugin system that violated that invariant would defeat the ADR 014 + ADR 015 work. The plugin trait surface MUST funnel graph mutation through `spine-bf` exactly like first-party code does.

Calibre is the precedent. Calibre's plugin taxonomy (`file-type`, `metadata-source`, `metadata-download`, `catalog`, `viewer`, `editor`, `store`, `library-closed`, `preferences`, `interface-action`) has fed the e-book ecosystem for fifteen years; users migrating from calibre will recognize the shape if Spine's slot taxonomy maps cleanly onto it.

## Decision

### 1. Slot taxonomy (locked at six surfaces)

ADR 023 defines six plugin extension surfaces, each backed by a distinct Rust trait. The taxonomy maps onto calibre's existing types so plugin authors and migrating users see the lineage:

| Spine slot | Trait | Calibre plugin-type analog | Sprint introduction |
|---|---|---|---|
| **Format** (read + write) | `InputFormat`, `OutputFormat`, `PolishOp` | `file-type` | Sprint 14-15 (read), Sprint 16 (write); plugin loading lights up Sprint 17 |
| **Metadata reconciler** | `MetadataReconciler` | `metadata-source` + `metadata-download` | Sprint 8 LCSH adapter pattern; plugin loading Sprint 17+ |
| **Metadata importer** | `MetadataImporter` | (no calibre analog — Spine-specific) | Sprint 17+ |
| **Reader / viewer** | `ReaderEngine` | `viewer` | Sprint 18+ (foliate-js is the only first-party default for now) |
| **Interface action** | `InterfaceAction` | `interface-action`, `editor`, `store` | Sprint 17+ |
| **Settings panel** | `SettingsPanel` | `preferences` | Sprint 9 Settings drawer + Sprint 17+ plugin-section |

`MetadataImporter` is Spine-specific and has no calibre precedent (closes review item C1, 2026-04-25). Spine is BIBFRAME-native; library-cataloging plugins that import bibliographic-metadata-as-a-file (MARC21, ONIX 3.0, MODS, KBART) are first-class extension surfaces, not foreign-bag retrofits onto `InputFormat` (book-shaped, `read → OebBook`) or `MetadataReconciler` (term → URI shape). The canonical case is a MARC21-source plugin that ingests a `.mrc` file from a library system export, parses it into one or more BIBFRAME `Work`/`Instance`/`Item` graphs, and asserts them via the `spine-bf` write API. ONIX 3.0, MODS, and KBART follow the same pattern.

Slots NOT in the taxonomy (intentional omissions):

- **`catalog`** (calibre's emit-catalog-as-EPUB feature): folded into `OutputFormat` — a plugin that wants to emit a catalog implements `OutputFormat` against a synthetic input.
- **`library-closed`** (calibre's library-close hook): not a plugin slot; library lifecycle is core. If a plugin needs to react to library close, it observes via the existing job-status channel.
- **`store`** (calibre's e-book-store search): rolled into `InterfaceAction` because it's a UI affordance that calls out to a third-party API. There's no separate `store` slot.

### 2. Plugin trait surface (Rust)

The trait shape draws on the initial architecture sketch. Each trait is `Send + Sync` for tokio compatibility; each lives in a small `spine-plugin-api` crate that plugins depend on at the version they target.

```rust
// core/spine-plugin-api/src/lib.rs (forthcoming)

pub trait InputFormat: Send + Sync {
    fn name(&self) -> &str;                        // "EPUB", "AZW3", "FB2"
    fn extensions(&self) -> &[&str];               // ["epub", "kepub"]
    fn read(&self, path: &Path, profile: SourceProfile) -> Result<OebBook, ReadError>;
}

pub trait OutputFormat: Send + Sync {
    fn name(&self) -> &str;
    fn extensions(&self) -> &[&str];
    fn write(&self, oeb: &OebBook, w: &mut dyn Write, opts: &WriteOpts) -> Result<(), WriteError>;
}

pub trait PolishOp: Send + Sync {                  // Same-format edits per BYTE_IDENTICAL §3 Class 3
    fn name(&self) -> &str;
    fn applies_to(&self, mime: &str) -> bool;
    fn run(&self, container: &mut Container, opts: &PolishOpts) -> Result<(), PolishError>;
}

pub trait MetadataReconciler: Send + Sync {
    fn name(&self) -> &str;                        // "id.loc.gov", "openlibrary", "wikidata"
    fn supports(&self) -> &[ReconcileTarget];      // Work | Instance | Subject | Agent
    fn reconcile_work(&self, candidate: &WorkCandidate) -> Result<ReconcileOutcome, ReconcileError>;
    fn reconcile_subject(&self, term: &str) -> Result<ReconcileOutcome, ReconcileError>;
}

pub trait MetadataImporter: Send + Sync {
    fn name(&self) -> &str;                        // "MARC21", "ONIX 3.0", "MODS", "KBART"
    fn extensions(&self) -> &[&str];               // ["mrc", "marc"] / ["xml"] / ["txt"]
    fn import(&self, path: &Path) -> Result<Vec<BibliographicGraph>, ImportError>;
    fn produces(&self) -> &[ImportTarget];         // Work | Instance | Item | Subject | Agent
}

pub trait ReaderEngine: Send + Sync {
    fn name(&self) -> &str;
    fn supports_mime(&self, mime: &str) -> bool;
    fn render_url(&self, book_id: &str) -> String;  // Returns URL the WebView opens
}

pub trait InterfaceAction: Send + Sync {
    fn name(&self) -> &str;                        // "Send to BOOX", "Open in Calibre"
    fn slot(&self) -> ActionSlot;                  // InspectorTab | ContextMenuItem | ToolbarButton | ConvertTarget
    fn execute(&self, ctx: &ActionContext) -> Result<(), ActionError>;
}

pub trait SettingsPanel: Send + Sync {
    fn name(&self) -> &str;
    fn html(&self) -> &str;                        // Static HTML rendered into the Settings drawer
    fn handle_change(&self, key: &str, value: serde_json::Value) -> Result<(), SettingsError>;
}
```

`OebBook`, `Container`, `SourceProfile` are the IR types the initial design sketch lands. ADR 017 (forthcoming, Sprint 14) locks them. Plugin authors target the IR; first-party code targets the same IR. Symmetry is the contract.

### 3. spine-bf invariants are non-negotiable

(Per CLAUDE.md and the internal design review.)

Plugins MUST NOT bypass `spine-bf`. Three concrete rules:

1. **Every graph mutation through `spine-bf`'s public write API.** A plugin that decides "this book has subject X" calls `spine_bf::add_subject` exactly like the Inspector "+ add subject" affordance does. Direct writes to `spine.db`'s `triples` table are SHACL-uncovered and provenance-uncovered; both invariants would silently degrade.

2. **`spine:addedBy = <plugin_uri>` provenance is required.** Every triple a plugin asserts carries an additional `spine:addedBy` triple naming the plugin's URI (`urn:spine:plugin:<plugin-id>`, where `<plugin-id>` is the plugin's manifest-declared identifier). The `spine-bf` write API gains a `Plugin(plugin_id)` provenance variant alongside `User` and `Inferred`; calls without this variant default to `User` and are rejected if invoked from plugin code.

   **Enforcement mechanism (resolves review item W1, 2026-04-25):** Rule 2 is enforced primarily at compile time, not at runtime. Plugins do NOT depend on `spine-bf` directly; they depend on a thin re-export crate `spine-bf-plugin` that exposes only `add_subject`, `add_instance`, `add_item`, `set_primary_instance`, `remove_subject`, plus the `BibliographicGraph` type for `MetadataImporter` outputs. Each re-exported function takes a `PluginContext` (carrying the plugin id) as its first argument, which the underlying `spine-bf` calls translate into the `Plugin(plugin_id)` provenance variant automatically. There is no path in `spine-bf-plugin` that forwards to a `User` or `Inferred` variant, so a plugin literally cannot construct a non-`Plugin`-provenance call without depending on a different crate it has no reason to reach for. The runtime tracing-span tag remains as belt-and-suspenders: `spine-bf` emits a span attribute `provenance="plugin:{id}"` on every plugin call, so audit logs surface unexpected paths without relying on the compile-time gate alone.

3. **Per-plugin segregated graphs for provisional data.** A plugin that wants to assert speculative or vendor-specific triples (e.g. an OpenLibrary reconciler producing candidate matches at confidence ≥ 0.50 but ≤ 0.79, or a MARC21-source plugin producing candidate `Work`/`Instance` graphs from an external library export) writes them to `urn:spine:graph:plugin:<plugin-id>:<book-uuid>`, NOT to the asserted graph.

   **Promotion path (resolves review item W2, 2026-04-25):** Promotion of plugin-graph triples to the asserted graph does NOT use the ADR 015 §4 reconcile drawer (that drawer is reconcile-specific — three actions per book, all about LoC URI matching). Plugin-graph promotion uses a separate **"Plugin Assertions" Inspector tab**, mirroring the inferred-graph "AI Suggestions" tab pattern that ADR 016 (forthcoming, Sprint 11) lands. The Plugin Assertions tab lists per-plugin triples grouped by predicate, with per-row Accept / Reject affordances, and a "Promote all from this plugin" bulk action gated on a soft-confidence threshold. This mirrors the asserted-vs-inferred split (TECH_DEBT §1.2 / ADR 016) — plugin data is effectively a third partition, with the same gatekeeping shape but a distinct UI surface.

4. **`spine:uriSource` for plugin-minted URIs (resolves review item W3, 2026-04-25).** When a plugin mints a URI (e.g. a MARC21-source plugin minting a `urn:spine:work:<uuid>` for a record LoC has not yet catalogued), the URI carries `spine:uriSource = "plugin:<plugin-id>"` per ADR 015 amendment-1's open-vocabulary clause (`docs/ADR_015_reconcile_first_ux.md §3`, the forward-compat append-only enumeration). This is a new value beyond the two locked at ADR 015 amendment-1 (`locref` + `spinemint`); it is the canonical first append-only addition the open-vocabulary clause was written to admit. The `<plugin-id>` suffix preserves provenance — the user can tell which plugin minted which URI without consulting `spine:addedBy`. The Sprint 17+ plugin loader implementer threads the plugin id through the `spine-bf-plugin` re-export so `add_instance` on the plugin path emits `spine:uriSource = "plugin:com.acme.marc21"` (or whatever the manifest id is) rather than `spinemint`.

### 4. Discovery, loading, lifecycle

Plugins are dynamic libraries (`.so` / `.dll` / `.dylib`) discovered at app start from a per-user directory:

- Linux: `~/.local/share/spine/plugins/`
- macOS: `~/Library/Application Support/Spine/plugins/`
- Windows: `%APPDATA%\Spine\plugins\`

Each plugin ships as a single shared library plus a `manifest.toml` adjacent to it:

```toml
[plugin]
id = "com.acme.kfx-unlocker"
name = "ACME KFX Unlocker"
version = "0.3.1"
spine_api_version = "1.0"      # Must match spine-plugin-api crate semver-major
authors = ["Jane Acme <jane@acme.example>"]
license = "GPL-3.0-or-later"
homepage = "https://acme.example/spine-kfx"

[slots]
input_formats = ["KFX"]         # Names registered by this plugin
output_formats = []
metadata_importers = []         # Slot for MARC21/ONIX/MODS/KBART plugins
metadata_reconcilers = []
reader_engines = []
interface_actions = []
settings_panels = []
```

**Manifest collision (resolves review item N4, 2026-04-25).** Two plugins on disk with identical `id` values are an error. The registry rejects the second plugin found (filesystem walk order is implementation-defined; do not rely on it for which plugin "wins"); the rejected plugin appears in the Settings drawer's Plugins section as `❌ id collision with com.acme.foo` with a link to the conflicting file path. The user resolves by removing one. There is no automatic-resolution rule — id collision is a packaging mistake by one of the plugin authors and demands user attention.

**Plugin disable vs uninstall (resolves review item N2, 2026-04-25).** The Settings drawer offers TWO destructive affordances per plugin, with distinct semantics:

- **Disable**: registry stops loading the plugin on next start. Plugin's segregated graph at `urn:spine:graph:plugin:<plugin-id>:<book-uuid>` and any asserted-graph triples it has already promoted both REMAIN intact. Re-enable rehydrates. Use when the user wants to suspend a plugin temporarily without losing its data.
- **Uninstall**: removes the `.so`/`.dll`/`.dylib` + `manifest.toml` from disk AND offers (with a separate confirmation) to delete the plugin's segregated graphs across all books in the library. Asserted-graph triples that the plugin already promoted via the Plugin Assertions tab REMAIN — those are user-asserted now, not plugin-asserted, and removing them would destroy user work. The Settings dialog wording is explicit: *"Removing this plugin will delete its candidate suggestions but keep the X subjects/instances you accepted from it."*

Forgetting the segregated-graph distinction would either orphan triples on disable (user-confusing) or silently nuke user-asserted data on uninstall (catastrophic). The split is load-bearing.

`spine-srv` exposes a merged registry endpoint:

```
GET /api/v1/plugins
→ [
    { id: "com.acme.kfx-unlocker", name: "ACME KFX Unlocker", version: "0.3.1",
      enabled: true, slots: ["input_formats:KFX"], spine_api_version: "1.0" },
    ...
  ]

GET /api/v1/conversion/formats
→ [
    { name: "EPUB", extensions: ["epub"], source: "builtin",         caps: ["read","write","polish"] },
    { name: "AZW3", extensions: ["azw3"], source: "builtin",         caps: ["read","write"] },
    { name: "KFX",  extensions: ["kfx"],  source: "plugin:com.acme.kfx-unlocker", caps: ["read"] },
  ]
```

The Settings drawer (Sprint 9 + Sprint 17) gains a "Plugins" section showing the list, a per-plugin enable/disable toggle, an "Install plugin" file-picker that copies the `.so`/`.dll`/`.dylib` + `manifest.toml` into the plugins directory and reloads, and a small status indicator per plugin (loaded / mismatched API version / load error).

Plugin disable is not destructive — the file stays on disk; the registry stops loading it next start. Re-enable rehydrates.

A plugin reload-without-restart path is **out of scope for v1**. Restart the app to pick up new plugins. (`dlclose` semantics on dynamic libraries holding tokio handles are subtle; deferring is the safe call.)

### 5. ABI + determinism

**ABI strategy: versioned-semver Rust crate** (option (a) from the initial design). Plugins depend on `spine-plugin-api = "1.x"` and are recompiled per Spine major-version bump. `spine_api_version` in `manifest.toml` must match the host's published semver-major; mismatch → plugin is loaded as inert and the Settings panel surfaces "API mismatch — rebuild against Spine x.y".

The alternative — a C-FFI plugin boundary with the entire OEB IR projected through C structs — is rejected for v1. The IR has too many polymorphic types (`enum SourceProfile`, the `Toc`/`PageList` variants, `WriteOpts`'s nested enums) to project cleanly through C; the friction would push plugin authors to small unmaintained shims. Recompile-per-version is acceptable for the niche-format plugin author; Spine's release cadence is months, not days.

**Determinism contract** (Sprint 14 + ADR 017's BYTE_IDENTICAL determinism doctrine extends to plugins):

- Plugin `read` MUST be deterministic-mode-honoring: no wall-clock UUIDs, no `std::collections::HashMap` iteration in observable output, no random state.
- Plugin `write` MUST be deterministic-mode-honoring on the same axes.
- Sorted iteration over any internal collections that escape into `OebBook` or output bytes.
- The `spine-plugin-api` crate exposes a `deterministic_uuid_v5(namespace, content)` helper so plugins minting URIs can do so deterministically.

ADR 017 names a compile-time `#[must_use_deterministic_mode]` doc-mandate on each trait method; v1 enforces by review and test fixtures, not by compiler magic.

### 6. Legal posture

(Per v3 §4.2 row "DRM stripping" + v3 §4.2 KFX refused-even-as-plugin.)

**DRM stripping**: Spine refuses to bundle, refuses to sign, refuses to advertise any DRM-stripping plugin. Spine does NOT actively block load — the plugin trait surface is open and a user choosing to install `acme-dedrm.so` is loading it under their own legal responsibility (DMCA §1201 / CDPA / EU InfoSoc 6(4)). This is calibre's exact posture; ADR 023 inherits it. The Settings drawer shows a one-time warning the first time a plugin is installed: *"Plugins run with full library access. Install only plugins you trust. Spine does not vet plugin code or legal posture."*

**KFX**: refused even as a plugin, per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2`. KFX has no public spec; reverse-engineering it carries direct legal exposure that bundling/non-bundling does not insulate against (the engineering act, not the distribution, is the gating concern). A plugin that registers `name = "KFX"` and an `InputFormat` trait will be **rejected at registry load** with a clear error pointing at the v3 §4.2 row. This is the only format-name blocklist; every other refused-first-party format from §4.2 is plugin-pathable.

**License boundary**: Spine is GPL-3.0. Plugins linking against `spine-plugin-api` link against a GPL-compatible Rust crate; the GPL viral surface applies. Source-distributed plugins are recommended GPL-3.0-or-later. Binary-only plugins (Apache / BSD / MIT / proprietary EULA) are tolerated; calibre's mixed-license plugin ecosystem proved this works. The plugin manifest's `license` field is required and surfaced in the Settings drawer.

**`serde_json::preserve_order` trap (resolves review item N1, 2026-04-25).** Plugin authors implementing any trait whose Result type contains `serde_json::Value` (currently `SettingsPanel::handle_change`, and any future trait that exchanges JSON payloads) MUST enable the `preserve_order` Cargo feature on their `serde_json` dependency:

```toml
[dependencies]
serde_json = { version = "1", features = ["preserve_order"] }
```

Without `preserve_order`, `serde_json::Value`'s map type is `BTreeMap` (alphabetical) on some configurations and `IndexMap` (insertion-order) on others, depending on whether some other crate in the dependency tree pulled the feature. This breaks the determinism contract: the same plugin compiled in two contexts produces different observable byte output. The `spine-plugin-api` crate documents this trap in its README and exposes a `serde_json::Value` re-export with the feature pre-enabled to make the right answer the easy answer.

### 7. Plugin author conventions

(Per the internal design review.)

`docs/PLUGIN_AUTHORING_GUIDE.md` (forthcoming, Sprint 17+) carries the full guide. ADR 023 locks the conventions:

- **Versioning**: semver. `spine_api_version` in manifest tracks the host Spine major-version supported.
- **Identifier**: reverse-DNS (`com.example.foo`); MUST be unique per plugins directory; collision → second plugin rejected at load.
- **Manifest**: `manifest.toml` adjacent to the library file. Required fields: `id`, `name`, `version`, `spine_api_version`, `license`. Optional: `authors`, `homepage`, `description`, per-slot capability declarations.
- **License recommendation**: GPL-3.0-or-later for source. Mixed-license tolerated; plugin author owns compatibility analysis.
- **Documentation**: README adjacent to manifest, surfaced in Settings drawer's per-plugin detail view.
- **Distribution**: out of scope for first-party — no plugin marketplace in v1. Plugin authors host on GitHub Releases / their own infrastructure / package managers.

## Out of scope for v1

- **Plugin marketplace** (curated discovery + signed updates). Defer past Sprint 19.
- **Plugin sandboxing** (capability-restricted execution). Plugins run with the same OS-level privileges as Spine itself; calibre precedent. A future ADR may revisit if the threat model shifts.
- **Hot-reload** (without app restart). Out of scope for v1.
- **Plugin-to-plugin communication** (one plugin calling another's API). The trait registry is read-only to plugins; cross-plugin orchestration goes through Spine's HTTP API like any other consumer.
- **Mobile (Android Compose) plugin loading**. The desktop dynamic-library scheme doesn't transfer; mobile plugins are deferred past the roadmap's 12-week window. Slot taxonomy is desktop-first; mobile parity is a future ADR.

## Consequences

### Closes

- The plugin-doctrine design threading through Sprint 8 (v3 §4.2 amendment) is captured as a durable artifact.
- BYTE_IDENTICAL §4.2's "Yes — community plugin candidate" rows have a sanctioned implementation path.

### Imposes

- Sprint 14-15 implementers MUST keep `OebBook` + sub-types `pub`. No internal-only types in the IR. The initial struct sketch already honors this.
- `spine-bf` write API gains a `Plugin(plugin_id: String)` provenance variant alongside `User` / `Inferred` — small enum extension, lands in Sprint 14 or 16 alongside the plugin loader.
- A new crate `core/spine-plugin-api/` is added. Initial scope is just the trait definitions + helper types; ~200-300L Rust.
- A new crate `core/spine-plugin-host/` (or module within `spine-srv`) implements the loader, manifest parser, and registry. ~400-500L.
- Sprint 17 and beyond Cannot Break Plugin ABI silently — semver discipline on `spine-plugin-api`.
- Settings drawer (Sprint 9, in flight) gets a "Plugins" section stub now (gracefully empty until the loader ships).

### Foregoes

- **Plugin signing / verification at load**. v1 trusts the user to install only what they trust. A future ADR may add manifest signing if the threat model demands it.
- **Per-plugin resource limits** (memory cap, file-handle cap). Plugins run with full process privilege.
- **Synchronous vs async plugin call discipline**. v1 traits are synchronous; long-running plugin work (network reconcile, format conversion) blocks the dispatching task. The reconcile-first 8s timeout from ADR 005 / 015 applies; format conversion is bounded by the user's Convert-dialog progress display. A future ADR may introduce async plugin traits if measurement shows it matters.

## Sprint placement

ADR 023 itself locks no implementation work in the project roadmap's 12-week window. The architectural shape it preserves enables:

- **Sprint 14**: ensures `OebBook` / `Container` / `SourceProfile` are `pub`-correct and plugin-targetable. The initial struct sketch already does this; ADR 023 endorses.
- **Sprint 16 (AZW3 writer)**: AZW3 first-party; structures the writer so a future MOBI-6 plugin can target the same `OutputFormat` trait by changing one impl. v3 §4.2 row "MOBI 6 — community plugin candidate" lives in this header space.
- **Sprint 17+**: actual `core/spine-plugin-api` + `spine-plugin-host` ship. The plugin trait surface goes live; first canonical plugin is a stub showing the Settings drawer surface working end-to-end (a no-op plugin that registers an `InterfaceAction` named "Plugin smoke test"). Real third-party plugins land post-roadmap window.

ADR 023 makes Sprint 14-16 do the right thing structurally without spending a single implementation sprint on plugin infrastructure first. That is the leverage.

## Open questions

1. **`spine_api_version` semantic**: tied to Spine version (e.g. `1.0` = Spine 1.x lifecycle) or to `spine-plugin-api` crate semver independently? Recommendation: latter — `spine-plugin-api` versions on its own cadence so a Spine point release that doesn't touch the trait surface doesn't break plugins. Confirm.

2. **Manifest format**: `manifest.toml` (this ADR's pick) vs `manifest.json`? Calibre uses a Python-zip-with-`__init__.py`-introspection pattern, which doesn't transfer. TOML matches Cargo.toml convention; plugin authors are Rust developers. Confirm.

3. **Slot taxonomy completeness**: ~~ADR 023 locks five slots.~~ Resolved 2026-04-25 — review item C1 surfaced a sixth (`MetadataImporter`) that the original five did not cover. ADR 023 now locks **six** slots; this open question is closed. Future slot additions follow the same review pattern: a real plugin author surfaces a need, the slot ADR-extends, the trait surface grows.

4. **KFX rejection mechanism**: rejection at `name == "KFX"` registry load (this ADR's pick) is brittle — a bad-faith plugin author could register `name = "KFX-rebranded"`. Recommendation: name-match is a first-line defense plus CLAUDE.md/ADR text as the social/legal layer; do not over-engineer. Spine's stance against KFX is documented; bad-faith plugin distribution is its author's problem.

5. **Mobile parity**: ADR 011 locks Android Compose. Plugin loading on Android requires a different mechanism (no `dlopen` on Play Store builds; sideload is fine but has different lifecycle). Defer past Sprint 19? Or scope a follow-on ADR for Android plugin loading at Sprint 17+? Recommendation: defer.

## References

- `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2` — the format kill-list with plugin-path column.
- `docs/ADR_005_LoC_Cache_Strategy.md` — reconcile latency budget, applies to `MetadataReconciler` plugins.
- `docs/ADR_011_mobile_compose.md` — Android target; mobile plugin loading deferred.
- `docs/ADR_014_spine_bf_write_api_shacl.md` — the write API plugin code MUST funnel through.
- `docs/ADR_015_reconcile_first_ux.md` — the drawer mechanism plugin-promotion uses.
- `docs/ADR_017_*` (forthcoming, Sprint 14) — OEB IR shape; plugin trait surface targets it.
- Internal design notes — calibre's plugin-type taxonomy precedent and the `InputFormat` / `OutputFormat` trait sketch.
- `core/spine-bf/src/write.rs` — write API the `Plugin(plugin_id)` provenance extends.
- Calibre plugin documentation: `https://manual.calibre-ebook.com/creating_plugins.html` — for migrating plugin authors' familiarity.

## Revision history

- 2026-04-25 — Initial draft (Sprint 9 doc-lane prep). Status: Draft. Inputs: plugin-doctrine design, BYTE_IDENTICAL v3 §4.2.
- 2026-04-25 — Amendment 1 (post-code-review `8be6715`). Closes 1 critical + 3 warnings + 4 notes. §1 slot taxonomy expands from five to six slots: adds `MetadataImporter` (MARC21 / ONIX 3.0 / MODS / KBART), Spine-specific with no calibre analog, first-class for the BIBFRAME-native 30-year horizon (closes review item C1). §2 trait surface gains the `MetadataImporter` trait shape verbatim from the review. §3 Rule 2 enforcement promotes from runtime tracing-span tag to **compile-time isolation via `spine-bf-plugin` re-export crate** with `PluginContext` first-arg threading the plugin id through to the underlying `Plugin(plugin_id)` provenance variant; tracing-span remains belt-and-suspenders (closes review item W1). §3 Rule 3 promotion path clarifies: NOT the ADR 015 §4 reconcile drawer (reconcile-specific) but a separate **"Plugin Assertions" Inspector tab** mirroring ADR 016's inferred-graph "AI Suggestions" pattern (closes review item W2). §3 gains a new Rule 4: plugin-minted URIs carry `spine:uriSource = "plugin:<plugin-id>"` per ADR 015 amendment-1's open-vocabulary clause; this is the canonical first append-only addition the clause was written to admit (closes review item W3). §4 Discovery gains explicit manifest-id collision UX (registry rejection visible in Settings drawer, no auto-resolution rule — closes review item N4) and the load-bearing **disable-vs-uninstall split** with explicit segregated-graph vs asserted-graph treatment (closes review item N2). §4 gains `serde_json::preserve_order` Cargo feature requirement for plugin authors, with `spine-plugin-api` providing a pre-enabled re-export to make the right answer the easy answer (closes review item N1). §"Open questions" Q3 (slot taxonomy completeness) resolved by C1 — answer changed from "five locked, defer if surfaced" to "six locked." Review item N3 (KFX name-match social-control acknowledged-brittle) accepted as-is; no change to §6 legal posture text. +41 / -4 lines (273 → 310 net).
