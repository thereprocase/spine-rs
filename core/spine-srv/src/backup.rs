//! Library backup endpoint implementation per Sprint 9.1.
//!
//! `POST /api/v1/library/backup` dispatches a `Job::Backup` that:
//!   1. Resolves source DB paths via the existing
//!      `CalibreLibrary::metadata_db_path()` + `SpineStore::database_path()`
//!      accessors (both in-memory aware — return `None` for `:memory:`).
//!   2. Creates the destination directory if missing (idempotent).
//!   3. Runs `VACUUM INTO` for each on-disk source DB. Skips any source
//!      that is in-memory.
//!   4. Records the result via `record_backup` in this module's
//!      process-singleton `OnceLock<Mutex<Option<BackupInfo>>>` so
//!      `GET /api/v1/library/backup/last` can serve it.
//!
//! The module-level static is intentional — the alternative (an
//! `AppState.last_backup` field) would force a 6-site constructor
//! fan-out (spine-srv main.rs + ingest.rs + 2 lib.rs tests + api_v1
//! test helper + apps/desktop/src-tauri). Same pattern as the storage
//! TTL cache committed in `293cae4` per Session 6.
//!
//! V0 scope (this commit): emit two `.db` files (`metadata-<ts>.db`,
//! `spine-<ts>.db`) directly into the destination directory using
//! ISO-8601 UTC timestamps so multiple backups co-exist without
//! overwriting. **ZIP bundling** per
//! `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md §G` and **cover walk** are
//! follow-on (Sprint 9 polish).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Recorded result of the most recent successful backup. Surfaced by
/// `GET /api/v1/library/backup/last` and consumed by the desktop
/// Settings → Backup tile to render the "last backup at" line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// UNIX-ms timestamp of the backup completion.
    pub at_ms: i64,
    /// Destination directory the user requested (echoed in POST 202).
    pub dest_path: String,
    /// Sum of bytes written into the destination this run. Useful for
    /// the Settings tile + free-space-hint heuristic.
    pub size_bytes: u64,
    /// UUID of the dispatched `Job::Backup` that produced this entry —
    /// lets the frontend correlate with `GET /api/v1/jobs/:id` history.
    pub job_id: String,
}

static LAST_BACKUP: OnceLock<Mutex<Option<BackupInfo>>> = OnceLock::new();

fn last_cell() -> &'static Mutex<Option<BackupInfo>> {
    LAST_BACKUP.get_or_init(|| Mutex::new(None))
}

/// Record a successful backup. Called from inside the `Job::Backup`
/// dispatch arm after both `VACUUM INTO` operations complete.
pub fn record_backup(info: BackupInfo) {
    *last_cell().lock().expect("last-backup mutex poisoned") = Some(info);
}

/// Read the most recent recorded backup, or `None` if no backup has
/// completed since process start. Process-scoped — does not survive
/// restarts. Persistence is a Sprint 9 polish item.
pub fn last_backup() -> Option<BackupInfo> {
    last_cell()
        .lock()
        .expect("last-backup mutex poisoned")
        .clone()
}

/// Run the backup synchronously on the current task. Caller is expected
/// to invoke this from `tokio::task::spawn_blocking` from a
/// `Job::Backup` arm in `jobs.rs` so the rusqlite calls don't block the
/// async runtime.
pub fn run_backup(
    dest_dir: PathBuf,
    metadata_db_src: Option<PathBuf>,
    spine_db_src: Option<PathBuf>,
    job_id: String,
) -> Result<BackupInfo, String> {
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("create_dir_all({}): {e}", dest_dir.display()))?;

    let ts = Utc::now();
    let suffix = ts.format("%Y%m%dT%H%M%SZ").to_string();
    let mut total_bytes: u64 = 0;

    if let Some(src) = metadata_db_src.as_ref() {
        let dest_file = dest_dir.join(format!("metadata-{suffix}.db"));
        vacuum_into(src, &dest_file)?;
        total_bytes += std::fs::metadata(&dest_file).map(|m| m.len()).unwrap_or(0);
    }
    if let Some(src) = spine_db_src.as_ref() {
        let dest_file = dest_dir.join(format!("spine-{suffix}.db"));
        vacuum_into(src, &dest_file)?;
        total_bytes += std::fs::metadata(&dest_file).map(|m| m.len()).unwrap_or(0);
    }

    let info = BackupInfo {
        at_ms: ts.timestamp_millis(),
        dest_path: dest_dir.to_string_lossy().into_owned(),
        size_bytes: total_bytes,
        job_id,
    };
    record_backup(info.clone());
    Ok(info)
}

/// Open `src` with rusqlite and emit a clean defragmented copy at
/// `dest`. `VACUUM INTO` does NOT support parameter binding for the
/// path so we SQL-escape single quotes and reject any path containing
/// a NUL byte (which would terminate the C-string the underlying
/// SQLite call uses, allowing path-truncation injection).
fn vacuum_into(src: &Path, dest: &Path) -> Result<(), String> {
    let dest_str = dest
        .to_str()
        .ok_or_else(|| format!("dest path is not valid UTF-8: {}", dest.display()))?;
    if dest_str.contains('\0') {
        return Err("dest path contains NUL byte — refusing to interpolate".to_string());
    }
    let escaped = dest_str.replace('\'', "''");
    let conn = rusqlite::Connection::open(src)
        .map_err(|e| format!("open({}): {e}", src.display()))?;
    conn.execute(&format!("VACUUM INTO '{escaped}'"), [])
        .map_err(|e| format!("VACUUM INTO failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_temp() -> tempfile::TempDir {
        // Reset module state between tests so they don't leak into
        // each other. The OnceLock value persists for the test
        // process; reset the inner Mutex content to None.
        *last_cell().lock().unwrap() = None;
        tempfile::tempdir().expect("tempdir")
    }

    /// VACUUM INTO produces a file whose size equals the source's
    /// page-aligned content (≤ source size, but always > 0).
    #[test]
    fn vacuum_into_copies_db_file() {
        let temp = fresh_temp();
        let src = temp.path().join("src.db");
        let dest = temp.path().join("dest.db");

        // Seed src with a tiny SQLite DB
        let conn = rusqlite::Connection::open(&src).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);",
        )
        .unwrap();
        drop(conn);

        vacuum_into(&src, &dest).expect("vacuum_into ok");

        let dest_size = std::fs::metadata(&dest).unwrap().len();
        assert!(dest_size > 0, "VACUUM INTO output should be non-empty");

        // Round-trip — open the dest and verify the row count
        let dest_conn = rusqlite::Connection::open(&dest).unwrap();
        let n: i64 = dest_conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3, "rows must round-trip through VACUUM INTO");
    }

    #[test]
    fn vacuum_into_rejects_nul_byte_in_dest() {
        let temp = fresh_temp();
        let src = temp.path().join("src.db");
        rusqlite::Connection::open(&src)
            .unwrap()
            .execute_batch("CREATE TABLE t (x INTEGER)")
            .unwrap();

        let bad_dest = PathBuf::from("/tmp/with\0nul.db");
        let result = vacuum_into(&src, &bad_dest);
        assert!(
            matches!(result, Err(msg) if msg.contains("NUL byte")),
            "NUL byte in dest path must be rejected before SQL"
        );
    }

    #[test]
    fn run_backup_with_no_sources_emits_record_with_zero_bytes() {
        let temp = fresh_temp();
        let dest = temp.path().join("backups");
        let info = run_backup(dest.clone(), None, None, "job-uuid".to_string()).expect("ok");

        assert_eq!(info.size_bytes, 0, "no sources → zero bytes copied");
        assert!(
            info.dest_path.contains("backups"),
            "dest_path echoes the requested dir"
        );
        assert!(info.at_ms > 0, "at_ms must be positive unix-ms");
        assert!(dest.is_dir(), "dest dir must be created idempotently");
        assert_eq!(
            last_backup().as_ref().map(|i| i.size_bytes),
            Some(0),
            "module record must be set"
        );
    }

    #[test]
    fn run_backup_copies_metadata_only_when_spine_in_memory() {
        let temp = fresh_temp();
        let metadata_src = temp.path().join("metadata.db");
        rusqlite::Connection::open(&metadata_src)
            .unwrap()
            .execute_batch("CREATE TABLE books (id INT)")
            .unwrap();

        let dest = temp.path().join("out");
        let info = run_backup(
            dest.clone(),
            Some(metadata_src),
            None, // spine in-memory → skipped
            "job-2".to_string(),
        )
        .expect("ok");

        assert!(info.size_bytes > 0, "metadata copy must contribute bytes");
        let entries: Vec<_> = std::fs::read_dir(&dest)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1, "only one .db emitted; got {entries:?}");
        assert!(
            entries[0].starts_with("metadata-") && entries[0].ends_with(".db"),
            "filename pattern: metadata-<ts>.db; got {}",
            entries[0]
        );
    }

    #[test]
    fn last_backup_returns_none_before_any_run() {
        // Reset state explicitly (other tests may have run first in
        // an arbitrary order; cargo test is unordered).
        *last_cell().lock().unwrap() = None;
        assert!(last_backup().is_none());
    }
}
