//! Cross-database atomic write path.
//!
//! `LibrarySession` opens a single SQLite connection that holds both the
//! calibre `metadata.db` (as `calibre.*`) and `spine.db` (as `spine.*`) via
//! `ATTACH DATABASE`. A single `BEGIN IMMEDIATE` / `COMMIT` envelope around a
//! write enrolls both files in one transaction — SQLite commits the attached
//! database as part of the main commit, and rolls back both on any error.
//!
//! # Why Option A (ATTACH) and not a saga
//!
//! The instruction asked for Option A unless a concrete blocker surfaced.
//! None did:
//! - Both databases are plain SQLite 3 files with no conflicting pragmas.
//!   SQLite's cross-DB atomic commit requires **both** attached databases to
//!   use rollback-journal mode (`DELETE`). WAL mode breaks the two-file atomic
//!   commit guarantee: SQLite can atomically commit across multiple databases
//!   only via the older master-journal mechanism, which WAL bypasses.
//!
//!   **Important:** `journal_mode` is a per-file setting in SQLite (stored in
//!   the database header), not merely a per-connection setting. Setting it on
//!   one connection changes it for all future connections to that file.
//!   `CalibreLibrary::open` and `SpineStore::open` both force `DELETE` mode at
//!   open time so the files are always in a compatible state before a session
//!   ATTACHes them. `LibrarySession::open` re-asserts the mode here as a
//!   belt-and-suspenders guard (another process could flip the mode between
//!   SpineStore::open and LibrarySession::open) and errors out rather than
//!   proceeding with mismatched modes.
//!
//!   Performance note: all writes — not just cross-DB ones — now pay the
//!   rollback-journal overhead. See §7.5 in `docs/TECH_DEBT.md`. Trigger for
//!   revisit: bulk-ingest profiling.
//! - The attach + detach cycle is cheap (microseconds), so session lifetime
//!   matches a single write operation without meaningful overhead.
//! - Saga with compensating rollback would double the failure modes (what
//!   if the compensation fails?). Atomic commit across attached DBs is the
//!   native SQLite behavior; we are paying for ATTACH to buy it.
//!
//! # Contract with callers
//!
//! Both database files must already be initialized — calibre's schema (with
//! its triggers and collations) before this type sees the file, and spine.db
//! must have been opened at least once by `SpineStore::open` so the RDF
//! tables exist. `LibrarySession::open` does NOT call `setup_schema` on the
//! attached spine database; doing so via this connection would target the
//! `main` (calibre) schema by default. Run the normal `SpineStore::open(...)`
//! once at app startup; `LibrarySession` is for write-time dispatch only.
//!
//! # Concurrency
//!
//! This type is not `Send` across threads because rusqlite's `Connection`
//! isn't. Callers wrap it in `tokio::sync::Mutex` or construct a fresh
//! session per write inside `spawn_blocking`. Spine-srv builds sessions
//! on-demand, so this matches the existing pattern.

use rusqlite::{Connection, Error as RusqliteError, OptionalExtension, Result};
use spine_api::{BibliographicGraph, Book};
use spine_db::SpineStore;

use crate::{register_calibre_functions, BookUpdate, CalibreLibrary, DeletedBook};

/// File paths for the two SQLite databases a library uses. Stored as a
/// struct so a `LibrarySession` can be reopened after a commit without the
/// caller juggling two independent strings.
#[derive(Debug, Clone)]
pub struct DualDbPaths {
    pub calibre_db: String,
    pub spine_db: String,
}

pub struct LibrarySession {
    conn: Connection,
    library_path: String,
}

impl LibrarySession {
    /// Open a session over both databases. Attaches spine.db as `spine`,
    /// keeping calibre on the main schema so existing calibre SQL (triggers,
    /// prepared statements cached elsewhere) keeps working unchanged when it
    /// runs on this connection.
    ///
    /// Both databases are re-asserted into `DELETE` (rollback-journal) mode.
    /// `CalibreLibrary::open` and `SpineStore::open` already force this at
    /// their respective open calls; this re-assertion is a guard against a
    /// window where another process flipped the mode between those opens and
    /// this session open. Errors out rather than proceeding with mixed modes.
    /// See the module-level doc for details on why `journal_mode` is a
    /// per-file setting and why this matters for cross-DB atomicity.
    pub fn open(paths: &DualDbPaths, library_path: String) -> Result<Self> {
        // Reject paths containing null bytes before they reach SQLite's C API.
        // A null byte truncates the path silently in C, causing `open()` to
        // target a different file than the caller intended.
        if paths.calibre_db.contains('\0') || paths.spine_db.contains('\0') {
            return Err(RusqliteError::InvalidParameterName(
                "database path contains null byte".to_string(),
            ));
        }

        let conn = Connection::open(&paths.calibre_db)?;
        // The attached path has to be bound as a literal; rusqlite cannot
        // parameterize pragmas/DDL. Escape any embedded single quote the user
        // may have in a library path (rare but not impossible on some macOS
        // setups that live under "Books' Library/").
        let escaped = paths.spine_db.replace('\'', "''");
        conn.execute_batch(&format!("ATTACH DATABASE '{}' AS spine", escaped))?;

        // Re-assert rollback-journal mode on both attached schemas and verify.
        // This guards against a race where another process flipped either file
        // back to WAL between SpineStore/CalibreLibrary::open and now. If we
        // cannot confirm DELETE mode we must not proceed — a cross-DB COMMIT
        // under mixed journal modes is not atomic.
        conn.execute_batch(
            "PRAGMA main.journal_mode = DELETE; PRAGMA spine.journal_mode = DELETE;",
        )?;
        let main_mode: String = conn.query_row("PRAGMA main.journal_mode", [], |r| r.get(0))?;
        if main_mode != "delete" && main_mode != "memory" {
            return Err(RusqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::CannotOpen,
                    extended_code: 0,
                },
                Some(format!(
                    "calibre db journal_mode is '{}' after PRAGMA; expected 'delete'. \
                     Another process may have this file open in WAL mode.",
                    main_mode
                )),
            ));
        }
        let spine_mode: String = conn.query_row("PRAGMA spine.journal_mode", [], |r| r.get(0))?;
        if spine_mode != "delete" && spine_mode != "memory" {
            return Err(RusqliteError::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::CannotOpen,
                    extended_code: 0,
                },
                Some(format!(
                    "spine db journal_mode is '{}' after PRAGMA; expected 'delete'. \
                     Another process may have this file open in WAL mode.",
                    spine_mode
                )),
            ));
        }

        // Calibre triggers depend on title_sort() and uuid4() — register them
        // on this fresh connection too. Without this the first UPDATE that
        // fires a calibre trigger will raise "no such function".
        register_calibre_functions(&conn)?;
        Ok(Self { conn, library_path })
    }

    /// Apply a metadata update to both BIBFRAME graph (spine.db) and calibre
    /// projection (metadata.db) in a single cross-DB transaction. Rolls back
    /// both on any error.
    ///
    /// The BIBFRAME graph is always rewritten (even when `projection` is
    /// empty) so graph-only edits — e.g. LoC reconcile that changes URIs but
    /// not any surface field — still travel through the atomic envelope.
    pub fn apply_metadata_update(
        &mut self,
        book_uuid: &str,
        graph: &BibliographicGraph,
        projection: &BookUpdate,
    ) -> Result<()> {
        let graph_uri = graph_uri_for_uuid(book_uuid);
        let triples = spine_bf::bibliographic_graph_to_triples(graph);

        // `unchecked_transaction` opens a DEFERRED transaction. SQLite
        // upgrades the lock on the first write against either the main
        // (calibre) or attached (spine) database, and COMMIT enrolls both
        // atomically. The AppState Mutex around this type prevents a
        // second writer from racing, so DEFERRED is safe.
        let tx = self.conn.unchecked_transaction()?;

        SpineStore::replace_graph_tx_with_prefix(&tx, "spine.", &graph_uri, &triples)?;

        if !projection.is_empty() {
            CalibreLibrary::update_book_tx(&tx, "", book_uuid, projection)?;
        }

        tx.commit()
    }

    /// Insert a newly imported EPUB into the canonical graph store and the
    /// calibre-compatible import/export surface in one cross-DB transaction.
    /// The source EPUB is copied into the library layout before commit so the
    /// reader/export paths resolve immediately after ingest.
    pub fn insert_imported_epub_with_graph(
        &mut self,
        book: &Book,
        graph_uri: &str,
        triples: &[(String, String, String)],
        source_path: &std::path::Path,
    ) -> Result<crate::ProjectionResult> {
        let tx = self.conn.unchecked_transaction()?;
        SpineStore::replace_graph_tx_with_prefix(&tx, "spine.", graph_uri, triples)?;
        let result = CalibreLibrary::insert_book_tx(
            &tx,
            "",
            Some(std::path::Path::new(&self.library_path)),
            book,
            Some(source_path),
        )?;
        tx.commit()?;
        Ok(result)
    }

    /// Delete a book from both databases in a single transaction, then
    /// optionally remove its on-disk folder. The file removal runs only
    /// after the DB commit succeeds — a mid-delete crash leaves an orphan
    /// directory the next `check_library` sweep can clean up, rather than
    /// a dangling DB row pointing at files that were already erased.
    pub fn delete_book_with_graph(
        &mut self,
        book_uuid: &str,
        delete_files: bool,
    ) -> Result<DeletedBook> {
        let graph_uri = graph_uri_for_uuid(book_uuid);

        // Snapshot the path before the delete so we can still report it
        // (and optionally walk it on disk) after the row disappears.
        let path: String =
            self.conn
                .query_row("SELECT path FROM books WHERE uuid = ?", [book_uuid], |r| {
                    r.get(0)
                })?;

        {
            let tx = self.conn.unchecked_transaction()?;
            SpineStore::delete_graph_tx_with_prefix(&tx, "spine.", &graph_uri)?;
            CalibreLibrary::delete_book_rows_tx(&tx, "", book_uuid)?;
            tx.commit()?;
        }

        let mut deleted_files = Vec::new();
        let mut failed_file_deletes: Vec<(std::path::PathBuf, String)> = Vec::new();
        if delete_files {
            if let Some(abs_dir) =
                crate::safe_join_dir(std::path::Path::new(&self.library_path), &path)
            {
                if abs_dir.exists() {
                    // Reject if the book directory itself is a symlink. Spine
                    // creates regular directories for books; a symlink in that
                    // position is anomalous and must be treated as tampering.
                    // Deleting through a symlink could affect files outside the
                    // library root, which is never the user's intent.
                    let is_symlink = std::fs::symlink_metadata(&abs_dir)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);
                    if is_symlink {
                        tracing::warn!(
                            path = %abs_dir.display(),
                            "delete_book_with_graph: book directory is a symlink; \
                             skipping disk removal to avoid out-of-tree deletion"
                        );
                    } else {
                        // Canonicalize the resolved target and verify it is
                        // under the library root. Since abs_dir is not a
                        // symlink, canonicalize resolves any symlinks in
                        // *parent* directories while keeping abs_dir itself
                        // a real path.
                        let canonical_ok = std::fs::canonicalize(&abs_dir)
                            .map(|canon| {
                                canon.starts_with(
                                    std::fs::canonicalize(&self.library_path).unwrap_or_else(
                                        |_| std::path::PathBuf::from(&self.library_path),
                                    ),
                                )
                            })
                            .unwrap_or(false);

                        if !canonical_ok {
                            tracing::warn!(
                                path = %abs_dir.display(),
                                "delete_book_with_graph: path escapes library root after \
                                 canonicalize; skipping disk removal"
                            );
                        } else {
                            // Delete files individually so partial failures are
                            // reported rather than silently discarded. Try the
                            // directory removal last.
                            crate::delete_files_individually(
                                &abs_dir,
                                &mut deleted_files,
                                &mut failed_file_deletes,
                            );
                            if !failed_file_deletes.is_empty() {
                                for (fp, err) in &failed_file_deletes {
                                    tracing::warn!(
                                        path = %fp.display(),
                                        error = %err,
                                        "failed to delete book file; DB rows already gone"
                                    );
                                }
                            }
                            // Remove the (now hopefully empty) directory. If any
                            // files failed above, this will fail too — log and
                            // continue rather than error, because the DB commit
                            // already happened.
                            if let Err(e) = std::fs::remove_dir(&abs_dir) {
                                tracing::warn!(
                                    path = %abs_dir.display(),
                                    error = %e,
                                    "failed to remove book directory from disk; DB rows already gone"
                                );
                            }
                        }
                    }
                }
            }
        }

        Ok(DeletedBook {
            uuid: book_uuid.to_string(),
            path,
            deleted_files,
            failed_file_deletes: failed_file_deletes
                .into_iter()
                .map(|(p, e)| (p.to_string_lossy().into_owned(), e))
                .collect(),
        })
    }

    /// Returns a read-only handle to the underlying connection. Exposed for
    /// tests that want to verify post-commit state across both databases
    /// without reopening the files.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Check whether a book with the given uuid still exists in calibre.
    pub fn book_exists(&self, book_uuid: &str) -> Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row("SELECT id FROM books WHERE uuid = ?", [book_uuid], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(found.is_some())
    }

    /// Returns the graph URI currently used by spine-srv for a book UUID.
    /// Exposed here so session callers don't need to redeclare the scheme.
    pub fn graph_uri_for(book_uuid: &str) -> String {
        graph_uri_for_uuid(book_uuid)
    }
}

/// The graph-URI scheme used by `spine-srv::graph_uri_for`. Duplicated here
/// so `calibre-db` doesn't pull in `spine-srv`, which would invert the
/// dependency direction. If this scheme ever changes, update both places
/// (and add a migration).
fn graph_uri_for_uuid(book_uuid: &str) -> String {
    format!("urn:spine:graph:book:{}", book_uuid)
}
