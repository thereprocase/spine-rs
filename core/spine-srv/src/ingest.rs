use crate::AppState;
use spine_bf::to_triples_reconciled;
use spine_bf::write::{
    InstanceCandidate, InstanceReconcilerExt, ReconcileResolution, WorkCandidate, WorkReconciler,
};
use spine_meta::epub::extract_epub_metadata;
use spine_meta::reconcile::BlockingLocReconciler;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("EPUB Extraction Error: {0}")]
    Extraction(#[from] spine_meta::epub::EpubError),
    #[error("Database Error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("I/O Error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SpineDB Error: {0}")]
    SpineDb(String),
    #[error("Calibre projection failed: {0}")]
    CalibreProjection(String),
}

/// Orchestrates the ingestion of an EPUB file into the Spine library.
/// Returns the UUID of the newly ingested book.
pub async fn ingest_epub(file_path: &Path, state: &AppState) -> Result<Uuid, IngestError> {
    // 1. Generate local UUID
    let book_id = Uuid::new_v4();

    // 2. Extract DC metadata from EPUB OPF
    let metadata = extract_epub_metadata(file_path)?;
    let preservation_triples = metadata.bibframe_preservation_triples(book_id);

    // 3. Map to intermediate Book struct
    let book = metadata.into_book(book_id);

    // 4. Reconcile-first hook (ADR 015 §1 + §2). Build candidates and
    //    consult LoC before any URI is minted; the resolutions feed the
    //    `to_triples_reconciled` overlay so the right URIs land with the
    //    right `spine:uriSource` / `spine:reconcileTimeoutAt` provenance.
    let work_candidate = WorkCandidate {
        title: book.title.clone(),
        authors: book.authors.clone(),
        isbn: None,
    };
    let instance_candidate = InstanceCandidate {
        format: "EPUB".to_string(),
        publication_date: book.legacy_metadata.pub_date.clone(),
        publisher: book.legacy_metadata.publisher.clone(),
        isbn: None,
        title: Some(book.title.clone()),
        reconcile_against_loc: true,
    };
    let (work_resolution, instance_resolution) =
        reconcile_for_ingest(state, work_candidate, instance_candidate).await?;

    let now_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut triples =
        to_triples_reconciled(&book, &work_resolution, &instance_resolution, now_epoch_ms);
    triples.extend(preservation_triples);

    let graph_uri = crate::graph_uri_for(&book_id);

    if let Some(paths) = state.db_paths.clone() {
        let library_path = {
            let lib = state.library.lock().await;
            lib.library_path().to_string()
        };
        let mut session = calibre_db::LibrarySession::open(&paths, library_path)
            .map_err(|e| IngestError::CalibreProjection(e.to_string()))?;
        session
            .insert_imported_epub_with_graph(&book, &graph_uri, &triples, file_path)
            .map_err(|e| IngestError::CalibreProjection(e.to_string()))?;
    } else {
        {
            let store = state.store.lock().await;
            store
                .insert_graph_triples(&graph_uri, &triples)
                .map_err(|e| IngestError::SpineDb(e.to_string()))?;
        }

        let projection = {
            let lib = state.library.lock().await;
            lib.insert_imported_epub(&book, file_path)
        };

        if let Err(e) = projection {
            let store = state.store.lock().await;
            if let Err(delete_err) = store.delete_graph(&graph_uri) {
                tracing::error!(
                    error = %delete_err,
                    graph = %graph_uri,
                    "rollback delete_graph failed after calibre projection error; graph is now orphaned"
                );
            }
            return Err(IngestError::CalibreProjection(e.to_string()));
        }
    }

    Ok(book_id)
}

/// Run the reconcile-first hook (ADR 015 §1) for a Work + Instance candidate.
/// Returns `(work_resolution, instance_resolution)` for the overlay caller.
///
/// If the AppState's LocClient is unavailable (init failed; `None`), both
/// resolutions are `Unmatched` — conformant with ADR 015 (the call was
/// "made"; LoC simply could not answer). Network errors are coerced to
/// `Unmatched` with a tracing warn; timeouts surface as `TimedOut`.
async fn reconcile_for_ingest(
    state: &AppState,
    work_candidate: WorkCandidate,
    instance_candidate: InstanceCandidate,
) -> Result<(ReconcileResolution, ReconcileResolution), IngestError> {
    let Some(loc_client) = state.get_or_init_loc_client().cloned() else {
        return Ok((ReconcileResolution::Unmatched, ReconcileResolution::Unmatched));
    };

    let resolutions = tokio::task::spawn_blocking(move || {
        let reconciler = BlockingLocReconciler::new(&loc_client);
        let work = WorkReconciler::reconcile_work(&reconciler, &work_candidate)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "Work reconcile failed; treating as Unmatched");
                ReconcileResolution::Unmatched
            });
        let instance = InstanceReconcilerExt::reconcile_with_resolution(
            &reconciler,
            &instance_candidate,
        )
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "Instance reconcile failed; treating as Unmatched");
            ReconcileResolution::Unmatched
        });
        (work, instance)
    })
    .await
    .map_err(|e| IngestError::SpineDb(format!("reconcile join failed: {e}")))?;

    Ok(resolutions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::LocalJobQueue;
    use calibre_db::CalibreLibrary;
    use rusqlite::Connection;
    use spine_db::SpineStore;
    use std::io::Write;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use zip::write::SimpleFileOptions;

    fn write_minimal_epub(path: &Path) {
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
        zip.write_all(
            br#"<?xml version="1.0"?>
<package>
  <metadata>
    <title>Rollback Test</title>
    <creator>Test Author</creator>
    <identifier>urn:test:rollback</identifier>
    <subject>Regression</subject>
    <description>Import path regression fixture.</description>
    <language>en</language>
  </metadata>
</package>"#,
        )
        .unwrap();

        zip.finish().unwrap();
    }

    fn create_calibre_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE books (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                sort TEXT,
                timestamp TEXT NOT NULL,
                pubdate TEXT,
                series_index REAL DEFAULT 1.0,
                author_sort TEXT,
                path TEXT NOT NULL DEFAULT '',
                uuid TEXT,
                has_cover INTEGER DEFAULT 0,
                last_modified TEXT NOT NULL
            );
            CREATE TABLE authors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                sort TEXT,
                link TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE books_authors_link (
                id INTEGER PRIMARY KEY,
                book INTEGER NOT NULL,
                author INTEGER NOT NULL
            );
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE books_tags_link (
                id INTEGER PRIMARY KEY,
                book INTEGER NOT NULL,
                tag INTEGER NOT NULL
            );
            CREATE TABLE publishers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                sort TEXT
            );
            CREATE TABLE books_publishers_link (
                id INTEGER PRIMARY KEY,
                book INTEGER NOT NULL,
                publisher INTEGER NOT NULL
            );
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY,
                book INTEGER NOT NULL,
                text TEXT NOT NULL
            );
            CREATE TABLE data (
                id INTEGER PRIMARY KEY,
                book INTEGER NOT NULL,
                format TEXT NOT NULL COLLATE NOCASE,
                uncompressed_size INTEGER NOT NULL,
                name TEXT NOT NULL
            );
            ",
        )
        .unwrap();
    }

    fn state_for_paths(calibre_path: &Path, spine_path: &Path, library_dir: &Path) -> AppState {
        let library = CalibreLibrary::open(calibre_path.to_str().unwrap()).unwrap();
        let store = SpineStore::open(spine_path.to_str().unwrap()).unwrap();
        let loc_cell = {
            let c = std::sync::OnceLock::new();
            c.set(Some(
                spine_meta::LocClient::with_base_url("http://localhost:0").unwrap(),
            ))
            .unwrap();
            std::sync::Arc::new(c)
        };
        AppState {
            library: Mutex::new(library),
            store: Mutex::new(store),
            db_paths: Some(calibre_db::DualDbPaths {
                calibre_db: calibre_path.to_string_lossy().into_owned(),
                spine_db: spine_path.to_string_lossy().into_owned(),
            }),
            loc_client: loc_cell,
            job_queue: Arc::new(LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            recent_libraries: Mutex::new(crate::RecentLibrariesState {
                recent: vec![],
                current: Some(library_dir.to_string_lossy().into_owned()),
            }),
        }
    }

    #[tokio::test]
    async fn rolls_back_graph_when_calibre_projection_fails() {
        let temp_dir = tempfile::tempdir().unwrap();
        let epub_path = temp_dir.path().join("rollback.epub");
        write_minimal_epub(&epub_path);

        let library = CalibreLibrary::open(":memory:").unwrap();
        let store = SpineStore::open(":memory:").unwrap();
        let loc_cell = {
            let c = std::sync::OnceLock::new();
            c.set(Some(
                spine_meta::LocClient::with_base_url("http://localhost:0").unwrap(),
            ))
            .unwrap();
            std::sync::Arc::new(c)
        };
        let state = AppState {
            library: Mutex::new(library),
            store: Mutex::new(store),
            db_paths: None,
            loc_client: loc_cell,
            job_queue: Arc::new(LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            recent_libraries: Mutex::new(crate::RecentLibrariesState::default()),
        };

        let result = ingest_epub(&epub_path, &state).await;
        assert!(matches!(result, Err(IngestError::CalibreProjection(_))));

        let store = state.store.lock().await;
        assert_eq!(store.count_triples().unwrap(), 0);
    }

    #[tokio::test]
    async fn file_backed_ingest_persists_graph_authors_and_epub_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let epub_path = temp_dir.path().join("import.epub");
        let calibre_path = temp_dir.path().join("metadata.db");
        let spine_path = temp_dir.path().join("spine.db");
        write_minimal_epub(&epub_path);
        create_calibre_db(&calibre_path);
        let state = state_for_paths(&calibre_path, &spine_path, temp_dir.path());

        let book_id = ingest_epub(&epub_path, &state).await.unwrap();

        let conn = Connection::open(&calibre_path).unwrap();
        let author: String = conn
            .query_row(
                "SELECT a.name FROM authors a \
                 JOIN books_authors_link l ON l.author = a.id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (book_path, format, name): (String, String, String) = conn
            .query_row(
                "SELECT b.path, d.format, d.name FROM books b JOIN data d ON d.book = b.id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let copied = temp_dir
            .path()
            .join(&book_path)
            .join(format!("{name}.epub"));

        assert_eq!(author, "Test Author");
        assert_eq!(format, "EPUB");
        assert!(copied.exists());

        let store = state.store.lock().await;
        let triples = store.get_triples(&crate::graph_uri_for(&book_id)).unwrap();
        assert!(triples.iter().any(|(_, p, o)| {
            p == "http://www.w3.org/1999/02/22-rdf-syntax-ns#value" && o == "urn:test:rollback"
        }));
        assert!(triples.iter().any(|(_, p, o)| {
            p == "http://www.w3.org/2000/01/rdf-schema#label" && o == "Regression"
        }));
    }
}
