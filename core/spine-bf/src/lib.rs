use oxrdf::{BlankNode, Literal, NamedNode, Subject, Term};
use spine_api::{AgentLink, AuthorityLink, BibliographicGraph, Book, Instance, Work};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

pub mod author_sort;
pub mod write;

use write::ReconcileResolution;

pub type GraphTriple = (String, String, String);

/// `spine:uriSource` predicate (mirrored from `write.rs` so callers don't need
/// to depend on private items). ADR 015 §3 open-vocab.
pub const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
/// `spine:reconcileTimeoutAt` predicate. ADR 015 §2 — present iff the
/// reconcile call timed out at write time, flagging the entity for the §6
/// background sweep.
pub const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";

pub(crate) const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
pub(crate) const RDFS_LABEL: &str = "http://www.w3.org/2000/01/rdf-schema#label";
pub(crate) const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";
pub(crate) const BF_INSTANCE: &str = "http://id.loc.gov/ontologies/bibframe/Instance";
const BF_AGENT_CLASS: &str = "http://id.loc.gov/ontologies/bibframe/Agent";
pub(crate) const BF_TOPIC: &str = "http://id.loc.gov/ontologies/bibframe/Topic";
pub(crate) const BF_MAIN_TITLE: &str = "http://id.loc.gov/ontologies/bibframe/mainTitle";
const BF_ORIGIN_DATE: &str = "http://id.loc.gov/ontologies/bibframe/originDate";
const BF_CONTRIBUTION: &str = "http://id.loc.gov/ontologies/bibframe/contribution";
const BF_AGENT: &str = "http://id.loc.gov/ontologies/bibframe/agent";
const BF_ROLE: &str = "http://id.loc.gov/ontologies/bibframe/role";
pub(crate) const BF_SUBJECT: &str = "http://id.loc.gov/ontologies/bibframe/subject";
const BF_SOURCE: &str = "http://id.loc.gov/ontologies/bibframe/source";
pub(crate) const BF_INSTANCE_OF: &str = "http://id.loc.gov/ontologies/bibframe/instanceOf";
pub(crate) const BF_FORMAT: &str = "http://id.loc.gov/ontologies/bibframe/format";
pub(crate) const BF_PUBLICATION_DATE: &str = "http://id.loc.gov/ontologies/bibframe/publicationDate";
pub(crate) const BF_PUBLISHER: &str = "http://id.loc.gov/ontologies/bibframe/publisher";
const BF_LANGUAGE: &str = "http://id.loc.gov/ontologies/bibframe/language";
const BF_LCCN: &str = "http://id.loc.gov/ontologies/bibframe/lccn";
const BF_DDC: &str = "http://id.loc.gov/ontologies/bibframe/classificationDdc";
pub(crate) const BF_ISBN: &str = "http://id.loc.gov/ontologies/bibframe/isbn";
const BF_OCLC: &str = "http://id.loc.gov/ontologies/bibframe/oclc";

fn push_opt(triples: &mut Vec<GraphTriple>, s: &str, p: &str, o: &Option<String>) {
    if let Some(value) = o {
        if !value.is_empty() {
            triples.push((s.to_string(), p.to_string(), value.clone()));
        }
    }
}

/// Produces a short stable hex token used to scope blank-node labels to a
/// specific graph. Blank nodes are graph-scoped by RDF spec; without this
/// prefix, `_:contrib_0` emitted from book A's graph would collide with
/// `_:contrib_0` from book B in the shared `terms` dictionary and any
/// cross-graph SPARQL query would attribute triples to the wrong book.
fn graph_scope_token(graph_uri: &str) -> String {
    let mut hasher = DefaultHasher::new();
    graph_uri.hash(&mut hasher);
    let digest = hasher.finish();
    // 8 hex chars (32 bits) — collision probability for N graphs is ~N^2/2^33.
    // For a 100k-book library that's ~0.6%, acceptable given blank nodes are
    // not identity-bearing and a collision only matters if both graphs also
    // happen to be loaded in the same query scope.
    format!("{:08x}", (digest >> 32) as u32)
}

pub fn bibliographic_graph_to_triples(graph: &BibliographicGraph) -> Vec<GraphTriple> {
    let mut triples = Vec::new();
    let work_uri = if graph.work.uri.is_empty() {
        graph.work_uri.as_str()
    } else {
        graph.work.uri.as_str()
    };

    // Scope all blank-node labels to the work URI so they don't collide with
    // blank nodes from other graphs in the shared term dictionary.
    let scope = graph_scope_token(work_uri);

    triples.push((
        work_uri.to_string(),
        RDF_TYPE.to_string(),
        BF_WORK.to_string(),
    ));
    push_opt(&mut triples, work_uri, BF_MAIN_TITLE, &graph.work.title);
    push_opt(
        &mut triples,
        work_uri,
        BF_ORIGIN_DATE,
        &graph.work.origin_date,
    );
    push_opt(&mut triples, work_uri, BF_LANGUAGE, &graph.work.language);
    push_opt(&mut triples, work_uri, BF_LCCN, &graph.work.lccn);
    push_opt(&mut triples, work_uri, BF_DDC, &graph.work.ddc);

    for (index, creator) in graph.work.creators.iter().enumerate() {
        let contribution_uri = format!("_:g{scope}_contrib_{index}");
        triples.push((
            work_uri.to_string(),
            BF_CONTRIBUTION.to_string(),
            contribution_uri.clone(),
        ));
        triples.push((
            contribution_uri.clone(),
            BF_AGENT.to_string(),
            creator.uri.clone(),
        ));
        triples.push((contribution_uri, BF_ROLE.to_string(), creator.role.clone()));
        triples.push((
            creator.uri.clone(),
            RDF_TYPE.to_string(),
            BF_AGENT_CLASS.to_string(),
        ));
        triples.push((
            creator.uri.clone(),
            RDFS_LABEL.to_string(),
            creator.name.clone(),
        ));
    }

    for subject in &graph.work.subjects {
        triples.push((
            work_uri.to_string(),
            BF_SUBJECT.to_string(),
            subject.uri.clone(),
        ));
        triples.push((
            subject.uri.clone(),
            RDF_TYPE.to_string(),
            BF_TOPIC.to_string(),
        ));
        triples.push((
            subject.uri.clone(),
            RDFS_LABEL.to_string(),
            subject.label.clone(),
        ));
        if !subject.source.is_empty() {
            triples.push((
                subject.uri.clone(),
                BF_SOURCE.to_string(),
                subject.source.clone(),
            ));
        }
    }

    let mut instances = graph.instances.clone();
    if instances.is_empty() && !graph.instance_uri.is_empty() {
        instances.push(Instance {
            uri: graph.instance_uri.clone(),
            format: "EPUB".to_string(),
            publication_date: None,
            publisher: None,
            isbn: None,
            oclc: None,
        });
    }

    for instance in &instances {
        triples.push((
            instance.uri.clone(),
            RDF_TYPE.to_string(),
            BF_INSTANCE.to_string(),
        ));
        triples.push((
            instance.uri.clone(),
            BF_INSTANCE_OF.to_string(),
            work_uri.to_string(),
        ));
        if !instance.format.is_empty() {
            triples.push((
                instance.uri.clone(),
                BF_FORMAT.to_string(),
                instance.format.clone(),
            ));
        }
        push_opt(
            &mut triples,
            &instance.uri,
            BF_PUBLICATION_DATE,
            &instance.publication_date,
        );
        push_opt(
            &mut triples,
            &instance.uri,
            BF_PUBLISHER,
            &instance.publisher,
        );
        push_opt(&mut triples, &instance.uri, BF_ISBN, &instance.isbn);
        push_opt(&mut triples, &instance.uri, BF_OCLC, &instance.oclc);
    }

    triples
}

pub fn triples_to_bibliographic_graph(
    book_id: &str,
    triples: &[GraphTriple],
) -> Option<BibliographicGraph> {
    if triples.is_empty() {
        return None;
    }

    let by_subject = triples.iter().fold(
        HashMap::<&str, Vec<(&str, &str)>>::new(),
        |mut acc, (s, p, o)| {
            acc.entry(s.as_str())
                .or_default()
                .push((p.as_str(), o.as_str()));
            acc
        },
    );

    let work_uri = triples
        .iter()
        .find(|(_, p, o)| p == RDF_TYPE && o == BF_WORK)
        .map(|(s, _, _)| s.clone())
        .or_else(|| {
            triples
                .iter()
                .find(|(_, p, _)| p == BF_ORIGIN_DATE || p == BF_SUBJECT || p == BF_CONTRIBUTION)
                .map(|(s, _, _)| s.clone())
        })
        .unwrap_or_else(|| format!("urn:spine:work:{book_id}"));

    let object = |subject: &str, predicate: &str| -> Option<String> {
        by_subject.get(subject).and_then(|values| {
            values
                .iter()
                .find(|(p, _)| *p == predicate)
                .map(|(_, o)| (*o).to_string())
        })
    };

    let title = object(&work_uri, BF_MAIN_TITLE)
        .or_else(|| object(&work_uri, RDFS_LABEL))
        .or_else(|| {
            triples
                .iter()
                .find(|(_, p, _)| p.ends_with("mainTitle"))
                .map(|(_, _, o)| o.clone())
        });

    let origin_date = object(&work_uri, BF_ORIGIN_DATE).or_else(|| {
        triples
            .iter()
            .find(|(s, p, _)| {
                s == &work_uri && (p.ends_with("originDate") || p.ends_with("datePublished"))
            })
            .map(|(_, _, o)| o.clone())
    });

    let mut creators = Vec::new();
    for (_, _, contribution_uri) in triples
        .iter()
        .filter(|(s, p, _)| s == &work_uri && p == BF_CONTRIBUTION)
    {
        let agent_uri =
            object(contribution_uri, BF_AGENT).unwrap_or_else(|| contribution_uri.clone());
        let name = object(&agent_uri, RDFS_LABEL).unwrap_or_else(|| agent_uri.clone());
        let role = object(contribution_uri, BF_ROLE).unwrap_or_else(|| "creator".to_string());
        creators.push(AgentLink {
            uri: agent_uri,
            name,
            role,
        });
    }

    if creators.is_empty() {
        for (s, _p, o) in triples
            .iter()
            .filter(|(s, p, _)| s.starts_with("_:") && (p.ends_with("label") || p == RDFS_LABEL))
        {
            creators.push(AgentLink {
                uri: s.clone(),
                name: o.clone(),
                role: "creator".to_string(),
            });
        }
    }

    let subjects = triples
        .iter()
        .filter(|(s, p, _)| s == &work_uri && p == BF_SUBJECT)
        .map(|(_, _, subject_uri)| AuthorityLink {
            uri: subject_uri.clone(),
            label: object(subject_uri, RDFS_LABEL).unwrap_or_else(|| subject_uri.clone()),
            source: object(subject_uri, BF_SOURCE).unwrap_or_else(|| "LCSH".to_string()),
        })
        .collect::<Vec<_>>();

    let instance_uris = triples
        .iter()
        .filter(|(_, p, o)| p == RDF_TYPE && o == BF_INSTANCE)
        .map(|(s, _, _)| s.clone())
        .chain(
            triples
                .iter()
                .filter(|(_, p, o)| p == BF_INSTANCE_OF && o == &work_uri)
                .map(|(s, _, _)| s.clone()),
        )
        .collect::<HashSet<_>>();

    let mut instance_uris = instance_uris.into_iter().collect::<Vec<_>>();
    instance_uris.sort();

    let instances = instance_uris
        .into_iter()
        .map(|uri| Instance {
            format: object(&uri, BF_FORMAT).unwrap_or_else(|| "EPUB".to_string()),
            publication_date: object(&uri, BF_PUBLICATION_DATE),
            publisher: object(&uri, BF_PUBLISHER),
            isbn: object(&uri, BF_ISBN),
            oclc: object(&uri, BF_OCLC),
            uri,
        })
        .collect::<Vec<_>>();

    if title.is_none()
        && origin_date.is_none()
        && creators.is_empty()
        && subjects.is_empty()
        && instances.is_empty()
    {
        return None;
    }

    let instance_uri = instances
        .first()
        .map(|instance| instance.uri.clone())
        .unwrap_or_else(|| format!("urn:spine:instance:{book_id}"));

    Some(BibliographicGraph {
        work_uri: work_uri.clone(),
        instance_uri,
        work: Work {
            uri: work_uri.clone(),
            title,
            origin_date,
            subjects,
            creators,
            language: object(&work_uri, BF_LANGUAGE),
            lccn: object(&work_uri, BF_LCCN),
            ddc: object(&work_uri, BF_DDC),
        },
        instances,
    })
}

/// Reconcile-first ingest emitter (ADR 015 §1 + §2).
///
/// Given a `Book` plus the three-way `ReconcileResolution` for both its
/// Work and its Instance, emit string-tuple triples ready for spine.db
/// with the right URIs and the right `spine:uriSource` /
/// `spine:reconcileTimeoutAt` provenance per ADR 015 §2:
///
/// | Outcome    | URI                              | uriSource     | timeout flag |
/// |------------|----------------------------------|---------------|--------------|
/// | Matched    | LoC URI verbatim                 | `"locref"`    | —            |
/// | Unmatched  | `urn:spine:work:{book.id}`       | `"spinemint"` | —            |
/// | TimedOut   | `urn:spine:work:{book.id}`       | `"spinemint"` | epoch ms     |
///
/// (Same mapping for Instance, with `urn:spine:instance:{book.id}`.)
///
/// This is the production import path — it replaces the blind-mint
/// `to_triples` for callers that ingest into spine.db. `to_triples`
/// itself is kept for unit tests that don't simulate the reconcile
/// path; production callers MUST go through this function so the
/// reconcile-first invariant in `CLAUDE.md` is preserved.
pub fn to_triples_reconciled(
    book: &Book,
    work_resolution: &ReconcileResolution,
    instance_resolution: &ReconcileResolution,
    now_epoch_ms: u64,
) -> Vec<GraphTriple> {
    let book_id = book.id.to_string();
    let (work_uri, work_source, work_timed_out) = resolve_uri(
        work_resolution,
        &format!("urn:spine:work:{book_id}"),
    );
    let (instance_uri, instance_source, instance_timed_out) = resolve_uri(
        instance_resolution,
        &format!("urn:spine:instance:{book_id}"),
    );

    let mut triples: Vec<GraphTriple> = Vec::new();

    triples.push((
        work_uri.clone(),
        RDF_TYPE.to_string(),
        BF_WORK.to_string(),
    ));
    triples.push((
        work_uri.clone(),
        RDFS_LABEL.to_string(),
        book.title.clone(),
    ));
    triples.push((
        work_uri.clone(),
        BF_MAIN_TITLE.to_string(),
        book.title.clone(),
    ));

    let scope = graph_scope_token(&work_uri);
    for (index, author) in book.authors.iter().enumerate() {
        let contrib_uri = format!("_:g{scope}_contrib_{index}");
        let agent_uri = format!("_:g{scope}_agent_{index}");
        triples.push((
            work_uri.clone(),
            BF_CONTRIBUTION.to_string(),
            contrib_uri.clone(),
        ));
        triples.push((
            contrib_uri.clone(),
            BF_AGENT.to_string(),
            agent_uri.clone(),
        ));
        triples.push((
            contrib_uri,
            BF_ROLE.to_string(),
            "http://id.loc.gov/vocabulary/relators/aut".to_string(),
        ));
        triples.push((
            agent_uri.clone(),
            RDF_TYPE.to_string(),
            BF_AGENT_CLASS.to_string(),
        ));
        triples.push((agent_uri, RDFS_LABEL.to_string(), author.clone()));
    }

    triples.push((
        instance_uri.clone(),
        RDF_TYPE.to_string(),
        BF_INSTANCE.to_string(),
    ));
    triples.push((
        instance_uri.clone(),
        BF_INSTANCE_OF.to_string(),
        work_uri.clone(),
    ));
    if let Some(pub_date) = &book.legacy_metadata.pub_date {
        triples.push((
            instance_uri.clone(),
            BF_PUBLICATION_DATE.to_string(),
            pub_date.clone(),
        ));
    }
    if let Some(publisher) = &book.legacy_metadata.publisher {
        triples.push((
            instance_uri.clone(),
            BF_PUBLISHER.to_string(),
            publisher.clone(),
        ));
    }

    triples.push((
        work_uri.clone(),
        SPINE_URI_SOURCE.to_string(),
        work_source.to_string(),
    ));
    triples.push((
        instance_uri.clone(),
        SPINE_URI_SOURCE.to_string(),
        instance_source.to_string(),
    ));
    if work_timed_out {
        triples.push((
            work_uri,
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            now_epoch_ms.to_string(),
        ));
    }
    if instance_timed_out {
        triples.push((
            instance_uri,
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            now_epoch_ms.to_string(),
        ));
    }

    triples
}

fn resolve_uri<'a>(
    resolution: &'a ReconcileResolution,
    spine_local: &'a str,
) -> (String, &'static str, bool) {
    match resolution {
        ReconcileResolution::Matched { uri, .. } => (uri.clone(), "locref", false),
        ReconcileResolution::Unmatched => (spine_local.to_string(), "spinemint", false),
        ReconcileResolution::TimedOut => (spine_local.to_string(), "spinemint", true),
    }
}

// Very basic initial crosswalk from flat legacy metadata to BIBFRAME 2.0
pub fn to_triples(book: &Book) -> Vec<(Subject, NamedNode, Term)> {
    let mut triples = Vec::new();

    let bf_work = NamedNode::new("http://id.loc.gov/ontologies/bibframe/Work").unwrap();
    let bf_instance = NamedNode::new("http://id.loc.gov/ontologies/bibframe/Instance").unwrap();
    let rdf_type = NamedNode::new("http://www.w3.org/1999/02/22-rdf-syntax-ns#type").unwrap();
    let rdfs_label = NamedNode::new("http://www.w3.org/2000/01/rdf-schema#label").unwrap();
    let bf_title = NamedNode::new("http://id.loc.gov/ontologies/bibframe/title").unwrap();
    let bf_main_title = NamedNode::new("http://id.loc.gov/ontologies/bibframe/mainTitle").unwrap();
    let bf_instance_of =
        NamedNode::new("http://id.loc.gov/ontologies/bibframe/instanceOf").unwrap();
    let bf_contribution =
        NamedNode::new("http://id.loc.gov/ontologies/bibframe/contribution").unwrap();
    let bf_agent = NamedNode::new("http://id.loc.gov/ontologies/bibframe/agent").unwrap();
    let bf_role = NamedNode::new("http://id.loc.gov/ontologies/bibframe/role").unwrap();

    // Work URI
    // Eventually this will be reconciled against id.loc.gov or deterministic hash
    let work_node = NamedNode::new(format!("urn:spine:work:{}", book.id)).unwrap();
    let work_subj = Subject::NamedNode(work_node.clone());

    // Instance URI
    let instance_node = NamedNode::new(format!("urn:spine:instance:{}", book.id)).unwrap();
    let instance_subj = Subject::NamedNode(instance_node.clone());

    // --- Work Triples ---
    triples.push((
        work_subj.clone(),
        rdf_type.clone(),
        Term::NamedNode(bf_work.clone()),
    ));

    // Title
    let title_bn = BlankNode::default();
    triples.push((
        work_subj.clone(),
        bf_title.clone(),
        Term::BlankNode(title_bn.clone()),
    ));
    triples.push((
        Subject::BlankNode(title_bn.clone()),
        rdf_type.clone(),
        Term::NamedNode(NamedNode::new("http://id.loc.gov/ontologies/bibframe/Title").unwrap()),
    ));
    triples.push((
        Subject::BlankNode(title_bn.clone()),
        bf_main_title.clone(),
        Term::Literal(Literal::new_simple_literal(&book.title)),
    ));
    triples.push((
        work_subj.clone(),
        rdfs_label.clone(),
        Term::Literal(Literal::new_simple_literal(&book.title)),
    ));

    // Authors
    for author in &book.authors {
        let contrib_bn = BlankNode::default();
        let agent_bn = BlankNode::default();

        triples.push((
            work_subj.clone(),
            bf_contribution.clone(),
            Term::BlankNode(contrib_bn.clone()),
        ));
        triples.push((
            Subject::BlankNode(contrib_bn.clone()),
            rdf_type.clone(),
            Term::NamedNode(
                NamedNode::new("http://id.loc.gov/ontologies/bibframe/Contribution").unwrap(),
            ),
        ));
        triples.push((
            Subject::BlankNode(contrib_bn.clone()),
            bf_agent.clone(),
            Term::BlankNode(agent_bn.clone()),
        ));
        triples.push((
            Subject::BlankNode(contrib_bn.clone()),
            bf_role.clone(),
            Term::NamedNode(NamedNode::new("http://id.loc.gov/vocabulary/relators/aut").unwrap()),
        ));

        triples.push((
            Subject::BlankNode(agent_bn.clone()),
            rdf_type.clone(),
            Term::NamedNode(NamedNode::new("http://id.loc.gov/ontologies/bibframe/Agent").unwrap()),
        ));
        triples.push((
            Subject::BlankNode(agent_bn.clone()),
            rdfs_label.clone(),
            Term::Literal(Literal::new_simple_literal(author)),
        ));
    }

    // --- Instance Triples ---
    triples.push((
        instance_subj.clone(),
        rdf_type.clone(),
        Term::NamedNode(bf_instance.clone()),
    ));
    triples.push((
        instance_subj.clone(),
        bf_instance_of.clone(),
        Term::NamedNode(work_node.clone()),
    ));

    if let Some(pub_date) = &book.legacy_metadata.pub_date {
        let provision_bn = BlankNode::default();
        triples.push((
            instance_subj.clone(),
            NamedNode::new("http://id.loc.gov/ontologies/bibframe/provisionActivity").unwrap(),
            Term::BlankNode(provision_bn.clone()),
        ));
        triples.push((
            Subject::BlankNode(provision_bn.clone()),
            rdf_type.clone(),
            Term::NamedNode(
                NamedNode::new("http://id.loc.gov/ontologies/bibframe/ProvisionActivity").unwrap(),
            ),
        ));
        triples.push((
            Subject::BlankNode(provision_bn.clone()),
            NamedNode::new("http://id.loc.gov/ontologies/bibframe/date").unwrap(),
            Term::Literal(Literal::new_simple_literal(pub_date)),
        ));
    }

    if let Some(publisher) = &book.legacy_metadata.publisher {
        let provision_bn = BlankNode::default();
        triples.push((
            instance_subj.clone(),
            NamedNode::new("http://id.loc.gov/ontologies/bibframe/provisionActivity").unwrap(),
            Term::BlankNode(provision_bn.clone()),
        ));
        triples.push((
            Subject::BlankNode(provision_bn.clone()),
            rdf_type.clone(),
            Term::NamedNode(
                NamedNode::new("http://id.loc.gov/ontologies/bibframe/ProvisionActivity").unwrap(),
            ),
        ));

        let agent_bn = BlankNode::default();
        triples.push((
            Subject::BlankNode(provision_bn.clone()),
            bf_agent.clone(),
            Term::BlankNode(agent_bn.clone()),
        ));
        triples.push((
            Subject::BlankNode(agent_bn.clone()),
            rdf_type.clone(),
            Term::NamedNode(NamedNode::new("http://id.loc.gov/ontologies/bibframe/Agent").unwrap()),
        ));
        triples.push((
            Subject::BlankNode(agent_bn.clone()),
            rdfs_label.clone(),
            Term::Literal(Literal::new_simple_literal(publisher)),
        ));
    }

    triples
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use spine_api::{Book, LegacyMetadata};
    use uuid::Uuid;

    fn create_test_book(
        title: &str,
        authors: Vec<&str>,
        pub_date: Option<&str>,
        publisher: Option<&str>,
    ) -> Book {
        Book {
            id: Uuid::new_v4(),
            title: title.to_string(),
            authors: authors.into_iter().map(String::from).collect(),
            legacy_metadata: LegacyMetadata {
                publisher: publisher.map(String::from),
                pub_date: pub_date.map(String::from),
                series: None,
                series_index: None,
                tags: vec![],
                description: None,
                has_cover: false,
            },
            bibliographic_graph: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    // ----------------------------------------------------------------
    // to_triples_reconciled — ADR 015 §1 + §2 reconcile-first overlay
    // ----------------------------------------------------------------

    fn fresh_book() -> Book {
        Book {
            id: Uuid::new_v4(),
            title: "Reconcile Test".to_string(),
            authors: vec!["Test Author".to_string()],
            legacy_metadata: LegacyMetadata {
                publisher: Some("Tor".to_string()),
                pub_date: Some("2024".to_string()),
                series: None,
                series_index: None,
                tags: vec![],
                description: None,
                has_cover: false,
            },
            bibliographic_graph: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn to_triples_reconciled_matched_uses_loc_uri_with_locref_provenance() {
        let book = fresh_book();
        let work_match = ReconcileResolution::Matched {
            uri: "http://id.loc.gov/resources/works/12345".to_string(),
            confidence: None,
        };
        let inst_match = ReconcileResolution::Matched {
            uri: "http://id.loc.gov/resources/instances/12345".to_string(),
            confidence: None,
        };
        let triples = to_triples_reconciled(&book, &work_match, &inst_match, 1714000000000);

        assert!(triples.iter().any(|(s, p, o)| s
            == "http://id.loc.gov/resources/works/12345"
            && p == SPINE_URI_SOURCE
            && o == "locref"));
        assert!(triples.iter().any(|(s, p, o)| s
            == "http://id.loc.gov/resources/instances/12345"
            && p == SPINE_URI_SOURCE
            && o == "locref"));
        assert!(
            !triples.iter().any(|(_, p, _)| p == SPINE_RECONCILE_TIMEOUT_AT),
            "Matched outcome must NOT carry reconcileTimeoutAt"
        );
    }

    #[test]
    fn to_triples_reconciled_unmatched_mints_local_with_spinemint_no_marker() {
        let book = fresh_book();
        let res = ReconcileResolution::Unmatched;
        let triples = to_triples_reconciled(&book, &res, &res, 1714000000000);

        let book_id = book.id.to_string();
        assert!(triples.iter().any(|(s, p, o)| s == &format!("urn:spine:work:{book_id}")
            && p == SPINE_URI_SOURCE
            && o == "spinemint"));
        assert!(triples.iter().any(
            |(s, p, o)| s == &format!("urn:spine:instance:{book_id}")
                && p == SPINE_URI_SOURCE
                && o == "spinemint"
        ));
        assert!(
            !triples.iter().any(|(_, p, _)| p == SPINE_RECONCILE_TIMEOUT_AT),
            "Unmatched per ADR 015 §2 must NOT carry reconcileTimeoutAt"
        );
    }

    #[test]
    fn to_triples_reconciled_timed_out_mints_local_with_marker() {
        let book = fresh_book();
        let res = ReconcileResolution::TimedOut;
        let triples = to_triples_reconciled(&book, &res, &res, 1714000000000);

        let book_id = book.id.to_string();
        assert!(triples.iter().any(|(s, p, o)| s == &format!("urn:spine:work:{book_id}")
            && p == SPINE_URI_SOURCE
            && o == "spinemint"));
        let marker = triples
            .iter()
            .find(|(s, p, _)| {
                s == &format!("urn:spine:work:{book_id}") && p == SPINE_RECONCILE_TIMEOUT_AT
            })
            .expect("Work TimedOut must carry reconcileTimeoutAt");
        assert_eq!(marker.2, "1714000000000");
    }

    #[test]
    fn test_to_triples_basic() {
        let book = create_test_book("Test Book", vec![], None, None);
        let triples = to_triples(&book);

        // Expected basic triples:
        // 1 work type
        // 1 work title bn
        // 1 title bn type
        // 1 title bn mainTitle
        // 1 work rdfs:label
        // 1 instance type
        // 1 instance instanceOf
        assert_eq!(triples.len(), 7);
    }

    #[test]
    fn test_to_triples_with_authors() {
        let book = create_test_book("Test Book", vec!["Author One", "Author Two"], None, None);
        let triples = to_triples(&book);

        // 7 basic + (6 per author * 2) = 19
        assert_eq!(triples.len(), 19);

        // Verify authors exist in literals
        let author_one_exists = triples.iter().any(|(_, _, term)| {
            if let Term::Literal(l) = term {
                l.value() == "Author One"
            } else {
                false
            }
        });
        assert!(author_one_exists);
    }

    #[test]
    fn test_to_triples_with_publication_info() {
        let book = create_test_book(
            "Test Book",
            vec![],
            Some("2023-01-01"),
            Some("Test Publisher"),
        );
        let triples = to_triples(&book);

        // 7 basic + 3 (pub_date provisionActivity) + 5 (publisher provisionActivity + agent)
        assert_eq!(triples.len(), 15);

        // Verify pub date and publisher exist in literals
        let pub_date_exists = triples.iter().any(|(_, _, term)| {
            if let Term::Literal(l) = term {
                l.value() == "2023-01-01"
            } else {
                false
            }
        });
        assert!(pub_date_exists);

        let publisher_exists = triples.iter().any(|(_, _, term)| {
            if let Term::Literal(l) = term {
                l.value() == "Test Publisher"
            } else {
                false
            }
        });
        assert!(publisher_exists);
    }

    fn get_golden_record() -> Book {
        use spine_api::{AgentLink, AuthorityLink, BibliographicGraph, Instance, Work};
        let id = Uuid::nil(); // Consistent ID for Day One demo
        Book {
            id,
            title: "Frankenstein; or, The Modern Prometheus".to_string(),
            authors: vec!["Mary Wollstonecraft Shelley".to_string()],
            legacy_metadata: LegacyMetadata {
                publisher: Some("Lackington, Hughes, Harding, Mavor & Jones".to_string()),
                pub_date: Some("1818-01-01".to_string()),
                series: None,
                series_index: None,
                tags: vec!["Gothic fiction".to_string(), "Science fiction".to_string()],
                description: Some("Frankenstein; or, The Modern Prometheus is an 1818 novel written by Mary Shelley.".to_string()),
                has_cover: false,
            },
            bibliographic_graph: Some(BibliographicGraph {
                work_uri: "http://id.loc.gov/resources/works/16028517".to_string(),
                instance_uri: "http://id.loc.gov/resources/instances/1818-lackington-ed".to_string(),
                work: Work {
                    uri: "http://id.loc.gov/resources/works/16028517".to_string(),
                    title: None,
                    origin_date: Some("1818".to_string()),
                    subjects: vec![
                        AuthorityLink {
                            uri: "http://id.loc.gov/authorities/subjects/sh85008810".to_string(),
                            label: "Frankenstein's monster (Fictitious character)".to_string(),
                            source: "LCSH".to_string(),
                        },
                        AuthorityLink {
                            uri: "http://id.loc.gov/authorities/subjects/sh85001254".to_string(),
                            label: "Scientists".to_string(),
                            source: "LCSH".to_string(),
                        },
                    ],
                    creators: vec![
                        AgentLink {
                            uri: "http://id.loc.gov/authorities/names/n79061063".to_string(),
                            name: "Shelley, Mary Wollstonecraft".to_string(),
                            role: "creator".to_string(),
                        },
                    ],
                    language: None,
                    lccn: None,
                    ddc: None,
                },
                instances: vec![
                    Instance {
                        uri: "http://id.loc.gov/resources/instances/1818-lackington-ed".to_string(),
                        format: "EPUB".to_string(),
                        publication_date: Some("1818-01-01".to_string()),
                        publisher: None,
                        isbn: None,
                        oclc: None,
                    },
                    Instance {
                        uri: "http://id.loc.gov/resources/instances/1831-revised-ed".to_string(),
                        format: "PDF".to_string(),
                        publication_date: Some("1831-10-31".to_string()),
                        publisher: None,
                        isbn: None,
                        oclc: None,
                    },
                ],
            }),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn test_to_triples_golden_record() {
        let book = get_golden_record();
        let triples = to_triples(&book);

        // 7 basic + 6 (1 author) + 3 (pub date) + 5 (publisher) = 21
        assert_eq!(triples.len(), 21);
    }

    #[test]
    fn bibliographic_graph_round_trips_visible_fields() {
        let mut graph = get_golden_record().bibliographic_graph.unwrap();
        graph.work.title = Some("Frankenstein".to_string());
        graph.work.language = Some("eng".to_string());
        graph.work.lccn = Some("12001234".to_string());
        graph.work.ddc = Some("823.7".to_string());
        graph.instances[0].publisher = Some("Lackington".to_string());
        graph.instances[0].isbn = Some("9780000000000".to_string());
        graph.instances[0].oclc = Some("123456".to_string());
        let triples = bibliographic_graph_to_triples(&graph);
        let hydrated = triples_to_bibliographic_graph("book-1", &triples).unwrap();

        assert_eq!(hydrated.work.title, graph.work.title);
        assert_eq!(hydrated.work.origin_date, graph.work.origin_date);
        assert_eq!(hydrated.work.language, graph.work.language);
        assert_eq!(hydrated.work.lccn, graph.work.lccn);
        assert_eq!(hydrated.work.ddc, graph.work.ddc);
        assert_eq!(hydrated.work.creators.len(), graph.work.creators.len());
        assert_eq!(hydrated.work.creators[0].name, graph.work.creators[0].name);
        assert_eq!(hydrated.work.creators[0].role, graph.work.creators[0].role);
        assert_eq!(hydrated.work.subjects.len(), graph.work.subjects.len());
        assert_eq!(
            hydrated.work.subjects[0].label,
            graph.work.subjects[0].label
        );
        assert_eq!(hydrated.instances.len(), graph.instances.len());
        assert_eq!(
            hydrated.instances[0].publisher,
            graph.instances[0].publisher
        );
        assert_eq!(
            hydrated.instances[0].publication_date,
            graph.instances[0].publication_date
        );
        assert_eq!(hydrated.instances[0].isbn, graph.instances[0].isbn);
        assert_eq!(hydrated.instances[0].oclc, graph.instances[0].oclc);
    }

    #[test]
    fn blank_node_labels_are_graph_scoped() {
        use spine_api::{AgentLink, BibliographicGraph, Work};

        let make_graph = |work_uri: &str, author_name: &str, author_uri: &str| BibliographicGraph {
            work_uri: work_uri.to_string(),
            instance_uri: format!("{work_uri}/instance"),
            work: Work {
                uri: work_uri.to_string(),
                title: Some("T".to_string()),
                origin_date: None,
                subjects: vec![],
                creators: vec![AgentLink {
                    uri: author_uri.to_string(),
                    name: author_name.to_string(),
                    role: "creator".to_string(),
                }],
                language: None,
                lccn: None,
                ddc: None,
            },
            instances: vec![],
        };

        let graph_a = make_graph(
            "urn:spine:work:book-a",
            "Alice Author",
            "urn:spine:agent:alice",
        );
        let graph_b = make_graph(
            "urn:spine:work:book-b",
            "Bob Author",
            "urn:spine:agent:bob",
        );

        let triples_a = bibliographic_graph_to_triples(&graph_a);
        let triples_b = bibliographic_graph_to_triples(&graph_b);

        // Collect every blank-node subject emitted from each graph.
        let bn_subjects_a: HashSet<&str> = triples_a
            .iter()
            .map(|(s, _, _)| s.as_str())
            .filter(|s| s.starts_with("_:"))
            .collect();
        let bn_subjects_b: HashSet<&str> = triples_b
            .iter()
            .map(|(s, _, _)| s.as_str())
            .filter(|s| s.starts_with("_:"))
            .collect();

        assert!(!bn_subjects_a.is_empty(), "graph A emitted no blank nodes");
        assert!(!bn_subjects_b.is_empty(), "graph B emitted no blank nodes");

        // No blank-node label appears in both graphs: labels are graph-scoped.
        let overlap: Vec<&&str> = bn_subjects_a.intersection(&bn_subjects_b).collect();
        assert!(
            overlap.is_empty(),
            "blank-node labels collided across graphs: {overlap:?}"
        );

        // Hydrating book A's triples must not surface book B's author.
        let hydrated_a =
            triples_to_bibliographic_graph("book-a", &triples_a).expect("hydrate A");
        assert!(
            hydrated_a
                .work
                .creators
                .iter()
                .all(|c| c.name != "Bob Author"),
            "book A hydration leaked book B's author"
        );
        let hydrated_b =
            triples_to_bibliographic_graph("book-b", &triples_b).expect("hydrate B");
        assert!(
            hydrated_b
                .work
                .creators
                .iter()
                .all(|c| c.name != "Alice Author"),
            "book B hydration leaked book A's author"
        );
    }
}
