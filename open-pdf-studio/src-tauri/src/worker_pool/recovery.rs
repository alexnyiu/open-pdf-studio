use super::spawn::spawn_worker;
use super::state::{Status, WorkerState};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CRASH_WINDOW: Duration = Duration::from_secs(30);
const MAX_CRASHES_IN_WINDOW: usize = 3;
const RESPAWN_DELAY: Duration = Duration::from_secs(1);

/// Called when WorkerPool::render detects an error talking to a worker.
/// Marks the worker Dead, schedules respawn after backoff, and tracks
/// crash count for the DeadPermanent threshold.
pub async fn handle_worker_crash(worker: Arc<WorkerState>, exe_path: PathBuf) {
    worker.set_status(Status::Dead);
    let crashes = worker.crashes.fetch_add(1, Ordering::Release) + 1;
    let now = Instant::now();

    let too_many = {
        let mut last = worker.last_crash_at.lock().await;
        let recent = last
            .map(|t| now.duration_since(t) < CRASH_WINDOW)
            .unwrap_or(false);
        *last = Some(now);
        recent && crashes >= MAX_CRASHES_IN_WINDOW
    };

    if too_many {
        worker.set_status(Status::DeadPermanent);
        eprintln!(
            "[recovery] worker {} crashed {}x in {:?} — marking DeadPermanent",
            worker.slot, crashes, CRASH_WINDOW
        );
        return;
    }

    eprintln!(
        "[recovery] worker {} crashed (#{}); respawning in {:?}",
        worker.slot, crashes, RESPAWN_DELAY
    );

    tokio::time::sleep(RESPAWN_DELAY).await;

    // Drain old handles
    *worker.child.lock().await = None;
    *worker.stdin.lock().await = None;
    *worker.stdout.lock().await = None;
    *worker.shm.lock().await = None;
    worker.queue_depth.store(0, Ordering::Release);

    match spawn_worker(worker.clone(), &exe_path).await {
        Ok(_) => eprintln!("[recovery] worker {} respawned", worker.slot),
        Err(e) => {
            eprintln!("[recovery] worker {} respawn failed: {}", worker.slot, e);
            worker.set_status(Status::Dead);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn three_quick_crashes_marks_permanent() {
        // Use a non-existent exe path so respawn always fails — we just
        // care about the crash counter / DeadPermanent transition.
        let worker = Arc::new(WorkerState::new(0));
        let bad_path = PathBuf::from("C:/does-not-exist.exe");

        // First crash: status Dead, respawn attempted (fails, set Dead again)
        handle_worker_crash(worker.clone(), bad_path.clone()).await;
        assert_eq!(worker.status(), Status::Dead);

        // Second crash within 30s: still Dead, not yet permanent
        handle_worker_crash(worker.clone(), bad_path.clone()).await;
        // crashes counter is 2 now

        // Third crash: should hit MAX_CRASHES_IN_WINDOW
        handle_worker_crash(worker.clone(), bad_path).await;
        assert_eq!(worker.status(), Status::DeadPermanent);
    }
}
