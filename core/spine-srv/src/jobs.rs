use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::sync::Arc;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Job {
    IngestEpub {
        path: std::path::PathBuf,
        cleanup: bool,
    },
    ConvertFormat {
        book_id: Uuid,
        target_format: String,
    },
    FetchMetadata {
        book_id: Uuid,
    },
    /// Sprint 9: copy metadata.db + spine.db to a destination directory
    /// via `VACUUM INTO`. Each source is `Option<PathBuf>` so that
    /// in-memory databases (typical in tests) are skipped without
    /// failing the job.
    Backup {
        dest_dir: std::path::PathBuf,
        metadata_db_src: Option<std::path::PathBuf>,
        spine_db_src: Option<std::path::PathBuf>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", content = "result", rename_all = "camelCase")]
pub enum JobStatus {
    Pending,
    Running,
    Completed(String), // e.g. newly created book UUID
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobId(pub Uuid);

#[async_trait]
pub trait JobQueue: Send + Sync {
    async fn dispatch(&self, job: Job, app_state: Arc<AppState>) -> Result<JobId, String>;
}

pub struct LocalJobQueue;

#[async_trait]
impl JobQueue for LocalJobQueue {
    async fn dispatch(&self, job: Job, app_state: Arc<AppState>) -> Result<JobId, String> {
        let job_id = JobId(Uuid::new_v4());
        let id_clone = job_id.0;
        
        // Mark as pending
        app_state.job_status.lock().await.insert(id_clone, JobStatus::Pending);
        
        let state_clone = Arc::clone(&app_state);

        tokio::spawn(async move {
            tracing::info!("Executing background job: {:?}", job);
            state_clone.job_status.lock().await.insert(id_clone, JobStatus::Running);

            match job {
                Job::IngestEpub { path, cleanup } => {
                    match crate::ingest::ingest_epub(&path, &state_clone).await {
                        Ok(book_id) => {
                            state_clone.job_status.lock().await.insert(id_clone, JobStatus::Completed(book_id.to_string()));
                        }
                        Err(e) => {
                            state_clone.job_status.lock().await.insert(id_clone, JobStatus::Failed(e.to_string()));
                        }
                    }
                    if cleanup {
                        let _ = tokio::fs::remove_file(path).await;
                    }
                    // Record terminal timestamp for TTL eviction.
                    state_clone.record_job_terminal(id_clone).await;
                }
                Job::Backup { dest_dir, metadata_db_src, spine_db_src } => {
                    // VACUUM INTO is sync rusqlite — shift to the
                    // blocking thread pool so the async runtime stays
                    // responsive while a large library is being copied.
                    let job_id_str = id_clone.to_string();
                    let result = tokio::task::spawn_blocking(move || {
                        crate::backup::run_backup(
                            dest_dir,
                            metadata_db_src,
                            spine_db_src,
                            job_id_str,
                        )
                    })
                    .await;
                    match result {
                        Ok(Ok(_info)) => {
                            state_clone.job_status.lock().await.insert(
                                id_clone,
                                JobStatus::Completed("backup".to_string()),
                            );
                        }
                        Ok(Err(e)) => {
                            state_clone.job_status.lock().await.insert(id_clone, JobStatus::Failed(e));
                        }
                        Err(e) => {
                            state_clone.job_status.lock().await.insert(
                                id_clone,
                                JobStatus::Failed(format!("backup task panicked: {e}")),
                            );
                        }
                    }
                    state_clone.record_job_terminal(id_clone).await;
                }
                _ => {
                    // Not implemented yet
                    state_clone.job_status.lock().await.insert(id_clone, JobStatus::Failed("Not implemented".to_string()));
                    // Record terminal timestamp for TTL eviction.
                    state_clone.record_job_terminal(id_clone).await;
                }
            }
        });
        
        Ok(job_id)
    }
}
