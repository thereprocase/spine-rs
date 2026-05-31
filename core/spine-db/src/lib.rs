use rusqlite::{params, Connection, Result, Transaction};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// NOTE: field rename 2026-04-23 — callers in spine-srv/src/api_v1.rs consume
// `updated_at_unix` (seconds). That field is preserved for backward compat.
// New code should prefer `updated_at_ms`, which carries millisecond
// resolution and is the field used by ORDER BY on list queries. Both fields
// are populated on every write; a later wave will retire `updated_at_unix`
// once spine-srv has migrated.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredReadingProgress {
    pub book_id: String,
    pub locator: String,
    pub progress_fraction: Option<f64>,
    pub chapter_label: Option<String>,
    /// Seconds since UNIX epoch. Retained for backward compat with
    /// `spine-srv/src/api_v1.rs`. New consumers: use `updated_at_ms`.
    pub updated_at_unix: i64,
    /// Milliseconds since UNIX epoch. Monotonic across saves: if the wall
    /// clock is adjusted backward, this value still advances by at least 1ms
    /// per write so ordering is preserved.
    pub updated_at_ms: i64,
}

pub struct SpineStore {
    conn: Connection,
    /// Path the store was opened against. Stored verbatim (including
    /// `:memory:` etc.) so callers like the Sprint 9 backup endpoint can
    /// distinguish on-disk vs in-memory without re-querying the connection.
    open_path: String,
}

impl SpineStore {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;

        // Force rollback-journal (DELETE) mode so that LibrarySession can
        // ATTACH this file into a cross-DB atomic transaction. WAL mode breaks
        // SQLite's master-journal two-file commit guarantee. In-memory databases
        // are exempt: SQLite returns "memory" for any in-memory path (:memory:
        // or file:name?mode=memory) — the journal-mode concept does not apply
        // to in-memory databases. We accept "memory" so tests that use in-memory
        // paths can open without error.
        {
            conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
            let mode: String = conn.query_row(
                "PRAGMA journal_mode",
                [],
                |r| r.get(0),
            )?;
            if mode != "delete" && mode != "memory" {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: rusqlite::ErrorCode::CannotOpen,
                        extended_code: 0,
                    },
                    Some(format!(
                        "could not set journal_mode=DELETE on '{}'; got '{}'. \
                         Another process may have this file open in WAL mode.",
                        path, mode
                    )),
                ));
            }
        }

        Self::setup_schema(&conn)?;
        Ok(Self {
            conn,
            open_path: path.to_string(),
        })
    }

    /// Path of the on-disk `spine.db` this store was opened against.
    /// Returns `Some` for file-backed databases, `None` for in-memory
    /// (`:memory:`, `file:name?mode=memory`) which have no on-disk
    /// representation. Used by the Sprint 9 library-backup endpoint to
    /// resolve the source path for `VACUUM INTO` without taking a copy
    /// of the connection.
    pub fn database_path(&self) -> Option<&str> {
        let p = self.open_path.as_str();
        if p == ":memory:" || p.starts_with("file::memory:") || p.is_empty() {
            None
        } else {
            Some(p)
        }
    }

    fn setup_schema(conn: &Connection) -> Result<()> {
        // 1. Terms table: Dictionary encoding for URIs and Literals
        conn.execute(
            "CREATE TABLE IF NOT EXISTS terms (
                id INTEGER PRIMARY KEY,
                value TEXT UNIQUE NOT NULL
            )",
            [],
        )?;

        // 2. Graphs table: Separation of concerns (Asserted vs Inferred)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS graphs (
                id INTEGER PRIMARY KEY,
                uri TEXT UNIQUE NOT NULL,
                source TEXT,
                confidence REAL DEFAULT 1.0
            )",
            [],
        )?;

        // 3. Triples table: The core relationship matrix using Integer IDs
        conn.execute(
            "CREATE TABLE IF NOT EXISTS triples (
                subject_id INTEGER NOT NULL REFERENCES terms(id),
                predicate_id INTEGER NOT NULL REFERENCES terms(id),
                object_id INTEGER NOT NULL REFERENCES terms(id),
                graph_id INTEGER NOT NULL REFERENCES graphs(id),
                PRIMARY KEY (subject_id, predicate_id, object_id, graph_id)
            )",
            [],
        )?;

        // Speed indices
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_triples_s ON triples(subject_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_triples_p ON triples(predicate_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_triples_o ON triples(object_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_triples_g ON triples(graph_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_triples_po ON triples(predicate_id, object_id)",
            [],
        )?;

        // Materialized view for fast subject lookup
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mv_book_subjects (
                book_uri TEXT NOT NULL,
                subject_value TEXT NOT NULL,
                PRIMARY KEY (book_uri, subject_value)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_mv_subj ON mv_book_subjects(subject_value)",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS reading_progress (
                book_id TEXT PRIMARY KEY,
                locator TEXT NOT NULL,
                progress_fraction REAL,
                chapter_label TEXT,
                updated_at_unix INTEGER NOT NULL,
                updated_at_ms INTEGER
            )",
            [],
        )?;

        // Migration must run before the index: on legacy databases the column
        // does not exist yet, so the CREATE INDEX would fail if it ran first.
        Self::migrate_reading_progress_ms(conn)?;

        // Backs ORDER BY updated_at_ms DESC in list_reading_progress and the
        // COALESCE(MAX(updated_at_ms), 0) aggregate in the monotonic upsert.
        // Without this both queries are full-table scans on reading_progress.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rp_updated_at_ms \
             ON reading_progress(updated_at_ms)",
            [],
        )?;

        Ok(())
    }

    /// Adds `updated_at_ms` to `reading_progress` on older databases that
    /// pre-date the millisecond column, and back-fills it from the seconds
    /// column.
    ///
    /// Idempotency: guarded by `PRAGMA user_version`. Version 1 means this
    /// migration has already run. On fully-migrated databases (the common path
    /// on every library open after first migration) the function returns after
    /// a single PRAGMA read — no table scan, no ALTER TABLE.
    ///
    /// Schema-version contract:
    ///   0 (or absent) — original schema, may or may not have the ms column
    ///   1             — ms column exists, all rows back-filled, index present
    fn migrate_reading_progress_ms(conn: &Connection) -> Result<()> {
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version >= 1 {
            // Already at or past this migration — nothing to do.
            return Ok(());
        }

        // Check whether the column exists so we can handle databases that had
        // a partial migration (column added but user_version never stamped).
        let mut has_ms = false;
        {
            let mut stmt = conn.prepare("PRAGMA table_info(reading_progress)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            for name in rows {
                if name? == "updated_at_ms" {
                    has_ms = true;
                    break;
                }
            }
        }

        // Wrap the structural change and back-fill in a single IMMEDIATE
        // transaction so a crash mid-migration leaves the DB in a consistent
        // state. On retry the version check above will re-enter here because
        // user_version was not yet stamped.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            if !has_ms {
                conn.execute(
                    "ALTER TABLE reading_progress ADD COLUMN updated_at_ms INTEGER",
                    [],
                )?;
            }
            // Back-fill any rows where ms is NULL (covers both: column just
            // added above, and pre-existing partial migration with NULLs).
            conn.execute(
                "UPDATE reading_progress SET updated_at_ms = updated_at_unix * 1000 \
                 WHERE updated_at_ms IS NULL",
                [],
            )?;
            // Stamp the version inside the same transaction so it is atomic
            // with the back-fill. PRAGMA inside a transaction is supported by
            // SQLite for user_version specifically.
            conn.execute_batch("PRAGMA user_version = 1")?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Wall-clock milliseconds since UNIX epoch, clamped to be strictly
    /// greater than `prev_max`. Pulled out of the upsert body so it can be
    /// exercised by unit tests without going through SQLite. The clamp is
    /// what makes timestamps survive a backward clock adjustment — a freshly
    /// NTP-synced laptop could otherwise skip the ms ordering the list view
    /// depends on.
    fn clamp_ms_monotonic(prev_max: i64) -> i64 {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| {
                let ms = d.as_millis();
                // Saturate u128 -> i64; i64::MAX ms is ~292 million years,
                // so this is an academic guard.
                if ms > i64::MAX as u128 {
                    i64::MAX
                } else {
                    ms as i64
                }
            })
            .unwrap_or(0);
        wall.max(prev_max.saturating_add(1))
    }

    /// High-level method to insert a triple using raw strings.
    /// Handles the dictionary lookups internally.
    pub fn insert_triple(&self, s: &str, p: &str, o: &str, g_uri: &str) -> Result<()> {
        let s_id = self.get_or_create_term(s)?;
        let p_id = self.get_or_create_term(p)?;
        let o_id = self.get_or_create_term(o)?;
        let g_id = self.get_or_create_graph(g_uri)?;

        self.conn.execute(
            "INSERT OR IGNORE INTO triples (subject_id, predicate_id, object_id, graph_id) 
             VALUES (?, ?, ?, ?)",
            params![s_id, p_id, o_id, g_id],
        )?;

        // Maintain MV
        if p == "http://id.loc.gov/ontologies/bibframe/subject" {
            self.conn.execute(
                "INSERT OR IGNORE INTO mv_book_subjects (book_uri, subject_value) VALUES (?, ?)",
                params![g_uri, o],
            )?;
        }

        Ok(())
    }

    pub fn insert_graph_triples(
        &self,
        graph_uri: &str,
        triples: &[(String, String, String)],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        Self::insert_graph_triples_tx(&tx, graph_uri, triples)?;
        tx.commit()
    }

    pub fn replace_graph(
        &self,
        graph_uri: &str,
        triples: &[(String, String, String)],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        if let Some(g_id) = Self::get_graph_id_tx(&tx, graph_uri)? {
            tx.execute("DELETE FROM triples WHERE graph_id = ?", [g_id])?;
            tx.execute(
                "DELETE FROM mv_book_subjects WHERE book_uri = ?",
                [graph_uri],
            )?;
        }
        Self::insert_graph_triples_tx(&tx, graph_uri, triples)?;
        tx.commit()
    }

    /// Replace-graph that runs inside a caller-owned transaction, targeting
    /// tables under an arbitrary schema prefix (for example `"spine."` when
    /// the spine database is opened as an ATTACHed schema). Empty prefix
    /// addresses the `main` schema, matching `replace_graph`'s behavior.
    ///
    /// Exists to let `calibre-db::LibrarySession` drive a single SQLite
    /// transaction that spans `metadata.db` and an ATTACHed `spine.db`, so
    /// the graph write and the calibre projection commit or roll back
    /// together. AGENTS.md §2 forbids direct writes to `triples`; callers
    /// route through this helper to keep the dictionary-encoding invariant.
    pub fn replace_graph_tx_with_prefix(
        tx: &Transaction<'_>,
        prefix: &str,
        graph_uri: &str,
        triples: &[(String, String, String)],
    ) -> Result<()> {
        if let Some(g_id) = Self::get_graph_id_tx_prefixed(tx, prefix, graph_uri)? {
            tx.execute(
                &format!("DELETE FROM {}triples WHERE graph_id = ?", prefix),
                [g_id],
            )?;
            tx.execute(
                &format!(
                    "DELETE FROM {}mv_book_subjects WHERE book_uri = ?",
                    prefix
                ),
                [graph_uri],
            )?;
        }
        Self::insert_graph_triples_tx_prefixed(tx, prefix, graph_uri, triples)
    }

    /// Delete-graph equivalent of `replace_graph_tx_with_prefix`. Removes
    /// every triple under `graph_uri` plus the matching materialized-view
    /// rows. Orphaned `terms` rows are left behind, matching the behavior of
    /// `SpineStore::delete_graph` (see TECH_DEBT §2.2).
    pub fn delete_graph_tx_with_prefix(
        tx: &Transaction<'_>,
        prefix: &str,
        graph_uri: &str,
    ) -> Result<()> {
        if let Some(g_id) = Self::get_graph_id_tx_prefixed(tx, prefix, graph_uri)? {
            tx.execute(
                &format!("DELETE FROM {}triples WHERE graph_id = ?", prefix),
                [g_id],
            )?;
            tx.execute(
                &format!(
                    "DELETE FROM {}mv_book_subjects WHERE book_uri = ?",
                    prefix
                ),
                [graph_uri],
            )?;
        }
        Ok(())
    }

    fn get_or_create_term_tx_prefixed(
        tx: &Transaction<'_>,
        prefix: &str,
        val: &str,
    ) -> Result<i64> {
        tx.prepare_cached(&format!(
            "INSERT OR IGNORE INTO {}terms (value) VALUES (?)",
            prefix
        ))?
        .execute([val])?;
        tx.prepare_cached(&format!(
            "SELECT id FROM {}terms WHERE value = ?",
            prefix
        ))?
        .query_row([val], |r| r.get(0))
    }

    fn get_or_create_graph_tx_prefixed(
        tx: &Transaction<'_>,
        prefix: &str,
        uri: &str,
    ) -> Result<i64> {
        tx.prepare_cached(&format!(
            "INSERT OR IGNORE INTO {}graphs (uri) VALUES (?)",
            prefix
        ))?
        .execute([uri])?;
        tx.prepare_cached(&format!(
            "SELECT id FROM {}graphs WHERE uri = ?",
            prefix
        ))?
        .query_row([uri], |r| r.get(0))
    }

    fn get_graph_id_tx_prefixed(
        tx: &Transaction<'_>,
        prefix: &str,
        uri: &str,
    ) -> Result<Option<i64>> {
        match tx.query_row(
            &format!("SELECT id FROM {}graphs WHERE uri = ?", prefix),
            [uri],
            |r| r.get(0),
        ) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn insert_graph_triples_tx_prefixed(
        tx: &Transaction<'_>,
        prefix: &str,
        graph_uri: &str,
        triples: &[(String, String, String)],
    ) -> Result<()> {
        let g_id = Self::get_or_create_graph_tx_prefixed(tx, prefix, graph_uri)?;

        for (s, p, o) in triples {
            let s_id = Self::get_or_create_term_tx_prefixed(tx, prefix, s)?;
            let p_id = Self::get_or_create_term_tx_prefixed(tx, prefix, p)?;
            let o_id = Self::get_or_create_term_tx_prefixed(tx, prefix, o)?;

            tx.prepare_cached(&format!(
                "INSERT OR IGNORE INTO {}triples \
                 (subject_id, predicate_id, object_id, graph_id) \
                 VALUES (?, ?, ?, ?)",
                prefix
            ))?
            .execute(params![s_id, p_id, o_id, g_id])?;

            if p == "http://id.loc.gov/ontologies/bibframe/subject" {
                tx.prepare_cached(&format!(
                    "INSERT OR IGNORE INTO {}mv_book_subjects \
                     (book_uri, subject_value) VALUES (?, ?)",
                    prefix
                ))?
                .execute(params![graph_uri, o])?;
            }
        }
        Ok(())
    }

    fn insert_graph_triples_tx(
        tx: &Transaction<'_>,
        graph_uri: &str,
        triples: &[(String, String, String)],
    ) -> Result<()> {
        // Resolve the graph id once outside the per-triple loop. Previously
        // this called get_or_create_graph_tx on every iteration: INSERT OR
        // IGNORE + SELECT × N triples. One call here reduces that to a
        // constant-cost pair of statements regardless of triple count.
        let g_id = Self::get_or_create_graph_tx(tx, graph_uri)?;

        for (s, p, o) in triples {
            let s_id = Self::get_or_create_term_tx(tx, s)?;
            let p_id = Self::get_or_create_term_tx(tx, p)?;
            let o_id = Self::get_or_create_term_tx(tx, o)?;

            tx.prepare_cached(
                "INSERT OR IGNORE INTO triples (subject_id, predicate_id, object_id, graph_id)
                 VALUES (?, ?, ?, ?)",
            )?
            .execute(params![s_id, p_id, o_id, g_id])?;

            if p == "http://id.loc.gov/ontologies/bibframe/subject" {
                tx.prepare_cached(
                    "INSERT OR IGNORE INTO mv_book_subjects (book_uri, subject_value) VALUES (?, ?)",
                )?
                .execute(params![graph_uri, o])?;
            }
        }
        Ok(())
    }

    fn get_or_create_term(&self, val: &str) -> Result<i64> {
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO terms (value) VALUES (?)")?
            .execute([val])?;
        self.conn.prepare_cached("SELECT id FROM terms WHERE value = ?")?.query_row([val], |r| r.get(0))
    }

    fn get_or_create_graph(&self, uri: &str) -> Result<i64> {
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO graphs (uri) VALUES (?)")?
            .execute([uri])?;
        self.conn.prepare_cached("SELECT id FROM graphs WHERE uri = ?")?.query_row([uri], |r| r.get(0))
    }

    fn get_or_create_term_tx(tx: &Transaction<'_>, val: &str) -> Result<i64> {
        tx.prepare_cached("INSERT OR IGNORE INTO terms (value) VALUES (?)")?
            .execute([val])?;
        tx.prepare_cached("SELECT id FROM terms WHERE value = ?")?
            .query_row([val], |r| r.get(0))
    }

    fn get_or_create_graph_tx(tx: &Transaction<'_>, uri: &str) -> Result<i64> {
        tx.prepare_cached("INSERT OR IGNORE INTO graphs (uri) VALUES (?)")?
            .execute([uri])?;
        tx.prepare_cached("SELECT id FROM graphs WHERE uri = ?")?
            .query_row([uri], |r| r.get(0))
    }

    fn get_graph_id_tx(tx: &Transaction<'_>, uri: &str) -> Result<Option<i64>> {
        match tx.query_row("SELECT id FROM graphs WHERE uri = ?", [uri], |r| r.get(0)) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn count_triples(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM triples", [], |r| r.get(0))
    }

    pub fn get_triples(&self, graph_uri: &str) -> Result<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT st.value, pt.value, ot.value
             FROM triples t
             JOIN terms st ON t.subject_id = st.id
             JOIN terms pt ON t.predicate_id = pt.id
             JOIN terms ot ON t.object_id = ot.id
             JOIN graphs g ON t.graph_id = g.id
             WHERE g.uri = ?",
        )?;

        let rows = stmt.query_map([graph_uri], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;

        rows.collect()
    }

    /// Fetch triples for multiple named graphs, chunked to stay within
    /// SQLite's variable limit. Returns a map from graph URI to its triple
    /// list. Graph URIs that have no triples are absent from the returned map
    /// — callers should treat a missing key as an empty triple set.
    ///
    /// This replaces N sequential `get_triples` calls in `list_enriched_books`:
    /// instead of one lock acquisition + one SELECT per book, the whole list
    /// endpoint takes a single lock and issues one query regardless of library
    /// size. O(N) → O(1) lock acquisitions; O(N × triples) → same data volume
    /// but a single query plan instead of N plans.
    ///
    /// Chunking: SQLite rejects IN-lists with more than 999 bound parameters
    /// on pre-3.32 builds (common on some Linux distros, iOS, Android). We
    /// split the URI list into chunks of BATCH_CHUNK_SIZE and merge the
    /// per-chunk maps into a single result.
    pub fn get_triples_batch(
        &self,
        graph_uris: &[&str],
    ) -> Result<HashMap<String, Vec<(String, String, String)>>> {
        if graph_uris.is_empty() {
            return Ok(HashMap::new());
        }

        // 999 is the pre-3.32 SQLITE_MAX_VARIABLE_NUMBER default. Use 500 to
        // give headroom for future callers that add their own parameters.
        const BATCH_CHUNK_SIZE: usize = 500;

        let mut result: HashMap<String, Vec<(String, String, String)>> = HashMap::new();

        for chunk in graph_uris.chunks(BATCH_CHUNK_SIZE) {
            // Build an IN (?,?,…) clause matched to this chunk's length.
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT g.uri, st.value, pt.value, ot.value
                 FROM triples t
                 JOIN terms st ON t.subject_id = st.id
                 JOIN terms pt ON t.predicate_id = pt.id
                 JOIN terms ot ON t.object_id = ot.id
                 JOIN graphs g ON t.graph_id = g.id
                 WHERE g.uri IN ({})",
                placeholders
            );

            // prepare_cached key is the SQL string. Chunks of the same size
            // (all full chunks) will hit the cache on subsequent iterations;
            // the final partial chunk gets its own cache entry. For libraries
            // with < 500 books this is a single cached prepare for the life
            // of the connection.
            let mut stmt = self.conn.prepare_cached(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|u| u as &dyn rusqlite::ToSql).collect();

            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?;

            for row in rows {
                let (g_uri, s, p, o) = row?;
                result.entry(g_uri).or_default().push((s, p, o));
            }
        }

        Ok(result)
    }

    /// Return the URIs of all named graphs carrying a non-zero
    /// `spine:reconcileTimeoutAt` triple — i.e. the queue of books awaiting
    /// user reconcile review per ADR 015 §4. Books skipped via
    /// `POST /api/v1/reconcile/{id}/skip` rewrite their timeout to "0" and
    /// drop out of this set; the §6 background sweep re-picks them on the
    /// next tick.
    pub fn list_reconcile_pending_graphs(&self) -> Result<Vec<String>> {
        const RECONCILE_TIMEOUT_AT: &str =
            "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";
        let mut stmt = self.conn.prepare_cached(
            "SELECT DISTINCT g.uri
             FROM triples t
             JOIN terms pt ON t.predicate_id = pt.id
             JOIN terms ot ON t.object_id = ot.id
             JOIN graphs g ON t.graph_id = g.id
             WHERE pt.value = ? AND ot.value <> '0' AND ot.value <> ''",
        )?;
        let rows = stmt.query_map([RECONCILE_TIMEOUT_AT], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// Return the URIs of every named graph in the store. Used by the
    /// ADR 015 §7 pre-ADR backfill which has to enumerate the full library
    /// to find graphs missing `spine:uriSource` provenance.
    pub fn list_all_graphs(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached("SELECT uri FROM graphs ORDER BY uri")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn delete_graph(&self, graph_uri: &str) -> Result<()> {
        let g_id: i64 =
            match self
                .conn
                .query_row("SELECT id FROM graphs WHERE uri = ?", [graph_uri], |r| {
                    r.get(0)
                }) {
                Ok(id) => id,
                Err(_) => return Ok(()), // Graph doesn't exist, nothing to delete
            };

        self.conn
            .execute("DELETE FROM triples WHERE graph_id = ?", [g_id])?;
        self.conn.execute(
            "DELETE FROM mv_book_subjects WHERE book_uri = ?",
            [graph_uri],
        )?;
        Ok(())
    }

    pub fn upsert_reading_progress(
        &self,
        book_id: &str,
        locator: &str,
        progress_fraction: Option<f64>,
        chapter_label: Option<&str>,
    ) -> Result<()> {
        // BEGIN IMMEDIATE grabs a RESERVED lock at the start of the
        // transaction so the subsequent `SELECT MAX(updated_at_ms)` + INSERT
        // pair is atomic under SQLite's locking model. Without the reserved
        // lock, two concurrent Connection handles can both read the same
        // `prev_max`, each clamp their wall clock to `prev_max + 1`, and the
        // second INSERT wins with the same ms value the first write
        // observed — violating the strict-monotonicity invariant that the
        // list-by-updated_at_ms endpoint relies on.
        //
        // `rusqlite::Connection::unchecked_transaction` defaults to DEFERRED;
        // we issue BEGIN IMMEDIATE manually and pair it with an explicit
        // COMMIT on success / ROLLBACK on drop.
        self.conn.execute_batch("BEGIN IMMEDIATE")?;

        // Compute the monotonic ms from inside the reserved lock so the read
        // is serialised with the write.
        let result = (|| -> Result<()> {
            // We need a transaction handle to reuse the prepared-statement
            // cache; construct one from the connection without starting a
            // nested tx (unchecked_transaction would issue another BEGIN,
            // which SQLite rejects).
            let prev_max: i64 = self.conn.query_row(
                "SELECT COALESCE(MAX(updated_at_ms), 0) FROM reading_progress",
                [],
                |r| r.get(0),
            )?;
            let updated_at_ms = Self::clamp_ms_monotonic(prev_max);
            // Seconds-resolution field retained for backward compat with any
            // consumer still reading `updated_at_unix`. Derived from ms so
            // the two views agree. TECH_DEBT.md §2.4 tracks retirement.
            let updated_at_unix = updated_at_ms / 1000;

            self.conn.execute(
                "INSERT INTO reading_progress (
                    book_id,
                    locator,
                    progress_fraction,
                    chapter_label,
                    updated_at_unix,
                    updated_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(book_id) DO UPDATE SET
                    locator = excluded.locator,
                    progress_fraction = excluded.progress_fraction,
                    chapter_label = excluded.chapter_label,
                    updated_at_unix = excluded.updated_at_unix,
                    updated_at_ms = excluded.updated_at_ms",
                params![
                    book_id,
                    locator,
                    progress_fraction,
                    chapter_label,
                    updated_at_unix,
                    updated_at_ms
                ],
            )?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(e) => {
                // Best-effort rollback; if this fails too, surface the
                // original error — rollback failure on an already-broken tx
                // is usually a no-op.
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn get_reading_progress(&self, book_id: &str) -> Result<Option<StoredReadingProgress>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT book_id, locator, progress_fraction, chapter_label, updated_at_unix, updated_at_ms
             FROM reading_progress
             WHERE book_id = ?",
        )?;
        let mut rows = stmt.query_map([book_id], |row| {
            let updated_at_unix: i64 = row.get(4)?;
            let updated_at_ms: Option<i64> = row.get(5)?;
            Ok(StoredReadingProgress {
                book_id: row.get(0)?,
                locator: row.get(1)?,
                progress_fraction: row.get(2)?,
                chapter_label: row.get(3)?,
                updated_at_unix,
                // Back-fill if an in-flight migration left this NULL.
                updated_at_ms: updated_at_ms.unwrap_or(updated_at_unix.saturating_mul(1000)),
            })
        })?;

        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn list_reading_progress(&self) -> Result<Vec<StoredReadingProgress>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT book_id, locator, progress_fraction, chapter_label, updated_at_unix, updated_at_ms
             FROM reading_progress
             ORDER BY updated_at_ms DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let updated_at_unix: i64 = row.get(4)?;
            let updated_at_ms: Option<i64> = row.get(5)?;
            Ok(StoredReadingProgress {
                book_id: row.get(0)?,
                locator: row.get(1)?,
                progress_fraction: row.get(2)?,
                chapter_label: row.get(3)?,
                updated_at_unix,
                updated_at_ms: updated_at_ms.unwrap_or(updated_at_unix.saturating_mul(1000)),
            })
        })?;

        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_memory_db() -> SpineStore {
        SpineStore::open(":memory:").expect("Failed to create memory db")
    }

    #[test]
    fn test_insert_triple_and_dictionary_caching() {
        let store = setup_memory_db();

        // Insert initial triple
        store.insert_triple("s1", "p1", "o1", "g1").unwrap();
        assert_eq!(store.count_triples().unwrap(), 1);

        // Verify terms and graphs were created
        let term_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM terms", [], |r| r.get(0))
            .unwrap();
        assert_eq!(term_count, 3); // s1, p1, o1

        let graph_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM graphs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(graph_count, 1); // g1

        // Insert duplicate triple - count should not change due to INSERT OR IGNORE
        store.insert_triple("s1", "p1", "o1", "g1").unwrap();
        assert_eq!(store.count_triples().unwrap(), 1);

        // Insert overlapping triple to test caching
        store.insert_triple("s1", "p2", "o1", "g1").unwrap();
        assert_eq!(store.count_triples().unwrap(), 2);

        let new_term_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM terms", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_term_count, 4); // Only p2 was added

        let new_graph_count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM graphs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_graph_count, 1); // Graph unchanged

        // Retrieve triples to verify
        let triples = store.get_triples("g1").unwrap();
        assert_eq!(triples.len(), 2);
        assert!(triples.contains(&("s1".to_string(), "p1".to_string(), "o1".to_string())));
        assert!(triples.contains(&("s1".to_string(), "p2".to_string(), "o1".to_string())));
    }

    #[test]
    fn test_replace_graph_is_atomic_at_graph_level() {
        let store = setup_memory_db();
        let graph_uri = "g1";
        let subject_predicate = "http://id.loc.gov/ontologies/bibframe/subject";

        store
            .insert_graph_triples(
                graph_uri,
                &[
                    ("s1".to_string(), "p1".to_string(), "o1".to_string()),
                    (
                        "s1".to_string(),
                        subject_predicate.to_string(),
                        "old-subject".to_string(),
                    ),
                ],
            )
            .unwrap();

        store
            .replace_graph(
                graph_uri,
                &[(
                    "s2".to_string(),
                    subject_predicate.to_string(),
                    "new-subject".to_string(),
                )],
            )
            .unwrap();

        let triples = store.get_triples(graph_uri).unwrap();
        assert_eq!(triples.len(), 1);
        assert_eq!(
            triples[0],
            (
                "s2".to_string(),
                subject_predicate.to_string(),
                "new-subject".to_string()
            )
        );

        let old_subject_count: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM mv_book_subjects WHERE subject_value = ?",
                ["old-subject"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_subject_count, 0);
    }

    #[test]
    fn test_upsert_and_list_reading_progress() {
        let store = setup_memory_db();

        store
            .upsert_reading_progress(
                "book-1",
                "epubcfi(/6/2[chapter]!/4/1:0)",
                Some(0.25),
                Some("Chapter 1"),
            )
            .unwrap();
        store
            .upsert_reading_progress(
                "book-1",
                "epubcfi(/6/4[chapter]!/4/1:0)",
                Some(0.5),
                Some("Chapter 2"),
            )
            .unwrap();

        let saved = store.get_reading_progress("book-1").unwrap().unwrap();
        assert_eq!(saved.locator, "epubcfi(/6/4[chapter]!/4/1:0)");
        assert_eq!(saved.progress_fraction, Some(0.5));
        assert_eq!(saved.chapter_label.as_deref(), Some("Chapter 2"));
        assert!(saved.updated_at_ms > 0, "ms timestamp should be populated");
        assert_eq!(
            saved.updated_at_unix,
            saved.updated_at_ms / 1000,
            "seconds field must be derived from ms field"
        );

        let all = store.list_reading_progress().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].book_id, "book-1");
    }

    #[test]
    fn test_reading_progress_ms_resolution_and_monotonicity() {
        let store = setup_memory_db();

        // Two writes on the same book in quick succession. Even if the wall
        // clock returns the same millisecond value (rare but possible on
        // low-resolution clocks), the monotonic helper must push the second
        // write's `updated_at_ms` strictly above the first.
        store
            .upsert_reading_progress("book-a", "loc-1", Some(0.1), None)
            .unwrap();
        let first = store.get_reading_progress("book-a").unwrap().unwrap();

        store
            .upsert_reading_progress("book-a", "loc-2", Some(0.2), None)
            .unwrap();
        let second = store.get_reading_progress("book-a").unwrap().unwrap();

        assert!(
            second.updated_at_ms > first.updated_at_ms,
            "second write must have strictly greater ms timestamp ({} vs {})",
            second.updated_at_ms,
            first.updated_at_ms
        );

        // Two books written back-to-back must also get distinct ms values
        // even when the wall clock hasn't ticked between writes.
        store
            .upsert_reading_progress("book-b", "loc-x", None, None)
            .unwrap();
        store
            .upsert_reading_progress("book-c", "loc-y", None, None)
            .unwrap();
        let all = store.list_reading_progress().unwrap();
        let mut timestamps: Vec<i64> = all.iter().map(|p| p.updated_at_ms).collect();
        timestamps.sort();
        timestamps.dedup();
        assert_eq!(
            timestamps.len(),
            all.len(),
            "every row must have a distinct updated_at_ms"
        );

        // List is ordered by ms DESC.
        let ordered: Vec<i64> = all.iter().map(|p| p.updated_at_ms).collect();
        let mut expected = ordered.clone();
        expected.sort_by(|a, b| b.cmp(a));
        assert_eq!(ordered, expected, "list must be sorted by ms DESC");
    }

    #[test]
    fn test_clamp_ms_monotonic_seeded_above_wall_bumps_strictly() {
        // When `prev_max` is set to a value far in the future (clock-forward
        // scenario, or replicated state from another host), the clamp MUST
        // bump by at least 1 ms rather than returning the wall-clock value.
        let future = 10_000_000_000_000_i64; // year 2286 in ms
        let clamped = SpineStore::clamp_ms_monotonic(future);
        assert!(
            clamped > future,
            "clamp must bump strictly above a future prev_max ({} !> {})",
            clamped,
            future
        );
        assert_eq!(clamped, future + 1);
    }

    #[test]
    fn test_upsert_reading_progress_concurrent_writers_produce_distinct_ms() {
        // Two threads each own their own rusqlite Connection pointing at the
        // same on-disk file. They race to upsert different books. The
        // BEGIN IMMEDIATE guard inside `upsert_reading_progress` must
        // serialise the SELECT MAX + INSERT pair so both rows land with
        // strictly distinct `updated_at_ms` values.
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("concurrent.db");
        let path_str = db_path.to_str().unwrap().to_string();

        // Prime the schema on a single connection first so both threads see
        // the reading_progress table.
        let _ = SpineStore::open(&path_str).unwrap();

        let path_a = path_str.clone();
        let path_b = path_str.clone();

        let handle_a = std::thread::spawn(move || {
            let store = SpineStore::open(&path_a).unwrap();
            for i in 0..20 {
                store
                    .upsert_reading_progress(
                        "book-thread-a",
                        &format!("loc-a-{}", i),
                        Some(i as f64 / 20.0),
                        None,
                    )
                    .unwrap();
            }
        });

        let handle_b = std::thread::spawn(move || {
            let store = SpineStore::open(&path_b).unwrap();
            for i in 0..20 {
                store
                    .upsert_reading_progress(
                        "book-thread-b",
                        &format!("loc-b-{}", i),
                        Some(i as f64 / 20.0),
                        None,
                    )
                    .unwrap();
            }
        });

        handle_a.join().unwrap();
        handle_b.join().unwrap();

        let store = SpineStore::open(&path_str).unwrap();
        let all = store.list_reading_progress().unwrap();
        assert_eq!(all.len(), 2, "both book rows should exist");
        // After concurrent upserts, each book holds exactly one row (upsert
        // semantics). What we care about is that the final stored ms values
        // are both present and are not identical; i.e. the internal clamp +
        // reserved-lock pair never produced two writes at the same ms.
        assert_ne!(
            all[0].updated_at_ms, all[1].updated_at_ms,
            "concurrent upserts must yield distinct ms timestamps"
        );
    }

    #[test]
    fn test_reading_progress_migration_backfills_ms_from_legacy_rows() {
        // Simulate an old DB: create the legacy schema manually, insert a
        // row with only `updated_at_unix`, then reopen via SpineStore::open
        // and verify the migration populated `updated_at_ms`.
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("legacy.db");
        let path_str = db_path.to_str().unwrap();

        {
            let conn = Connection::open(path_str).unwrap();
            conn.execute(
                "CREATE TABLE reading_progress (
                    book_id TEXT PRIMARY KEY,
                    locator TEXT NOT NULL,
                    progress_fraction REAL,
                    chapter_label TEXT,
                    updated_at_unix INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO reading_progress (book_id, locator, progress_fraction, chapter_label, updated_at_unix)
                 VALUES ('legacy-book', 'loc', 0.1, NULL, 1700000000)",
                [],
            )
            .unwrap();
        }

        let store = SpineStore::open(path_str).unwrap();
        let row = store.get_reading_progress("legacy-book").unwrap().unwrap();
        assert_eq!(row.updated_at_unix, 1_700_000_000);
        assert_eq!(row.updated_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn test_get_triples_batch_returns_triples_for_both_graphs() {
        let store = setup_memory_db();

        store
            .insert_graph_triples(
                "urn:spine:graph:book:aaa",
                &[
                    ("s1".to_string(), "p1".to_string(), "o1".to_string()),
                    ("s1".to_string(), "p2".to_string(), "o2".to_string()),
                ],
            )
            .unwrap();
        store
            .insert_graph_triples(
                "urn:spine:graph:book:bbb",
                &[("s2".to_string(), "p1".to_string(), "o3".to_string())],
            )
            .unwrap();

        let batch = store
            .get_triples_batch(&["urn:spine:graph:book:aaa", "urn:spine:graph:book:bbb"])
            .unwrap();

        let triples_a = batch.get("urn:spine:graph:book:aaa").unwrap();
        assert_eq!(triples_a.len(), 2, "graph aaa should have 2 triples");
        assert!(triples_a.contains(&("s1".to_string(), "p1".to_string(), "o1".to_string())));
        assert!(triples_a.contains(&("s1".to_string(), "p2".to_string(), "o2".to_string())));

        let triples_b = batch.get("urn:spine:graph:book:bbb").unwrap();
        assert_eq!(triples_b.len(), 1, "graph bbb should have 1 triple");
        assert!(triples_b.contains(&("s2".to_string(), "p1".to_string(), "o3".to_string())));
    }

    #[test]
    fn test_get_triples_batch_empty_input_returns_empty_map() {
        let store = setup_memory_db();
        let batch = store.get_triples_batch(&[]).unwrap();
        assert!(batch.is_empty());
    }

    /// Inserts 1001 graphs each with a single triple, then calls
    /// `get_triples_batch` with all 1001 URIs. Without chunking, SQLite
    /// (pre-3.32) would return SQLITE_ERROR for the >999-variable IN list.
    /// With BATCH_CHUNK_SIZE = 500 the call issues three queries (500+500+1)
    /// and merges the results.
    #[test]
    fn test_get_triples_batch_chunks_beyond_999_variables() {
        let store = setup_memory_db();

        let num_graphs = 1001usize;
        let uris: Vec<String> = (0..num_graphs)
            .map(|i| format!("urn:spine:graph:book:{:04}", i))
            .collect();

        // Insert one triple per graph. Use a fixed subject/predicate and a
        // per-graph object so we can verify each graph individually.
        for (i, uri) in uris.iter().enumerate() {
            store
                .insert_graph_triples(
                    uri,
                    &[(
                        "urn:subject".to_string(),
                        "urn:predicate".to_string(),
                        format!("urn:object:{}", i),
                    )],
                )
                .unwrap();
        }

        let uri_refs: Vec<&str> = uris.iter().map(|s| s.as_str()).collect();
        let batch = store.get_triples_batch(&uri_refs).unwrap();

        assert_eq!(
            batch.len(),
            num_graphs,
            "all {} graphs must appear in the merged result",
            num_graphs
        );

        for (i, uri) in uris.iter().enumerate() {
            let triples = batch
                .get(uri.as_str())
                .unwrap_or_else(|| panic!("graph {} missing from batch result", uri));
            assert_eq!(
                triples.len(),
                1,
                "graph {} should have exactly 1 triple",
                uri
            );
            assert_eq!(
                triples[0],
                (
                    "urn:subject".to_string(),
                    "urn:predicate".to_string(),
                    format!("urn:object:{}", i),
                ),
                "graph {} has wrong triple",
                uri
            );
        }
    }

    /// Verifies the three idempotency properties of `migrate_reading_progress_ms`:
    ///
    /// 1. Freshly-opened `:memory:` DB → `user_version` is stamped to 1.
    /// 2. Legacy on-disk DB (column absent) → migrated and stamped to 1.
    /// 3. Second open of an already-migrated DB → version check returns early;
    ///    `user_version` remains 1 and no UPDATE runs (observable by checking
    ///    the row count is unchanged from a prior known state).
    #[test]
    fn test_migrate_reading_progress_ms_idempotent_skip() {
        // Property 1: fresh DB gets version = 1.
        let store = setup_memory_db();
        let version: i32 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version, 1,
            "fresh DB must be stamped at user_version = 1 after setup_schema"
        );

        // Property 2: legacy DB (no ms column) is migrated and stamped.
        let temp_dir = tempfile::tempdir().unwrap();
        let legacy_path = temp_dir.path().join("legacy_idem.db");
        let path_str = legacy_path.to_str().unwrap();

        {
            let conn = Connection::open(path_str).unwrap();
            // Create the legacy schema without updated_at_ms.
            conn.execute(
                "CREATE TABLE reading_progress (
                    book_id TEXT PRIMARY KEY,
                    locator TEXT NOT NULL,
                    progress_fraction REAL,
                    chapter_label TEXT,
                    updated_at_unix INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO reading_progress
                 (book_id, locator, progress_fraction, chapter_label, updated_at_unix)
                 VALUES ('b1', 'loc', 0.1, NULL, 1700000000)",
                [],
            )
            .unwrap();
            // user_version stays 0.
        }

        let store2 = SpineStore::open(path_str).unwrap();
        let v2: i32 = store2
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, 1, "legacy DB must be stamped at user_version = 1 after open");

        let row = store2.get_reading_progress("b1").unwrap().unwrap();
        assert_eq!(
            row.updated_at_ms, 1_700_000_000_000,
            "back-fill must convert seconds to ms"
        );

        // Property 3: second open returns without re-running the UPDATE.
        // We verify this indirectly: insert a row with an intentionally wrong
        // ms value after the first open, then reopen — if the migration skips
        // (as it should) the bad value survives; if it wrongly re-runs the
        // UPDATE it would overwrite the bad value with the correct one.
        store2
            .conn
            .execute(
                "UPDATE reading_progress SET updated_at_ms = 99999 WHERE book_id = 'b1'",
                [],
            )
            .unwrap();
        drop(store2);

        let store3 = SpineStore::open(path_str).unwrap();
        let v3: i32 = store3
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v3, 1, "user_version must remain 1 on second open");

        let row3 = store3.get_reading_progress("b1").unwrap().unwrap();
        assert_eq!(
            row3.updated_at_ms, 99999,
            "migration must not re-run on an already-migrated DB (idempotent skip)"
        );
    }

    #[test]
    fn test_insert_graph_triples_tx_graph_hoisted_same_graph_many_triples() {
        // Verifies that the hoisted graph-id path in insert_graph_triples_tx
        // correctly inserts all triples under the same graph URI.
        let store = setup_memory_db();
        let triples: Vec<(String, String, String)> = (0..10)
            .map(|i| (format!("s{i}"), format!("p{i}"), format!("o{i}")))
            .collect();
        store.insert_graph_triples("urn:test:g1", &triples).unwrap();
        let stored = store.get_triples("urn:test:g1").unwrap();
        assert_eq!(stored.len(), 10, "all 10 triples should land under the same graph");
        // All retrieved triples must be exactly what was inserted.
        for (s, p, o) in &triples {
            assert!(stored.contains(&(s.clone(), p.clone(), o.clone())));
        }
    }

    /// Verifies `clamp_ms_monotonic` in a clock-backward scenario.
    ///
    /// The seeded-above-wall test (`test_clamp_ms_monotonic_seeded_above_wall_bumps_strictly`)
    /// proves the helper handles a far-future `prev_max` (e.g. replicated state).
    /// This test proves the same invariant for the specific case where the wall
    /// clock has moved backward relative to `prev_max` by a small delta (5 seconds),
    /// which is the realistic NTP slew or VM resume scenario.
    #[test]
    fn test_clamp_ms_monotonic_backward_clock() {
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        // Simulate a clock that is 5 seconds ahead of what wall_ms currently
        // reads — the scenario where the previous write happened on a clock 5s
        // fast, then NTP corrected it backward.
        let prev_max = wall_ms + 5_000;
        let clamped = SpineStore::clamp_ms_monotonic(prev_max);

        assert!(
            clamped > prev_max,
            "clamp must bump strictly above prev_max even when wall < prev_max ({} <= {}, clamped = {})",
            wall_ms,
            prev_max,
            clamped
        );
        assert_eq!(
            clamped,
            prev_max + 1,
            "the exact bump must be prev_max + 1 (not more) to keep the sequence tight"
        );
    }

    /// Verifies that `get_triples_batch` is absent-key for unknown URIs.
    ///
    /// The frontend's hydration code treats a missing map key as "no graph yet"
    /// and renders the book without bibliographic metadata. If the batch query
    /// accidentally returned an empty `Vec` for unknown URIs, the frontend
    /// would receive a populated key with zero triples and could silently skip
    /// re-enrichment for books that have never been ingested.
    #[test]
    fn test_get_triples_batch_partial_miss() {
        let store = setup_memory_db();

        // Seed 10 graphs, 3 triples each.
        let known_uris: Vec<String> = (0..10)
            .map(|i| format!("urn:spine:graph:book:{:04}", i))
            .collect();
        for (i, uri) in known_uris.iter().enumerate() {
            store
                .insert_graph_triples(
                    uri,
                    &[
                        (format!("s{i}"), "p:type".to_string(), format!("o{i}-a")),
                        (format!("s{i}"), "p:title".to_string(), format!("o{i}-b")),
                        (format!("s{i}"), "p:date".to_string(), format!("o{i}-c")),
                    ],
                )
                .unwrap();
        }

        // Query with 15 URIs: 10 known + 5 that were never inserted.
        let mut query_uris: Vec<String> = known_uris.clone();
        for j in 10..15 {
            query_uris.push(format!("urn:spine:graph:book:unknown-{j}"));
        }
        let uri_refs: Vec<&str> = query_uris.iter().map(|s| s.as_str()).collect();

        let batch = store.get_triples_batch(&uri_refs).unwrap();

        // Exactly the 10 known URIs must appear as keys.
        assert_eq!(
            batch.len(),
            10,
            "batch result must have exactly 10 keys (one per known graph)"
        );

        // All 5 unknown URIs must be absent — not present with an empty Vec.
        for j in 10..15 {
            let missing = format!("urn:spine:graph:book:unknown-{j}");
            assert!(
                !batch.contains_key(missing.as_str()),
                "unknown URI {} must not appear in the batch result",
                missing
            );
        }

        // Each known URI must have exactly 3 triples.
        for uri in &known_uris {
            let triples = batch
                .get(uri.as_str())
                .unwrap_or_else(|| panic!("known URI {} missing from batch result", uri));
            assert_eq!(
                triples.len(),
                3,
                "each known graph should have 3 triples, {} has {}",
                uri,
                triples.len()
            );
        }
    }

    /// Verifies the partial-migration guard: rows that already have a non-NULL
    /// `updated_at_ms` value must not be overwritten by the back-fill UPDATE,
    /// even when the migration is triggered by `user_version = 0`.
    ///
    /// The back-fill SQL is:
    ///   UPDATE reading_progress SET updated_at_ms = updated_at_unix * 1000
    ///   WHERE updated_at_ms IS NULL
    ///
    /// This test documents the intent: the `WHERE updated_at_ms IS NULL`
    /// predicate is load-bearing. If someone changes the migration to an
    /// unconditional UPDATE, this test catches the regression.
    ///
    /// The scenario modelled here is a partial migration: the `updated_at_ms`
    /// column was added by a previous run but `user_version` was never stamped
    /// (e.g. the process was killed between the ALTER TABLE and the PRAGMA).
    /// The row has an intentionally disagreeing ms value — it is not
    /// `updated_at_unix * 1000`. The migration must leave that value intact.
    #[test]
    fn test_partial_migration_preserves_existing_ms() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("partial_migration.db");
        let path_str = db_path.to_str().unwrap();

        // Set up a DB that looks like a partial migration:
        // - updated_at_ms column exists (ALTER TABLE was done)
        // - user_version is still 0 (PRAGMA stamp was not reached)
        // - one row has updated_at_ms populated with a value that disagrees
        //   with updated_at_unix * 1000
        {
            let conn = Connection::open(path_str).unwrap();
            conn.execute(
                "CREATE TABLE reading_progress (
                    book_id TEXT PRIMARY KEY,
                    locator TEXT NOT NULL,
                    progress_fraction REAL,
                    chapter_label TEXT,
                    updated_at_unix INTEGER NOT NULL,
                    updated_at_ms INTEGER
                )",
                [],
            )
            .unwrap();

            // updated_at_unix = 1_000_000 → naive back-fill would write 1_000_000_000.
            // We seed a distinct value (42) to detect if the back-fill touched it.
            conn.execute(
                "INSERT INTO reading_progress
                 (book_id, locator, progress_fraction, chapter_label,
                  updated_at_unix, updated_at_ms)
                 VALUES ('partial-book', 'loc/partial', 0.3, NULL, 1000000, 42)",
                [],
            )
            .unwrap();
            // user_version stays 0 — migration will re-enter.
        }

        // Reopening triggers migrate_reading_progress_ms. It must see
        // updated_at_ms IS NOT NULL for our row and skip the back-fill.
        let store = SpineStore::open(path_str).unwrap();

        let row = store
            .get_reading_progress("partial-book")
            .unwrap()
            .unwrap();

        assert_eq!(
            row.updated_at_ms, 42,
            "migration must not overwrite an existing non-NULL updated_at_ms; \
             the WHERE updated_at_ms IS NULL predicate must be preserved"
        );
    }

    use std::time::Instant;

    #[test]
    #[ignore]
    fn test_sqlite_scale() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("scale.db");

        let store = SpineStore::open(db_path.to_str().unwrap()).unwrap();

        store
            .conn
            .execute_batch(
                "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -64000;",
            )
            .unwrap();

        let start = Instant::now();
        let num_books = 10_000;
        let triples_per_book = 500;

        let tx = store.conn.unchecked_transaction().unwrap();
        let mut term_cache = std::collections::HashMap::<String, i64>::new();
        let mut term_id_counter = 1;
        let mut get_term_id = |val: &str| -> i64 {
            *term_cache.entry(val.to_string()).or_insert_with(|| {
                let id = term_id_counter;
                term_id_counter += 1;
                id
            })
        };

        {
            let mut term_stmt = tx
                .prepare("INSERT INTO terms (id, value) VALUES (?, ?)")
                .unwrap();
            let p_title = get_term_id("http://id.loc.gov/ontologies/bibframe/mainTitle");
            let p_author = get_term_id("http://id.loc.gov/ontologies/bibframe/agent");
            let p_subject = get_term_id("http://id.loc.gov/ontologies/bibframe/subject");

            term_stmt
                .insert(rusqlite::params![
                    p_title,
                    "http://id.loc.gov/ontologies/bibframe/mainTitle"
                ])
                .unwrap();
            term_stmt
                .insert(rusqlite::params![
                    p_author,
                    "http://id.loc.gov/ontologies/bibframe/agent"
                ])
                .unwrap();
            term_stmt
                .insert(rusqlite::params![
                    p_subject,
                    "http://id.loc.gov/ontologies/bibframe/subject"
                ])
                .unwrap();
        }

        {
            let mut triple_stmt = tx.prepare("INSERT INTO triples (subject_id, predicate_id, object_id, graph_id) VALUES (?, ?, ?, ?)").unwrap();
            let mut term_stmt = tx
                .prepare("INSERT INTO terms (id, value) VALUES (?, ?)")
                .unwrap();
            let mut graph_stmt = tx
                .prepare("INSERT INTO graphs (id, uri) VALUES (?, ?)")
                .unwrap();
            let mut mv_stmt = tx
                .prepare("INSERT INTO mv_book_subjects (book_uri, subject_value) VALUES (?, ?)")
                .unwrap();

            let p_title = get_term_id("http://id.loc.gov/ontologies/bibframe/mainTitle");
            let p_author = get_term_id("http://id.loc.gov/ontologies/bibframe/agent");
            let p_subject = get_term_id("http://id.loc.gov/ontologies/bibframe/subject");

            for i in 0..num_books {
                let graph_uri = format!("urn:loc:work:{}", i);
                let graph_id = i as i64 + 1;
                graph_stmt
                    .insert(rusqlite::params![graph_id, graph_uri])
                    .unwrap();

                let s_val = format!("urn:loc:work:{}", i);
                let s_id = get_term_id(&s_val);
                term_stmt.insert(rusqlite::params![s_id, s_val]).unwrap();

                for j in 0..triples_per_book {
                    let o_val = format!("Object {} for book {}", j, i);
                    let o_id = get_term_id(&o_val);
                    term_stmt.insert(rusqlite::params![o_id, &o_val]).unwrap();

                    let p_id = match j % 3 {
                        0 => p_title,
                        1 => p_author,
                        _ => {
                            mv_stmt
                                .insert(rusqlite::params![&graph_uri, &o_val])
                                .unwrap();
                            p_subject
                        }
                    };

                    triple_stmt
                        .insert(rusqlite::params![s_id, p_id, o_id, graph_id])
                        .unwrap();
                }
            }
        }

        tx.commit().unwrap();
        println!(
            "Inserted {} triples in {:?}",
            num_books * triples_per_book,
            start.elapsed()
        );

        let query_start = Instant::now();
        let graph_uri = "urn:loc:work:5000";
        let _triples = store.get_triples(graph_uri).unwrap();
        let query_time = query_start.elapsed();
        println!("Query time for single book graph: {:?}", query_time);

        let subject_query_start = Instant::now();
        let mut stmt = store
            .conn
            .prepare(
                "
            SELECT book_uri 
            FROM mv_book_subjects
            WHERE subject_value = 'Object 2 for book 5000'
        ",
            )
            .unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut count = 0;
        while let Some(_) = rows.next().unwrap() {
            count += 1;
        }
        let subject_query_time = subject_query_start.elapsed();
        println!(
            "Query time for finding books by subject: {:?}",
            subject_query_time
        );
        assert_eq!(count, 1);
        assert!(
            subject_query_time.as_millis() < 100,
            "Query is too slow! ({}ms)",
            subject_query_time.as_millis()
        );
    }
}
