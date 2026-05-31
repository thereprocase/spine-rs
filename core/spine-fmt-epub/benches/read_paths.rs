//! Criterion bench harness for `spine_fmt_epub::read_epub`.
//!
//! Sprint 14 perf scaffold. Locks per-call cost for
//! the EPUB → OebBook IR reader before Sprint 15's writer doubles the
//! surface (read + write) and Sprint 16's AZW3 work doubles it again
//! (EPUB read + AZW3 read + EPUB write + AZW3 write).
//!
//! Workload shape (matches `core/spine-bf/benches/write_paths.rs`):
//!   * `iter_batched(.., BatchSize::SmallInput)` keeps any per-iter setup
//!     out of the timing window.
//!   * Fixtures live in `benches/fixtures/` and are committed bytes — no
//!     network, no synthesis, byte-identical across runs.
//!
//! Invocation:
//!   cargo bench -p spine-fmt-epub --bench read_paths
//!
//! Quick smoke (matches workspace baseline config):
//!   cargo bench -p spine-fmt-epub --bench read_paths -- \
//!       --warm-up-time 1 --measurement-time 2 --sample-size 20
//!
//! Adding a new fixture:
//!   1. Drop the .epub into `benches/fixtures/`.
//!   2. Add a `bench_read_epub_*` function below following the pattern.
//!   3. Register the new bench in the `criterion_group!` block.
//!   4. Add a baseline + ceiling entry to `benches/baseline.json` (or mark
//!      `informational: true` if the fixture is too noisy for a gate).
//!   5. See `benches/fixtures/README.md` for fixture-shape guidance.

use std::path::PathBuf;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use spine_fmt_epub::read_epub;
use spine_oeb::SourceProfile;

/// Resolve a fixture path relative to the bench binary's source directory.
/// `CARGO_MANIFEST_DIR` is set by cargo at build time and points at the
/// crate root (`core/spine-fmt-epub/`), so the fixtures dir is always
/// `<crate>/benches/fixtures/<name>` regardless of where `cargo bench`
/// was invoked from.
fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("benches")
        .join("fixtures")
        .join(name)
}

fn bench_read_epub_small_strict(c: &mut Criterion) {
    let path = fixture("small.epub");
    assert!(
        path.exists(),
        "missing fixture: {} (see benches/fixtures/README.md)",
        path.display()
    );
    c.bench_function("read_epub small (Strict — no fixers)", |b| {
        b.iter_batched(
            || path.clone(),
            |p| read_epub(&p, Some(SourceProfile::Strict)).expect("read_epub small Strict"),
            BatchSize::SmallInput,
        );
    });
}

fn bench_read_epub_small_pg(c: &mut Criterion) {
    let path = fixture("small.epub");
    assert!(
        path.exists(),
        "missing fixture: {} (see benches/fixtures/README.md)",
        path.display()
    );
    c.bench_function(
        "read_epub small (ProjectGutenberg — full fixer chain)",
        |b| {
            b.iter_batched(
                || path.clone(),
                |p| {
                    read_epub(&p, Some(SourceProfile::ProjectGutenberg))
                        .expect("read_epub small ProjectGutenberg")
                },
                BatchSize::SmallInput,
            );
        },
    );
}

criterion_group!(
    read_paths,
    bench_read_epub_small_strict,
    bench_read_epub_small_pg,
);
criterion_main!(read_paths);
