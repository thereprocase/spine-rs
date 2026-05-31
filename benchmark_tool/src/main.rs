use rusqlite::{Connection, Result};
use std::time::Instant;
use calibre_db::CalibreLibrary;

fn create_db() -> Result<()> {
    let _ = std::fs::remove_file("test_large.db");
    let conn = Connection::open("test_large.db")?;
    conn.execute(
        "CREATE TABLE books (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            uuid TEXT NOT NULL,
            pubdate TEXT,
            series_index REAL,
            timestamp TEXT NOT NULL,
            last_modified TEXT NOT NULL,
            has_cover INTEGER,
            path TEXT NOT NULL
        )",
        (),
    )?;

    println!("Inserting 100,000 books...");
    let mut stmt = conn.prepare(
        "INSERT INTO books (title, uuid, pubdate, series_index, timestamp, last_modified, has_cover, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )?;

    conn.execute("BEGIN TRANSACTION", [])?;
    for i in 0..100_000 {
        stmt.execute((
            format!("Book Title {}", i),
            format!("uuid-{}", i),
            "2023-01-01",
            1.0,
            "2023-01-01",
            "2023-01-01",
            0,
            format!("/path/to/book/{}", i),
        ))?;
    }
    conn.execute("COMMIT", [])?;
    Ok(())
}

fn benchmark_list_find(lib: &CalibreLibrary, target_id: &str) -> Result<()> {
    let start = Instant::now();
    let books = lib.list_books().unwrap_or_default();
    let _book_opt = books.into_iter().find(|b| b.id.to_string() == target_id);
    println!("list_books + find took: {:?}", start.elapsed());
    Ok(())
}

fn benchmark_get_book(lib: &CalibreLibrary, target_id: i32) -> Result<()> {
    let start = Instant::now();
    let _book_opt = lib.get_book(target_id).unwrap_or_default();
    println!("get_book by id took: {:?}", start.elapsed());
    Ok(())
}

fn main() -> Result<()> {
    if !std::path::Path::new("test_large.db").exists() {
        create_db()?;
    }

    let lib = CalibreLibrary::open("test_large.db").unwrap();
    println!("Benchmarking getting ID 99999 by list_books + find...");
    benchmark_list_find(&lib, "99999")?;

    println!("Benchmarking getting ID 99999 by get_book...");
    benchmark_get_book(&lib, 99999)?;

    Ok(())
}
