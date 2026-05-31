use calibre_db::CalibreLibrary;
use spine_db::SpineStore;

#[test]
fn test_in_memory_stores_open() {
    let lib = CalibreLibrary::open(":memory:");
    assert!(lib.is_ok(), "calibre in-memory connection should open");

    let store = SpineStore::open(":memory:").expect("spine in-memory store should open");
    assert_eq!(store.count_triples().unwrap(), 0);
}
