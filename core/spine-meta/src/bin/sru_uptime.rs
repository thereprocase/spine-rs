use spine_meta::LocClient;
use std::time::{Duration, Instant};
use std::fs::OpenOptions;
use std::io::Write;
use tokio::time::sleep;

#[tokio::main]
async fn main() {
    let client = LocClient::new().expect("Failed to construct LocClient");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open("sru_uptime_log.csv")
        .unwrap();

    println!("Starting 72-hour SRU Uptime Characterization...");
    writeln!(file, "timestamp,query,latency_ms,status_code,error").unwrap();

    let queries = [
        "dc.title=\"The Origin of Species\"",
        "dc.creator=\"Tolstoy, Leo\"",
        "dc.subject=\"Biology\"",
        "bath.isbn=\"9780140449136\"",
    ];

    let mut query_idx = 0;
    
    // For a real 72 hour test, loop infinitely or until 72 hours
    loop {
        let query = queries[query_idx % queries.len()];
        let start = Instant::now();
        
        match client.search(query).await {
            Ok(_) => {
                let latency = start.elapsed().as_millis();
                println!("[OK] Latency: {}ms", latency);
                writeln!(file, "{},\"{}\",{},200,", chrono::Utc::now().to_rfc3339(), query, latency).unwrap();
            }
            Err(e) => {
                let latency = start.elapsed().as_millis();
                println!("[ERROR] Latency: {}ms - {}", latency, e);
                writeln!(file, "{},\"{}\",{},500,\"{}\"", chrono::Utc::now().to_rfc3339(), query, latency, e).unwrap();
            }
        }
        
        query_idx += 1;
        
        // Sleep for 5 seconds between queries to avoid getting banned
        sleep(Duration::from_secs(5)).await;
    }
}
