//! Speculative integration tests for the Sprint 10.5 reconcile-first
//! ingest hook + background re-reconcile sweep + pre-ADR backfill.
//!
//! Pre-pins behavior before the implementation lands,
//! per the Sprint 10.5 design. (Wire-shape pinned before the handlers
//! land, as with the Settings drawer, backup endpoint, and Sprint 10
//! reconcile endpoints).
//!
//! EXPECTED RED until the following land:
//!   1. `to_triples` (or new `to_triples_with_reconcile` variant)
//!      reconcile-first hook — when AppState carries a live `LocClient`,
//!      `ingest_epub` produces a graph whose Instance subject carries
//!      `spine:uriSource = "locref"` on hit, `spine:uriSource = "spinemint"`
//!      + `spine:reconcileTimeoutAt > 0` on miss/timeout.
//!   2. `spine_meta::background_reconcile_sweep(store, loc_client) ->
//!      Result<SweepReport, _>` — walks rows with `reconcileTimeoutAt`,
//!      runs reconcile, on hit writes `<old> owl:sameAs <new>` (BOTH
//!      kept per ADR 015 §step-5 + ADR 006 §2 + the keep-both merge policy)
//!      and updates `spine:uriSource` → `"locref"`.
//!   3. Pre-ADR backfill function (step-3 — name TBD,
//!      best guess `spine_meta::backfill_pre_adr_reconcile_markers`):
//!      scans for books with NO `spine:uriSource` triple and emits
//!      `spine:reconcileTimeoutAt = 0` to flag for the sweep.
//!
//! Naming notes:
//! - `to_triples` reconcile-aware variant is the single area where
//!   the implementation might pick a different surface (e.g. take a
//!   `&BlockingLocReconciler` parameter, or expose via `ingest_epub`
//!   wiring only). This test exercises the OBSERVED EFFECT through the
//!   `ingest_epub` entry point, so internal renames don't break it.
//! - `background_reconcile_sweep` and `backfill_pre_adr_reconcile_markers`
//!   are loosely-pinned function names; if the implementation picks different
//!   names, update the test accordingly.
//! - `SweepReport` fields are not pinned — only the function returns
//!   `Ok(_)` and the store mutation is pinned.

use axum::{
    body::Body,
    http::{Method, Request},
};
use calibre_db::CalibreLibrary;
use spine_db::SpineStore;
use spine_meta::LocClient;
use spine_srv::{create_router, ingest::ingest_epub, jobs::LocalJobQueue, AppState};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";
const OWL_SAMEAS: &str = "http://www.w3.org/2002/07/owl#sameAs";

/// MARCXML SRU response that the BlockingLocReconciler treats as a hit
/// (one record with controlfield 001 = LCCN). Used to drive the
/// "LoC hit" branch on ISBN searches.
const HIT_MARCXML: &str = r#"<?xml version="1.0"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
  <zs:numberOfRecords>1</zs:numberOfRecords>
  <zs:records>
    <zs:record>
      <zs:recordData>
        <record xmlns="http://www.loc.gov/MARC21/slim">
          <controlfield tag="001">2019012345</controlfield>
        </record>
      </zs:recordData>
    </zs:record>
  </zs:records>
</zs:searchRetrieveResponse>"#;

/// MARCXML SRU response that the BlockingLocReconciler treats as a miss
/// (numberOfRecords=0, no records).
const MISS_MARCXML: &str = r#"<?xml version="1.0"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
  <zs:numberOfRecords>0</zs:numberOfRecords>
</zs:searchRetrieveResponse>"#;

/// Write a minimal EPUB carrying the supplied `<dc:identifier>`. When
/// `isbn` is set, identifier is `urn:isbn:<isbn>` so the InstanceReconciler
/// has a usable hit candidate.
fn write_minimal_epub(path: &Path, isbn: Option<&str>) {
    let identifier = match isbn {
        Some(i) => format!("urn:isbn:{i}"),
        None => "urn:test:no-isbn".to_string(),
    };
    let opf = format!(
        r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Reconcile Fixture</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:identifier id="bookid">{identifier}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
</package>"#,
        identifier = identifier
    );
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    zip.start_file("META-INF/container.xml", options).unwrap();
    zip.write_all(
        br#"<?xml version="1.0"?>
<container>
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .unwrap();
    zip.start_file("content.opf", options).unwrap();
    zip.write_all(opf.as_bytes()).unwrap();
    zip.finish().unwrap();
}

/// Build an in-memory AppState whose `LocClient` points at a caller-
/// supplied SRU base URL. `lcsh_url` and `sru_url` may both be the same
/// mockito server — the BlockingLocReconciler differentiates by path,
/// not host.
async fn state_with_mocked_loc(lcsh_url: &str, sru_url: &str) -> Arc<AppState> {
    let library = CalibreLibrary::open(":memory:").unwrap();
    let store = SpineStore::open(":memory:").unwrap();
    let cell = std::sync::OnceLock::new();
    cell.set(Some(LocClient::with_base_urls(sru_url, lcsh_url).unwrap()))
        .unwrap();
    Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client: Arc::new(cell),
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    })
}

/// Read the per-book graph for `book_id` out of the AppState's spine.db.
/// Mirror the per-book URI format used by `spine_srv::graph_uri_for`
/// (which is `pub(crate)` and not reachable here).
fn graph_uri_for(book_id: &Uuid) -> String {
    format!("urn:spine:graph:book:{book_id}")
}

async fn graph_triples_for(state: &AppState, book_id: Uuid) -> Vec<(String, String, String)> {
    let graph_uri = graph_uri_for(&book_id);
    let store = state.store.lock().await;
    store.get_triples(&graph_uri).unwrap()
}

/// Returns true if any triple has predicate == p and object == o.
fn has_triple(triples: &[(String, String, String)], p: &str, o: &str) -> bool {
    triples.iter().any(|(_, pp, oo)| pp == p && oo == o)
}

/// Returns the object of the first triple with the given predicate, if
/// any.
fn object_for_predicate<'a>(
    triples: &'a [(String, String, String)],
    p: &str,
) -> Option<&'a str> {
    triples.iter().find_map(|(_, pp, oo)| (pp == p).then_some(oo.as_str()))
}

// ---------------------------------------------------------------------------
// Reconcile-first ingest hook (3 cases): hit → locref, miss → spinemint +
// timeoutAt marker, timeout → spinemint + timeoutAt marker.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ingest_with_loc_hit_yields_locref_uri_source() {
    // Mockito serves a hit MARCXML for the SRU search. The reconcile-first
    // hook in `to_triples` must observe the hit and
    // tag the produced Instance subject with `spine:uriSource = "locref"`
    // — never `"spinemint"` — and never write a `reconcileTimeoutAt`
    // marker (no need, reconcile resolved synchronously).
    let mut server = mockito::Server::new_async().await;
    let _hit = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_body(HIT_MARCXML)
        .create_async()
        .await;
    let url = server.url();

    let temp = tempfile::tempdir().unwrap();
    let epub = temp.path().join("hit.epub");
    write_minimal_epub(&epub, Some("9780451524935"));

    let state = state_with_mocked_loc(&url, &url).await;
    let book_id = ingest_epub(&epub, &state).await.expect("ingest ok");
    let triples = graph_triples_for(&state, book_id).await;

    assert!(
        has_triple(&triples, SPINE_URI_SOURCE, "locref"),
        "LoC hit must yield spine:uriSource = \"locref\"; got triples: {triples:?}"
    );
    assert!(
        !has_triple(&triples, SPINE_URI_SOURCE, "spinemint"),
        "LoC hit must NOT carry spinemint provenance; got triples: {triples:?}"
    );
    assert!(
        object_for_predicate(&triples, SPINE_RECONCILE_TIMEOUT_AT).is_none(),
        "LoC hit must NOT write reconcileTimeoutAt marker; got triples: {triples:?}"
    );
}

#[tokio::test]
async fn ingest_with_loc_miss_yields_spinemint_with_reconcile_timeout_marker() {
    // Mockito serves an empty record set. The hook must mint locally with
    // `spinemint` provenance AND write a `reconcileTimeoutAt > 0` marker
    // so the background sweep picks it up.
    //
    // Loose pin: the design distinguishes "Unmatched" from "TimedOut"
    // (only TimedOut adds the timeoutAt marker per ADR 015 §step-4).
    // However the synchronous reconciler in spine-meta normalises both to
    // `Ok(None)`, so the spine-bf write path can't actually distinguish
    // them — it must conservatively flag both for the sweep. If the
    // implementation lands a finer distinction (e.g. only flag on actual
    // timeout), this test should pivot to assert the timeoutAt marker
    // only on the timeout case below.
    let mut server = mockito::Server::new_async().await;
    let _miss = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_body(MISS_MARCXML)
        .create_async()
        .await;
    let url = server.url();

    let temp = tempfile::tempdir().unwrap();
    let epub = temp.path().join("miss.epub");
    write_minimal_epub(&epub, Some("9780000000000"));

    let state = state_with_mocked_loc(&url, &url).await;
    let book_id = ingest_epub(&epub, &state).await.expect("ingest ok");
    let triples = graph_triples_for(&state, book_id).await;

    assert!(
        has_triple(&triples, SPINE_URI_SOURCE, "spinemint"),
        "LoC miss must yield spine:uriSource = \"spinemint\"; got triples: {triples:?}"
    );
    assert!(
        !has_triple(&triples, SPINE_URI_SOURCE, "locref"),
        "LoC miss must NOT carry locref provenance; got triples: {triples:?}"
    );
    let timeout_at = object_for_predicate(&triples, SPINE_RECONCILE_TIMEOUT_AT)
        .expect("LoC miss must write reconcileTimeoutAt marker for sweep eligibility");
    let parsed: i64 = timeout_at
        .parse()
        .expect("reconcileTimeoutAt must be an integer millisecond timestamp");
    assert!(
        parsed > 0,
        "reconcileTimeoutAt must be > 0 to mark sweep-eligibility; got {parsed}"
    );
}

#[tokio::test]
async fn ingest_with_loc_timeout_yields_spinemint_with_reconcile_timeout_marker() {
    // Mockito delays the response past the BlockingLocReconciler's
    // SYNC_RECONCILE_TIMEOUT (8s). The reconciler returns Ok(None) on
    // timeout (per spine-meta::reconcile.rs §line 116), and the hook
    // must mint locally + write the timeoutAt marker.
    //
    // To keep the test fast: bind the LocClient through a shorter
    // timeout. Loose pin: `LocClient` doesn't currently expose a
    // configurable per-call timeout — the 8s is a `BlockingLocReconciler`
    // constant. If the implementation wires the hook with `with_timeout`,
    // this test should call that path; for now it falls back to mockito's
    // 9-second delay.
    let mut server = mockito::Server::new_async().await;
    let _delay = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_body(MISS_MARCXML)
        .with_chunked_body(|w| {
            std::thread::sleep(std::time::Duration::from_secs(9));
            w.write_all(MISS_MARCXML.as_bytes())
        })
        .create_async()
        .await;
    let url = server.url();

    let temp = tempfile::tempdir().unwrap();
    let epub = temp.path().join("timeout.epub");
    write_minimal_epub(&epub, Some("9780111111111"));

    let state = state_with_mocked_loc(&url, &url).await;
    let book_id = ingest_epub(&epub, &state).await.expect("ingest ok");
    let triples = graph_triples_for(&state, book_id).await;

    assert!(
        has_triple(&triples, SPINE_URI_SOURCE, "spinemint"),
        "LoC timeout must yield spine:uriSource = \"spinemint\"; got triples: {triples:?}"
    );
    assert!(
        object_for_predicate(&triples, SPINE_RECONCILE_TIMEOUT_AT).is_some(),
        "LoC timeout must write reconcileTimeoutAt marker for sweep eligibility; \
         got triples: {triples:?}"
    );
}

// ---------------------------------------------------------------------------
// Background sweep — promotes spinemint + reconcileTimeoutAt rows when
// LoC subsequently returns a hit. Per ADR 015 §step-5 + ADR 006 §2 +
// keep-both merge policy: writes `<old> owl:sameAs <new>` and KEEPS
// BOTH URIs (no full-subject rewrite).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn background_sweep_promotes_timed_out_uri_via_owl_sameas() {
    // Seed a SpineStore with a Work URI flagged as needing-reconcile
    // (spinemint provenance + reconcileTimeoutAt > 0). Mock LoC to hit.
    // Run the sweep. Assert: store now contains
    //   <old> owl:sameAs <new>
    //   <old/new>.spine:uriSource = "locref"
    // and BOTH URIs remain present (no destructive rewrite).
    //
    // Loose pin: function name `background_reconcile_sweep` per the design.
    // If the implementation picks a different name (e.g.
    // `sweep_reconcile_timeouts`), update the test accordingly.
    let mut server = mockito::Server::new_async().await;
    let _hit = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_body(HIT_MARCXML)
        .create_async()
        .await;
    let url = server.url();

    let store = SpineStore::open(":memory:").unwrap();
    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let old_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let seed: Vec<(String, String, String)> = vec![
        (
            old_uri.clone(),
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#type".to_string(),
            "http://id.loc.gov/ontologies/bibframe/Work".to_string(),
        ),
        (
            old_uri.clone(),
            SPINE_URI_SOURCE.to_string(),
            "spinemint".to_string(),
        ),
        (
            old_uri.clone(),
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            "1714000000000".to_string(),
        ),
    ];
    store.replace_graph(&graph_uri, &seed).unwrap();

    let client = LocClient::with_base_urls(&url, &url).unwrap();
    let _report = spine_meta::background_reconcile_sweep(&store, &client)
        .await
        .expect("sweep ok");

    let after = store.get_triples(&graph_uri).unwrap();

    // Old URI must still exist (BOTH-keep policy per ADR 015 §step-5).
    assert!(
        after.iter().any(|(s, _, _)| s == &old_uri),
        "old URI must remain after promotion; got triples: {after:?}"
    );

    // owl:sameAs link must be present from old to a new (locref-style) URI.
    let new_uri = after
        .iter()
        .find_map(|(s, p, o)| (s == &old_uri && p == OWL_SAMEAS).then_some(o.clone()))
        .expect("owl:sameAs from old → new must be written");
    assert_ne!(new_uri, old_uri, "new URI must differ from old");

    // uriSource must update to locref (on either subject — per ADR 015 the
    // promoted edge carries the new provenance). Loose pin on which subject
    // owns the new uriSource triple.
    assert!(
        after.iter().any(|(_, p, o)| p == SPINE_URI_SOURCE && o == "locref"),
        "uriSource must be updated to \"locref\" after promote; got triples: {after:?}"
    );

    // The reconcileTimeoutAt marker should be cleared (or rewritten to 0
    // / absent) since the row is no longer sweep-eligible. Loose pin —
    // The implementation may keep history; the hard contract is "no longer
    // selectable as TimedOut".
    let still_pending = after
        .iter()
        .any(|(_, p, o)| p == SPINE_RECONCILE_TIMEOUT_AT && o.parse::<i64>().unwrap_or(0) > 0);
    assert!(
        !still_pending,
        "reconcileTimeoutAt > 0 must be cleared after successful promotion; \
         got triples: {after:?}"
    );
}

// ---------------------------------------------------------------------------
// Pre-ADR backfill — books written before ADR 015 landed have no
// `spine:uriSource` triple. On library open, the backfill flags them
// with `reconcileTimeoutAt = 0` so the sweep reconciles them next pass.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pre_adr_backfill_emits_reconcile_timeout_marker_for_books_missing_uri_source() {
    // Seed a SpineStore with a Work that lacks spine:uriSource entirely
    // (pre-ADR 015 minted). Run the backfill. Assert the Work now carries
    // spine:reconcileTimeoutAt = "0" so the sweep picks it up.
    //
    // Loose pin: function name `backfill_pre_adr_reconcile_markers` is a
    // best guess per the design ("scan for books with NO spine:uriSource
    // triple and emit reconcileTimeoutAt = 0"). If the implementation
    // picks a different name, update the test accordingly.
    let store = SpineStore::open(":memory:").unwrap();
    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let seed: Vec<(String, String, String)> = vec![(
        work_uri.clone(),
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type".to_string(),
        "http://id.loc.gov/ontologies/bibframe/Work".to_string(),
    )];
    store.replace_graph(&graph_uri, &seed).unwrap();

    let _report = spine_meta::backfill_pre_adr_reconcile_markers(&store)
        .expect("backfill ok");

    let after = store.get_triples(&graph_uri).unwrap();
    let timeout_at = object_for_predicate(&after, SPINE_RECONCILE_TIMEOUT_AT)
        .expect("backfill must emit reconcileTimeoutAt marker for books missing uriSource");
    assert_eq!(
        timeout_at, "0",
        "pre-ADR backfill marker must be exactly \"0\" per design step-3; got {timeout_at}"
    );
}

#[tokio::test]
async fn pre_adr_backfill_skips_books_that_already_have_uri_source() {
    // Seed a book that already has a `spine:uriSource` triple. The
    // backfill must NOT add a redundant `reconcileTimeoutAt` marker
    // (otherwise it would re-flag every locref-resolved book on every
    // library open).
    let store = SpineStore::open(":memory:").unwrap();
    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:locref:works/{}", Uuid::new_v4());
    let seed: Vec<(String, String, String)> = vec![
        (
            work_uri.clone(),
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#type".to_string(),
            "http://id.loc.gov/ontologies/bibframe/Work".to_string(),
        ),
        (
            work_uri.clone(),
            SPINE_URI_SOURCE.to_string(),
            "locref".to_string(),
        ),
    ];
    store.replace_graph(&graph_uri, &seed).unwrap();

    let _report = spine_meta::backfill_pre_adr_reconcile_markers(&store)
        .expect("backfill ok");

    let after = store.get_triples(&graph_uri).unwrap();
    assert!(
        object_for_predicate(&after, SPINE_RECONCILE_TIMEOUT_AT).is_none(),
        "backfill must NOT mark already-resolved books; got triples: {after:?}"
    );
}

// ---------------------------------------------------------------------------
// Sanity check that the test file compiles even before the speculative
// surface lands — this is a no-op test that exercises the existing
// router so a "test-list" smoke discovers all entries above.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn smoke_router_responds_to_health_check() {
    let library = CalibreLibrary::open(":memory:").unwrap();
    let store = SpineStore::open(":memory:").unwrap();
    let cell = std::sync::OnceLock::new();
    cell.set(Some(LocClient::with_base_urls("http://localhost:0", "http://localhost:0").unwrap()))
        .unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client: Arc::new(cell),
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });
    let app = create_router(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Health endpoint may not exist; this test only asserts the router
    // builds without panicking. Status not pinned.
    let _ = resp.status();
}
