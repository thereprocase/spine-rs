//! ADR 014 — spine-bf write API.
//!
//! Pluggable write surface for adding Subjects / Instances / Items to an
//! existing Work, plus the SHACL cardinality shapes that gate every write.
//! Reconciler traits are stub-able so the foundational types can land
//! without forcing a synchronous wire to spine-meta in the same commit;
//! the production wire (`SyncLocReconciler` against id.loc.gov) lands in
//! a follow-on commit per the ADR's §6 implementation plan.
//!
//! Every successful write attaches asserted-graph provenance triples
//! (`spine:uriSource`, `spine:addedBy`, `spine:addedAt`, …) per ADR 014 §4.
//! The `Inferred` source variant is rejected from this asserted-graph path;
//! inferred-graph mutations are TECH_DEBT §1.2 and out of scope here.

use crate::{
    BF_FORMAT, BF_INSTANCE, BF_INSTANCE_OF, BF_ISBN, BF_MAIN_TITLE, BF_PUBLICATION_DATE,
    BF_PUBLISHER, BF_SUBJECT, BF_TOPIC, BF_WORK, RDF_TYPE, RDFS_LABEL,
};

const BF_LANGUAGE: &str = "http://id.loc.gov/ontologies/bibframe/language";
const BF_AGENT: &str = "http://id.loc.gov/ontologies/bibframe/agent";
const BF_AGENT_CLASS: &str = "http://id.loc.gov/ontologies/bibframe/Agent";
const BF_CONTRIBUTION: &str = "http://id.loc.gov/ontologies/bibframe/contribution";
const BF_ROLE: &str = "http://id.loc.gov/ontologies/bibframe/role";
const REL_AUT: &str = "http://id.loc.gov/vocabulary/relators/aut";
use serde::{Deserialize, Serialize};
use spine_db::SpineStore;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// New URIs introduced by ADR 014.
// ---------------------------------------------------------------------------

/// `bf:hasInstance` predicate connecting a Work to one of its Instances.
pub(crate) const BF_HAS_INSTANCE: &str = "http://id.loc.gov/ontologies/bibframe/hasInstance";
/// `bf:Item` rdf:type for a file resource attached to an Instance.
pub(crate) const BF_ITEM: &str = "http://id.loc.gov/ontologies/bibframe/Item";
/// `bf:itemOf` predicate connecting an Item back to its parent Instance.
pub(crate) const BF_ITEM_OF: &str = "http://id.loc.gov/ontologies/bibframe/itemOf";
/// `bf:electronicLocator` predicate on an Item pointing at the file path.
pub(crate) const BF_ELECTRONIC_LOCATOR: &str =
    "http://id.loc.gov/ontologies/bibframe/electronicLocator";

/// Spine-defined predicate marking an Instance as the primary edition of
/// its Work. SHACL caps to one per Work; backfilled from single-Instance
/// Works on next library open per ADR 014 §"Migration / compatibility".
pub(crate) const SPINE_PRIMARY_INSTANCE: &str =
    "https://thereprocase.github.io/spine/ns/primaryInstance";

/// Provenance: where the URI came from. Open-vocab per ADR 015 §3; current
/// known set is {locref, spinemint}. Forward-compat: future ADRs may add
/// values like `external-wikidata` — consumers MUST tolerate unknown values.
pub(crate) const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
/// Provenance: agent that authored the mutation. Defaults to `urn:spine:user:local`
/// until the multi-user model lands.
pub(crate) const SPINE_ADDED_BY: &str = "https://thereprocase.github.io/spine/ns/addedBy";
/// Provenance: ISO-8601 timestamp of the mutation.
pub(crate) const SPINE_ADDED_AT: &str = "https://thereprocase.github.io/spine/ns/addedAt";
/// Provenance: optional session URI for audit-trail correlation.
pub(crate) const SPINE_ADDED_BY_SESSION: &str =
    "https://thereprocase.github.io/spine/ns/addedBySession";
/// Provenance: id.loc.gov authority URI this entity was reconciled against.
pub(crate) const SPINE_RECONCILED_AGAINST: &str =
    "https://thereprocase.github.io/spine/ns/reconciledAgainst";
/// Provenance: timestamp of successful reconcile.
pub(crate) const SPINE_RECONCILED_AT: &str = "https://thereprocase.github.io/spine/ns/reconciledAt";
/// Provenance: confidence score (0.0–1.0) when fuzzy match was used.
pub(crate) const SPINE_RECONCILE_CONFIDENCE: &str =
    "https://thereprocase.github.io/spine/ns/reconcileConfidence";
/// Provenance: agent that asserted this metadata via an explicit edit
/// (distinct from `spine:addedBy`, which records the agent that
/// originally inserted the entity at ingest). Recorded by every
/// `set_fields` invocation per Sprint 12 contract.
pub(crate) const SPINE_ASSERTED_BY: &str =
    "https://thereprocase.github.io/spine/ns/assertedBy";
/// Provenance: ISO-8601 timestamp of the last `set_fields` mutation.
pub(crate) const SPINE_ASSERTED_AT: &str =
    "https://thereprocase.github.io/spine/ns/assertedAt";
/// Spine-defined predicate for the per-book series name (calibre
/// `series.name`). BIBFRAME has no native single-valued series
/// predicate; modelling via `bf:partOf` would require an Instance
/// chain that Spine doesn't synthesise on user edits.
pub(crate) const SPINE_SERIES: &str = "https://thereprocase.github.io/spine/ns/series";
/// Spine-defined predicate for the float series index (calibre
/// `books.series_index`). Same rationale as `spine:series`.
pub(crate) const SPINE_SERIES_INDEX: &str =
    "https://thereprocase.github.io/spine/ns/seriesIndex";
/// Marker triple flagging an entity for background re-reconciliation after
/// a synchronous reconcile timed out. spine-meta's background queue
/// re-runs reconcile when this is present and reconcile_timeoutAt > N
/// seconds ago.
pub(crate) const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";

const DEFAULT_USER_URI: &str = "urn:spine:user:local";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Description of a new edition the user wants to add to an existing Work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceCandidate {
    /// `EPUB`, `MOBI`, `PDF` — bibframe term for the format. Not validated
    /// here; ADR 014 leaves format-vocabulary curation to a follow-on shape.
    pub format: String,
    pub publication_date: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    /// Override Work title if this edition's title differs (translation,
    /// abridgement). Otherwise the Work's existing title is used.
    pub title: Option<String>,
    /// If `false`, skips reconcile-first against id.loc.gov and immediately
    /// mints `urn:spine:instance:*`. Default `true` per ADR 014 §2.
    pub reconcile_against_loc: bool,
}

impl Default for InstanceCandidate {
    fn default() -> Self {
        Self {
            format: String::new(),
            publication_date: None,
            publisher: None,
            isbn: None,
            title: None,
            reconcile_against_loc: true,
        }
    }
}

/// Description of a file resource to attach to an Instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemDescriptor {
    /// Library-relative or absolute path. Calibre convention is
    /// `<library>/<author>/<title>/<file>.epub`.
    pub file_path: String,
    pub format: Option<String>,
    pub file_size: Option<u64>,
    pub sha256: Option<String>,
}

/// Source of a subject term — drives reconcile policy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SubjectSource {
    /// Library of Congress Subject Headings — reconcile-first against
    /// id.loc.gov LCSH. Match → URI is the LoC authority URI.
    /// Miss/timeout → mint `urn:spine:subject:lcsh:<uuid>` flagged for
    /// background re-reconcile.
    Lcsh,
    /// Free-form user tag — never reconciles, mints
    /// `urn:spine:subject:tag:<uuid>` immediately.
    LocalTag,
    /// LLM/heuristic-inferred — must use the inferred-graph write path
    /// (TECH_DEBT §1.2). Asserted-graph add_subject rejects this variant
    /// with `SpineWriteError::AssertedRejectInferred`.
    Inferred,
}

/// Where the URI on a freshly-added entity came from. ADR 015 §3 locks two
/// values today; the on-wire predicate is open-vocab to allow future
/// authority sources (`external-wikidata`, etc.) without a breaking change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum UriSource {
    /// Reference to an existing id.loc.gov authority URI.
    Locref,
    /// Locally-minted because LoC has no record (or reconcile timed out).
    /// Promotion to a LoC URI is later expressed as an `owl:sameAs` edge
    /// per ADR 006 — the original `spinemint` provenance is preserved.
    Spinemint,
}

impl UriSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            UriSource::Locref => "locref",
            UriSource::Spinemint => "spinemint",
        }
    }
}

/// Response of a successful add_* call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteOutcome {
    pub uri: String,
    /// True iff the synchronous reconcile timed out (or LCSH was attempted
    /// but no match found) and the URI was minted locally with
    /// `spine:reconcileTimeoutAt`. Frontend should surface "added locally;
    /// reconciliation pending."
    pub partial: bool,
    pub uri_source: UriSource,
}

/// All errors the write API can return.
#[derive(Debug)]
pub enum SpineWriteError {
    /// Underlying spine-db error, surfaced as the original `Display` text.
    Store(String),
    /// SHACL shape constraint violated. `path` is the predicate URI; `message`
    /// is a human-readable description of the constraint that failed.
    ShapeViolation { path: String, message: String },
    /// Caller passed `SubjectSource::Inferred` to the asserted-graph write
    /// path. Inferred triples must use the inferred-graph path
    /// (TECH_DEBT §1.2).
    AssertedRejectInferred,
    /// Work URI not found in store; can't add to it.
    WorkNotFound { work_uuid: Uuid },
    /// Instance URI not found in store (set_primary_instance preconditions).
    InstanceNotFound { instance_uri: String },
    /// Subject URI not present on the work (remove_subject preconditions).
    SubjectNotPresent {
        work_uuid: Uuid,
        subject_uri: String,
    },
    /// Reconcile failed for a non-timeout reason (network error, malformed
    /// LoC response, etc.). Distinct from a timeout (which is *not* an
    /// error — caller gets a `partial: true` outcome instead).
    ReconcileFailed(String),
    /// Caller-supplied input malformed (empty term, blank URI, …).
    InvalidInput(String),
}

impl std::fmt::Display for SpineWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(msg) => write!(f, "store error: {msg}"),
            Self::ShapeViolation { path, message } => {
                write!(f, "SHACL shape violation on {path}: {message}")
            }
            Self::AssertedRejectInferred => write!(
                f,
                "Inferred subjects must use the inferred-graph write path \
                 (TECH_DEBT §1.2); rejecting from asserted graph"
            ),
            Self::WorkNotFound { work_uuid } => write!(f, "work {work_uuid} not found"),
            Self::InstanceNotFound { instance_uri } => {
                write!(f, "instance {instance_uri} not found")
            }
            Self::SubjectNotPresent {
                work_uuid,
                subject_uri,
            } => write!(f, "subject {subject_uri} not present on work {work_uuid}"),
            Self::ReconcileFailed(msg) => write!(f, "reconcile failed: {msg}"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
        }
    }
}

impl std::error::Error for SpineWriteError {}

// ---------------------------------------------------------------------------
// Reconciler traits — pluggable so a stub-only commit can land before the
// production wire to spine-meta. The asynchronous LoC client is wrapped by
// a follow-on `SyncLocReconciler` impl that uses tokio's `block_in_place`
// or a `block_on` shim to satisfy the synchronous trait.
// ---------------------------------------------------------------------------

/// Result of a synchronous reconcile attempt against id.loc.gov.
#[derive(Debug, Clone)]
pub struct ReconcileOutcome {
    /// The URI to use for the entity (LoC authority URI when matched).
    pub uri: String,
    pub source: UriSource,
    /// 0.0–1.0 if a fuzzy match was used; `None` for exact ISBN matches.
    pub confidence: Option<f64>,
    /// The id.loc.gov authority URI matched against. Stored as the
    /// `spine:reconciledAgainst` provenance value.
    pub authority_uri: Option<String>,
}

/// Reconciles a subject term against id.loc.gov LCSH. Returns `Ok(None)`
/// for an unmatched term (caller mints `urn:spine:subject:lcsh:<uuid>`
/// flagged with `reconcileTimeoutAt`).
pub trait SubjectReconciler {
    fn reconcile(&self, term: &str) -> Result<Option<ReconcileOutcome>, SpineWriteError>;
}

/// Reconciles an instance candidate by ISBN, then title+author.
pub trait InstanceReconciler {
    fn reconcile(
        &self,
        candidate: &InstanceCandidate,
    ) -> Result<Option<ReconcileOutcome>, SpineWriteError>;
}

// ---------------------------------------------------------------------------
// Reconcile-first ingest hook (ADR 015 §1 + §2). The work-level reconciler
// and the three-way `ReconcileResolution` enum disambiguate Unmatched (LoC
// answered "no") from TimedOut (LoC didn't answer in time) so the overlay
// can decide whether to add `spine:reconcileTimeoutAt` per ADR 015 §2.
// ---------------------------------------------------------------------------

/// Description of a Work for the import-time reconcile call. Same
/// shape spine-srv has at `to_triples` time: title + authors are the
/// minimum identifying signal, ISBN is opportunistic.
#[derive(Debug, Clone, Default)]
pub struct WorkCandidate {
    pub title: String,
    pub authors: Vec<String>,
    pub isbn: Option<String>,
}

/// Three-way outcome distinguishing Unmatched (negative answer) from
/// TimedOut (no answer) per ADR 015 §2. The Sprint-10 `ReconcileOutcome`
/// struct collapses both into `Ok(None)`; `ReconcileResolution` is the
/// shape ADR 015 actually requires for ingest-time mint decisions.
#[derive(Debug, Clone)]
pub enum ReconcileResolution {
    Matched {
        uri: String,
        confidence: Option<f64>,
    },
    Unmatched,
    TimedOut,
}

/// Reconciles a Work candidate against id.loc.gov per ADR 015 §1.
pub trait WorkReconciler {
    fn reconcile_work(
        &self,
        candidate: &WorkCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError>;
}

/// Reconciles an Instance candidate with three-way outcome — the
/// existing `InstanceReconciler::reconcile` returns `Option`, which
/// can't carry the TimedOut signal ADR 015 §2 needs.
pub trait InstanceReconcilerExt {
    fn reconcile_with_resolution(
        &self,
        candidate: &InstanceCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError>;
}

/// No-op reconciler that always returns `Ok(None)`. Useful for unit
/// tests, for callers that opt out of LoC reconciliation, and as a
/// concrete placeholder before the production wire lands.
pub struct AlwaysUnmatched;

impl SubjectReconciler for AlwaysUnmatched {
    fn reconcile(&self, _term: &str) -> Result<Option<ReconcileOutcome>, SpineWriteError> {
        Ok(None)
    }
}

impl InstanceReconciler for AlwaysUnmatched {
    fn reconcile(
        &self,
        _candidate: &InstanceCandidate,
    ) -> Result<Option<ReconcileOutcome>, SpineWriteError> {
        Ok(None)
    }
}

impl WorkReconciler for AlwaysUnmatched {
    fn reconcile_work(
        &self,
        _candidate: &WorkCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError> {
        Ok(ReconcileResolution::Unmatched)
    }
}

impl InstanceReconcilerExt for AlwaysUnmatched {
    fn reconcile_with_resolution(
        &self,
        _candidate: &InstanceCandidate,
    ) -> Result<ReconcileResolution, SpineWriteError> {
        Ok(ReconcileResolution::Unmatched)
    }
}

// ---------------------------------------------------------------------------
// Provenance triples
// ---------------------------------------------------------------------------

/// Context describing who/when authored a write. Defaults to
/// `urn:spine:user:local` until multi-user lands.
#[derive(Debug, Clone)]
pub struct ProvenanceContext {
    pub user_uri: String,
    pub session_uri: Option<String>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

impl Default for ProvenanceContext {
    fn default() -> Self {
        Self {
            user_uri: DEFAULT_USER_URI.to_string(),
            session_uri: None,
            timestamp: chrono::Utc::now(),
        }
    }
}

/// Build the asserted-graph provenance triples for a newly-added entity.
/// Mandatory triples (per ADR 014 §4): uriSource, addedBy, addedAt.
/// Optional: addedBySession, reconcile-* when the URI came from a
/// successful LoC match.
fn provenance_triples(
    entity_uri: &str,
    uri_source: UriSource,
    ctx: &ProvenanceContext,
    reconcile: Option<&ReconcileOutcome>,
) -> Vec<(String, String, String)> {
    let mut triples = vec![
        (
            entity_uri.to_string(),
            SPINE_URI_SOURCE.to_string(),
            uri_source.as_str().to_string(),
        ),
        (
            entity_uri.to_string(),
            SPINE_ADDED_BY.to_string(),
            ctx.user_uri.clone(),
        ),
        (
            entity_uri.to_string(),
            SPINE_ADDED_AT.to_string(),
            ctx.timestamp.to_rfc3339(),
        ),
    ];
    if let Some(session) = &ctx.session_uri {
        triples.push((
            entity_uri.to_string(),
            SPINE_ADDED_BY_SESSION.to_string(),
            session.clone(),
        ));
    }
    if let Some(outcome) = reconcile {
        if let Some(authority) = &outcome.authority_uri {
            triples.push((
                entity_uri.to_string(),
                SPINE_RECONCILED_AGAINST.to_string(),
                authority.clone(),
            ));
            triples.push((
                entity_uri.to_string(),
                SPINE_RECONCILED_AT.to_string(),
                ctx.timestamp.to_rfc3339(),
            ));
            if let Some(conf) = outcome.confidence {
                triples.push((
                    entity_uri.to_string(),
                    SPINE_RECONCILE_CONFIDENCE.to_string(),
                    format!("{conf}"),
                ));
            }
        }
    }
    triples
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Calibre book-uuid → graph URI convention. Mirrors `crate::graph_uri_for`
/// in lib.rs (kept private there); duplicated here so write.rs doesn't
/// reach across modules for what's essentially a string format.
fn graph_uri_for(work_uuid: &Uuid) -> String {
    format!("urn:spine:graph:book:{}", work_uuid)
}

/// Resolve the Work URI inside a book's named graph by scanning for the
/// `(?, rdf:type, bf:Work)` triple. The graph is small (<100 triples for
/// a typical book) so a linear scan is cheap and avoids cross-crate
/// query helpers.
fn work_uri_for(store: &SpineStore, work_uuid: &Uuid) -> Result<String, SpineWriteError> {
    let graph_uri = graph_uri_for(work_uuid);
    let triples = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    triples
        .into_iter()
        .find(|(_, p, o)| p == RDF_TYPE && o == BF_WORK)
        .map(|(s, _, _)| s)
        .ok_or(SpineWriteError::WorkNotFound {
            work_uuid: *work_uuid,
        })
}

/// Atomically rewrite a graph by appending new triples. Reads the
/// existing triple set, appends, and writes back via `replace_graph`
/// (which is transactional on the spine-db side).
fn append_graph_triples(
    store: &SpineStore,
    graph_uri: &str,
    additions: &[(String, String, String)],
) -> Result<(), SpineWriteError> {
    let mut triples = store
        .get_triples(graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    triples.extend(additions.iter().cloned());
    store
        .replace_graph(graph_uri, &triples)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    Ok(())
}

/// Atomically rewrite a graph by removing every triple where the entity
/// URI appears as subject OR as object on a given outgoing-edge predicate.
/// Used by `remove_subject` to drop both the work→subject edge and the
/// subject's own type/label/provenance triples.
fn delete_entity_and_edge(
    store: &SpineStore,
    graph_uri: &str,
    entity_uri: &str,
    edge_subject: &str,
    edge_predicate: &str,
) -> Result<(), SpineWriteError> {
    let triples = store
        .get_triples(graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    let filtered: Vec<(String, String, String)> = triples
        .into_iter()
        .filter(|(s, p, o)| {
            // Drop the edge: <edge_subject> <edge_predicate> <entity_uri>
            if s == edge_subject && p == edge_predicate && o == entity_uri {
                return false;
            }
            // Drop entity's own outgoing triples.
            if s == entity_uri {
                return false;
            }
            true
        })
        .collect();
    store
        .replace_graph(graph_uri, &filtered)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public write API — Subjects (commit A1).
// ---------------------------------------------------------------------------

/// Add a subject term to an existing Work. ADR 014 §1.
///
/// Reconcile policy is dictated by `source`:
///
/// - `Lcsh`: synchronous reconcile against id.loc.gov LCSH via `reconciler`.
///   Match → subject_uri = LoC authority URI, uri_source = `Locref`.
///   Miss → mint `urn:spine:subject:lcsh:<uuid_v4>`,
///   uri_source = `Spinemint`, partial = true (flagged for background
///   re-reconcile).
/// - `LocalTag`: never reconciles. subject_uri = `urn:spine:subject:tag:<uuid_v4>`,
///   uri_source = `Spinemint`, partial = false.
/// - `Inferred`: rejected with `SpineWriteError::AssertedRejectInferred`
///   per ADR 014 §1 — inferred triples use the inferred-graph path.
pub fn add_subject<R: SubjectReconciler>(
    store: &SpineStore,
    reconciler: &R,
    work_uuid: &Uuid,
    subject_term: &str,
    source: SubjectSource,
    ctx: &ProvenanceContext,
) -> Result<WriteOutcome, SpineWriteError> {
    if source == SubjectSource::Inferred {
        return Err(SpineWriteError::AssertedRejectInferred);
    }
    if subject_term.trim().is_empty() {
        return Err(SpineWriteError::InvalidInput(
            "empty subject term".to_string(),
        ));
    }

    let work_uri = work_uri_for(store, work_uuid)?;
    let graph_uri = graph_uri_for(work_uuid);

    // Reconcile (LCSH only). LocalTag skips; Inferred rejected above.
    let (subject_uri, uri_source, partial, reconcile_outcome) = match source {
        SubjectSource::Lcsh => match reconciler.reconcile(subject_term)? {
            Some(outcome) => {
                let src = outcome.source;
                (outcome.uri.clone(), src, false, Some(outcome))
            }
            None => (
                format!("urn:spine:subject:lcsh:{}", Uuid::new_v4()),
                UriSource::Spinemint,
                true,
                None,
            ),
        },
        SubjectSource::LocalTag => (
            format!("urn:spine:subject:tag:{}", Uuid::new_v4()),
            UriSource::Spinemint,
            false,
            None,
        ),
        SubjectSource::Inferred => unreachable!("rejected above"),
    };

    // Build triples.
    let mut triples: Vec<(String, String, String)> = vec![
        (
            subject_uri.clone(),
            RDF_TYPE.to_string(),
            BF_TOPIC.to_string(),
        ),
        (
            subject_uri.clone(),
            RDFS_LABEL.to_string(),
            subject_term.to_string(),
        ),
        (
            work_uri.clone(),
            BF_SUBJECT.to_string(),
            subject_uri.clone(),
        ),
    ];

    if partial {
        triples.push((
            subject_uri.clone(),
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            ctx.timestamp.to_rfc3339(),
        ));
    }

    triples.extend(provenance_triples(
        &subject_uri,
        uri_source,
        ctx,
        reconcile_outcome.as_ref(),
    ));

    append_graph_triples(store, &graph_uri, &triples)?;

    Ok(WriteOutcome {
        uri: subject_uri,
        partial,
        uri_source,
    })
}

/// Remove a subject from an existing Work. ADR 014 §1.
///
/// Removes both the `<work> bf:subject <subject>` edge and the subject
/// entity's own triples (rdf:type, rdfs:label, provenance). Subject URIs
/// are graph-scoped — each `add_subject` mints fresh — so cleaning up the
/// entity is safe within this graph.
///
/// Returns `SpineWriteError::SubjectNotPresent` if the edge wasn't there
/// (idempotent caller can ignore; strict caller surfaces).
pub fn remove_subject(
    store: &SpineStore,
    work_uuid: &Uuid,
    subject_uri: &str,
) -> Result<(), SpineWriteError> {
    let work_uri = work_uri_for(store, work_uuid)?;
    let graph_uri = graph_uri_for(work_uuid);

    // Verify the edge exists before any mutation.
    let triples = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    let present = triples
        .iter()
        .any(|(s, p, o)| s == &work_uri && p == BF_SUBJECT && o == subject_uri);
    if !present {
        return Err(SpineWriteError::SubjectNotPresent {
            work_uuid: *work_uuid,
            subject_uri: subject_uri.to_string(),
        });
    }

    delete_entity_and_edge(store, &graph_uri, subject_uri, &work_uri, BF_SUBJECT)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SHACL shape validators (ADR 014 §3).
//
// Each validator runs against the *post-mutation* triple set for a single
// entity. Per-entity checks (rather than whole-graph) so that mutations
// which don't touch a constrained class don't have to reason about
// other entities' invariants — `add_subject` doesn't need to care about
// Work's hasInstance cardinality, even though both the subject and the
// Work live in the same named graph.
// ---------------------------------------------------------------------------

/// Count occurrences of (entity_uri, predicate, *) in a triple slice.
fn count_outgoing(triples: &[(String, String, String)], entity_uri: &str, predicate: &str) -> usize {
    triples
        .iter()
        .filter(|(s, p, _)| s == entity_uri && p == predicate)
        .count()
}

/// Validate `spine:WorkShape` for the given Work URI on the post-mutation
/// triple set. ADR 014 §3:
/// - `bf:hasInstance` minCount 1
/// - `spine:primaryInstance` minCount 0, maxCount 1
fn validate_work_shape(
    triples: &[(String, String, String)],
    work_uri: &str,
) -> Result<(), SpineWriteError> {
    let has_instance_count = count_outgoing(triples, work_uri, BF_HAS_INSTANCE);
    if has_instance_count < 1 {
        return Err(SpineWriteError::ShapeViolation {
            path: BF_HAS_INSTANCE.to_string(),
            message: format!(
                "Work {work_uri} must have at least one bf:hasInstance edge \
                 (got {has_instance_count})"
            ),
        });
    }
    let primary_count = count_outgoing(triples, work_uri, SPINE_PRIMARY_INSTANCE);
    if primary_count > 1 {
        return Err(SpineWriteError::ShapeViolation {
            path: SPINE_PRIMARY_INSTANCE.to_string(),
            message: format!(
                "Work {work_uri} must have at most one spine:primaryInstance \
                 (got {primary_count})"
            ),
        });
    }
    Ok(())
}

/// Validate `spine:InstanceShape` for the given Instance URI on the
/// post-mutation triple set. ADR 014 §3 + ADR 015 §3:
/// - `bf:instanceOf` minCount 1, maxCount 1
/// - `spine:uriSource` minCount 1, value non-empty (open-vocab per ADR
///   015 §3; known set is {locref, spinemint}, unknown values warn-not-reject)
fn validate_instance_shape(
    triples: &[(String, String, String)],
    instance_uri: &str,
) -> Result<(), SpineWriteError> {
    let instance_of_count = count_outgoing(triples, instance_uri, BF_INSTANCE_OF);
    if instance_of_count != 1 {
        return Err(SpineWriteError::ShapeViolation {
            path: BF_INSTANCE_OF.to_string(),
            message: format!(
                "Instance {instance_uri} must have exactly one bf:instanceOf \
                 edge (got {instance_of_count})"
            ),
        });
    }
    let mut uri_source_ok = false;
    for (s, p, o) in triples {
        if s != instance_uri || p != SPINE_URI_SOURCE || o.is_empty() {
            continue;
        }
        uri_source_ok = true;
        if !matches!(o.as_str(), "locref" | "spinemint") {
            tracing::warn!(
                instance_uri = %instance_uri,
                uri_source = %o,
                "spine:uriSource value outside known set {{locref, spinemint}}; \
                 accepting per ADR 015 §3 open-vocab forward-compat clause"
            );
        }
    }
    if !uri_source_ok {
        return Err(SpineWriteError::ShapeViolation {
            path: SPINE_URI_SOURCE.to_string(),
            message: format!(
                "Instance {instance_uri} must have a non-empty spine:uriSource \
                 (open-vocab per ADR 015 §3)"
            ),
        });
    }
    Ok(())
}

/// Validate `spine:ItemShape` for the given Item URI on the post-mutation
/// triple set. ADR 014 §3:
/// - `bf:itemOf` minCount 1, maxCount 1
fn validate_item_shape(
    triples: &[(String, String, String)],
    item_uri: &str,
) -> Result<(), SpineWriteError> {
    let item_of_count = count_outgoing(triples, item_uri, BF_ITEM_OF);
    if item_of_count != 1 {
        return Err(SpineWriteError::ShapeViolation {
            path: BF_ITEM_OF.to_string(),
            message: format!(
                "Item {item_uri} must have exactly one bf:itemOf edge \
                 (got {item_of_count})"
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public write API — Instances + Items + primary (commit A2).
// ---------------------------------------------------------------------------

/// Add a new Instance (edition) to an existing Work. ADR 014 §1.
///
/// Reconcile policy follows ADR 014 §2: when `candidate.reconcile_against_loc`
/// is true (default), the synchronous reconciler is invoked first against
/// id.loc.gov by ISBN, then by title+author. A match returns the LoC URI
/// with `UriSource::Locref`; a miss (or timeout, when the production
/// reconciler is wired in commit B1) mints `urn:spine:instance:<uuid_v4>`
/// with `UriSource::Spinemint` + a `spine:reconcileTimeoutAt` triple
/// flagging the entity for background re-reconcile.
///
/// Setting `reconcile_against_loc = false` skips reconcile entirely and
/// mints locally with `partial: false` — caller has explicitly opted out.
///
/// Validates `WorkShape` (the work now has at least one Instance) and
/// `InstanceShape` (the new Instance has instanceOf + uriSource) on the
/// post-mutation graph before commit.
pub fn add_instance<R: InstanceReconciler>(
    store: &SpineStore,
    reconciler: &R,
    work_uuid: &Uuid,
    candidate: InstanceCandidate,
    ctx: &ProvenanceContext,
) -> Result<WriteOutcome, SpineWriteError> {
    let work_uri = work_uri_for(store, work_uuid)?;
    let graph_uri = graph_uri_for(work_uuid);

    let (instance_uri, uri_source, partial, reconcile_outcome) =
        if candidate.reconcile_against_loc {
            match reconciler.reconcile(&candidate)? {
                Some(outcome) => {
                    let src = outcome.source;
                    (outcome.uri.clone(), src, false, Some(outcome))
                }
                None => (
                    format!("urn:spine:instance:{}", Uuid::new_v4()),
                    UriSource::Spinemint,
                    true,
                    None,
                ),
            }
        } else {
            (
                format!("urn:spine:instance:{}", Uuid::new_v4()),
                UriSource::Spinemint,
                false,
                None,
            )
        };

    let mut new_triples: Vec<(String, String, String)> = vec![
        (
            instance_uri.clone(),
            RDF_TYPE.to_string(),
            BF_INSTANCE.to_string(),
        ),
        (
            instance_uri.clone(),
            BF_INSTANCE_OF.to_string(),
            work_uri.clone(),
        ),
        (
            work_uri.clone(),
            BF_HAS_INSTANCE.to_string(),
            instance_uri.clone(),
        ),
    ];
    if !candidate.format.is_empty() {
        new_triples.push((
            instance_uri.clone(),
            BF_FORMAT.to_string(),
            candidate.format.clone(),
        ));
    }
    if let Some(p) = &candidate.publication_date {
        new_triples.push((
            instance_uri.clone(),
            BF_PUBLICATION_DATE.to_string(),
            p.clone(),
        ));
    }
    if let Some(p) = &candidate.publisher {
        new_triples.push((instance_uri.clone(), BF_PUBLISHER.to_string(), p.clone()));
    }
    if let Some(isbn) = &candidate.isbn {
        new_triples.push((instance_uri.clone(), BF_ISBN.to_string(), isbn.clone()));
    }
    if let Some(t) = &candidate.title {
        new_triples.push((instance_uri.clone(), BF_MAIN_TITLE.to_string(), t.clone()));
    }
    if partial {
        new_triples.push((
            instance_uri.clone(),
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            ctx.timestamp.to_rfc3339(),
        ));
    }
    new_triples.extend(provenance_triples(
        &instance_uri,
        uri_source,
        ctx,
        reconcile_outcome.as_ref(),
    ));

    // SHACL: combined post-state must satisfy WorkShape + InstanceShape
    // for the entities we touched. Pre-state validity isn't checked —
    // a bare Work fixture is invalid by WorkShape until the first
    // Instance lands here, and that's fine.
    let existing = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;
    let combined: Vec<(String, String, String)> =
        existing.iter().chain(new_triples.iter()).cloned().collect();
    validate_work_shape(&combined, &work_uri)?;
    validate_instance_shape(&combined, &instance_uri)?;

    store
        .replace_graph(&graph_uri, &combined)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    Ok(WriteOutcome {
        uri: instance_uri,
        partial,
        uri_source,
    })
}

/// Add a new Item (file resource) under an existing Instance. ADR 014 §1.
///
/// Items are file descriptors, not bibliographic entities — they don't
/// reconcile against id.loc.gov. URI is always `urn:spine:item:<uuid_v4>`
/// with `UriSource::Spinemint` and `partial: false`.
///
/// Validates `ItemShape` on the new Item (exactly one `bf:itemOf` edge
/// to the named Instance).
pub fn add_item(
    store: &SpineStore,
    work_uuid: &Uuid,
    instance_uri: &str,
    item: ItemDescriptor,
    ctx: &ProvenanceContext,
) -> Result<WriteOutcome, SpineWriteError> {
    if item.file_path.trim().is_empty() {
        return Err(SpineWriteError::InvalidInput(
            "ItemDescriptor.file_path must not be empty".to_string(),
        ));
    }

    let graph_uri = graph_uri_for(work_uuid);
    let existing = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    // Verify the parent Instance exists in this graph.
    let instance_present = existing
        .iter()
        .any(|(s, p, o)| s == instance_uri && p == RDF_TYPE && o == BF_INSTANCE);
    if !instance_present {
        return Err(SpineWriteError::InstanceNotFound {
            instance_uri: instance_uri.to_string(),
        });
    }

    let item_uri = format!("urn:spine:item:{}", Uuid::new_v4());
    let mut new_triples: Vec<(String, String, String)> = vec![
        (item_uri.clone(), RDF_TYPE.to_string(), BF_ITEM.to_string()),
        (
            item_uri.clone(),
            BF_ITEM_OF.to_string(),
            instance_uri.to_string(),
        ),
        (
            item_uri.clone(),
            BF_ELECTRONIC_LOCATOR.to_string(),
            item.file_path.clone(),
        ),
    ];
    if let Some(format) = &item.format {
        new_triples.push((item_uri.clone(), BF_FORMAT.to_string(), format.clone()));
    }
    new_triples.extend(provenance_triples(
        &item_uri,
        UriSource::Spinemint,
        ctx,
        None,
    ));

    let combined: Vec<(String, String, String)> =
        existing.iter().chain(new_triples.iter()).cloned().collect();
    validate_item_shape(&combined, &item_uri)?;

    store
        .replace_graph(&graph_uri, &combined)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    Ok(WriteOutcome {
        uri: item_uri,
        partial: false,
        uri_source: UriSource::Spinemint,
    })
}

/// Designate an Instance as the primary edition of its Work. ADR 014 §1.
///
/// Drops any existing `<work> spine:primaryInstance <_>` edge and writes
/// the new one. Idempotent — calling twice with the same instance_uri
/// is a no-op functionally; SHACL `WorkShape.maxCount 1` is preserved.
///
/// Returns `InstanceNotFound` if the instance_uri isn't a known Instance
/// in this work's graph.
pub fn set_primary_instance(
    store: &SpineStore,
    work_uuid: &Uuid,
    instance_uri: &str,
) -> Result<(), SpineWriteError> {
    let work_uri = work_uri_for(store, work_uuid)?;
    let graph_uri = graph_uri_for(work_uuid);
    let existing = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    let instance_present = existing
        .iter()
        .any(|(s, p, o)| s == instance_uri && p == RDF_TYPE && o == BF_INSTANCE);
    if !instance_present {
        return Err(SpineWriteError::InstanceNotFound {
            instance_uri: instance_uri.to_string(),
        });
    }

    // Filter out any existing primaryInstance edges from this Work, then
    // append the new one. Replace_graph commits atomically.
    let mut new_triples: Vec<(String, String, String)> = existing
        .into_iter()
        .filter(|(s, p, _)| !(s == &work_uri && p == SPINE_PRIMARY_INSTANCE))
        .collect();
    new_triples.push((
        work_uri.clone(),
        SPINE_PRIMARY_INSTANCE.to_string(),
        instance_uri.to_string(),
    ));

    validate_work_shape(&new_triples, &work_uri)?;

    store
        .replace_graph(&graph_uri, &new_triples)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Sprint 12 — set_fields write API (D4 Library Manage MVP).
// ---------------------------------------------------------------------------

/// 8-field metadata edit payload for the D4 Library Manage MVP write API.
/// Each field is `Option<T>` so PATCH-style
/// partial updates work — `None` means "leave this field untouched",
/// `Some(value)` (or `Some(empty)` for clearable fields) means "replace
/// with this value".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFieldsRequest {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub pubdate: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
}

/// Update the BIBFRAME triples for a Work to reflect a `SetFieldsRequest`.
/// Filters out the existing field-level triples for any field present in
/// the request and appends fresh ones. Other graph triples
/// (`spine:uriSource`, `bf:hasInstance`, addedBy/addedAt etc.) are left
/// untouched.
///
/// Per Sprint 12 contract: every successful call adds a fresh
/// `spine:assertedBy = <user URI>` + `spine:assertedAt = <RFC3339>` pair
/// on the Work, replacing any prior pair so the latest edit's authorship
/// is the one of record. The Sprint-10 `spine:addedBy` / `spine:addedAt`
/// triples (the original ingest provenance) are preserved.
///
/// Calibre-side updates (`books.author_sort`, `authors.sort`,
/// `books.last_modified`) are NOT performed here — that's the
/// orchestrator's job in spine-srv. spine-bf stays BIBFRAME-only.
pub fn set_fields(
    store: &SpineStore,
    work_uuid: &Uuid,
    request: &SetFieldsRequest,
    ctx: &ProvenanceContext,
) -> Result<(), SpineWriteError> {
    let work_uri = work_uri_for(store, work_uuid)?;
    let graph_uri = graph_uri_for(work_uuid);
    let existing = store
        .get_triples(&graph_uri)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    let instance_uri = existing
        .iter()
        .find(|(_, p, o)| p == BF_INSTANCE_OF && o == &work_uri)
        .map(|(s, _, _)| s.clone());

    // Authors and tags are reified through one or two hops of blank /
    // entity nodes (Work → bf:contribution → bf:agent → label, Work →
    // bf:subject → label). Filter those subordinate subjects out
    // transitively when their parent edge is being replaced; otherwise
    // the in-graph labels and types persist as orphaned triples after
    // the head edge is dropped.
    let mut subordinate_subjects = std::collections::HashSet::<String>::new();
    if request.authors.is_some() {
        let contribs: Vec<&str> = existing
            .iter()
            .filter(|(s, p, _)| s == &work_uri && p == BF_CONTRIBUTION)
            .map(|(_, _, o)| o.as_str())
            .collect();
        for cn in &contribs {
            subordinate_subjects.insert((*cn).to_string());
            for (_, _, o) in existing
                .iter()
                .filter(|(s, p, _)| s == cn && p == BF_AGENT)
            {
                subordinate_subjects.insert(o.clone());
            }
        }
    }
    if request.tags.is_some() {
        for (_, _, o) in existing
            .iter()
            .filter(|(s, p, _)| s == &work_uri && p == BF_SUBJECT)
        {
            subordinate_subjects.insert(o.clone());
        }
    }

    let mut next: Vec<(String, String, String)> = existing
        .into_iter()
        .filter(|(s, p, _)| {
            !subordinate_subjects.contains(s)
                && !is_field_triple(s, p, &work_uri, instance_uri.as_deref(), request)
        })
        .collect();

    if let Some(title) = &request.title {
        next.push((work_uri.clone(), BF_MAIN_TITLE.to_string(), title.clone()));
        next.push((work_uri.clone(), RDFS_LABEL.to_string(), title.clone()));
    }

    if let Some(authors) = &request.authors {
        for (index, author) in authors.iter().enumerate() {
            if author.is_empty() {
                continue;
            }
            let contrib_bn = format!("_:set_{work_uuid}_contrib_{index}");
            let agent_bn = format!("_:set_{work_uuid}_agent_{index}");
            next.push((
                work_uri.clone(),
                BF_CONTRIBUTION.to_string(),
                contrib_bn.clone(),
            ));
            next.push((
                contrib_bn.clone(),
                BF_AGENT.to_string(),
                agent_bn.clone(),
            ));
            next.push((contrib_bn, BF_ROLE.to_string(), REL_AUT.to_string()));
            next.push((
                agent_bn.clone(),
                RDF_TYPE.to_string(),
                BF_AGENT_CLASS.to_string(),
            ));
            next.push((agent_bn, RDFS_LABEL.to_string(), author.clone()));
        }
    }

    if let Some(tags) = &request.tags {
        for tag in tags {
            if tag.is_empty() {
                continue;
            }
            let tag_uri = format!("urn:spine:subject:tag:{}", Uuid::new_v4());
            next.push((work_uri.clone(), BF_SUBJECT.to_string(), tag_uri.clone()));
            next.push((tag_uri.clone(), RDF_TYPE.to_string(), BF_TOPIC.to_string()));
            next.push((tag_uri, RDFS_LABEL.to_string(), tag.clone()));
        }
    }

    if let Some(series) = &request.series {
        if !series.is_empty() {
            next.push((work_uri.clone(), SPINE_SERIES.to_string(), series.clone()));
        }
    }
    if let Some(idx) = request.series_index {
        next.push((
            work_uri.clone(),
            SPINE_SERIES_INDEX.to_string(),
            idx.to_string(),
        ));
    }

    if let Some(language) = &request.language {
        if !language.is_empty() {
            next.push((
                work_uri.clone(),
                BF_LANGUAGE.to_string(),
                language.clone(),
            ));
        }
    }

    let target_for_publication = instance_uri.as_deref().unwrap_or(&work_uri);
    if let Some(pubdate) = &request.pubdate {
        if !pubdate.is_empty() {
            next.push((
                target_for_publication.to_string(),
                BF_PUBLICATION_DATE.to_string(),
                pubdate.clone(),
            ));
        }
    }
    if let Some(publisher) = &request.publisher {
        if !publisher.is_empty() {
            next.push((
                target_for_publication.to_string(),
                BF_PUBLISHER.to_string(),
                publisher.clone(),
            ));
        }
    }

    next.push((
        work_uri.clone(),
        SPINE_ASSERTED_BY.to_string(),
        ctx.user_uri.clone(),
    ));
    next.push((
        work_uri,
        SPINE_ASSERTED_AT.to_string(),
        ctx.timestamp.to_rfc3339(),
    ));

    store
        .replace_graph(&graph_uri, &next)
        .map_err(|e| SpineWriteError::Store(e.to_string()))?;

    Ok(())
}

/// Decide whether a triple should be filtered out before re-writing the
/// graph in `set_fields`. Field-level edits replace; everything else
/// (the Work URI itself, instance edges, ingest provenance, reconcile
/// flags) is preserved.
fn is_field_triple(
    s: &str,
    p: &str,
    work_uri: &str,
    instance_uri: Option<&str>,
    request: &SetFieldsRequest,
) -> bool {
    if s == work_uri {
        match p {
            BF_MAIN_TITLE | RDFS_LABEL if request.title.is_some() => return true,
            BF_CONTRIBUTION if request.authors.is_some() => return true,
            BF_SUBJECT if request.tags.is_some() => return true,
            SPINE_SERIES if request.series.is_some() => return true,
            SPINE_SERIES_INDEX if request.series_index.is_some() => return true,
            BF_LANGUAGE if request.language.is_some() => return true,
            // Always replace assertedBy/assertedAt — there's only one current.
            SPINE_ASSERTED_BY | SPINE_ASSERTED_AT => return true,
            _ => return false,
        }
    }
    if Some(s) == instance_uri {
        match p {
            BF_PUBLICATION_DATE if request.pubdate.is_some() => return true,
            BF_PUBLISHER if request.publisher.is_some() => return true,
            _ => return false,
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use spine_db::SpineStore;

    /// Spin up an in-memory SpineStore with a single Work in book-graph form.
    /// Returns (store, work_uuid).
    fn fixture_store_with_work() -> (SpineStore, Uuid) {
        let store = SpineStore::open(":memory:").expect("in-memory spine.db");
        let work_uuid = Uuid::new_v4();
        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
        let triples: Vec<(String, String, String)> = vec![
            (
                work_uri.clone(),
                RDF_TYPE.to_string(),
                BF_WORK.to_string(),
            ),
            (
                work_uri,
                RDFS_LABEL.to_string(),
                "Test Work".to_string(),
            ),
        ];
        store
            .replace_graph(&graph_uri, &triples)
            .expect("seed graph");
        (store, work_uuid)
    }

    #[test]
    fn add_subject_lcsh_unmatched_mints_partial() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();

        let outcome = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "Dragons in literature",
            SubjectSource::Lcsh,
            &ctx,
        )
        .expect("should mint locally on no-match");

        assert!(
            outcome.uri.starts_with("urn:spine:subject:lcsh:"),
            "unmatched LCSH must mint urn:spine:subject:lcsh:* — got {}",
            outcome.uri
        );
        assert_eq!(outcome.uri_source, UriSource::Spinemint);
        assert!(
            outcome.partial,
            "unmatched LCSH must flag partial=true for background re-reconcile"
        );

        // Verify the work→subject edge + provenance triples landed.
        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(
            triples
                .iter()
                .any(|(_, p, o)| p == BF_SUBJECT && o == &outcome.uri),
            "work→subject edge must be present after add_subject"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == SPINE_URI_SOURCE),
            "provenance uriSource triple must be present on the new subject"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == SPINE_RECONCILE_TIMEOUT_AT),
            "partial mint must include reconcileTimeoutAt"
        );
    }

    #[test]
    fn add_subject_local_tag_never_partials() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();

        let outcome = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "to-read",
            SubjectSource::LocalTag,
            &ctx,
        )
        .expect("LocalTag never reconciles, always succeeds");

        assert!(
            outcome.uri.starts_with("urn:spine:subject:tag:"),
            "LocalTag mints urn:spine:subject:tag:*"
        );
        assert!(
            !outcome.partial,
            "LocalTag never sets partial — there's no reconciliation to be pending on"
        );
    }

    #[test]
    fn add_subject_inferred_rejected() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();

        let err = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "fantasy",
            SubjectSource::Inferred,
            &ctx,
        )
        .expect_err("inferred source must be rejected from asserted graph");

        assert!(
            matches!(err, SpineWriteError::AssertedRejectInferred),
            "expected AssertedRejectInferred; got {err:?}"
        );
    }

    #[test]
    fn add_subject_empty_term_rejected() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();

        let err = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "   ",
            SubjectSource::LocalTag,
            &ctx,
        )
        .expect_err("whitespace-only term is invalid input");

        assert!(matches!(err, SpineWriteError::InvalidInput(_)));
    }

    #[test]
    fn add_subject_unknown_work_returns_not_found() {
        let store = SpineStore::open(":memory:").unwrap();
        let work_uuid = Uuid::new_v4();
        let ctx = ProvenanceContext::default();

        let err = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "anything",
            SubjectSource::LocalTag,
            &ctx,
        )
        .expect_err("missing work must return WorkNotFound");

        assert!(matches!(
            err,
            SpineWriteError::WorkNotFound { work_uuid: u } if u == work_uuid
        ));
    }

    #[test]
    fn remove_subject_present_succeeds_and_drops_entity_triples() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();

        let outcome = add_subject(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            "Cyberpunk",
            SubjectSource::LocalTag,
            &ctx,
        )
        .unwrap();

        remove_subject(&store, &work_uuid, &outcome.uri).expect("present subject removes");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(
            !triples
                .iter()
                .any(|(_, p, o)| p == BF_SUBJECT && o == &outcome.uri),
            "work→subject edge must be gone after remove_subject"
        );
        assert!(
            !triples.iter().any(|(s, _, _)| s == &outcome.uri),
            "subject entity's own triples must be gone after remove_subject"
        );
    }

    #[test]
    fn remove_subject_not_present_returns_error() {
        let (store, work_uuid) = fixture_store_with_work();

        let err = remove_subject(&store, &work_uuid, "urn:spine:subject:tag:nonexistent")
            .expect_err("absent subject must return SubjectNotPresent");

        assert!(matches!(err, SpineWriteError::SubjectNotPresent { .. }));
    }

    #[test]
    fn provenance_triples_always_include_added_by_and_uri_source() {
        let ctx = ProvenanceContext::default();
        let triples = provenance_triples(
            "urn:spine:subject:tag:abc",
            UriSource::Spinemint,
            &ctx,
            None,
        );

        // Mandatory: uriSource, addedBy, addedAt.
        assert!(triples.iter().any(|(_, p, _)| p == SPINE_URI_SOURCE));
        assert!(triples.iter().any(|(_, p, _)| p == SPINE_ADDED_BY));
        assert!(triples.iter().any(|(_, p, _)| p == SPINE_ADDED_AT));
        // Reconcile-* fields absent without an outcome.
        assert!(!triples.iter().any(|(_, p, _)| p == SPINE_RECONCILED_AGAINST));
        assert!(!triples.iter().any(|(_, p, _)| p == SPINE_RECONCILE_CONFIDENCE));
    }

    #[test]
    fn provenance_triples_with_locref_include_reconcile_fields() {
        let ctx = ProvenanceContext::default();
        let outcome = ReconcileOutcome {
            uri: "http://id.loc.gov/authorities/subjects/sh85044002".to_string(),
            source: UriSource::Locref,
            confidence: Some(0.95),
            authority_uri: Some(
                "http://id.loc.gov/authorities/subjects/sh85044002".to_string(),
            ),
        };
        let triples = provenance_triples(&outcome.uri, UriSource::Locref, &ctx, Some(&outcome));

        assert!(triples
            .iter()
            .any(|(_, p, _)| p == SPINE_RECONCILED_AGAINST));
        assert!(triples
            .iter()
            .any(|(_, p, _)| p == SPINE_RECONCILED_AT));
        assert!(triples
            .iter()
            .any(|(_, p, _)| p == SPINE_RECONCILE_CONFIDENCE));
    }

    // -----------------------------------------------------------------
    // Commit A2 — add_instance / add_item / set_primary_instance tests
    // -----------------------------------------------------------------

    /// Spin up an in-memory SpineStore with a Work + one Instance + the
    /// hasInstance edge + provenance. Returns (store, work_uuid, instance_uri).
    /// Used by add_item / set_primary_instance tests that need a pre-
    /// existing Instance to operate on.
    fn fixture_store_with_work_and_instance() -> (SpineStore, Uuid, String) {
        let store = SpineStore::open(":memory:").expect("in-memory spine.db");
        let work_uuid = Uuid::new_v4();
        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
        let instance_uri = format!("urn:spine:instance:{}", Uuid::new_v4());
        let triples: Vec<(String, String, String)> = vec![
            (
                work_uri.clone(),
                RDF_TYPE.to_string(),
                BF_WORK.to_string(),
            ),
            (
                work_uri.clone(),
                RDFS_LABEL.to_string(),
                "Test Work".to_string(),
            ),
            (
                work_uri.clone(),
                BF_HAS_INSTANCE.to_string(),
                instance_uri.clone(),
            ),
            (
                instance_uri.clone(),
                RDF_TYPE.to_string(),
                BF_INSTANCE.to_string(),
            ),
            (
                instance_uri.clone(),
                BF_INSTANCE_OF.to_string(),
                work_uri,
            ),
            // SHACL-required uriSource on Instance.
            (
                instance_uri.clone(),
                SPINE_URI_SOURCE.to_string(),
                "spinemint".to_string(),
            ),
        ];
        store
            .replace_graph(&graph_uri, &triples)
            .expect("seed graph");
        (store, work_uuid, instance_uri)
    }

    #[test]
    fn add_instance_unmatched_mints_partial_with_provenance() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();
        let candidate = InstanceCandidate {
            format: "EPUB".to_string(),
            isbn: Some("9780000000001".to_string()),
            ..Default::default()
        };

        let outcome = add_instance(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            candidate,
            &ctx,
        )
        .expect("first instance lands even when reconcile misses");

        assert!(
            outcome.uri.starts_with("urn:spine:instance:"),
            "unmatched candidate must mint urn:spine:instance:* — got {}",
            outcome.uri
        );
        assert_eq!(outcome.uri_source, UriSource::Spinemint);
        assert!(outcome.partial, "miss must flag partial=true");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(
            triples
                .iter()
                .any(|(_, p, o)| p == BF_HAS_INSTANCE && o == &outcome.uri),
            "work→instance hasInstance edge must be present"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == BF_INSTANCE_OF),
            "instance→work instanceOf edge must be present"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == SPINE_URI_SOURCE),
            "Instance must carry uriSource provenance"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == SPINE_RECONCILE_TIMEOUT_AT),
            "partial mint must include reconcileTimeoutAt"
        );
    }

    #[test]
    fn add_instance_persists_all_supplied_metadata() {
        let (store, work_uuid) = fixture_store_with_work();
        let ctx = ProvenanceContext::default();
        let candidate = InstanceCandidate {
            format: "EPUB".to_string(),
            publication_date: Some("2024".to_string()),
            publisher: Some("Tor".to_string()),
            isbn: Some("9780765376671".to_string()),
            title: Some("Translated Edition".to_string()),
            reconcile_against_loc: false,
        };

        let outcome = add_instance(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            candidate,
            &ctx,
        )
        .expect("opt-out reconcile path");

        assert!(!outcome.partial, "no_reconcile path must not set partial");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        let on_instance: Vec<&str> = triples
            .iter()
            .filter(|(s, _, _)| s == &outcome.uri)
            .map(|(_, p, _)| p.as_str())
            .collect();
        assert!(on_instance.contains(&BF_FORMAT));
        assert!(on_instance.contains(&BF_PUBLICATION_DATE));
        assert!(on_instance.contains(&BF_PUBLISHER));
        assert!(on_instance.contains(&BF_ISBN));
        assert!(on_instance.contains(&BF_MAIN_TITLE));
    }

    #[test]
    fn add_instance_unknown_work_returns_not_found() {
        let store = SpineStore::open(":memory:").unwrap();
        let work_uuid = Uuid::new_v4();
        let ctx = ProvenanceContext::default();
        let err = add_instance(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            InstanceCandidate::default(),
            &ctx,
        )
        .expect_err("missing work returns WorkNotFound");
        assert!(matches!(
            err,
            SpineWriteError::WorkNotFound { work_uuid: u } if u == work_uuid
        ));
    }

    #[test]
    fn add_item_under_existing_instance_succeeds() {
        let (store, work_uuid, instance_uri) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let item = ItemDescriptor {
            file_path: "Author/Title (1)/book.epub".to_string(),
            format: Some("EPUB".to_string()),
            file_size: Some(123456),
            sha256: None,
        };

        let outcome = add_item(&store, &work_uuid, &instance_uri, item, &ctx)
            .expect("item lands under known instance");

        assert!(
            outcome.uri.starts_with("urn:spine:item:"),
            "item must mint urn:spine:item:*"
        );
        assert!(!outcome.partial, "items don't reconcile, never partial");
        assert_eq!(outcome.uri_source, UriSource::Spinemint);

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(
            triples
                .iter()
                .any(|(s, p, o)| s == &outcome.uri && p == BF_ITEM_OF && o == &instance_uri),
            "item→instance itemOf edge must be present"
        );
        assert!(
            triples
                .iter()
                .any(|(s, p, _)| s == &outcome.uri && p == BF_ELECTRONIC_LOCATOR),
            "item must carry electronicLocator pointing at file_path"
        );
    }

    #[test]
    fn add_item_unknown_instance_returns_not_found() {
        let (store, work_uuid, _) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let item = ItemDescriptor {
            file_path: "x.epub".to_string(),
            format: None,
            file_size: None,
            sha256: None,
        };

        let err = add_item(
            &store,
            &work_uuid,
            "urn:spine:instance:nonexistent",
            item,
            &ctx,
        )
        .expect_err("unknown instance must return InstanceNotFound");
        assert!(matches!(err, SpineWriteError::InstanceNotFound { .. }));
    }

    #[test]
    fn add_item_empty_path_returns_invalid_input() {
        let (store, work_uuid, instance_uri) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let item = ItemDescriptor {
            file_path: "   ".to_string(),
            format: None,
            file_size: None,
            sha256: None,
        };
        let err = add_item(&store, &work_uuid, &instance_uri, item, &ctx)
            .expect_err("whitespace path is invalid");
        assert!(matches!(err, SpineWriteError::InvalidInput(_)));
    }

    #[test]
    fn set_primary_instance_writes_edge_and_replaces_existing() {
        let (store, work_uuid, instance_uri) = fixture_store_with_work_and_instance();

        // First call writes the edge.
        set_primary_instance(&store, &work_uuid, &instance_uri).expect("first set succeeds");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let after_first = store.get_triples(&graph_uri).unwrap();
        let primary_edges: Vec<&String> = after_first
            .iter()
            .filter(|(_, p, _)| p == SPINE_PRIMARY_INSTANCE)
            .map(|(_, _, o)| o)
            .collect();
        assert_eq!(primary_edges.len(), 1, "exactly one primary edge");
        assert_eq!(primary_edges[0], &instance_uri);

        // Second call with a different instance — first add the second
        // instance, then point primary at it.
        let ctx = ProvenanceContext::default();
        let outcome = add_instance(
            &store,
            &AlwaysUnmatched,
            &work_uuid,
            InstanceCandidate {
                format: "MOBI".to_string(),
                reconcile_against_loc: false,
                ..Default::default()
            },
            &ctx,
        )
        .expect("second instance lands");

        set_primary_instance(&store, &work_uuid, &outcome.uri).expect("second set succeeds");

        let after_second = store.get_triples(&graph_uri).unwrap();
        let primary_edges: Vec<&String> = after_second
            .iter()
            .filter(|(_, p, _)| p == SPINE_PRIMARY_INSTANCE)
            .map(|(_, _, o)| o)
            .collect();
        assert_eq!(primary_edges.len(), 1, "still exactly one primary after replace");
        assert_eq!(
            primary_edges[0], &outcome.uri,
            "primary now points at the second instance"
        );
    }

    #[test]
    fn set_primary_instance_unknown_instance_returns_not_found() {
        let (store, work_uuid, _) = fixture_store_with_work_and_instance();
        let err = set_primary_instance(&store, &work_uuid, "urn:spine:instance:nope")
            .expect_err("unknown instance fails");
        assert!(matches!(err, SpineWriteError::InstanceNotFound { .. }));
    }

    #[test]
    fn validate_work_shape_rejects_zero_instances() {
        let work_uri = "urn:spine:work:abc";
        // A Work with no hasInstance edges.
        let triples = vec![
            (
                work_uri.to_string(),
                RDF_TYPE.to_string(),
                BF_WORK.to_string(),
            ),
            (
                work_uri.to_string(),
                RDFS_LABEL.to_string(),
                "Bare Work".to_string(),
            ),
        ];
        let err = validate_work_shape(&triples, work_uri).expect_err("0 instances violates shape");
        assert!(matches!(
            err,
            SpineWriteError::ShapeViolation { ref path, .. } if path == BF_HAS_INSTANCE
        ));
    }

    #[test]
    fn validate_work_shape_rejects_two_primary_instances() {
        let work_uri = "urn:spine:work:abc";
        let triples = vec![
            (
                work_uri.to_string(),
                BF_HAS_INSTANCE.to_string(),
                "urn:spine:instance:1".to_string(),
            ),
            (
                work_uri.to_string(),
                SPINE_PRIMARY_INSTANCE.to_string(),
                "urn:spine:instance:1".to_string(),
            ),
            (
                work_uri.to_string(),
                SPINE_PRIMARY_INSTANCE.to_string(),
                "urn:spine:instance:2".to_string(),
            ),
        ];
        let err =
            validate_work_shape(&triples, work_uri).expect_err("2 primaries violates maxCount 1");
        assert!(matches!(
            err,
            SpineWriteError::ShapeViolation { ref path, .. } if path == SPINE_PRIMARY_INSTANCE
        ));
    }

    #[test]
    fn validate_instance_shape_rejects_missing_uri_source() {
        let instance_uri = "urn:spine:instance:abc";
        let triples = vec![
            (
                instance_uri.to_string(),
                RDF_TYPE.to_string(),
                BF_INSTANCE.to_string(),
            ),
            (
                instance_uri.to_string(),
                BF_INSTANCE_OF.to_string(),
                "urn:spine:work:def".to_string(),
            ),
        ];
        let err = validate_instance_shape(&triples, instance_uri)
            .expect_err("missing uriSource violates shape");
        assert!(matches!(
            err,
            SpineWriteError::ShapeViolation { ref path, .. } if path == SPINE_URI_SOURCE
        ));
    }

    // ----------------------------------------------------------------
    // Sprint 12 — set_fields tests
    // ----------------------------------------------------------------

    #[test]
    fn set_fields_replaces_title_and_adds_assertion_provenance() {
        let (store, work_uuid, _instance_uri) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let request = SetFieldsRequest {
            title: Some("Renamed Work".to_string()),
            ..Default::default()
        };
        set_fields(&store, &work_uuid, &request, &ctx).expect("set_fields");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(triples.iter().any(|(_, p, o)| p == BF_MAIN_TITLE && o == "Renamed Work"));
        assert!(triples.iter().any(|(_, p, _)| p == SPINE_ASSERTED_BY));
        assert!(triples.iter().any(|(_, p, _)| p == SPINE_ASSERTED_AT));
    }

    #[test]
    fn set_fields_authors_replaces_existing_contributions() {
        let (store, work_uuid, _instance_uri) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let r1 = SetFieldsRequest {
            authors: Some(vec!["Alice Author".to_string()]),
            ..Default::default()
        };
        set_fields(&store, &work_uuid, &r1, &ctx).expect("set_fields 1");
        let r2 = SetFieldsRequest {
            authors: Some(vec!["Bob Author".to_string(), "Carol Co-author".to_string()]),
            ..Default::default()
        };
        set_fields(&store, &work_uuid, &r2, &ctx).expect("set_fields 2");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        let labels: Vec<&str> = triples
            .iter()
            .filter(|(s, p, _)| s.starts_with("_:set_") && p == RDFS_LABEL)
            .map(|(_, _, o)| o.as_str())
            .collect();
        assert!(labels.contains(&"Bob Author"));
        assert!(labels.contains(&"Carol Co-author"));
        assert!(!labels.contains(&"Alice Author"), "Alice must be replaced");
    }

    #[test]
    fn set_fields_pubdate_lands_on_instance() {
        let (store, work_uuid, instance_uri) = fixture_store_with_work_and_instance();
        let ctx = ProvenanceContext::default();
        let r = SetFieldsRequest {
            pubdate: Some("1818".to_string()),
            publisher: Some("Lackington".to_string()),
            ..Default::default()
        };
        set_fields(&store, &work_uuid, &r, &ctx).expect("set_fields");

        let graph_uri = format!("urn:spine:graph:book:{work_uuid}");
        let triples = store.get_triples(&graph_uri).unwrap();
        assert!(triples
            .iter()
            .any(|(s, p, o)| s == &instance_uri && p == BF_PUBLICATION_DATE && o == "1818"));
        assert!(triples
            .iter()
            .any(|(s, p, o)| s == &instance_uri && p == BF_PUBLISHER && o == "Lackington"));
    }

    #[test]
    fn set_fields_unknown_work_returns_not_found() {
        let store = SpineStore::open(":memory:").unwrap();
        let work_uuid = Uuid::new_v4();
        let ctx = ProvenanceContext::default();
        let err = set_fields(&store, &work_uuid, &SetFieldsRequest::default(), &ctx)
            .expect_err("missing work");
        assert!(matches!(
            err,
            SpineWriteError::WorkNotFound { work_uuid: u } if u == work_uuid
        ));
    }

    #[test]
    fn validate_item_shape_rejects_two_item_of_edges() {
        let item_uri = "urn:spine:item:abc";
        let triples = vec![
            (
                item_uri.to_string(),
                BF_ITEM_OF.to_string(),
                "urn:spine:instance:1".to_string(),
            ),
            (
                item_uri.to_string(),
                BF_ITEM_OF.to_string(),
                "urn:spine:instance:2".to_string(),
            ),
        ];
        let err = validate_item_shape(&triples, item_uri)
            .expect_err("two itemOf edges violates maxCount 1");
        assert!(matches!(
            err,
            SpineWriteError::ShapeViolation { ref path, .. } if path == BF_ITEM_OF
        ));
    }
}
