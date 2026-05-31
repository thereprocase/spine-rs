//! Criterion bench harness for the spine-bf write hot paths.
//!
//! Closes item W1 from the Sprint 8 code review of the perf baseline
//! (internal design notes): the synth harness used to derive the
//! baseline numbers was a throwaway sqlite3 CLI script, leaving the doc
//! non-rerunnable as a CI regression gate. This file is the rerunnable form.
//!
//! Workload shape:
//!   * Each bench seeds a fresh in-memory `SpineStore` with a single
//!     bf:Work + rdfs:label, then runs ONE write call per iteration.
//!   * `iter_batched(.., BatchSize::SmallInput)` keeps the seed cost outside
//!     the timing window so we measure the write call itself, not the
//!     per-iter SpineStore construction.
//!   * `AlwaysUnmatched` from `spine-bf::write` provides the reconciler
//!     stub; for `Lcsh` source this exercises the partial-mint path
//!     (`urn:spine:subject:lcsh:<uuid>` + `reconcileTimeoutAt`); for
//!     `LocalTag` the reconciler isn't called at all (covers the cheapest
//!     write path).
//!
//! Invocation:
//!   cargo bench -p spine-bf --bench write_paths
//!
//! Quick smoke:
//!   cargo bench -p spine-bf --bench write_paths -- \
//!       --warm-up-time 1 --measurement-time 2 --sample-size 20
//!
//! Sprint 19 entry can pin thresholds + add a CI gate; today this just
//! gives reproducible numbers.
//!
//! Indicative measurements (Linux 6.6 / WSL2, dev laptop, NVMe;
//! `--warm-up-time 1 --measurement-time 2 --sample-size 20`):
//!
//!   add_subject local-tag (no reconcile)              : 135 µs
//!   add_subject lcsh (AlwaysUnmatched -> partial mint): 134 µs
//!   add_instance no-reconcile                         : 117 µs
//!   add_instance reconcile (AlwaysUnmatched -> partial): 129 µs
//!
//! These are 10-15× faster than the conservative 1.5-2.0 ms estimate in
//! the 2026-04-25 baseline doc — the doc's Rust-stack 2× multiplier was
//! far too pessimistic. Real per-call cost is ~100-150 µs end-to-end on
//! :memory: spine.db; for a 1500-book batch ingest at ~6 calls/book the
//! pure spine-bf budget is ~1.2 s, not the doc's ~14 s estimate.
//! Hardware-pinned thresholds belong in Sprint 19 alongside the CI gate.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use spine_bf::write::{
    add_instance, add_subject, AlwaysUnmatched, InstanceCandidate, ProvenanceContext,
    SubjectSource,
};
use spine_db::SpineStore;
use uuid::Uuid;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_LABEL: &str = "http://www.w3.org/2000/01/rdf-schema#label";
const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";

/// Open an in-memory SpineStore and seed a single bf:Work into the
/// per-book named graph. Returns the store, the book-uuid (== work-uuid
/// per the spine-srv `parse_book_uuid` convention), and a default
/// ProvenanceContext.
fn fresh_state_with_seeded_work() -> (SpineStore, Uuid, ProvenanceContext) {
    let store = SpineStore::open(":memory:").expect("open in-memory spine.db");
    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let triples: Vec<(String, String, String)> = vec![
        (
            work_uri.clone(),
            RDF_TYPE.to_string(),
            BF_WORK.to_string(),
        ),
        (work_uri, RDFS_LABEL.to_string(), "Bench Work".to_string()),
    ];
    store
        .replace_graph(&graph_uri, &triples)
        .expect("seed work graph");
    (store, book_uuid, ProvenanceContext::default())
}

fn bench_add_subject_local_tag(c: &mut Criterion) {
    c.bench_function("add_subject local-tag (no reconcile)", |b| {
        b.iter_batched(
            fresh_state_with_seeded_work,
            |(store, work_uuid, ctx)| {
                add_subject(
                    &store,
                    &AlwaysUnmatched,
                    &work_uuid,
                    "fiction",
                    SubjectSource::LocalTag,
                    &ctx,
                )
                .expect("add_subject local-tag must succeed")
            },
            BatchSize::SmallInput,
        );
    });
}

fn bench_add_subject_lcsh_unmatched(c: &mut Criterion) {
    c.bench_function("add_subject lcsh (AlwaysUnmatched -> partial mint)", |b| {
        b.iter_batched(
            fresh_state_with_seeded_work,
            |(store, work_uuid, ctx)| {
                add_subject(
                    &store,
                    &AlwaysUnmatched,
                    &work_uuid,
                    "Cyberpunk fiction",
                    SubjectSource::Lcsh,
                    &ctx,
                )
                .expect("add_subject lcsh-unmatched must succeed")
            },
            BatchSize::SmallInput,
        );
    });
}

fn bench_add_instance_no_reconcile(c: &mut Criterion) {
    c.bench_function("add_instance no-reconcile", |b| {
        b.iter_batched(
            fresh_state_with_seeded_work,
            |(store, work_uuid, ctx)| {
                let mut candidate = InstanceCandidate::default();
                candidate.format = "epub".to_string();
                candidate.reconcile_against_loc = false;
                add_instance(&store, &AlwaysUnmatched, &work_uuid, candidate, &ctx)
                    .expect("add_instance no-reconcile must succeed")
            },
            BatchSize::SmallInput,
        );
    });
}

fn bench_add_instance_reconcile_unmatched(c: &mut Criterion) {
    c.bench_function(
        "add_instance reconcile (AlwaysUnmatched -> partial mint)",
        |b| {
            b.iter_batched(
                fresh_state_with_seeded_work,
                |(store, work_uuid, ctx)| {
                    let mut candidate = InstanceCandidate::default();
                    candidate.format = "epub".to_string();
                    candidate.title = Some("Bench Title".to_string());
                    candidate.reconcile_against_loc = true;
                    add_instance(&store, &AlwaysUnmatched, &work_uuid, candidate, &ctx)
                        .expect("add_instance reconcile-unmatched must succeed")
                },
                BatchSize::SmallInput,
            );
        },
    );
}

// ---------------------------------------------------------------------------
// Sprint 19 item #2 — get_or_create_term inner-loop cost on replace_graph
// ---------------------------------------------------------------------------
//
// Question: every `add_subject` / `add_instance` writes a triple set through
// `SpineStore::replace_graph`, which calls `get_or_create_term_tx(s/p/o)` for
// every triple. Each call does INSERT OR IGNORE + SELECT (two prepared-cached
// SQL statements). For a 50-triple book graph that's 100+ statements just for
// dictionary lookups — but most of the predicate URIs (rdf:type, rdfs:label,
// the BIBFRAME predicate set) are RECURRING across every write, so SQLite's
// terms table is hot after the first few calls.
//
// `_cold_vocabulary` benches mint a fresh store per iter — every term lookup
// pays the INSERT-OR-IGNORE-then-SELECT round-trip; this is the
// `iter_batched` baseline above, restated as a paired contrast.
//
// `_warm_vocabulary` benches reuse one store across all iterations via
// `iter_custom`. The first `add_subject` call populates the terms table with
// every BIBFRAME predicate URI; subsequent calls only mint the per-call UUID
// URN and timestamp literal as NEW term values. This matches the production
// reality of a long-lived `spine.db` past the first few writes.
//
// If warm is materially faster than cold, an in-process LRU on the
// connection (HashMap<String, i64>) for the recurring vocab would convert
// 2 round-trips per known term into a memory hit. If they're close, the
// SQLite B-tree probe is already the floor and a cache adds complexity for
// no win.

fn bench_add_subject_local_tag_warm_vocabulary(c: &mut Criterion) {
    c.bench_function(
        "add_subject local-tag (warm vocab — persistent store across iters)",
        |b| {
            b.iter_custom(|iters| {
                let (store, book_uuid, ctx) = fresh_state_with_seeded_work();
                // Pre-warm: populate the terms table with every BIBFRAME
                // predicate URI add_subject writes. After this single call,
                // only the per-iter UUID URN + timestamp literal will be
                // genuinely new terms.
                add_subject(
                    &store,
                    &AlwaysUnmatched,
                    &book_uuid,
                    "warmup",
                    SubjectSource::LocalTag,
                    &ctx,
                )
                .expect("warm-up add_subject must succeed");

                let start = Instant::now();
                for _ in 0..iters {
                    add_subject(
                        &store,
                        &AlwaysUnmatched,
                        &book_uuid,
                        "fiction",
                        SubjectSource::LocalTag,
                        &ctx,
                    )
                    .expect("add_subject warm-vocab iter must succeed");
                }
                start.elapsed()
            });
        },
    );
}

fn bench_add_subject_lcsh_warm_vocabulary(c: &mut Criterion) {
    c.bench_function(
        "add_subject lcsh-unmatched (warm vocab — persistent store)",
        |b| {
            b.iter_custom(|iters| {
                let (store, book_uuid, ctx) = fresh_state_with_seeded_work();
                add_subject(
                    &store,
                    &AlwaysUnmatched,
                    &book_uuid,
                    "warmup",
                    SubjectSource::Lcsh,
                    &ctx,
                )
                .expect("warm-up add_subject lcsh must succeed");

                let start = Instant::now();
                for _ in 0..iters {
                    add_subject(
                        &store,
                        &AlwaysUnmatched,
                        &book_uuid,
                        "Cyberpunk fiction",
                        SubjectSource::Lcsh,
                        &ctx,
                    )
                    .expect("add_subject lcsh warm-vocab iter must succeed");
                }
                start.elapsed()
            });
        },
    );
}

// ---------------------------------------------------------------------------
// Sprint 19 item #4 — Mutex<SpineStore> contention under concurrent writes
// ---------------------------------------------------------------------------
//
// `core/spine-srv/src/lib.rs:62` exposes `pub store: Mutex<SpineStore>` —
// every spine-srv handler that touches the triple store goes through that
// single mutex. Under burst-import (1500-book scrape, multi-tab UI hammering
// add_subject, etc.) every concurrent writer serializes here.
//
// These benches measure the realistic per-call latency when N threads hold
// `Arc<Mutex<SpineStore>>` and call `add_subject` in a tight loop. Compare
// against the single-threaded `add_subject local-tag (no reconcile)` baseline
// (~135 µs); the per-call cost should rise toward N×135 µs as threads
// perfectly serialize through the mutex, plus lock-acquisition overhead.
//
// Two contention shapes:
//
// - `same-graph` — all N threads target the same book/graph. SQLite-level
//   contention (B-tree page locks inside the per-call transaction) stacks on
//   top of the Rust-level Mutex serialization.
// - `diff-graphs` — each thread owns a distinct book/graph. The Mutex still
//   serializes Rust-side, but SQLite has no row-level contention because
//   writes hit different graph_id rows. Isolates pure mutex overhead from
//   SQLite contention.
//
// If diff-graphs ≈ N × single-threaded, the mutex is the entire ceiling and a
// finer-grained scheme (per-graph mutex, sharded connection pool, or just
// dropping the lock during compute and reacquiring for the SQL call) would
// unlock parallelism. If same-graph >> diff-graphs, SQLite-side contention is
// the next layer below the mutex.

fn seed_book_graph(store: &SpineStore) -> Uuid {
    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    store
        .replace_graph(
            &graph_uri,
            &[
                (
                    work_uri.clone(),
                    RDF_TYPE.to_string(),
                    BF_WORK.to_string(),
                ),
                (work_uri, RDFS_LABEL.to_string(), "Bench Work".to_string()),
            ],
        )
        .expect("seed work graph");
    book_uuid
}

fn bench_add_subject_concurrent_same_graph(c: &mut Criterion) {
    c.bench_function(
        "add_subject local-tag (4 threads, same graph — Mutex<SpineStore> + SQLite contention)",
        |b| {
            b.iter_custom(|iters| {
                const N: u64 = 4;
                let store = SpineStore::open(":memory:").expect("open in-memory spine.db");
                let book_uuid = seed_book_graph(&store);
                let store = Arc::new(Mutex::new(store));

                let per_thread = (iters / N).max(1);
                let mut handles = Vec::with_capacity(N as usize);
                let start = Instant::now();
                for _ in 0..N {
                    let store = Arc::clone(&store);
                    handles.push(thread::spawn(move || {
                        let ctx = ProvenanceContext::default();
                        for _ in 0..per_thread {
                            let s = store.lock().expect("mutex poisoned");
                            add_subject(
                                &*s,
                                &AlwaysUnmatched,
                                &book_uuid,
                                "fiction",
                                SubjectSource::LocalTag,
                                &ctx,
                            )
                            .expect("add_subject same-graph contention iter must succeed");
                        }
                    }));
                }
                for h in handles {
                    h.join().expect("thread panicked");
                }
                start.elapsed()
            });
        },
    );
}

fn bench_add_subject_concurrent_diff_graphs(c: &mut Criterion) {
    c.bench_function(
        "add_subject local-tag (4 threads, distinct graphs — Mutex<SpineStore> only)",
        |b| {
            b.iter_custom(|iters| {
                const N: u64 = 4;
                let store = SpineStore::open(":memory:").expect("open in-memory spine.db");
                let mut book_uuids = Vec::with_capacity(N as usize);
                for _ in 0..N {
                    book_uuids.push(seed_book_graph(&store));
                }
                let store = Arc::new(Mutex::new(store));

                let per_thread = (iters / N).max(1);
                let mut handles = Vec::with_capacity(N as usize);
                let start = Instant::now();
                for t in 0..N as usize {
                    let store = Arc::clone(&store);
                    let book_uuid = book_uuids[t];
                    handles.push(thread::spawn(move || {
                        let ctx = ProvenanceContext::default();
                        for _ in 0..per_thread {
                            let s = store.lock().expect("mutex poisoned");
                            add_subject(
                                &*s,
                                &AlwaysUnmatched,
                                &book_uuid,
                                "fiction",
                                SubjectSource::LocalTag,
                                &ctx,
                            )
                            .expect("add_subject diff-graphs contention iter must succeed");
                        }
                    }));
                }
                for h in handles {
                    h.join().expect("thread panicked");
                }
                start.elapsed()
            });
        },
    );
}

fn bench_add_subject_single_threaded_through_mutex(c: &mut Criterion) {
    c.bench_function(
        "add_subject local-tag (1 thread, through Arc<Mutex> — isolates lock overhead)",
        |b| {
            b.iter_custom(|iters| {
                let store = SpineStore::open(":memory:").expect("open in-memory spine.db");
                let book_uuid = seed_book_graph(&store);
                let store = Arc::new(Mutex::new(store));
                let ctx = ProvenanceContext::default();

                let start = Instant::now();
                for _ in 0..iters {
                    let s = store.lock().expect("mutex poisoned");
                    add_subject(
                        &*s,
                        &AlwaysUnmatched,
                        &book_uuid,
                        "fiction",
                        SubjectSource::LocalTag,
                        &ctx,
                    )
                    .expect("add_subject through-mutex iter must succeed");
                }
                start.elapsed()
            });
        },
    );
}

criterion_group!(
    write_paths,
    bench_add_subject_local_tag,
    bench_add_subject_lcsh_unmatched,
    bench_add_instance_no_reconcile,
    bench_add_instance_reconcile_unmatched,
    bench_add_subject_local_tag_warm_vocabulary,
    bench_add_subject_lcsh_warm_vocabulary,
    bench_add_subject_single_threaded_through_mutex,
    bench_add_subject_concurrent_same_graph,
    bench_add_subject_concurrent_diff_graphs,
);
criterion_main!(write_paths);
