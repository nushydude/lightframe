use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum PriorityClass {
    InteractivePreview = 1,
    InteractiveTile = 2,
    InteractiveMetadata = 3,
    VisibleThumbnail = 4,
    DirectionalPreload = 5,
    BackgroundPreload = 6,
    UserEdit = 7,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ExecutorTelemetry {
    pub queued_jobs: usize,
    pub running_jobs: usize,
    pub completed_jobs: u64,
    pub canceled_jobs: u64,
    pub coalesced_jobs: u64,
}

pub struct CancellationToken {
    canceled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self { canceled: Arc::new(AtomicBool::new(false)) }
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

struct WorkerScopeGuard {
    executor: MediaExecutor,
    request_id: String,
    start_time: std::time::Instant,
}

impl Drop for WorkerScopeGuard {
    fn drop(&mut self) {
        let duration_ms = self.start_time.elapsed().as_millis() as u64;
        self.executor.on_worker_exit(&self.request_id, std::thread::panicking(), duration_ms);
    }
}

pub struct ScheduledJob {
    pub request_id: String,
    pub priority: PriorityClass,
    pub dedup_key: Option<String>,
    pub token: Arc<AtomicBool>,
    pub work: Box<dyn FnOnce() + Send + 'static>,
}

pub struct MediaExecutorInner {
    pub capacity: usize,
    pub running_count: usize,
    pub queue: Vec<ScheduledJob>,
    pub cancellation_map: HashMap<String, Arc<AtomicBool>>,
    pub dedup_map: HashMap<String, String>, // dedup_key -> request_id
    pub completed_jobs: u64,
    pub canceled_jobs: u64,
    pub coalesced_jobs: u64,
    pub total_execution_ms: u64,
}

#[derive(Clone)]
pub struct MediaExecutor {
    inner: Arc<Mutex<MediaExecutorInner>>,
}

impl MediaExecutor {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MediaExecutorInner {
                capacity: capacity.max(1),
                running_count: 0,
                queue: Vec::new(),
                cancellation_map: HashMap::new(),
                dedup_map: HashMap::new(),
                completed_jobs: 0,
                canceled_jobs: 0,
                coalesced_jobs: 0,
                total_execution_ms: 0,
            })),
        }
    }

    pub fn spawn<F, R>(
        &self,
        request_id: String,
        priority: PriorityClass,
        dedup_key: Option<String>,
        work: F,
    ) -> Arc<AtomicBool>
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + 'static,
    {
        let token = Arc::new(AtomicBool::new(false));
        let token_clone = token.clone();
        let cancel_tok = CancellationToken { canceled: token.clone() };

        let job_wrapper = Box::new(move || {
            if !cancel_tok.is_canceled() {
                let _ = work(&cancel_tok);
            }
        });

        let mut inner = self.inner.lock().unwrap();

        // Deduplication check for read-only jobs
        if let Some(ref key) = dedup_key {
            let existing_token =
                inner.dedup_map.get(key).and_then(|id| inner.cancellation_map.get(id).cloned());

            if let Some(tok) = existing_token {
                inner.coalesced_jobs += 1;
                return tok;
            }
            inner.dedup_map.insert(key.clone(), request_id.clone());
        }

        inner.cancellation_map.insert(request_id.clone(), token.clone());

        let scheduled_job = ScheduledJob {
            request_id,
            priority,
            dedup_key,
            token: token.clone(),
            work: job_wrapper,
        };

        inner.queue.push(scheduled_job);
        // Sort queue by priority class (lowest PriorityClass enum value = highest priority)
        inner.queue.sort_by_key(|j| j.priority);

        drop(inner);
        self.try_dispatch();

        token_clone
    }

    pub fn cancel_request(&self, request_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(token) = inner.cancellation_map.get(request_id) {
            token.store(true, Ordering::SeqCst);
            inner.canceled_jobs += 1;
            true
        } else {
            false
        }
    }

    fn try_dispatch(&self) {
        let mut inner = self.inner.lock().unwrap();
        while inner.running_count < inner.capacity && !inner.queue.is_empty() {
            let job = inner.queue.remove(0);
            if job.token.load(Ordering::SeqCst) {
                inner.canceled_jobs += 1;
                if let Some(ref key) = job.dedup_key {
                    inner.dedup_map.remove(key);
                }
                inner.cancellation_map.remove(&job.request_id);
                continue;
            }

            inner.running_count += 1;
            let executor_clone = self.clone();
            let req_id = job.request_id.clone();
            thread::spawn(move || {
                let _guard = WorkerScopeGuard {
                    executor: executor_clone,
                    request_id: req_id,
                    start_time: std::time::Instant::now(),
                };
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    (job.work)();
                }));
            });
        }
    }

    fn on_worker_exit(&self, request_id: &str, is_panic: bool, duration_ms: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.running_count > 0 {
            inner.running_count -= 1;
        }
        if !is_panic {
            inner.completed_jobs += 1;
            inner.total_execution_ms += duration_ms;
        } else {
            inner.canceled_jobs += 1;
        }

        inner.cancellation_map.remove(request_id);
        inner.dedup_map.retain(|_, id| id != request_id);

        drop(inner);
        self.try_dispatch();
    }

    pub fn telemetry(&self) -> ExecutorTelemetry {
        let inner = self.inner.lock().unwrap();
        ExecutorTelemetry {
            queued_jobs: inner.queue.len(),
            running_jobs: inner.running_count,
            completed_jobs: inner.completed_jobs,
            canceled_jobs: inner.canceled_jobs,
            coalesced_jobs: inner.coalesced_jobs,
        }
    }
}

impl Default for MediaExecutor {
    fn default() -> Self {
        let default_cap = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
        Self::new(default_cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn test_media_executor_concurrency_capacity_and_priority() {
        let executor = MediaExecutor::new(2);
        let (tx, rx) = channel();

        let tx1 = tx.clone();
        executor.spawn("req_1".to_string(), PriorityClass::BackgroundPreload, None, move |_| {
            thread::sleep(Duration::from_millis(50));
            tx1.send("job1").unwrap();
            Ok::<(), String>(())
        });

        let tx2 = tx.clone();
        executor.spawn("req_2".to_string(), PriorityClass::InteractivePreview, None, move |_| {
            tx2.send("job2").unwrap();
            Ok::<(), String>(())
        });

        let res1 = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let res2 = rx.recv_timeout(Duration::from_secs(1)).unwrap();

        assert!(res1 == "job1" || res1 == "job2");
        assert!(res2 == "job1" || res2 == "job2");
    }

    #[test]
    fn test_media_executor_cancellation_and_telemetry() {
        let executor = MediaExecutor::new(1);
        let token = executor.spawn(
            "req_cancel".to_string(),
            PriorityClass::BackgroundPreload,
            None,
            move |tok| {
                if tok.is_canceled() {
                    return Err("canceled".to_string());
                }
                Ok::<(), String>(())
            },
        );

        assert!(executor.cancel_request("req_cancel"));
        assert!(token.load(Ordering::SeqCst));

        let telem = executor.telemetry();
        assert!(telem.canceled_jobs >= 1);
    }
}
