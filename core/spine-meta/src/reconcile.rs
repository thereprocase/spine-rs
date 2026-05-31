//! Synchronous reconcile entry point — wraps `LocClient`'s async SRU calls
//! with a tokio `timeout` per ADR 005's 8-second worker latency budget,
//! and provides `BlockingLocReconciler` impls for spine-bf's
//! `SubjectReconciler` + `InstanceReconciler` traits.
//!
//! spine-bf's reconciler traits are synchronous (the write API is sync —
//! `&SpineStore` interior-mutability + rusqlite). The HTTP handler in
//! spine-srv is async and runs on a tokio runtime. Bridge: handler calls
//! `tokio::task::spawn_blocking { ... }` to invoke the sync spine-bf
//! function; that function calls `BlockingLocReconciler::reconcile`,
//! which uses `Handle::current().block_on` to drive the async LoC SRU
//! call. The blocking thread pool absorbs the wait without starving
//! the main runtime's executors.
//!
//! Timeout policy (per ADR 014 §2 + ADR 005): the synchronous reconcile
//! blocks the HTTP write for up to `SYNC_RECONCILE_TIMEOUT` (8s by
//! default — one ISBN query + one fallback title query each at the
//! rate-limited cap). On timeout the wrapper returns `Ok(None)` so the
//! spine-bf caller treats it as a miss and mints `urn:spine:*` with
//! `spine:reconcileTimeoutAt` for background re-reconcile.

use crate::LocClient;
use spine_bf::write::{
    InstanceCandidate, InstanceReconciler, InstanceReconcilerExt, ReconcileOutcome,
    ReconcileResolution, SpineWriteError, SubjectReconciler, UriSource, WorkCandidate,
    WorkReconciler,
};
use std::time::Duration;
use tokio::runtime::Handle;

/// Maximum time the synchronous reconcile can block per ADR 005 latency
/// budget. Picked to fit one ISBN search (~2-4s p99 against id.loc.gov
/// SRU) plus one fallback title+author search.
pub const SYNC_RECONCILE_TIMEOUT: Duration = Duration::from_secs(8);

/// Reconciler that synchronously calls `LocClient`'s async SRU methods
/// via `Handle::current().block_on(timeout(...))`. Constructed once per
/// HTTP request (wrapping the request-scoped `LocClient` and the
/// per-request timeout), then handed to spine-bf functions.
///
/// Caller must be on a tokio runtime — typically inside
/// `tokio::task::spawn_blocking` from an async HTTP handler.
pub struct BlockingLocReconciler<'a> {
    pub client: &'a LocClient,
    pub timeout: Duration,
}

impl<'a> BlockingLocReconciler<'a> {
    /// Construct with the standard 8-second timeout.
    pub fn new(client: &'a LocClient) -> Self {
        Self {
            client,
            timeout: SYNC_RECONCILE_TIMEOUT,
        }
    }

    /// Construct with a caller-specified timeout (e.g. tests with shorter
    /// budgets, or a future "patient" mode for bulk reconcile sweeps).
    pub fn with_timeout(client: &'a LocClient, timeout: Duration) -> Self {
        Self { client, timeout }
    }
}

impl<'a> SubjectReconciler for BlockingLocReconciler<'a> {
    /// Reconcile a subject term against id.loc.gov LCSH `suggest2`.
    ///
    /// Per ADR 014 §2 + Sprint 8 Step 1 contract:
    /// - Match → `Some(ReconcileOutcome { uri, source: Locref, … })`
    ///   using the first hit's authoritative `aLabel` URI. suggest2 is
    ///   left-anchored alpha-sorted; the first hit is the best match,
    ///   there is no scoring math (suggest2 returns pre-ranked results).
    /// - Empty hits, HTTP 404, or timeout → `Ok(None)`. Caller mints
    ///   `urn:spine:subject:lcsh:<uuid>` flagged with
    ///   `spine:reconcileTimeoutAt` for background re-reconcile.
    /// - Network / parse errors → `Err(ReconcileFailed)`. Distinct from
    ///   timeout, which is treated as a soft miss.
    ///
    /// Confidence is `None` because suggest2 is authoritative-prefix
    /// rather than fuzzy — there is no numeric degree to surface.
    fn reconcile(&self, term: &str) -> Result<Option<ReconcileOutcome>, SpineWriteError> {
        let trimmed = term.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let handle = Handle::try_current().map_err(|_| {
            SpineWriteError::ReconcileFailed(
                "BlockingLocReconciler must be called from within a tokio runtime \
                 (typically via tokio::task::spawn_blocking from an async handler)"
                    .to_string(),
            )
        })?;

        let term_owned = trimmed.to_string();
        let client = self.client.clone();
        let timeout = self.timeout;
        let result = handle.block_on(async move {
            tokio::time::timeout(timeout, client.search_lcsh_subject(&term_owned)).await
        });
        match result {
            Ok(Ok(matches)) => match matches.into_iter().next() {
                Some(top) => {
                    let authority = top.uri.clone();
                    Ok(Some(ReconcileOutcome {
                        uri: top.uri,
                        source: UriSource::Locref,
                        // suggest2 is left-anchored alpha-sorted; no
                        // numeric ranking.
                        confidence: None,
                        authority_uri: Some(authority),
                    }))
                }
                None => Ok(None),
            },
            Ok(Err(e)) => Err(SpineWriteError::ReconcileFailed(format!(
                "LCSH suggest2 failed: {e}"
            ))),
            Err(_) => {
                tracing::debug!(
                    "LoC reconcile timeout after {:?} on LCSH search",
                    self.timeout
                );
                Ok(None)
            }
        }
    }
}

impl<'a> InstanceReconciler for BlockingLocReconciler<'a> {
    /// Reconcile an instance candidate by ISBN, then by title+author.
    ///
    /// Per ADR 014 §2: ISBN match → use LoC URI + `Locref`. ISBN miss
    /// (or no ISBN provided) → title+author search. Title match with
    /// confidence ≥ ADR 009 threshold → LoC URI + `Locref`. Otherwise
    /// → `Ok(None)` (caller mints `urn:spine:instance:*`).
    fn reconcile(
        &self,
        candidate: &InstanceCandidate,
    ) -> Result<Option<ReconcileOutcome>, SpineWriteError> {
        let handle = Handle::try_current().map_err(|_| {
            SpineWriteError::ReconcileFailed(
                "BlockingLocReconciler must be called from within a tokio runtime \
                 (typically via tokio::task::spawn_blocking from an async handler)"
                    .to_string(),
            )
        })?;

        // Try ISBN first (fastest, exact match).
        if let Some(isbn) = candidate.isbn.as_deref().filter(|s| !s.is_empty()) {
            let isbn_owned = isbn.to_string();
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(timeout, client.search_by_isbn(&isbn_owned)).await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        let authority = format!("http://id.loc.gov/resources/instances/{lccn}");
                        return Ok(Some(ReconcileOutcome {
                            uri: authority.clone(),
                            source: UriSource::Locref,
                            // Exact-ISBN match: confidence elided (caller
                            // distinguishes None from Some(<1.0)).
                            confidence: None,
                            authority_uri: Some(authority),
                        }));
                    }
                    // Empty record set — fall through to title search.
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC ISBN search failed: {e}"
                    )));
                }
                Err(_) => {
                    // Timeout on ISBN — return miss; caller mints local
                    // with reconcileTimeoutAt.
                    tracing::debug!(
                        "LoC reconcile timeout after {:?} on ISBN search",
                        self.timeout
                    );
                    return Ok(None);
                }
            }
        }

        // ISBN missing or no match — try title+author. Only attempt if we
        // have a title (author is optional but helps narrow the result
        // set; we substitute a wildcard if absent).
        if let Some(title) = candidate.title.as_deref().filter(|s| !s.is_empty()) {
            let title_owned = title.to_string();
            // ADR 014 doesn't specify how to derive author for the
            // candidate-level search — calibre stores authors on the
            // Work, not the Instance. For B1 we pass an empty string
            // and let LocClient's CQL escape handle it; the caller's
            // confidence threshold gating then decides whether the
            // match is acceptable. Future polish: thread the work's
            // author through the candidate.
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(
                    timeout,
                    client.search_by_title_author(&title_owned, ""),
                )
                .await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        let authority = format!("http://id.loc.gov/resources/instances/{lccn}");
                        return Ok(Some(ReconcileOutcome {
                            uri: authority.clone(),
                            source: UriSource::Locref,
                            // Title-fuzzy: stamp 0.5 placeholder until
                            // the candidate-confidence scoring per ADR
                            // 009 is wired. Caller sees a confidence
                            // value but should not rely on its
                            // numerical accuracy until ADR 009 lands.
                            confidence: Some(0.5),
                            authority_uri: Some(authority),
                        }));
                    }
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC title+author search failed: {e}"
                    )));
                }
                Err(_) => {
                    tracing::debug!(
                        "LoC reconcile timeout after {:?} on title+author search",
                        self.timeout
                    );
                    return Ok(None);
                }
            }
        }

        Ok(None)
    }
}

impl<'a> WorkReconciler for BlockingLocReconciler<'a> {
    /// ADR 015 §1 + §2 reconcile-first hook for Work URIs at import.
    ///
    /// Reuses the existing ISBN-then-title SRU client methods; constructs a
    /// `http://id.loc.gov/resources/works/{lccn}` Work URI from the matched
    /// MARCXML 001 LCCN. The Work-vs-Instance LCCN distinction (the 240
    /// vs 001 fields) is glossed at this sprint — both URI namespaces are
    /// keyed off the instance LCCN. A future ADR pinning Work-level SRU
    /// search will refine this; today's behaviour is conformant with ADR
    /// 015 §1 (the reconcile call is made; the outcome is honest).
    fn reconcile_work(
        &self,
        candidate: &WorkCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError> {
        let handle = Handle::try_current().map_err(|_| {
            SpineWriteError::ReconcileFailed(
                "BlockingLocReconciler must be called from within a tokio runtime"
                    .to_string(),
            )
        })?;

        if let Some(isbn) = candidate.isbn.as_deref().filter(|s| !s.is_empty()) {
            let isbn_owned = isbn.to_string();
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(timeout, client.search_by_isbn(&isbn_owned)).await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        return Ok(ReconcileResolution::Matched {
                            uri: format!("http://id.loc.gov/resources/works/{lccn}"),
                            confidence: None,
                        });
                    }
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC ISBN search failed: {e}"
                    )));
                }
                Err(_) => return Ok(ReconcileResolution::TimedOut),
            }
        }

        if !candidate.title.is_empty() {
            let title_owned = candidate.title.clone();
            let author_owned = candidate
                .authors
                .first()
                .cloned()
                .unwrap_or_default();
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(
                    timeout,
                    client.search_by_title_author(&title_owned, &author_owned),
                )
                .await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        return Ok(ReconcileResolution::Matched {
                            uri: format!("http://id.loc.gov/resources/works/{lccn}"),
                            confidence: Some(0.5),
                        });
                    }
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC title+author search failed: {e}"
                    )));
                }
                Err(_) => return Ok(ReconcileResolution::TimedOut),
            }
        }

        Ok(ReconcileResolution::Unmatched)
    }
}

impl<'a> InstanceReconcilerExt for BlockingLocReconciler<'a> {
    /// ADR 015 §2 three-way Instance reconcile. Mirrors the existing
    /// `InstanceReconciler::reconcile` but distinguishes TimedOut from
    /// Unmatched so the ingest overlay can decide whether to flag the
    /// entity with `spine:reconcileTimeoutAt`.
    fn reconcile_with_resolution(
        &self,
        candidate: &InstanceCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError> {
        let handle = Handle::try_current().map_err(|_| {
            SpineWriteError::ReconcileFailed(
                "BlockingLocReconciler must be called from within a tokio runtime"
                    .to_string(),
            )
        })?;

        if let Some(isbn) = candidate.isbn.as_deref().filter(|s| !s.is_empty()) {
            let isbn_owned = isbn.to_string();
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(timeout, client.search_by_isbn(&isbn_owned)).await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        return Ok(ReconcileResolution::Matched {
                            uri: format!("http://id.loc.gov/resources/instances/{lccn}"),
                            confidence: None,
                        });
                    }
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC ISBN search failed: {e}"
                    )));
                }
                Err(_) => return Ok(ReconcileResolution::TimedOut),
            }
        }

        if let Some(title) = candidate.title.as_deref().filter(|s| !s.is_empty()) {
            let title_owned = title.to_string();
            let client = self.client.clone();
            let timeout = self.timeout;
            let result = handle.block_on(async move {
                tokio::time::timeout(
                    timeout,
                    client.search_by_title_author(&title_owned, ""),
                )
                .await
            });
            match result {
                Ok(Ok(text)) => {
                    if let Some(lccn) = parse_first_marcxml_001(&text) {
                        return Ok(ReconcileResolution::Matched {
                            uri: format!("http://id.loc.gov/resources/instances/{lccn}"),
                            confidence: Some(0.5),
                        });
                    }
                }
                Ok(Err(e)) => {
                    return Err(SpineWriteError::ReconcileFailed(format!(
                        "LoC title+author search failed: {e}"
                    )));
                }
                Err(_) => return Ok(ReconcileResolution::TimedOut),
            }
        }

        Ok(ReconcileResolution::Unmatched)
    }
}

/// Extract the first `<controlfield tag="001">VALUE</controlfield>` from
/// a MARCXML SRU response. Returns the LCCN value with whitespace trimmed,
/// or `None` if the response carries no records (LoC SRU returns an
/// empty `<zs:numberOfRecords>0</zs:numberOfRecords>` envelope on misses).
///
/// This is a deliberately string-based extraction rather than a full
/// quick_xml parse: the 001 field is the first thing after the SRU
/// envelope on a non-empty result, MARCXML responses are well-formed
/// (LoC produces them), and a regex/find-based extractor is faster than
/// a streaming parser for the single field we need. If we need to read
/// more MARCXML fields in a future commit (245 title, 100 author, 020
/// ISBN), promote to a proper quick_xml SAX walk.
fn parse_first_marcxml_001(marcxml: &str) -> Option<String> {
    let needle = r#"<controlfield tag="001">"#;
    let start = marcxml.find(needle)?;
    let after_tag = &marcxml[start + needle.len()..];
    let end = after_tag.find("</controlfield>")?;
    let lccn = after_tag[..end].trim();
    if lccn.is_empty() {
        None
    } else {
        Some(lccn.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_first_marcxml_001_extracts_lccn() {
        let xml = r#"<?xml version="1.0"?>
<zs:searchRetrieveResponse>
  <zs:records>
    <zs:record>
      <zs:recordData>
        <record xmlns="http://www.loc.gov/MARC21/slim">
          <controlfield tag="001">  2019012345  </controlfield>
          <controlfield tag="003">DLC</controlfield>
          <datafield tag="245" ind1="1" ind2="0">
            <subfield code="a">The Test Book</subfield>
          </datafield>
        </record>
      </zs:recordData>
    </zs:record>
  </zs:records>
</zs:searchRetrieveResponse>"#;
        let lccn = parse_first_marcxml_001(xml).expect("LCCN extracted");
        assert_eq!(lccn, "2019012345", "whitespace must be trimmed");
    }

    #[test]
    fn parse_first_marcxml_001_returns_none_on_empty_result() {
        let xml = r#"<?xml version="1.0"?>
<zs:searchRetrieveResponse>
  <zs:numberOfRecords>0</zs:numberOfRecords>
</zs:searchRetrieveResponse>"#;
        assert!(parse_first_marcxml_001(xml).is_none());
    }

    #[test]
    fn parse_first_marcxml_001_returns_none_on_empty_001_value() {
        // Malformed but legal: LCCN is present but empty/whitespace.
        let xml = r#"<controlfield tag="001">   </controlfield>"#;
        assert!(parse_first_marcxml_001(xml).is_none());
    }

    #[test]
    fn parse_first_marcxml_001_returns_none_on_garbage_input() {
        assert!(parse_first_marcxml_001("not even xml").is_none());
        assert!(parse_first_marcxml_001("").is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_reconciler_subject_lcsh_match_uses_first_hit() {
        // Production path: HTTP handler -> spawn_blocking -> spine-bf
        // sync write -> BlockingLocReconciler -> Handle::block_on. The
        // spawn_blocking step is required for `Handle::block_on` to be
        // called off the executor thread; mirrored here.
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", "/")
            .match_query(mockito::Matcher::UrlEncoded("q".into(), "Dragons".into()))
            .with_status(200)
            .with_body(
                r#"{"q":"Dragons","count":1,"hits":[{"aLabel":"Dragons",
                  "uri":"http://id.loc.gov/authorities/subjects/sh85039287",
                  "suggestLabel":"Dragons","vLabel":"","sLabel":"","code":"",
                  "token":"sh85039287","rank":""}]}"#,
            )
            .create_async()
            .await;
        let lcsh_url = server.url();

        let outcome = tokio::task::spawn_blocking(move || {
            let client =
                LocClient::with_base_urls("http://127.0.0.1:1", &lcsh_url).unwrap();
            let reconciler = BlockingLocReconciler::new(&client);
            SubjectReconciler::reconcile(&reconciler, "Dragons")
        })
        .await
        .expect("blocking task joined")
        .expect("reconcile ok")
        .expect("first hit returned");

        assert_eq!(
            outcome.uri,
            "http://id.loc.gov/authorities/subjects/sh85039287"
        );
        assert_eq!(outcome.source, UriSource::Locref);
        assert!(
            outcome.confidence.is_none(),
            "suggest2 is left-anchored alpha-sorted, no scoring"
        );
        assert_eq!(
            outcome.authority_uri.as_deref(),
            Some("http://id.loc.gov/authorities/subjects/sh85039287")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_reconciler_subject_lcsh_no_hits_returns_none() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(200)
            .with_body(r#"{"q":"qwxxz","count":0,"hits":[]}"#)
            .create_async()
            .await;
        let lcsh_url = server.url();

        let result = tokio::task::spawn_blocking(move || {
            let client =
                LocClient::with_base_urls("http://127.0.0.1:1", &lcsh_url).unwrap();
            let reconciler = BlockingLocReconciler::new(&client);
            SubjectReconciler::reconcile(&reconciler, "qwxxz")
        })
        .await
        .expect("joined")
        .expect("ok");
        assert!(result.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_reconciler_subject_lcsh_404_treated_as_none() {
        // id.loc.gov occasionally returns 404 in cold-cache states; the
        // adapter normalises to Ok(None) so the spine-bf caller mints
        // locally instead of surfacing an error to the user.
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(404)
            .create_async()
            .await;
        let lcsh_url = server.url();

        let result = tokio::task::spawn_blocking(move || {
            let client =
                LocClient::with_base_urls("http://127.0.0.1:1", &lcsh_url).unwrap();
            let reconciler = BlockingLocReconciler::new(&client);
            SubjectReconciler::reconcile(&reconciler, "Anything")
        })
        .await
        .expect("joined")
        .expect("ok");
        assert!(result.is_none(), "404 must normalise to Ok(None)");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_reconciler_subject_empty_term_short_circuits_to_none() {
        // Whitespace-only term short-circuits before any network attempt,
        // so the unreachable lcsh_url is never contacted.
        let result = tokio::task::spawn_blocking(|| {
            let client = LocClient::with_base_urls(
                "http://127.0.0.1:1",
                "http://127.0.0.1:2",
            )
            .unwrap();
            let reconciler = BlockingLocReconciler::new(&client);
            SubjectReconciler::reconcile(&reconciler, "   ")
        })
        .await
        .expect("joined")
        .expect("ok");
        assert!(result.is_none());
    }

    #[test]
    fn blocking_reconciler_instance_outside_tokio_runtime_errors() {
        // Synthesize a no-runtime context. `Handle::try_current()`
        // returns Err here because no runtime is installed.
        let client = LocClient::with_base_url("http://localhost:0").unwrap();
        let reconciler = BlockingLocReconciler::new(&client);
        let candidate = InstanceCandidate {
            isbn: Some("9780000000001".to_string()),
            ..Default::default()
        };
        let result = InstanceReconciler::reconcile(&reconciler, &candidate);
        // Should error with the no-runtime hint, not panic.
        match result {
            Err(SpineWriteError::ReconcileFailed(msg)) => {
                assert!(
                    msg.contains("tokio runtime"),
                    "error must hint at the runtime requirement; got {msg}"
                );
            }
            other => panic!(
                "expected ReconcileFailed with runtime hint; got {other:?}"
            ),
        }
    }
}
