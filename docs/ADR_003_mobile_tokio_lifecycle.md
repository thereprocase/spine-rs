# ADR 003: Mobile Tokio Lifecycle and Job Queue Abstraction

## Context
When running the `spine-srv` rust core on mobile platforms (via Tauri or direct ffi), the OS aggressively suspends and terminates background processes. Standard `tokio::spawn` tasks handling long-running operations (like EPUB format conversions, metadata fetching, or syncing) will be abruptly killed when the app goes into the background, leading to data corruption or incomplete operations.

## Decision
We are introducing a `JobQueue` abstraction that decouples job dispatch from execution. 

### Architecture
1. **`JobQueue` Trait**: A Rust trait defining asynchronous job submission.
   ```rust
   #[async_trait]
   pub trait JobQueue: Send + Sync {
       async fn dispatch(&self, job: Job) -> Result<JobId, Error>;
   }
   ```
2. **`Job` Enum**: Represents all possible background tasks (e.g., `Job::ConvertFormat { book_id, to_format }`, `Job::SyncRemote`).
3. **Desktop/Local Implementation**: `LocalJobQueue` which just spawns a `tokio::spawn` task and manages it locally, suitable for Desktop and local development.
4. **Mobile implementations (Future)**: 
   - `AndroidWorkManagerQueue`: Uses JNI/FFI to dispatch a `OneTimeWorkRequest` to Android's `WorkManager`.
   - `IOSBackgroundTasksQueue`: Uses `BGTaskScheduler` via FFI on iOS.

## Implementation Plan
- Create `core/spine-srv/src/jobs.rs` with the `Job` enum and `JobQueue` trait.
- Implement `LocalJobQueue`.
- Expose the queue via `AppState` so route handlers can dispatch jobs rather than using `tokio::spawn` directly.
