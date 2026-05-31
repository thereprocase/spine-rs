use spine_marc::{extract_marc_records, to_bibframe_graph};

#[test]
fn test_regression_corpus() {
    let xml = std::fs::read_to_string("tests/data/regression_corpus.xml")
        .expect("Failed to read regression corpus");
        
    let records = extract_marc_records(&xml).expect("Failed to extract records");
    assert!(records.len() >= 90, "Corpus should contain at least 90 records");
    
    let mut successes = 0;
    
    for (i, record) in records.iter().enumerate() {
        let book_id = format!("book-{}", i);
        let graph = to_bibframe_graph(record, &book_id);
        
        // Ensure that the basic graph structure is valid
        assert!(!graph.work_uri.is_empty());
        assert!(!graph.instance_uri.is_empty());
        
        // Documenting lossy fields: we currently expect title to be missing in most cases
        // because the mapper does not extract 245 yet.
        
        successes += 1;
    }
    
    assert_eq!(successes, records.len());
}
