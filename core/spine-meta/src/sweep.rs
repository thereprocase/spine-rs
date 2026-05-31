//! ADR 015 §6 background re-reconcile sweep + §7 pre-ADR backfill.
//!
//! Two independent operations both keyed on `spine:reconcileTimeoutAt`:
//!
//! - [`background_reconcile_sweep`] walks every book graph carrying a
//!   non-zero `reconcileTimeoutAt` triple and re-runs reconcile. On a
//!   match, the previous (`spinemint`) URI gets an `owl:sameAs` edge to
//!   the freshly-resolved LoC URI and the new URI inherits
//!   `spine:uriSource = "locref"`. Per ADR 015 §step-5 + ADR 006 §2 +
//!   the keep-both merge policy, **both URIs are kept** — the original
//!   `spinemint` provenance is the truthful record of what Spine did at
//!   write time, the LoC URI is added on the other side of the
//!   equivalence edge.
//!
//! - [`backfill_pre_adr_reconcile_markers`] walks every book graph and,
//!   for any Work that carries no `spine:uriSource` triple at all
//!   (pre-ADR-015 minted), emits `(work_uri, spine:reconcileTimeoutAt,
//!   "0")` so the §6 sweep picks it up on its next tick. Non-blocking
//!   per ADR 015 §7 — runs on library open.

use crate::LocClient;
use spine_db::SpineStore;
use std::time::Duration;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";
const OWL_SAMEAS: &str = "http://www.w3.org/2002/07/owl#sameAs";
const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";
const RDFS_LABEL: &str = "http://www.w3.org/2000/01/rdf-schema#label";
const BF_MAIN_TITLE: &str = "http://id.loc.gov/ontologies/bibframe/mainTitle";

/// Per-call result of [`background_reconcile_sweep`]. Counts are
/// load-bearing for telemetry / drawer summarization but the test scaffold
/// only pins the function's `Result<_>` shape — internal field names are
/// allowed to evolve.
#[derive(Debug, Default, Clone)]
pub struct SweepReport {
    pub graphs_examined: usize,
    pub promoted: usize,
    pub still_pending: usize,
    pub errors: usize,
}

/// Per-call result of [`backfill_pre_adr_reconcile_markers`].
#[derive(Debug, Default, Clone)]
pub struct BackfillReport {
    pub graphs_examined: usize,
    pub flagged: usize,
}

/// ADR 015 §6 sweep entry point.
///
/// Walks all graphs with a non-zero `spine:reconcileTimeoutAt` triple,
/// extracts the candidate Work title from each, and re-reconciles
/// against `id.loc.gov` via the supplied [`LocClient`]. On a hit the
/// graph is rewritten to:
///
/// - keep the original `spinemint` URI and all its outgoing triples;
/// - add `(old_uri, owl:sameAs, new_uri)`;
/// - add `(new_uri, spine:uriSource, "locref")`;
/// - rewrite `(_, reconcileTimeoutAt, *)` to `"0"` so the row drops out
///   of the §4 drawer queue.
///
/// On a miss or timeout the graph is left untouched (the marker stays;
/// the sweep retries on the next tick — ADR 015 §6 specifies a 24h
/// floor between retries which is enforced by the marker's monotonically
/// advancing timestamp, not by this function).
pub async fn background_reconcile_sweep(
    store: &SpineStore,
    client: &LocClient,
) -> Result<SweepReport, String> {
    let pending = store
        .list_reconcile_pending_graphs()
        .map_err(|e| format!("list_reconcile_pending_graphs: {e}"))?;

    let mut report = SweepReport::default();

    for graph_uri in pending {
        report.graphs_examined += 1;
        let triples = match store.get_triples(&graph_uri) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, graph = %graph_uri, "sweep: get_triples failed");
                report.errors += 1;
                continue;
            }
        };

        let Some((work_uri, work_title)) = pick_pending_work(&triples) else {
            report.still_pending += 1;
            continue;
        };

        let Some(loc_uri) = run_title_search(client, &work_title).await else {
            report.still_pending += 1;
            continue;
        };

        let mut next: Vec<(String, String, String)> = triples
            .into_iter()
            .map(|(s, p, o)| {
                if p == SPINE_RECONCILE_TIMEOUT_AT {
                    (s, p, "0".to_string())
                } else {
                    (s, p, o)
                }
            })
            .collect();
        next.push((work_uri.clone(), OWL_SAMEAS.to_string(), loc_uri.clone()));
        next.push((loc_uri.clone(), SPINE_URI_SOURCE.to_string(), "locref".to_string()));

        if let Err(e) = store.replace_graph(&graph_uri, &next) {
            tracing::warn!(error = %e, graph = %graph_uri, "sweep: replace_graph failed");
            report.errors += 1;
            continue;
        }
        report.promoted += 1;
    }

    Ok(report)
}

/// ADR 015 §7 pre-ADR backfill entry point.
///
/// Walks every graph in the store. For graphs containing a
/// `(?, rdf:type, bf:Work)` triple whose Work URI has no
/// `spine:uriSource` triple anywhere in the graph, append
/// `(work_uri, reconcileTimeoutAt, "0")` so the §6 sweep picks the
/// graph up on its next tick. Non-blocking per §7 — best-effort,
/// runs on library open. Graphs that already carry a `uriSource`
/// triple are left untouched so we don't re-flag locref-resolved
/// books on every library open.
pub fn backfill_pre_adr_reconcile_markers(
    store: &SpineStore,
) -> Result<BackfillReport, String> {
    let graphs = store
        .list_all_graphs()
        .map_err(|e| format!("list_all_graphs: {e}"))?;

    let mut report = BackfillReport::default();

    for graph_uri in graphs {
        report.graphs_examined += 1;
        let triples = match store.get_triples(&graph_uri) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, graph = %graph_uri, "backfill: get_triples failed");
                continue;
            }
        };

        let has_uri_source = triples
            .iter()
            .any(|(_, p, _)| p == SPINE_URI_SOURCE);
        if has_uri_source {
            continue;
        }

        let Some(work_uri) = triples
            .iter()
            .find(|(_, p, o)| p == RDF_TYPE && o == BF_WORK)
            .map(|(s, _, _)| s.clone())
        else {
            continue;
        };

        let mut next = triples;
        next.push((
            work_uri,
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            "0".to_string(),
        ));
        if let Err(e) = store.replace_graph(&graph_uri, &next) {
            tracing::warn!(error = %e, graph = %graph_uri, "backfill: replace_graph failed");
            continue;
        }
        report.flagged += 1;
    }

    Ok(report)
}

/// Find a Work in `triples` that's flagged for reconcile and extract its
/// title. Returns `None` if no such Work exists or no title can be
/// derived (no point reconciling without a search term).
fn pick_pending_work(triples: &[(String, String, String)]) -> Option<(String, String)> {
    let work_uri = triples
        .iter()
        .find(|(_, p, o)| p == RDF_TYPE && o == BF_WORK)
        .map(|(s, _, _)| s.clone())?;

    let pending = triples.iter().any(|(s, p, o)| {
        s == &work_uri
            && p == SPINE_RECONCILE_TIMEOUT_AT
            && o.parse::<i64>().unwrap_or(0) > 0
    });
    if !pending {
        return None;
    }

    let title = triples
        .iter()
        .find(|(s, p, _)| s == &work_uri && (p == BF_MAIN_TITLE || p == RDFS_LABEL))
        .map(|(_, _, o)| o.clone())
        .unwrap_or_default();

    Some((work_uri, title))
}

/// Run a title-only SRU search through `client` with the standard 8s
/// timeout (ADR 005). Returns `Some(loc_work_uri)` on a hit (LCCN
/// extracted from MARCXML 001), `None` on miss / timeout / error —
/// the caller doesn't need finer disambiguation since the sweep's
/// behavior on no-match is identical (leave the graph alone).
async fn run_title_search(client: &LocClient, title: &str) -> Option<String> {
    if title.is_empty() {
        return None;
    }
    let timeout = Duration::from_secs(8);
    let result = tokio::time::timeout(timeout, client.search_by_title_author(title, "")).await;
    match result {
        Ok(Ok(text)) => parse_first_marcxml_001(&text)
            .map(|lccn| format!("http://id.loc.gov/resources/works/{lccn}")),
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "sweep title search failed");
            None
        }
        Err(_) => {
            tracing::debug!("sweep title search timed out");
            None
        }
    }
}

/// Mirror of `crate::reconcile::parse_first_marcxml_001` — kept private
/// here because the reconcile module's copy is also private and copying
/// the eight lines beats threading visibility.
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
    use uuid::Uuid;

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_promotes_pending_work_when_loc_hits() {
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
            (old_uri.clone(), RDF_TYPE.to_string(), BF_WORK.to_string()),
            (
                old_uri.clone(),
                RDFS_LABEL.to_string(),
                "Sweep Title".to_string(),
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
        let report = background_reconcile_sweep(&store, &client).await.unwrap();
        assert_eq!(report.promoted, 1);

        let after = store.get_triples(&graph_uri).unwrap();
        assert!(
            after.iter().any(|(s, p, _)| s == &old_uri && p == OWL_SAMEAS),
            "owl:sameAs from old → new must be present"
        );
        assert!(
            after.iter().any(|(_, p, o)| p == SPINE_URI_SOURCE && o == "locref"),
            "locref provenance must land on the new URI"
        );
        assert!(
            !after
                .iter()
                .any(|(_, p, o)| p == SPINE_RECONCILE_TIMEOUT_AT
                    && o.parse::<i64>().unwrap_or(0) > 0),
            "timeout marker must clear after promotion"
        );
    }

    #[test]
    fn backfill_flags_pre_adr_books_only() {
        let store = SpineStore::open(":memory:").unwrap();
        let pre_adr_uuid = Uuid::new_v4();
        let pre_adr_graph = format!("urn:spine:graph:book:{pre_adr_uuid}");
        let pre_adr_work = format!("urn:spine:work:{}", Uuid::new_v4());
        store
            .replace_graph(
                &pre_adr_graph,
                &[(pre_adr_work.clone(), RDF_TYPE.to_string(), BF_WORK.to_string())],
            )
            .unwrap();

        let resolved_uuid = Uuid::new_v4();
        let resolved_graph = format!("urn:spine:graph:book:{resolved_uuid}");
        let resolved_work = format!("urn:locref:works/{}", Uuid::new_v4());
        store
            .replace_graph(
                &resolved_graph,
                &[
                    (
                        resolved_work.clone(),
                        RDF_TYPE.to_string(),
                        BF_WORK.to_string(),
                    ),
                    (
                        resolved_work,
                        SPINE_URI_SOURCE.to_string(),
                        "locref".to_string(),
                    ),
                ],
            )
            .unwrap();

        let report = backfill_pre_adr_reconcile_markers(&store).unwrap();
        assert_eq!(report.flagged, 1);

        let pre_adr_after = store.get_triples(&pre_adr_graph).unwrap();
        assert!(
            pre_adr_after
                .iter()
                .any(|(_, p, o)| p == SPINE_RECONCILE_TIMEOUT_AT && o == "0"),
            "pre-ADR book must gain reconcileTimeoutAt = \"0\""
        );

        let resolved_after = store.get_triples(&resolved_graph).unwrap();
        assert!(
            !resolved_after
                .iter()
                .any(|(_, p, _)| p == SPINE_RECONCILE_TIMEOUT_AT),
            "resolved book must NOT be re-flagged"
        );
    }
}
