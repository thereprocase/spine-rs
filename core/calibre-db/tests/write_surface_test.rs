//! Integration tests for the D4/D5 durable write substrate.
//!
//! These tests set up a minimal calibre-schema `metadata.db` and a
//! spine-schema `spine.db`, drive edits through `LibrarySession`, and verify
//! that partial failures roll back BOTH sides — the "no silent data loss"
//! invariant.

use calibre_db::{BookUpdate, CalibreLibrary, DualDbPaths, LibrarySession};
use chrono::Utc;
use rusqlite::Connection;
use spine_api::{AgentLink, BibliographicGraph, Book, LegacyMetadata, Work};
use spine_db::SpineStore;
use std::path::Path;
use tempfile::tempdir;

/// Creates a minimal calibre `metadata.db` — just enough schema for the
/// write surface under test. Real calibre dbs have FTS, custom columns,
/// and triggers that populate sort columns automatically; we supply `sort`
/// explicitly from Rust so the tests stay hermetic.
fn create_calibre_db(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE books (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            sort TEXT,
            timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f+00:00', 'now')),
            pubdate TEXT,
            series_index REAL DEFAULT 1.0,
            author_sort TEXT,
            isbn TEXT DEFAULT '',
            lccn TEXT DEFAULT '',
            path TEXT NOT NULL DEFAULT '',
            flags INTEGER NOT NULL DEFAULT 1,
            uuid TEXT,
            has_cover INTEGER DEFAULT 0,
            last_modified TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f+00:00', 'now'))
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
        CREATE TABLE series (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            sort TEXT
        );
        CREATE TABLE books_series_link (
            id INTEGER PRIMARY KEY,
            book INTEGER NOT NULL,
            series INTEGER NOT NULL
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
        CREATE TABLE languages (
            id INTEGER PRIMARY KEY,
            lang_code TEXT NOT NULL UNIQUE
        );
        CREATE TABLE books_languages_link (
            id INTEGER PRIMARY KEY,
            book INTEGER NOT NULL,
            lang_code INTEGER NOT NULL,
            item_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE data (
            id INTEGER PRIMARY KEY,
            book INTEGER NOT NULL,
            format TEXT NOT NULL,
            uncompressed_size INTEGER DEFAULT 0,
            name TEXT NOT NULL
        );
        CREATE TABLE comments (
            id INTEGER PRIMARY KEY,
            book INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE TABLE identifiers (
            id INTEGER PRIMARY KEY,
            book INTEGER NOT NULL,
            type TEXT NOT NULL,
            val TEXT NOT NULL
        );
        ",
    )
    .unwrap();
}

/// Insert a seed book with uuid. Returns the book id.
fn seed_book(calibre_path: &Path, uuid: &str, title: &str, rel_path: &str) -> i64 {
    let conn = Connection::open(calibre_path).unwrap();
    conn.execute(
        "INSERT INTO books (title, uuid, path, sort, author_sort) VALUES (?, ?, ?, ?, '')",
        rusqlite::params![title, uuid, rel_path, title],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn sample_graph(book_uuid: &str, title: &str, author: &str) -> BibliographicGraph {
    BibliographicGraph {
        work_uri: format!("urn:spine:work:{}", book_uuid),
        instance_uri: format!("urn:spine:instance:{}", book_uuid),
        work: Work {
            uri: format!("urn:spine:work:{}", book_uuid),
            title: Some(title.to_string()),
            origin_date: None,
            subjects: vec![],
            creators: vec![AgentLink {
                uri: format!("urn:spine:agent:{}", author.replace(' ', "_")),
                name: author.to_string(),
                role: "creator".to_string(),
            }],
            language: None,
            lccn: None,
            ddc: None,
        },
        instances: vec![],
    }
}

fn sample_book(title: &str, authors: Vec<&str>) -> Book {
    Book {
        id: uuid::Uuid::new_v4(),
        title: title.to_string(),
        authors: authors.into_iter().map(String::from).collect(),
        legacy_metadata: LegacyMetadata {
            publisher: Some("Test Publisher".to_string()),
            pub_date: Some("2026".to_string()),
            series: None,
            series_index: None,
            tags: vec!["tag one".to_string(), "tag two".to_string()],
            description: Some("A useful description.".to_string()),
            has_cover: false,
        },
        bibliographic_graph: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    paths: DualDbPaths,
    library_path: String,
}

fn fresh_fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let calibre = dir.path().join("metadata.db");
    let spine = dir.path().join("spine.db");
    create_calibre_db(&calibre);
    // Bootstrap spine schema on its own connection, then drop — the session
    // opens a fresh ATTACH connection for write-time dispatch.
    let _ = SpineStore::open(spine.to_str().unwrap()).unwrap();

    Fixture {
        library_path: dir.path().to_string_lossy().into_owned(),
        paths: DualDbPaths {
            calibre_db: calibre.to_string_lossy().into_owned(),
            spine_db: spine.to_string_lossy().into_owned(),
        },
        _dir: dir,
    }
}

#[test]
fn insert_book_persists_import_metadata_surface() {
    let fx = fresh_fixture();
    let library = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();
    let book = sample_book("Imported Book", vec!["Jane Doe", "John Smith"]);

    library.insert_book(&book).unwrap();

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let author_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM authors", [], |r| r.get(0))
        .unwrap();
    let link_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books_authors_link", [], |r| r.get(0))
        .unwrap();
    let author_sort: String = conn
        .query_row(
            "SELECT author_sort FROM books WHERE uuid = ?",
            [book.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let tag_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books_tags_link", [], |r| r.get(0))
        .unwrap();
    let publisher_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books_publishers_link", [], |r| {
            r.get(0)
        })
        .unwrap();
    let comment: String = conn
        .query_row("SELECT text FROM comments", [], |r| r.get(0))
        .unwrap();

    assert_eq!(author_count, 2);
    assert_eq!(link_count, 2);
    assert_eq!(author_sort, "Doe, Jane & Smith, John");
    assert_eq!(tag_count, 2);
    assert_eq!(publisher_count, 1);
    assert_eq!(comment, "A useful description.");
}

#[test]
fn insert_imported_epub_copies_file_and_registers_format() {
    let fx = fresh_fixture();
    let source = fx._dir.path().join("source.epub");
    std::fs::write(&source, b"fake epub bytes").unwrap();
    let library = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();
    let book = sample_book("Imported/File: Book", vec!["Jane/Author"]);

    let projection = library.insert_imported_epub(&book, &source).unwrap();

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let (format, name, size): (String, String, i64) = conn
        .query_row(
            "SELECT format, name, uncompressed_size FROM data",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let copied = Path::new(&fx.library_path)
        .join(&projection.path)
        .join(format!("{name}.epub"));

    assert_eq!(format, "EPUB");
    assert_eq!(size, b"fake epub bytes".len() as i64);
    assert!(
        copied.exists(),
        "imported EPUB must be copied to library layout"
    );
}

#[test]
fn apply_metadata_update_happy_path_writes_both_dbs() {
    let fx = fresh_fixture();
    let uuid = "11111111-1111-1111-1111-111111111111";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Old Title",
        "Author/Book (1)",
    );

    let graph = sample_graph(uuid, "New Title", "Jane Doe");
    let update = BookUpdate {
        title: Some("New Title".to_string()),
        authors: Some(vec!["Jane Doe".to_string()]),
        ..Default::default()
    };

    let mut session = LibrarySession::open(&fx.paths, fx.library_path.clone()).unwrap();
    session
        .apply_metadata_update(uuid, &graph, &update)
        .unwrap();
    drop(session);

    // Calibre projection landed.
    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let (title, sort, author_sort): (String, String, String) = conn
        .query_row(
            "SELECT title, sort, author_sort FROM books WHERE uuid = ?",
            [uuid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "New Title");
    // books.sort goes through calibre_title_sort — no leading article, so
    // the title passes through unchanged.
    assert_eq!(sort, "New Title");
    assert_eq!(author_sort, "Doe, Jane");

    let author_row_sort: String = conn
        .query_row(
            "SELECT sort FROM authors WHERE name = ?",
            ["Jane Doe"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(author_row_sort, "Doe, Jane");

    // Graph landed in spine.db.
    let store = SpineStore::open(&fx.paths.spine_db).unwrap();
    let triples = store
        .get_triples(&LibrarySession::graph_uri_for(uuid))
        .unwrap();
    assert!(
        triples.iter().any(|(_, _, o)| o == "New Title"),
        "expected title triple in spine.db, got {:?}",
        triples
    );
    assert!(
        triples.iter().any(|(_, _, o)| o == "Jane Doe"),
        "expected author label triple in spine.db, got {:?}",
        triples
    );
}

#[test]
fn calibre_projection_failure_rolls_back_graph() {
    // Drive a failure from the calibre side: delete the book row out from
    // under us so update_book_tx fails on the "WHERE uuid = ?" lookup. Then
    // verify the graph did NOT land in spine.db.
    let fx = fresh_fixture();
    let uuid = "22222222-2222-2222-2222-222222222222";

    let graph = sample_graph(uuid, "Phantom", "Ghost Author");
    let update = BookUpdate {
        title: Some("Phantom".to_string()),
        ..Default::default()
    };

    // NOTE: we never seed the book. `update_book_tx` will raise
    // QueryReturnedNoRows. The graph write runs first, so its side effect
    // must roll back.
    let mut session = LibrarySession::open(&fx.paths, fx.library_path.clone()).unwrap();
    let err = session.apply_metadata_update(uuid, &graph, &update);
    assert!(err.is_err(), "expected failure when book uuid is unknown");
    drop(session);

    let store = SpineStore::open(&fx.paths.spine_db).unwrap();
    let triples = store
        .get_triples(&LibrarySession::graph_uri_for(uuid))
        .unwrap();
    assert!(
        triples.is_empty(),
        "graph must have rolled back after calibre projection failed; got {:?}",
        triples
    );
}

#[test]
fn graph_only_edit_with_empty_projection_still_commits_atomically() {
    // The "authority reconcile changes URIs but not any surface field" case.
    // projection = default (all None) — session should still replace the
    // graph but leave calibre untouched.
    let fx = fresh_fixture();
    let uuid = "33333333-3333-3333-3333-333333333333";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Reconcile Title",
        "Author/Reconcile (1)",
    );

    let graph = sample_graph(uuid, "Reconcile Title", "Reconcile Author");
    let update = BookUpdate::default();

    let mut session = LibrarySession::open(&fx.paths, fx.library_path.clone()).unwrap();
    session
        .apply_metadata_update(uuid, &graph, &update)
        .unwrap();
    drop(session);

    // Graph is present; calibre title is unchanged.
    let store = SpineStore::open(&fx.paths.spine_db).unwrap();
    let triples = store
        .get_triples(&LibrarySession::graph_uri_for(uuid))
        .unwrap();
    assert!(!triples.is_empty());

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let title: String = conn
        .query_row("SELECT title FROM books WHERE uuid = ?", [uuid], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "Reconcile Title");
}

#[test]
fn delete_book_without_files_clears_rows_only() {
    let fx = fresh_fixture();
    let uuid = "44444444-4444-4444-4444-444444444444";
    let rel_path = "Author/Book (1)";
    seed_book(Path::new(&fx.paths.calibre_db), uuid, "To Delete", rel_path);

    // Create the book folder + a dummy file on disk.
    let book_dir = Path::new(&fx.library_path).join(rel_path);
    std::fs::create_dir_all(&book_dir).unwrap();
    std::fs::write(book_dir.join("Book.epub"), b"fake").unwrap();

    // Seed a graph so the delete has something to remove from spine.db too.
    let mut session = LibrarySession::open(&fx.paths, fx.library_path.clone()).unwrap();
    let graph = sample_graph(uuid, "To Delete", "Author One");
    let update = BookUpdate::default();
    session
        .apply_metadata_update(uuid, &graph, &update)
        .unwrap();

    let deleted = session.delete_book_with_graph(uuid, false).unwrap();
    drop(session);

    assert_eq!(deleted.uuid, uuid);
    assert_eq!(deleted.path, rel_path);
    assert!(
        deleted.deleted_files.is_empty(),
        "delete_files=false must not report any files"
    );

    // DB rows gone.
    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books WHERE uuid = ?", [uuid], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);

    // On-disk file still there.
    assert!(
        book_dir.join("Book.epub").exists(),
        "file must remain on disk when delete_files=false"
    );

    // Graph gone.
    let store = SpineStore::open(&fx.paths.spine_db).unwrap();
    let triples = store
        .get_triples(&LibrarySession::graph_uri_for(uuid))
        .unwrap();
    assert!(triples.is_empty(), "graph triples should have been removed");
}

#[test]
fn delete_book_with_files_removes_disk_folder() {
    let fx = fresh_fixture();
    let uuid = "55555555-5555-5555-5555-555555555555";
    let rel_path = "Author/Book With Files (2)";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "To Delete With Files",
        rel_path,
    );

    let book_dir = Path::new(&fx.library_path).join(rel_path);
    std::fs::create_dir_all(&book_dir).unwrap();
    std::fs::write(book_dir.join("Book.epub"), b"fake").unwrap();
    std::fs::write(book_dir.join("cover.jpg"), b"jpg").unwrap();

    let mut session = LibrarySession::open(&fx.paths, fx.library_path.clone()).unwrap();
    let deleted = session.delete_book_with_graph(uuid, true).unwrap();
    drop(session);

    assert_eq!(deleted.deleted_files.len(), 2);
    assert!(!book_dir.exists(), "book directory must be removed");
}

#[test]
fn authors_sort_is_maintained_on_update() {
    let fx = fresh_fixture();
    let uuid = "66666666-6666-6666-6666-666666666666";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Some Book",
        "Author/Some (1)",
    );

    // The instruction's explicit example: add "John Smith" as an author and
    // verify authors.sort = "Smith, John".
    let update = BookUpdate {
        authors: Some(vec!["John Smith".to_string()]),
        ..Default::default()
    };

    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();
    lib.update_book(uuid, &update).unwrap();
    drop(lib);

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let sort: String = conn
        .query_row(
            "SELECT sort FROM authors WHERE name = ?",
            ["John Smith"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sort, "Smith, John");
}

#[test]
fn books_sort_is_maintained_on_title_rename() {
    let fx = fresh_fixture();
    let uuid = "77777777-7777-7777-7777-777777777777";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Some Other Book",
        "Author/Other (1)",
    );

    let update = BookUpdate {
        title: Some("The Hobbit".to_string()),
        ..Default::default()
    };
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();
    lib.update_book(uuid, &update).unwrap();
    drop(lib);

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let sort: String = conn
        .query_row("SELECT sort FROM books WHERE uuid = ?", [uuid], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(sort, "Hobbit, The");
}

#[test]
fn update_replaces_collections_not_merges() {
    let fx = fresh_fixture();
    let uuid = "88888888-8888-8888-8888-888888888888";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Collection Book",
        "Author/Collection (1)",
    );

    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();
    lib.update_book(
        uuid,
        &BookUpdate {
            tags: Some(vec!["alpha".to_string(), "beta".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    lib.update_book(
        uuid,
        &BookUpdate {
            tags: Some(vec!["gamma".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let book_id: i64 = conn
        .query_row("SELECT id FROM books WHERE uuid = ?", [uuid], |r| r.get(0))
        .unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t \
             JOIN books_tags_link btl ON btl.tag = t.id \
             WHERE btl.book = ? ORDER BY t.name",
        )
        .unwrap();
    let tags: Vec<String> = stmt
        .query_map([book_id], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(tags, vec!["gamma".to_string()]);
}

#[test]
fn facet_listers_count_and_order_correctly() {
    let fx = fresh_fixture();
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();

    let a_uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let b_uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let c_uuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    seed_book(Path::new(&fx.paths.calibre_db), a_uuid, "A", "A/A");
    seed_book(Path::new(&fx.paths.calibre_db), b_uuid, "B", "B/B");
    seed_book(Path::new(&fx.paths.calibre_db), c_uuid, "C", "C/C");

    lib.update_book(
        a_uuid,
        &BookUpdate {
            tags: Some(vec!["rust".to_string(), "sci-fi".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();
    lib.update_book(
        b_uuid,
        &BookUpdate {
            tags: Some(vec!["rust".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();
    lib.update_book(
        c_uuid,
        &BookUpdate {
            tags: Some(vec!["rust".to_string(), "history".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    let tags = lib.list_tags().unwrap();
    // rust has 3 books, history/sci-fi have 1 each, tied at 1 break by name
    // ASC → history before sci-fi.
    let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["rust", "history", "sci-fi"]);
    assert_eq!(tags[0].book_count, 3);
    assert_eq!(tags[1].book_count, 1);
    assert_eq!(tags[2].book_count, 1);
}

#[test]
fn search_books_is_case_insensitive_across_title_author_tag() {
    let fx = fresh_fixture();
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();

    let a = "a1111111-0000-0000-0000-000000000001";
    let b = "b1111111-0000-0000-0000-000000000002";
    let c = "c1111111-0000-0000-0000-000000000003";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        a,
        "The Rust Programming Language",
        "A/A",
    );
    seed_book(
        Path::new(&fx.paths.calibre_db),
        b,
        "Programming Erlang",
        "B/B",
    );
    seed_book(Path::new(&fx.paths.calibre_db), c, "Dune", "C/C");

    lib.update_book(
        b,
        &BookUpdate {
            authors: Some(vec!["Joe Armstrong".to_string()]),
            tags: Some(vec!["rust".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();
    lib.update_book(
        c,
        &BookUpdate {
            authors: Some(vec!["Frank Herbert".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    // Title hit — case-insensitive.
    let hits = lib.search_books("RUST", None, None).unwrap();
    let ids: Vec<String> = hits.iter().map(|b| b.id.to_string()).collect();
    assert!(ids.contains(&a.to_string()), "title hit missing: {:?}", ids);
    assert!(
        ids.contains(&b.to_string()),
        "tag hit missing (rust tag on book B): {:?}",
        ids
    );
    assert!(!ids.contains(&c.to_string()));

    // Author hit.
    let hits = lib.search_books("herbert", None, None).unwrap();
    let ids: Vec<String> = hits.iter().map(|b| b.id.to_string()).collect();
    assert_eq!(ids, vec![c.to_string()]);

    // Empty query returns the full list.
    let all = lib.search_books("", None, None).unwrap();
    assert_eq!(all.len(), 3);
}

#[test]
fn series_clear_passes_via_outer_some_inner_none() {
    let fx = fresh_fixture();
    let uuid = "ee000000-0000-0000-0000-000000000001";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Series Book",
        "A/Series (1)",
    );
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();

    // Set a series.
    lib.update_book(
        uuid,
        &BookUpdate {
            series: Some(Some("Foundation".to_string())),
            ..Default::default()
        },
    )
    .unwrap();

    // Confirm link row exists.
    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let book_id: i64 = conn
        .query_row("SELECT id FROM books WHERE uuid = ?", [uuid], |r| r.get(0))
        .unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM books_series_link WHERE book = ?",
            [book_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);

    // Clear the series.
    lib.update_book(
        uuid,
        &BookUpdate {
            series: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM books_series_link WHERE book = ?",
            [book_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn pubdate_carries_through() {
    let fx = fresh_fixture();
    let uuid = "ff000000-0000-0000-0000-000000000001";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Dated Book",
        "A/Dated (1)",
    );
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();

    let dt = Utc::now();
    lib.update_book(
        uuid,
        &BookUpdate {
            pubdate: Some(Some(dt)),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let stored: Option<String> = conn
        .query_row("SELECT pubdate FROM books WHERE uuid = ?", [uuid], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(stored.is_some());
    assert!(stored
        .unwrap()
        .starts_with(&dt.format("%Y-%m-%d").to_string()));
}

#[test]
fn languages_update_populates_link_with_item_order() {
    let fx = fresh_fixture();
    let uuid = "12121212-0000-0000-0000-000000000001";
    seed_book(
        Path::new(&fx.paths.calibre_db),
        uuid,
        "Polyglot",
        "A/Poly (1)",
    );
    let lib = CalibreLibrary::open(&fx.paths.calibre_db).unwrap();

    lib.update_book(
        uuid,
        &BookUpdate {
            languages: Some(vec!["eng".to_string(), "fra".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = Connection::open(&fx.paths.calibre_db).unwrap();
    let book_id: i64 = conn
        .query_row("SELECT id FROM books WHERE uuid = ?", [uuid], |r| r.get(0))
        .unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT l.lang_code, bll.item_order \
             FROM languages l JOIN books_languages_link bll ON bll.lang_code = l.id \
             WHERE bll.book = ? ORDER BY bll.item_order",
        )
        .unwrap();
    let rows: Vec<(String, i64)> = stmt
        .query_map([book_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![("eng".into(), 1), ("fra".into(), 2)]);
}
