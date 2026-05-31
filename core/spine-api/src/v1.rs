use serde::{Deserialize, Serialize};
use typeshare::typeshare;
use std::collections::HashMap;

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiBook {
    pub id: String,
    pub title: String,
    pub sort_title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Vec<ApiContributor>,
    pub subjects: Vec<String>,
    pub instances: Vec<ApiInstance>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiContributor {
    pub id: Option<String>,
    pub name: String,
    pub role: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInstance {
    pub id: String,
    pub publisher: Option<String>,
    pub publication_date: Option<String>,
    pub identifiers: HashMap<String, String>,
    pub items: Vec<ApiItem>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiItem {
    pub id: String,
    pub file_path: String,
    pub format: Option<String>,
    pub file_size: Option<u64>,
}

/// Freshness summary of the spine-meta LoC reconciliation cache.
/// Consumed by the desktop Footer "loc cache" line to surface how
/// recently authority records were refreshed.
///
/// Until the LoC cache layer lands (no on-disk store today; spine-meta
/// is point-of-call SRU only), `present` is `false` and counters are
/// zero / null. The contract is upgrade-transparent: when the cache
/// arrives, the handler swaps to real data without changing wire shape.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocCacheStatus {
    /// `true` once a cache layer is wired up. While `false`, the other
    /// fields are zero / null and the Footer should render
    /// "not enabled" rather than "0 entries · never refreshed".
    pub present: bool,
    /// Number of cached authority records.
    pub entries: u64,
    /// Most recent successful refresh as ms since the UNIX epoch, or
    /// `null` if nothing has ever been cached.
    pub last_refreshed_at_ms: Option<i64>,
}

/// One LCSH `suggest2` candidate as projected to the autocomplete UI.
///
/// Each match carries the LoC subject authority URI (e.g.
/// `http://id.loc.gov/authorities/subjects/sh85039287`) and the
/// authoritative `aLabel` text (canonical preferred form). The
/// `suggestLabel` / `vLabel` / scope-note fields from id.loc.gov's
/// upstream response are deliberately not surfaced — the autocomplete
/// dropdown displays the canonical label so users converge on the
/// authoritative phrasing.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcshSuggestMatch {
    pub uri: String,
    pub label: String,
}

/// Response of `GET /api/v1/loc/lcsh/suggest?q=`. Up to 10 matches in
/// the order id.loc.gov returned them (`sortmethod=alpha`,
/// `searchtype=left-anchored` — the first hit is the best prefix
/// match; clients should NOT re-sort or score).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcshSuggestResponse {
    pub matches: Vec<LcshSuggestMatch>,
}

/// Status-bucket tally of `AppState.job_status` aggregated for the
/// desktop Footer ticker. Counts reflect the server's TTL'd snapshot
/// — completed and failed jobs drop out after JOB_TTL_SECS so the
/// ticker doesn't grow without bound.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsSummary {
    pub pending: u32,
    pub running: u32,
    pub completed: u32,
    pub failed: u32,
}

/// Snapshot of on-disk space and content counts for the currently open
/// library. Consumed by the desktop Footer storage block. Bytes are raw
/// so the frontend can humanize per-locale (`formatters.ts` pattern).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// Size of the BIBFRAME triple store sidecar (`spine.db`).
    pub spine_db_bytes: u64,
    /// Size of upstream calibre's `metadata.db`.
    pub metadata_db_bytes: u64,
    /// Sum of `cover.jpg` sizes across `<library>/<author>/<title>/`.
    /// Excludes EPUB blobs so the Footer surfaces "metadata storage"
    /// without conflating it with content.
    pub covers_bytes: u64,
    /// Cardinality of the `books` table.
    pub book_count: u32,
    /// Most recent `books.timestamp` (calibre import time) as ms since
    /// UNIX epoch, or `null` if the library is empty or the stored
    /// value cannot be parsed.
    pub last_import_at_ms: Option<i64>,
}

/// Request body for POST /api/v1/library/recent. Idempotent push of
/// a library path into the recent-libraries snapshot. Most-recent-
/// first after dedup; truncated to the most-recent 5. Also sets the
/// `current` library so the Tauri shell's open-library flow doesn't
/// have to make two requests for one logical action.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRecentLibraryRequest {
    pub path: String,
}

/// Response of GET /api/v1/library/list. Combined snapshot of the
/// recent-libraries list + currently-open library path, consumed by
/// the desktop TitleBar library-switcher dropdown. Frontend rewire
/// from the existing `desktopState.recentLibraries` Tauri-command
/// path is deferred to a future session.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryList {
    pub recent: Vec<String>,
    pub current: Option<String>,
}

/// Request body for POST /api/v1/book/:id/subject. ADR 014 §5.
///
/// `source` is a wire-string (rather than a typeshare-friendly enum)
/// because typeshare's enum support varies across target languages
/// and the value-set is small + stable. Backend rejects values
/// outside `{"lcsh", "local-tag"}` with 400. The "inferred" variant
/// from spine-bf's `SubjectSource` is *not* exposed here — inferred-
/// graph mutations are TECH_DEBT §1.2 and out of scope for this ADR.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSubjectRequest {
    pub term: String,
    /// "lcsh" → reconcile-first against id.loc.gov LCSH (URI is the
    /// LoC authority URI on match; minted locally with `partial: true`
    /// on miss/timeout).
    /// "local-tag" → never reconciles, mints
    /// `urn:spine:subject:tag:<uuid>`.
    pub source: String,
}

/// Response of POST /api/v1/book/:id/subject. ADR 014 §5.
///
/// The frontend stores `subject_uri` and uses it for subsequent
/// DELETE calls — there's no `?label=` fallback because every
/// subject has a URI per ADR 014 §2 (LCSH → LoC URI; local-tag →
/// minted URI).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSubjectResponse {
    pub subject_uri: String,
    /// `true` iff the synchronous LoC reconcile timed out (or LCSH
    /// matching was not yet wired) and the URI was minted locally
    /// with `spine:reconcileTimeoutAt` for background re-reconcile.
    /// Frontend should surface "added locally; reconciliation pending."
    pub partial: bool,
}

/// Request body for POST /api/v1/book/:id/instance. ADR 014 §1+§2.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInstanceRequest {
    pub format: String,
    pub publication_date: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub title: Option<String>,
    /// Defaults to `true` if absent. Set `false` to skip the
    /// synchronous LoC reconcile and immediately mint
    /// `urn:spine:instance:<uuid>` — caller has explicitly
    /// opted out (e.g. fan edition that LoC won't have).
    pub reconcile_against_loc: Option<bool>,
}

/// Response of POST /api/v1/book/:id/instance. ADR 014 §5. Same shape
/// as `WriteSubjectResponse` modulo the URI key.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteInstanceResponse {
    pub instance_uri: String,
    pub partial: bool,
}

/// Request body for POST /api/v1/library/backup. ALL fields optional;
/// an empty body (`{}`) accepts the server-default destination.
///
/// Server resolves the default to `<library-path>/backups/` when
/// available, falling back to `<temp>/spine-backups/` for headless or
/// in-memory test scenarios.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupRequest {
    /// Optional override for the backup destination directory. If
    /// supplied and not absolute it is resolved relative to the current
    /// working directory of the server process.
    pub dest_path: Option<String>,
}

/// Response of POST /api/v1/library/backup. Returned with 202 Accepted
/// — the actual `VACUUM INTO` runs asynchronously in `Job::Backup`;
/// poll `GET /api/v1/jobs/:id` (using the returned `jobId`) for status,
/// or read the most recent successful run via
/// `GET /api/v1/library/backup/last`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupStartResponse {
    pub job_id: String,
    /// Resolved destination directory — echoed back to the caller so
    /// the desktop Settings tile can render the absolute target even
    /// when the request body omitted `destPath`.
    pub dest_path: String,
}

/// Response of GET /api/v1/library/backup/last. The serialized JSON is
/// `null` when no backup has completed since process start, otherwise
/// an object with the four fields below. Frontend deserializes as
/// `LibraryBackupLastResponse | null`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupLastResponse {
    /// UNIX-ms timestamp of the most recent successful backup.
    pub at_ms: i64,
    /// Destination directory the user requested for that backup.
    pub dest_path: String,
    /// Sum of bytes written into `dest_path` during that backup —
    /// useful for the Settings tile + free-space hint.
    pub size_bytes: u64,
    /// UUID of the `Job::Backup` that produced this entry. Lets the
    /// frontend correlate with the jobs ticker history.
    pub job_id: String,
}
