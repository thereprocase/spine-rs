use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use serde::{Deserialize, Serialize};
use spine_api::{Book, LegacyMetadata};
use uuid::Uuid;

pub mod session;
pub use session::{DualDbPaths, LibrarySession};

/// Sprint 8.5 hot-fix: typed errors from `CalibreLibrary::open` so the
/// surface above (the `/api/v1/library/open` handler) can return clean
/// 4xx with actionable copy instead of 500-with-stringified-sqlite.
///
/// `Uninitialized` and `WrongDatabaseFile` are distinguished by table
/// presence + the calibre-signature `book` foreign-key column:
///
/// - 0 tables → `Uninitialized` (empty file, never touched).
/// - `books` table present → success (return `Ok(Self)`).
/// - `books` missing, but some other table carries a `book` FK column
///   (calibre's distinctive shape) → `Uninitialized` (partial init).
/// - `books` missing AND no table has a `book` column → `WrongDatabaseFile`.
///
/// `Sqlite` wraps the underlying rusqlite error for everything else
/// (file-not-found, locked, corrupted, IO failure, …) so callers can
/// still pattern-match by category.
#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("calibre library at '{path}' is uninitialized — open the folder once with calibre to populate the schema")]
    Uninitialized { path: String },
    #[error("'{path}' is a SQLite database but not a calibre library — pick a different file or open it with calibre first")]
    WrongDatabaseFile { path: String },
    #[error("SQLite error opening '{path}': {source}")]
    Sqlite {
        path: String,
        #[source]
        source: rusqlite::Error,
    },
}

impl LibraryError {
    fn from_sqlite(path: &str, source: rusqlite::Error) -> Self {
        Self::Sqlite {
            path: path.to_string(),
            source,
        }
    }
}

pub struct CalibreLibrary {
    conn: Connection,
    library_path: String,
    metadata_db_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionResult {
    pub book_id: i64,
    pub path: String,
}

/// Partial update to the calibre projection of a book. Any field left as
/// `None` means "leave unchanged". For nullable fields (`series`, `pubdate`,
/// `publisher`) the outer `Some` with inner `None` means "clear".
///
/// Collection fields (`authors`, `tags`, `languages`) use replace-full-set
/// semantics when `Some`: the existing link rows are deleted and rebuilt from
/// the supplied list. `None` leaves them untouched.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookUpdate {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub series: Option<Option<String>>,
    pub series_index: Option<f64>,
    pub pubdate: Option<Option<DateTime<Utc>>>,
    pub publisher: Option<Option<String>>,
    pub languages: Option<Vec<String>>,
}

impl BookUpdate {
    /// True if no field is set — used by `apply_metadata_update` to short-
    /// circuit the calibre projection when the caller only wants to rewrite
    /// the graph (e.g. authority reconcile that didn't change any surface
    /// field). The cross-DB transaction still runs so graph-only writes are
    /// still atomic with the (no-op) calibre leg.
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.authors.is_none()
            && self.tags.is_none()
            && self.series.is_none()
            && self.series_index.is_none()
            && self.pubdate.is_none()
            && self.publisher.is_none()
            && self.languages.is_none()
    }
}

/// Descriptor of a book removed from the library. Returned by `delete_book`
/// and `delete_book_with_graph` so callers can tell the user exactly what
/// disappeared from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedBook {
    pub uuid: String,
    /// Relative path from the library root, as it was stored in `books.path`.
    pub path: String,
    /// Absolute paths of files that were successfully removed from disk. Empty
    /// when the caller passed `delete_files = false`.
    pub deleted_files: Vec<String>,
    /// Files that could not be removed. Each entry is `(path, error_message)`.
    /// The DB commit already happened when these are populated; the caller
    /// should surface them as warnings rather than errors.
    #[serde(default)]
    pub failed_file_deletes: Vec<(String, String)>,
}

/// A single row in a facet browser (tags, authors, series, publishers,
/// languages). Produced by `list_*` methods on `CalibreLibrary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCount {
    pub name: String,
    pub book_count: u64,
}

impl CalibreLibrary {
    pub fn open(path: &str) -> std::result::Result<Self, LibraryError> {
        let conn = Connection::open(path).map_err(|e| LibraryError::from_sqlite(path, e))?;
        let library_path = std::path::Path::new(path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new(""))
            .to_string_lossy()
            .to_string();

        // Force rollback-journal (DELETE) mode. SQLite's cross-DB atomic commit via
        // the master-journal mechanism only works when every attached database is in
        // DELETE mode — WAL breaks the two-file atomicity guarantee. This is a
        // per-file setting: setting it here keeps calibre's own long-lived connection
        // in DELETE mode so that when LibrarySession ATTACHes this same file its own
        // DELETE PRAGMA applies consistently. Verify the result and reject if the
        // file cannot be switched (e.g., held open in WAL by another process).
        //
        // In-memory databases are exempt: SQLite returns "memory" for any in-memory
        // connection (:memory: or file:name?mode=memory) and the journal-mode concept
        // does not apply. We accept "memory" so unit tests that use in-memory paths
        // can open without error.
        {
            conn.execute_batch("PRAGMA journal_mode = DELETE;")
                .map_err(|e| LibraryError::from_sqlite(path, e))?;
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .map_err(|e| LibraryError::from_sqlite(path, e))?;
            if mode != "delete" && mode != "memory" {
                return Err(LibraryError::from_sqlite(
                    path,
                    rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error {
                            code: rusqlite::ErrorCode::CannotOpen,
                            extended_code: 0,
                        },
                        Some(format!(
                            "could not set journal_mode=DELETE on '{}'; got '{}'. \
                             Another process may have this file open in WAL mode.",
                            path, mode
                        )),
                    ),
                ));
            }
        }

        // Sprint 8.5 schema-classification gate: distinguish empty / partial /
        // unrelated SQLite files from real calibre libraries before any
        // calibre-shaped read tries to query a missing `books` table and
        // surfaces a stringified rusqlite error to the user.
        //
        // In-memory databases are exempt — they're caller-controlled in tests
        // and never hit the misclassification path. Skip the gate when the
        // underlying connection reports `journal_mode = memory`.
        if mode_is_in_memory(&conn) {
            register_calibre_functions(&conn).map_err(|e| LibraryError::from_sqlite(path, e))?;
            return Ok(Self {
                conn,
                library_path,
                metadata_db_path: path.to_string(),
            });
        }
        match classify_schema(&conn).map_err(|e| LibraryError::from_sqlite(path, e))? {
            SchemaClass::Calibre => {}
            SchemaClass::Uninitialized => {
                return Err(LibraryError::Uninitialized {
                    path: path.to_string(),
                });
            }
            SchemaClass::WrongDatabaseFile => {
                return Err(LibraryError::WrongDatabaseFile {
                    path: path.to_string(),
                });
            }
        }

        // Register required functions for Calibre's triggers
        register_calibre_functions(&conn).map_err(|e| LibraryError::from_sqlite(path, e))?;

        Ok(Self {
            conn,
            library_path,
            metadata_db_path: path.to_string(),
        })
    }

    /// Absolute (or relative-to-cwd) path of the `metadata.db` file this
    /// library instance was opened from. Used by cross-DB helpers that need
    /// to open their own transactional connection with ATTACH.
    pub fn metadata_db_path(&self) -> &str {
        &self.metadata_db_path
    }

    /// Path of the directory containing `metadata.db`. Used by delete paths
    /// to resolve `books.path` to an absolute folder for on-disk removal.
    pub fn library_path(&self) -> &str {
        &self.library_path
    }

    /// Number of rows in the `books` table. Cheap counterpart to
    /// `list_books` for storage / dashboard endpoints that only need the
    /// cardinality, without paying to hydrate every row's metadata.
    pub fn count_books(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// Latest `books.timestamp` (calibre's import time) as milliseconds
    /// since the UNIX epoch, or `None` if the table is empty or the value
    /// is unparseable.
    ///
    /// Semantic note: `books.timestamp` is calibre's "added-to-library"
    /// column. The "last edit" timestamp is `books.last_modified` and
    /// would warrant its own helper if a future endpoint surfaces it.
    /// Don't conflate.
    ///
    /// Calibre writes timestamp as a Python-flavored ISO string with a
    /// space separator (`YYYY-MM-DD HH:MM:SS.ffffff+ZZ:ZZ`); chrono's
    /// RFC 3339 parser wants `T`, so we swap the first space. A parse
    /// failure is reported as `None` so storage / dashboard endpoints
    /// stay 200 on a non-conformant library rather than 500.
    pub fn last_import_at_ms(&self) -> Result<Option<i64>> {
        let raw: Option<String> =
            self.conn
                .query_row("SELECT MAX(timestamp) FROM books", [], |r| r.get(0))?;
        Ok(raw.and_then(|s| {
            let normalized = s.replacen(' ', "T", 1);
            chrono::DateTime::parse_from_rfc3339(&normalized)
                .ok()
                .map(|dt| dt.timestamp_millis())
        }))
    }

    pub fn list_books(&self) -> Result<Vec<Book>> {
        // Fetch all books
        let mut stmt = self.conn.prepare(
            "SELECT id, title, uuid, pubdate, series_index, timestamp, last_modified, has_cover, path
             FROM books"
        )?;

        let book_rows = stmt.query_map([], |row| {
            let id_val: i32 = row.get(0)?;
            let title: String = row.get(1)?;
            let uuid_str: String = row.get(2)?;
            let pubdate_str: Option<String> = row.get(3)?;
            let series_index: Option<f32> = row.get(4)?;
            let timestamp_str: String = row.get(5)?;
            let last_modified_str: String = row.get(6)?;
            let has_cover: bool = row.get::<_, i32>(7).unwrap_or(0) == 1;
            let path: String = row.get(8)?;

            let created_at = parse_calibre_date(&timestamp_str).unwrap_or_else(Utc::now);
            let updated_at = parse_calibre_date(&last_modified_str).unwrap_or_else(Utc::now);
            let uuid = match Uuid::parse_str(&uuid_str) {
                Ok(u) => u,
                Err(e) => {
                    tracing::warn!(book_id = id_val, error = %e, invalid_uuid = %uuid_str, "Invalid UUID found for book, generating a random one");
                    Uuid::new_v4()
                }
            };

            Ok((id_val, title, uuid, pubdate_str, series_index, created_at, updated_at, has_cover, path))
        })?;

        let mut books_data = Vec::new();
        for row in book_rows {
            books_data.push(row?);
        }

        // Fetch all authors mapped to book ids
        let mut authors_map: std::collections::HashMap<i32, Vec<String>> =
            std::collections::HashMap::new();
        let mut authors_stmt = self.conn.prepare(
            "SELECT l.book, a.name FROM authors a
             JOIN books_authors_link l ON a.id = l.author",
        )?;
        let authors_rows = authors_stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in authors_rows {
            let (book_id, name) = row?;
            authors_map.entry(book_id).or_default().push(name);
        }

        // Fetch all tags mapped to book ids
        let mut tags_map: std::collections::HashMap<i32, Vec<String>> =
            std::collections::HashMap::new();
        let mut tags_stmt = self.conn.prepare(
            "SELECT l.book, t.name FROM tags t
             JOIN books_tags_link l ON t.id = l.tag",
        )?;
        let tags_rows = tags_stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in tags_rows {
            let (book_id, name) = row?;
            tags_map.entry(book_id).or_default().push(name);
        }

        // Fetch all publishers mapped to book ids
        let mut publishers_map: std::collections::HashMap<i32, String> =
            std::collections::HashMap::new();
        let mut publishers_stmt = self.conn.prepare(
            "SELECT l.book, p.name FROM publishers p
             JOIN books_publishers_link l ON p.id = l.publisher",
        )?;
        let publishers_rows = publishers_stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in publishers_rows {
            let (book_id, name) = row?;
            publishers_map.insert(book_id, name);
        }

        // Fetch all comments mapped to book ids
        let mut comments_map: std::collections::HashMap<i32, String> =
            std::collections::HashMap::new();
        let mut comments_stmt = self.conn.prepare("SELECT book, text FROM comments")?;
        let comments_rows = comments_stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in comments_rows {
            let (book_id, text) = row?;
            comments_map.insert(book_id, text);
        }

        let mut books = Vec::new();
        for (id, title, uuid, pubdate, series_index, created_at, updated_at, has_cover, _path) in
            books_data
        {
            let authors = authors_map.remove(&id).unwrap_or_default();
            let tags = tags_map.remove(&id).unwrap_or_default();
            let publisher = publishers_map.remove(&id);
            let description = comments_map.remove(&id);

            books.push(Book {
                id: uuid,
                title,
                authors,
                legacy_metadata: LegacyMetadata {
                    publisher,
                    pub_date: pubdate,
                    series: None, // Need to join series table
                    series_index,
                    tags,
                    description,
                    has_cover,
                },
                bibliographic_graph: None,
                created_at,
                updated_at,
            });
        }

        Ok(books)
    }

    pub fn get_book_by_uuid(&self, uuid_str: &str) -> Result<Option<Book>> {
        let mut stmt = self.conn.prepare("SELECT id FROM books WHERE uuid = ?")?;
        let mut rows = stmt.query_map([uuid_str], |row| row.get::<_, i32>(0))?;
        if let Some(id_res) = rows.next() {
            let id = id_res?;
            self.get_book(id)
        } else {
            Ok(None)
        }
    }

    pub fn get_book(&self, book_id: i32) -> Result<Option<Book>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, uuid, pubdate, series_index, timestamp, last_modified, has_cover, path 
             FROM books WHERE id = ?"
        )?;

        let mut book_rows = stmt.query_map([book_id], |row| {
            let id_val: i32 = row.get(0)?;
            let title: String = row.get(1)?;
            let uuid_str: String = row.get(2)?;
            let pubdate_str: Option<String> = row.get(3)?;
            let series_index: Option<f32> = row.get(4)?;
            let timestamp_str: String = row.get(5)?;
            let last_modified_str: String = row.get(6)?;
            let has_cover: bool = row.get::<_, i32>(7).unwrap_or(0) == 1;
            let path: String = row.get(8)?;

            // Calibre dates are often ISO strings
            let created_at = parse_calibre_date(&timestamp_str).unwrap_or_else(Utc::now);
            let updated_at = parse_calibre_date(&last_modified_str).unwrap_or_else(Utc::now);
            let uuid = match Uuid::parse_str(&uuid_str) {
                Ok(u) => u,
                Err(e) => {
                    tracing::warn!(book_id = id_val, error = %e, invalid_uuid = %uuid_str, "Invalid UUID found for book, generating a random one");
                    Uuid::new_v4()
                }
            };

            Ok((
                id_val,
                title,
                uuid,
                pubdate_str,
                series_index,
                created_at,
                updated_at,
                has_cover,
                path,
            ))
        })?;

        if let Some(row_res) = book_rows.next() {
            let (id, title, uuid, pubdate, series_index, created_at, updated_at, has_cover, _path) =
                row_res?;
            let authors = self.get_authors(id)?;
            let tags = self.get_tags(id)?;
            let publisher = self.get_publisher(id)?;
            let description = self.get_comments(id)?;

            Ok(Some(Book {
                id: uuid,
                title,
                authors,
                legacy_metadata: LegacyMetadata {
                    publisher,
                    pub_date: pubdate,
                    series: None, // Need to join series table
                    series_index,
                    tags,
                    description,
                    has_cover,
                },
                bibliographic_graph: None,
                created_at,
                updated_at,
            }))
        } else {
            Ok(None)
        }
    }

    fn get_authors(&self, book_id: i32) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT a.name FROM authors a 
             JOIN books_authors_link l ON a.id = l.author 
             WHERE l.book = ?",
        )?;
        let rows = stmt.query_map([book_id], |row| row.get(0))?;
        let mut authors = Vec::new();
        for name in rows {
            authors.push(name?);
        }
        Ok(authors)
    }

    fn get_tags(&self, book_id: i32) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.name FROM tags t 
             JOIN books_tags_link l ON t.id = l.tag 
             WHERE l.book = ?",
        )?;
        let rows = stmt.query_map([book_id], |row| row.get(0))?;
        let mut tags = Vec::new();
        for name in rows {
            tags.push(name?);
        }
        Ok(tags)
    }

    fn get_publisher(&self, book_id: i32) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.name FROM publishers p 
             JOIN books_publishers_link l ON p.id = l.publisher 
             WHERE l.book = ?",
        )?;
        let mut rows = stmt.query_map([book_id], |row| row.get(0))?;
        if let Some(res) = rows.next() {
            Ok(Some(res?))
        } else {
            Ok(None)
        }
    }

    fn get_comments(&self, book_id: i32) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT text FROM comments WHERE book = ?")?;
        let mut rows = stmt.query_map([book_id], |row| row.get(0))?;
        if let Some(res) = rows.next() {
            Ok(Some(res?))
        } else {
            Ok(None)
        }
    }

    pub fn get_cover_path(&self, uuid: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, has_cover FROM books WHERE uuid = ?")?;
        let mut rows = stmt.query_map([uuid], |row| {
            let path: String = row.get(0)?;
            let has_cover: bool = row.get::<_, i32>(1).unwrap_or(0) == 1;
            Ok((path, has_cover))
        })?;

        if let Some(res) = rows.next() {
            let (path, has_cover) = res?;
            if has_cover {
                if let Some(safe_path) =
                    safe_join(std::path::Path::new(&self.library_path), &path, "cover.jpg")
                {
                    return Ok(Some(safe_path.to_string_lossy().into_owned()));
                }
            }
        }
        Ok(None)
    }

    pub fn get_format_path(&self, uuid: &str, format: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT b.path, d.name 
             FROM books b 
             JOIN data d ON b.id = d.book 
             WHERE b.uuid = ? AND d.format = ?",
        )?;

        // formats in Calibre are usually uppercase (e.g. 'EPUB')
        let format_upper = format.to_uppercase();
        let mut rows = stmt.query_map([uuid, &format_upper], |row| {
            let path: String = row.get(0)?;
            let name: String = row.get(1)?;
            Ok((path, name))
        })?;

        if let Some(res) = rows.next() {
            let (path, name) = res?;
            let file_name = format!("{}.{}", name, format.to_lowercase());
            if let Some(safe_path) =
                safe_join(std::path::Path::new(&self.library_path), &path, &file_name)
            {
                return Ok(Some(safe_path.to_string_lossy().into_owned()));
            }
        }
        Ok(None)
    }

    /// Return every on-disk format file for the given book UUID. Each entry is
    /// an absolute path. The caller uses this to decide whether an export is
    /// possible (no entries → no files to zip) and to enumerate what to include.
    pub fn list_format_paths(&self, uuid: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT b.path, d.name, d.format
             FROM books b
             JOIN data d ON b.id = d.book
             WHERE b.uuid = ?",
        )?;
        let rows = stmt.query_map([uuid], |row| {
            let book_path: String = row.get(0)?;
            let name: String = row.get(1)?;
            let format: String = row.get(2)?;
            Ok((book_path, name, format))
        })?;
        let mut paths = Vec::new();
        for row in rows {
            let (book_path, name, format) = row?;
            let file_name = format!("{}.{}", name, format.to_lowercase());
            if let Some(safe_path) = safe_join(
                std::path::Path::new(&self.library_path),
                &book_path,
                &file_name,
            ) {
                paths.push(safe_path.to_string_lossy().into_owned());
            }
        }
        Ok(paths)
    }

    /// Apply a partial update to the calibre projection for a book identified
    /// by UUID. Runs as a single transaction — partial success never lands.
    ///
    /// Collection fields replace the full link set: passing `authors: Some(vec![])`
    /// unlinks every author for the book. Unspecified fields (`None`) are left
    /// untouched.
    ///
    /// Maintains the trigger-critical sort fields (`authors.sort`, `books.sort`)
    /// so calibre's indexes and browse panes stay usable after a Spine write.
    pub fn update_book(&self, book_uuid: &str, update: &BookUpdate) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        Self::update_book_tx(&tx, "", book_uuid, update)?;
        tx.commit()
    }

    /// Delete a book by UUID. Removes `books`, `data`, and link-table rows in
    /// a single transaction. If `delete_files` is true, also removes the
    /// on-disk folder recursively and reports the deleted paths on the
    /// returned `DeletedBook`.
    pub fn delete_book(&self, book_uuid: &str, delete_files: bool) -> Result<DeletedBook> {
        // Step 1: snapshot the calibre path before touching any rows — we
        // need it for both the on-disk removal and the caller-visible
        // DeletedBook payload, and the `books` row disappears mid-transaction.
        let path: String =
            self.conn
                .query_row("SELECT path FROM books WHERE uuid = ?", [book_uuid], |r| {
                    r.get(0)
                })?;

        let tx = self.conn.unchecked_transaction()?;
        Self::delete_book_rows_tx(&tx, "", book_uuid)?;
        tx.commit()?;

        let mut deleted_files = Vec::new();
        let mut failed_file_deletes: Vec<(std::path::PathBuf, String)> = Vec::new();
        if delete_files {
            if let Some(abs_dir) = safe_join_dir(std::path::Path::new(&self.library_path), &path) {
                if abs_dir.exists() {
                    // Reject if the book directory itself is a symlink. Spine
                    // creates regular directories for books; a symlink in that
                    // position is anomalous and must be treated as tampering.
                    // Deleting through a symlink could affect files outside
                    // the library root, which is never the user's intent.
                    let is_symlink = std::fs::symlink_metadata(&abs_dir)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);
                    if is_symlink {
                        tracing::warn!(
                            path = %abs_dir.display(),
                            "delete_book: book directory is a symlink; skipping disk removal to avoid out-of-tree deletion"
                        );
                    } else {
                        // Canonicalize the resolved target and verify it is
                        // under the library root before deleting.
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
                                "delete_book: path escapes library root after canonicalize; skipping disk removal"
                            );
                        } else {
                            delete_files_individually(
                                &abs_dir,
                                &mut deleted_files,
                                &mut failed_file_deletes,
                            );
                            for (fp, err) in &failed_file_deletes {
                                tracing::warn!(
                                    path = %fp.display(),
                                    error = %err,
                                    "failed to delete book file; DB rows already gone"
                                );
                            }
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

    /// Transactional update primitive shared by `update_book` (prefix "") and
    /// `LibrarySession::apply_metadata_update` (prefix "calibre."). Kept on
    /// `CalibreLibrary` only because it borrows nothing from `self`; the
    /// prefix threads through every SQL statement so the attached-db caller
    /// writes into the right schema.
    pub(crate) fn update_book_tx(
        tx: &Transaction<'_>,
        prefix: &str,
        book_uuid: &str,
        update: &BookUpdate,
    ) -> Result<()> {
        let book_id: i64 = tx.query_row(
            &format!("SELECT id FROM {}books WHERE uuid = ?", prefix),
            [book_uuid],
            |r| r.get(0),
        )?;

        if let Some(title) = &update.title {
            let sort = calibre_title_sort(title);
            tx.execute(
                &format!(
                    "UPDATE {}books SET title = ?, sort = ?, last_modified = ? WHERE id = ?",
                    prefix
                ),
                params![title, sort, Utc::now().to_rfc3339(), book_id],
            )?;
        }

        if let Some(authors) = &update.authors {
            tx.execute(
                &format!("DELETE FROM {}books_authors_link WHERE book = ?", prefix),
                [book_id],
            )?;
            for (idx, name) in authors.iter().enumerate() {
                let author_id = get_or_create_author(tx, prefix, name)?;
                tx.execute(
                    &format!(
                        "INSERT INTO {}books_authors_link (book, author) VALUES (?, ?)",
                        prefix
                    ),
                    params![book_id, author_id],
                )?;
                // Calibre does not store per-book author order in the link
                // table by default, but `item_order` is a documented column
                // on some schema revisions. Write it when present via an
                // ignored-on-missing-column fallback.
                let _ = idx; // reserved for future item_order handling
            }
            // Refresh author_sort on `books` — the concatenation of author
            // sort-forms is how calibre's author-sort column is populated.
            let author_sort = authors
                .iter()
                .map(|a| author_to_author_sort(a))
                .collect::<Vec<_>>()
                .join(" & ");
            tx.execute(
                &format!(
                    "UPDATE {}books SET author_sort = ?, last_modified = ? WHERE id = ?",
                    prefix
                ),
                params![author_sort, Utc::now().to_rfc3339(), book_id],
            )?;
        }

        if let Some(tags) = &update.tags {
            tx.execute(
                &format!("DELETE FROM {}books_tags_link WHERE book = ?", prefix),
                [book_id],
            )?;
            for tag in tags {
                let tag_id = get_or_create_named(tx, prefix, "tags", tag)?;
                tx.execute(
                    &format!(
                        "INSERT INTO {}books_tags_link (book, tag) VALUES (?, ?)",
                        prefix
                    ),
                    params![book_id, tag_id],
                )?;
            }
        }

        if let Some(series_opt) = &update.series {
            tx.execute(
                &format!("DELETE FROM {}books_series_link WHERE book = ?", prefix),
                [book_id],
            )?;
            if let Some(series_name) = series_opt {
                let series_id = get_or_create_named(tx, prefix, "series", series_name)?;
                tx.execute(
                    &format!(
                        "INSERT INTO {}books_series_link (book, series) VALUES (?, ?)",
                        prefix
                    ),
                    params![book_id, series_id],
                )?;
            }
        }

        if let Some(idx) = update.series_index {
            tx.execute(
                &format!(
                    "UPDATE {}books SET series_index = ?, last_modified = ? WHERE id = ?",
                    prefix
                ),
                params![idx, Utc::now().to_rfc3339(), book_id],
            )?;
        }

        if let Some(pubdate_opt) = &update.pubdate {
            let value: Option<String> = pubdate_opt.as_ref().map(|dt| dt.to_rfc3339());
            tx.execute(
                &format!(
                    "UPDATE {}books SET pubdate = ?, last_modified = ? WHERE id = ?",
                    prefix
                ),
                params![value, Utc::now().to_rfc3339(), book_id],
            )?;
        }

        if let Some(publisher_opt) = &update.publisher {
            tx.execute(
                &format!("DELETE FROM {}books_publishers_link WHERE book = ?", prefix),
                [book_id],
            )?;
            if let Some(name) = publisher_opt {
                let pub_id = get_or_create_named(tx, prefix, "publishers", name)?;
                tx.execute(
                    &format!(
                        "INSERT INTO {}books_publishers_link (book, publisher) \
                         VALUES (?, ?)",
                        prefix
                    ),
                    params![book_id, pub_id],
                )?;
            }
        }

        if let Some(languages) = &update.languages {
            tx.execute(
                &format!("DELETE FROM {}books_languages_link WHERE book = ?", prefix),
                [book_id],
            )?;
            for (item_order, lang_code) in languages.iter().enumerate() {
                let lang_id = get_or_create_language(tx, prefix, lang_code)?;
                tx.execute(
                    &format!(
                        "INSERT INTO {}books_languages_link \
                         (book, lang_code, item_order) VALUES (?, ?, ?)",
                        prefix
                    ),
                    params![book_id, lang_id, item_order as i64 + 1],
                )?;
            }
        }

        Ok(())
    }

    /// Transactional delete shared by `delete_book` and
    /// `LibrarySession::delete_book_with_graph`.
    pub(crate) fn delete_book_rows_tx(
        tx: &Transaction<'_>,
        prefix: &str,
        book_uuid: &str,
    ) -> Result<i64> {
        let book_id: i64 = tx.query_row(
            &format!("SELECT id FROM {}books WHERE uuid = ?", prefix),
            [book_uuid],
            |r| r.get(0),
        )?;

        // Order matters: link tables reference books.id. Delete them first,
        // then dependent rows (data, comments), then books itself.
        for table in [
            "books_authors_link",
            "books_tags_link",
            "books_series_link",
            "books_publishers_link",
            "books_languages_link",
            "data",
            "comments",
            "identifiers",
        ] {
            let _ = tx.execute(
                &format!("DELETE FROM {}{} WHERE book = ?", prefix, table),
                [book_id],
            );
        }
        tx.execute(
            &format!("DELETE FROM {}books WHERE id = ?", prefix),
            [book_id],
        )?;
        Ok(book_id)
    }

    /// Case-insensitive substring search across title, authors, and tags.
    /// An empty query returns the full list (matching the `q=` no-op contract
    /// in `docs/MVP_DESKTOP_MOBILE_PLAN.md` D4.1).
    ///
    /// SQL uses bound parameters with `LIKE '%' || ? || '%'` so the query
    /// string is never concatenated into SQL; the caller cannot inject
    /// predicates through the search box.
    pub fn search_books(
        &self,
        query: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Book>> {
        let trimmed = query.trim();
        // Effective limit clamped to prevent runaway payloads; the D4 UI only
        // ever requests a page at a time.
        let effective_limit = limit.unwrap_or(1000).min(10_000) as i64;
        let effective_offset = offset.unwrap_or(0) as i64;

        let ids: Vec<i32> = if trimmed.is_empty() {
            // Full list, ordered deterministically so paginated callers get
            // stable slices.
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM books ORDER BY sort, id LIMIT ? OFFSET ?")?;
            let rows = stmt.query_map(params![effective_limit, effective_offset], |row| {
                row.get::<_, i32>(0)
            })?;
            rows.collect::<Result<Vec<_>>>()?
        } else {
            // Escape LIKE wildcards in the user query so `%` doesn't match
            // every row and `_` doesn't act as a single-char wildcard. We use
            // `\` as the escape character (declared via ESCAPE '\' in each
            // LIKE clause). The three characters that need escaping are `%`,
            // `_`, and `\` itself.
            let escaped = escape_like(trimmed);

            // Match title OR any linked author OR any linked tag OR publisher
            // OR series. DISTINCT because a book with two matching tags would
            // otherwise appear twice. Diacritics folding is not yet applied —
            // TODO(search-diacritics): wire up a custom ICU collation once
            // spine-db publishes the same.
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT b.id
                 FROM books b
                 LEFT JOIN books_authors_link bal ON bal.book = b.id
                 LEFT JOIN authors a ON a.id = bal.author
                 LEFT JOIN books_tags_link btl ON btl.book = b.id
                 LEFT JOIN tags t ON t.id = btl.tag
                 LEFT JOIN books_publishers_link bpl ON bpl.book = b.id
                 LEFT JOIN publishers p ON p.id = bpl.publisher
                 LEFT JOIN books_series_link bsl ON bsl.book = b.id
                 LEFT JOIN series s ON s.id = bsl.series
                 WHERE b.title LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\'
                    OR a.name  LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\'
                    OR t.name  LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\'
                    OR p.name  LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\'
                    OR s.name  LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\'
                 ORDER BY b.sort, b.id
                 LIMIT ? OFFSET ?",
            )?;
            let rows = stmt
                .query_map(params![escaped, effective_limit, effective_offset], |row| {
                    row.get::<_, i32>(0)
                })?;
            rows.collect::<Result<Vec<_>>>()?
        };

        let mut books = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(b) = self.get_book(id)? {
                books.push(b);
            }
        }
        Ok(books)
    }

    /// Field-prefix search per Sprint 12 §S12 step 6. Restricts the
    /// substring match to a single calibre-side field instead of the
    /// title/author/tag/publisher/series union performed by
    /// [`search_books`]. Used by `GET /api/v1/book?q=author:Shelley`.
    /// `field` is one of `"author"`, `"tag"`, `"series"`, `"publisher"`,
    /// `"language"`. Empty `value` returns the full list (consistent
    /// with [`search_books`]'s no-op contract). Unknown `field` falls
    /// through to substring search across the full union — never
    /// errors, never 4xx.
    pub fn search_books_by_field(
        &self,
        field: &str,
        value: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Book>> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return self.search_books("", limit, offset);
        }

        let effective_limit = limit.unwrap_or(1000).min(10_000) as i64;
        let effective_offset = offset.unwrap_or(0) as i64;
        let escaped = escape_like(trimmed);

        let sql = match field {
            "author" => {
                "SELECT DISTINCT b.id FROM books b \
                 JOIN books_authors_link bal ON bal.book = b.id \
                 JOIN authors a ON a.id = bal.author \
                 WHERE a.name LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\' \
                 ORDER BY b.sort, b.id LIMIT ? OFFSET ?"
            }
            "tag" => {
                "SELECT DISTINCT b.id FROM books b \
                 JOIN books_tags_link btl ON btl.book = b.id \
                 JOIN tags t ON t.id = btl.tag \
                 WHERE t.name LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\' \
                 ORDER BY b.sort, b.id LIMIT ? OFFSET ?"
            }
            "series" => {
                "SELECT DISTINCT b.id FROM books b \
                 JOIN books_series_link bsl ON bsl.book = b.id \
                 JOIN series s ON s.id = bsl.series \
                 WHERE s.name LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\' \
                 ORDER BY b.sort, b.id LIMIT ? OFFSET ?"
            }
            "publisher" => {
                "SELECT DISTINCT b.id FROM books b \
                 JOIN books_publishers_link bpl ON bpl.book = b.id \
                 JOIN publishers p ON p.id = bpl.publisher \
                 WHERE p.name LIKE '%' || ?1 || '%' COLLATE NOCASE ESCAPE '\\' \
                 ORDER BY b.sort, b.id LIMIT ? OFFSET ?"
            }
            // Unknown field — fall through to the union search per
            // contract (never 4xx).
            _ => return self.search_books(value, limit, offset),
        };

        let mut stmt = self.conn.prepare(sql)?;
        let ids = stmt
            .query_map(params![escaped, effective_limit, effective_offset], |row| {
                row.get::<_, i32>(0)
            })?
            .collect::<Result<Vec<i32>>>()?;
        let mut books = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(b) = self.get_book(id)? {
                books.push(b);
            }
        }
        Ok(books)
    }

    /// Enumerate unique authors across the library with their book counts.
    /// Ordered by count desc, then name asc. Powers the D5 browse tree.
    pub fn list_authors(&self) -> Result<Vec<FacetCount>> {
        facet_count(
            &self.conn,
            "SELECT a.name, COUNT(bal.book) FROM authors a \
             LEFT JOIN books_authors_link bal ON bal.author = a.id \
             GROUP BY a.id ORDER BY COUNT(bal.book) DESC, a.name ASC",
        )
    }

    pub fn list_tags(&self) -> Result<Vec<FacetCount>> {
        facet_count(
            &self.conn,
            "SELECT t.name, COUNT(btl.book) FROM tags t \
             LEFT JOIN books_tags_link btl ON btl.tag = t.id \
             GROUP BY t.id ORDER BY COUNT(btl.book) DESC, t.name ASC",
        )
    }

    pub fn list_series(&self) -> Result<Vec<FacetCount>> {
        facet_count(
            &self.conn,
            "SELECT s.name, COUNT(bsl.book) FROM series s \
             LEFT JOIN books_series_link bsl ON bsl.series = s.id \
             GROUP BY s.id ORDER BY COUNT(bsl.book) DESC, s.name ASC",
        )
    }

    pub fn list_publishers(&self) -> Result<Vec<FacetCount>> {
        facet_count(
            &self.conn,
            "SELECT p.name, COUNT(bpl.book) FROM publishers p \
             LEFT JOIN books_publishers_link bpl ON bpl.publisher = p.id \
             GROUP BY p.id ORDER BY COUNT(bpl.book) DESC, p.name ASC",
        )
    }

    pub fn list_languages(&self) -> Result<Vec<FacetCount>> {
        facet_count(
            &self.conn,
            "SELECT l.lang_code, COUNT(bll.book) FROM languages l \
             LEFT JOIN books_languages_link bll ON bll.lang_code = l.id \
             GROUP BY l.id ORDER BY COUNT(bll.book) DESC, l.lang_code ASC",
        )
    }

    /// Inserts a book record into metadata.db for compatibility/export.
    pub fn insert_book(&self, book: &Book) -> Result<ProjectionResult> {
        let tx = self.conn.unchecked_transaction()?;
        let result = Self::insert_book_tx(&tx, "", None, book, None)?;
        tx.commit()?;
        Ok(result)
    }

    /// Inserts an imported EPUB as a calibre-compatible row set and copies the
    /// source EPUB into the library layout so reader/export paths resolve.
    pub fn insert_imported_epub(
        &self,
        book: &Book,
        source_path: &std::path::Path,
    ) -> Result<ProjectionResult> {
        let tx = self.conn.unchecked_transaction()?;
        let result = Self::insert_book_tx(
            &tx,
            "",
            Some(std::path::Path::new(&self.library_path)),
            book,
            Some(source_path),
        )?;
        tx.commit()?;
        Ok(result)
    }

    pub(crate) fn insert_book_tx(
        tx: &Transaction<'_>,
        prefix: &str,
        library_path: Option<&std::path::Path>,
        book: &Book,
        source_path: Option<&std::path::Path>,
    ) -> Result<ProjectionResult> {
        let pubdate = book
            .legacy_metadata
            .pub_date
            .clone()
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let title_component = sanitize_path_component(&book.title);
        let author_component = book
            .authors
            .iter()
            .map(|a| sanitize_path_component(a))
            .find(|a| !a.is_empty())
            .unwrap_or_else(|| "Unknown".to_string());
        let file_stem = title_component.clone();
        let provisional_path = format!("Spine/{}_{}", title_component, book.id);

        tx.execute(
            &format!(
                "INSERT INTO {}books \
                 (title, uuid, pubdate, timestamp, last_modified, path) \
                 VALUES (?, ?, ?, ?, ?, ?)",
                prefix
            ),
            rusqlite::params![
                book.title,
                book.id.to_string(),
                pubdate,
                book.created_at.to_rfc3339(),
                book.updated_at.to_rfc3339(),
                provisional_path
            ],
        )?;
        let book_id = tx.last_insert_rowid();
        let path = format!("{}/{} ({})", author_component, file_stem, book_id);
        tx.execute(
            &format!(
                "UPDATE {}books SET path = ?, sort = ?, last_modified = ? WHERE id = ?",
                prefix
            ),
            params![
                path,
                calibre_title_sort(&book.title),
                Utc::now().to_rfc3339(),
                book_id
            ],
        )?;

        let authors = book
            .authors
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .collect::<Vec<_>>();
        for author in &authors {
            let author_id = get_or_create_author(tx, prefix, author)?;
            tx.execute(
                &format!(
                    "INSERT INTO {}books_authors_link (book, author) VALUES (?, ?)",
                    prefix
                ),
                params![book_id, author_id],
            )?;
        }
        if !authors.is_empty() {
            let author_sort = authors
                .iter()
                .map(|a| author_to_author_sort(a))
                .collect::<Vec<_>>()
                .join(" & ");
            tx.execute(
                &format!(
                    "UPDATE {}books SET author_sort = ?, last_modified = ? WHERE id = ?",
                    prefix
                ),
                params![author_sort, Utc::now().to_rfc3339(), book_id],
            )?;
        }

        for tag in &book.legacy_metadata.tags {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            let tag_id = get_or_create_named(tx, prefix, "tags", tag)?;
            tx.execute(
                &format!(
                    "INSERT INTO {}books_tags_link (book, tag) VALUES (?, ?)",
                    prefix
                ),
                params![book_id, tag_id],
            )?;
        }

        if let Some(publisher) = book
            .legacy_metadata
            .publisher
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let publisher_id = get_or_create_named(tx, prefix, "publishers", publisher)?;
            tx.execute(
                &format!(
                    "INSERT INTO {}books_publishers_link (book, publisher) VALUES (?, ?)",
                    prefix
                ),
                params![book_id, publisher_id],
            )?;
        }

        if let Some(description) = book
            .legacy_metadata
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            tx.execute(
                &format!("INSERT INTO {}comments (book, text) VALUES (?, ?)", prefix),
                params![book_id, description],
            )?;
        }

        if let Some(source_path) = source_path {
            if let Some(library_path) = library_path {
                let dest_dir = library_path.join(&path);
                std::fs::create_dir_all(&dest_dir)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let dest_file = dest_dir.join(format!("{}.epub", file_stem));
                std::fs::copy(source_path, &dest_file)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let size = std::fs::metadata(&dest_file)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);
                tx.execute(
                    &format!(
                        "INSERT INTO {}data (book, format, uncompressed_size, name) \
                         VALUES (?, 'EPUB', ?, ?)",
                        prefix
                    ),
                    params![book_id, size, file_stem],
                )?;
            }
        }

        Ok(ProjectionResult { book_id, path })
    }
}

pub(crate) fn register_calibre_functions(conn: &Connection) -> Result<()> {
    use rusqlite::functions::FunctionFlags;

    // uuid4() -> String
    conn.create_scalar_function("uuid4", 0, FunctionFlags::SQLITE_UTF8, |_ctx| {
        Ok(uuid::Uuid::new_v4().to_string())
    })?;

    // title_sort(String) -> String
    conn.create_scalar_function(
        "title_sort",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let title: String = ctx.get(0)?;
            Ok(calibre_title_sort(&title))
        },
    )?;

    Ok(())
}

enum SchemaClass {
    /// `books` table present — looks like a real calibre library.
    Calibre,
    /// 0 tables, OR `books` missing but at least one table carries the
    /// calibre-distinctive `book` foreign-key column. Suggests the file
    /// was opened mid-init or with a stale/partial calibre schema.
    Uninitialized,
    /// `books` missing AND no table carries a `book` FK column. Caller
    /// pointed at a SQLite database that isn't a calibre library.
    WrongDatabaseFile,
}

/// Test whether the connection's underlying database is in-memory.
/// Mirrors the same `PRAGMA journal_mode = memory` signal `SpineStore`
/// uses, but as a side-effect-free check (no PRAGMA write).
fn mode_is_in_memory(conn: &Connection) -> bool {
    conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
        .map(|m| m == "memory")
        .unwrap_or(false)
}

/// Sprint 8.5 schema classifier — see [`LibraryError`] for the contract.
fn classify_schema(conn: &Connection) -> Result<SchemaClass> {
    let tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>>>()?
    };

    if tables.is_empty() {
        return Ok(SchemaClass::Uninitialized);
    }
    if tables.iter().any(|t| t == "books") {
        return Ok(SchemaClass::Calibre);
    }

    // No `books` table — distinguish "calibre-adjacent partial init" from
    // "unrelated SQLite file" by looking for the calibre-distinctive
    // `book` foreign-key column on any of the present tables. Calibre's
    // link tables and `data`/`comments`/`identifiers` all carry it; a
    // generic SQLite database would be highly unlikely to coincidentally
    // ship a `book` column. False-positives possible (a non-calibre DB
    // with a `book` column would mis-classify as Uninitialized) — known
    // limitation, deferred refinement.
    for table in &tables {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
        let has_book_col = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .any(|name| matches!(name, Ok(ref n) if n == "book"));
        if has_book_col {
            return Ok(SchemaClass::Uninitialized);
        }
    }
    Ok(SchemaClass::WrongDatabaseFile)
}

/// Convert "First Last" → "Last, First" using calibre's heuristic: split on
/// the last space and move the tail to the front. Single-word names are
/// returned unchanged. This is an intentional approximation of calibre's
/// `author_to_author_sort` Python helper; canonical port lives in
/// `spine_bf::author_sort` (see docs/TECH_DEBT.md). Re-exported
/// here so existing call sites (`update_book_tx` author_sort write) keep
/// working without crate-boundary churn.
pub(crate) fn author_to_author_sort(author: &str) -> String {
    spine_bf::author_sort::author_to_author_sort(author)
}

fn sanitize_path_component(value: &str) -> String {
    let cleaned = value
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        "Unknown".to_string()
    } else {
        cleaned
    }
}

/// Join a library-relative directory path onto the library root, rejecting
/// traversal components. Sibling helper to `safe_join`, used by delete paths
/// that resolve a directory rather than a file inside it.
fn safe_join_dir(base: &std::path::Path, user_path: &str) -> Option<std::path::PathBuf> {
    let mut safe_relative = std::path::PathBuf::new();
    for component in std::path::Path::new(user_path).components() {
        match component {
            std::path::Component::Normal(c) => safe_relative.push(c),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(base.join(safe_relative))
}

/// Delete files under `dir` one by one, recording each successful deletion in
/// `deleted` and each failure in `failed`. Recurses into subdirectories.
/// Subdirectory entries are removed individually; the caller is responsible for
/// removing the now-empty (or partly-empty) top-level directory afterward.
pub(crate) fn delete_files_individually(
    dir: &std::path::Path,
    deleted: &mut Vec<String>,
    failed: &mut Vec<(std::path::PathBuf, String)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            failed.push((dir.to_path_buf(), e.to_string()));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            delete_files_individually(&path, deleted, failed);
            // Try removing the now-hopefully-empty subdir.
            if let Err(e) = std::fs::remove_dir(&path) {
                // Non-fatal: the parent dir removal will also fail, logged by
                // the caller.
                tracing::debug!(path = %path.display(), error = %e, "could not remove subdir");
            }
        } else {
            match std::fs::remove_file(&path) {
                Ok(()) => deleted.push(path.to_string_lossy().into_owned()),
                Err(e) => failed.push((path, e.to_string())),
            }
        }
    }
}

/// Look up or insert an author row, maintaining the `sort` column. Returns
/// the author's `id`.
fn get_or_create_author(tx: &Transaction<'_>, prefix: &str, name: &str) -> Result<i64> {
    if let Some(id) = tx
        .query_row(
            &format!("SELECT id FROM {}authors WHERE name = ?", prefix),
            [name],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let sort = author_to_author_sort(name);
    tx.execute(
        &format!("INSERT INTO {}authors (name, sort) VALUES (?, ?)", prefix),
        params![name, sort],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Look up or insert a row in a simple `(id, name)` table (`tags`, `series`,
/// `publishers`). `series` additionally has a `sort` column; we populate it
/// with `title_sort`'s treatment of the name so calibre browse order matches.
fn get_or_create_named(tx: &Transaction<'_>, prefix: &str, table: &str, name: &str) -> Result<i64> {
    if let Some(id) = tx
        .query_row(
            &format!("SELECT id FROM {}{} WHERE name = ?", prefix, table),
            [name],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    match table {
        "series" | "publishers" => {
            let sort = calibre_title_sort(name);
            tx.execute(
                &format!("INSERT INTO {}{} (name, sort) VALUES (?, ?)", prefix, table),
                params![name, sort],
            )?;
        }
        _ => {
            tx.execute(
                &format!("INSERT INTO {}{} (name) VALUES (?)", prefix, table),
                [name],
            )?;
        }
    }
    Ok(tx.last_insert_rowid())
}

/// Look up or insert a language row keyed by ISO language code.
fn get_or_create_language(tx: &Transaction<'_>, prefix: &str, lang_code: &str) -> Result<i64> {
    if let Some(id) = tx
        .query_row(
            &format!("SELECT id FROM {}languages WHERE lang_code = ?", prefix),
            [lang_code],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    tx.execute(
        &format!("INSERT INTO {}languages (lang_code) VALUES (?)", prefix),
        [lang_code],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Escape `%`, `_`, and `\` in a LIKE pattern so user-supplied query strings
/// cannot act as wildcards. The result must be used with `ESCAPE '\'` in the
/// SQL LIKE clause.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out
}

fn facet_count(conn: &Connection, sql: &str) -> Result<Vec<FacetCount>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(FacetCount {
            name: row.get::<_, String>(0)?,
            book_count: row.get::<_, i64>(1).unwrap_or(0) as u64,
        })
    })?;
    rows.collect()
}

fn calibre_title_sort(title: &str) -> String {
    let lower = title.to_lowercase();
    if lower.starts_with("the ") {
        format!("{}, The", &title[4..])
    } else if lower.starts_with("a ") {
        format!("{}, A", &title[2..])
    } else if lower.starts_with("an ") {
        format!("{}, An", &title[3..])
    } else {
        title.to_string()
    }
}

/// Safely joins a user-provided path and a filename to a base directory.
/// It mitigates directory traversal attacks by ignoring any components that
/// would escape the base directory (e.g., ParentDir `..`, RootDir `/`, Prefix `C:`).
fn safe_join(base: &std::path::Path, user_path: &str, file: &str) -> Option<std::path::PathBuf> {
    let mut safe_relative = std::path::PathBuf::new();
    for component in std::path::Path::new(user_path).components() {
        match component {
            std::path::Component::Normal(c) => safe_relative.push(c),
            std::path::Component::CurDir => {}
            // Reject ParentDir, RootDir, Prefix to prevent path traversal
            _ => return None,
        }
    }
    safe_relative.push(file);
    Some(base.join(safe_relative))
}

fn parse_calibre_date(s: &str) -> Option<DateTime<Utc>> {
    // Calibre uses "YYYY-MM-DD HH:MM:SS.MS+00:00" or similar
    // Simple naive parser for now
    let cleaned = s.split('+').next()?;
    let formats = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ];
    for fmt in formats {
        if let Ok(naive) = NaiveDateTime::parse_from_str(cleaned, fmt) {
            return Some(DateTime::from_naive_utc_and_offset(naive, Utc));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    #[test]
    fn test_parse_calibre_date_valid() {
        let cases = vec![
            ("2023-10-25 14:30:00.123456+00:00", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25 14:30:00+00:00", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25T14:30:00.123+00:00", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25T14:30:00+00:00", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25 14:30:00.123", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25 14:30:00", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25T14:30:00.123", 2023, 10, 25, 14, 30, 0),
            ("2023-10-25T14:30:00", 2023, 10, 25, 14, 30, 0),
        ];

        for (input, y, m, d, h, min, s) in cases {
            let parsed = parse_calibre_date(input).expect(&format!("Failed to parse: {}", input));
            assert_eq!(parsed.year(), y);
            assert_eq!(parsed.month(), m);
            assert_eq!(parsed.day(), d);
            assert_eq!(parsed.hour(), h);
            assert_eq!(parsed.minute(), min);
            assert_eq!(parsed.second(), s);
        }
    }

    #[test]
    fn test_parse_calibre_date_invalid() {
        let invalid_cases = vec![
            "",
            "2023-10-25",
            "not-a-date",
            "2023-10-25 14:30",    // missing seconds
            "2023/10/25 14:30:00", // wrong separator
        ];

        for input in invalid_cases {
            assert!(
                parse_calibre_date(input).is_none(),
                "Should fail to parse: {}",
                input
            );
        }
    }

    #[test]
    fn test_safe_join() {
        let base = std::path::Path::new("/var/lib/calibre");

        // Valid paths
        assert_eq!(
            safe_join(base, "Author Name/Book Title (123)", "cover.jpg").unwrap(),
            std::path::Path::new("/var/lib/calibre/Author Name/Book Title (123)/cover.jpg")
        );
        assert_eq!(
            safe_join(base, "book_id", "cover.jpg").unwrap(),
            std::path::Path::new("/var/lib/calibre/book_id/cover.jpg")
        );

        // Path traversal attempts
        assert!(safe_join(base, "../../etc/passwd", "cover.jpg").is_none());
        assert!(safe_join(base, "Author/../../etc", "cover.jpg").is_none());

        // Absolute paths
        assert!(safe_join(base, "/etc/passwd", "cover.jpg").is_none());
    }

    #[test]
    #[ignore = "requires the `calibredb` CLI on PATH (calibre install). Run with `cargo test -p calibre-db -- --ignored` on a host that has it."]
    fn test_insert_book_trigger_collations() {
        // Create an empty temp directory
        let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
        let db_path = temp_dir.path().join("metadata.db");

        // Let calibre initialize the DB
        let status = std::process::Command::new("calibredb")
            .arg("add")
            .arg("--empty")
            .arg("--with-library")
            .arg(temp_dir.path())
            .status()
            .expect("Failed to run calibredb");

        assert!(status.success(), "calibredb failed to initialize library");

        // Open it with our rust library (which registers functions)
        let lib = CalibreLibrary::open(db_path.to_str().unwrap()).expect("Failed to open library");

        // Write to books directly using rusqlite
        lib.conn
            .execute(
                "INSERT INTO books (title, path) VALUES (?, ?)",
                rusqlite::params!["The Rust Programming Language", "Rust/Rust (1)"],
            )
            .expect("Failed to insert book, probably due to missing triggers/functions");

        // Run calibredb check_library
        let check_status = std::process::Command::new("calibredb")
            .arg("check_library")
            .arg("--with-library")
            .arg(temp_dir.path())
            .status()
            .expect("Failed to run calibredb check_library");

        assert!(
            check_status.success(),
            "calibredb check_library reported errors"
        );
    }
}
