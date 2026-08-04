use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoalescingPolicy {
    ByContentKey,
    Never,
}

impl PriorityClass {
    pub fn max_concurrent_workers(&self, total_capacity: usize) -> usize {
        match self {
            PriorityClass::InteractivePreview => total_capacity,
            PriorityClass::InteractiveTile => (total_capacity / 2).max(1),
            PriorityClass::InteractiveMetadata => (total_capacity / 2).max(1),
            PriorityClass::VisibleThumbnail => (total_capacity / 2).max(1),
            PriorityClass::DirectionalPreload => (total_capacity / 4).max(1),
            PriorityClass::BackgroundPreload => (total_capacity / 4).max(1),
            PriorityClass::UserEdit => total_capacity,
        }
    }
}

use std::collections::VecDeque;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ExecutorTelemetry {
    pub queued_jobs: usize,
    pub running_jobs: usize,
    pub completed_jobs: u64,
    pub canceled_jobs: u64,
    pub coalesced_jobs: u64,
    pub p50_execution_ms: u64,
    pub p95_execution_ms: u64,
    pub p99_execution_ms: u64,
    pub average_queue_wait_ms: u64,
    pub canceled_by_class: HashMap<String, u64>,
}

#[derive(Clone)]
pub struct CancellationToken {
    state: Arc<AtomicU8>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self { state: Arc::new(AtomicU8::new(0)) }
    }

    pub fn is_canceled(&self) -> bool {
        self.state.load(Ordering::SeqCst) == 1
    }

    pub fn cancel(&self) -> bool {
        self.state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    pub fn try_commit(&self) -> bool {
        self.state.compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

pub type AnyResult = Result<Arc<dyn std::any::Any + Send + Sync>, String>;
pub type ListenerCallback = Box<dyn FnOnce(AnyResult) + Send + 'static>;
pub type WorkRunnerFn = Box<dyn FnOnce(&CancellationToken) -> AnyResult + Send + 'static>;

pub struct SubscriberState {
    pub consumer_id: String,
    pub token: Arc<AtomicBool>,
    pub callback: ListenerCallback,
}

pub struct ActiveJob {
    pub job_key: String,
    pub priority: PriorityClass,
    pub queued_at: std::time::Instant,
    pub cancel_token: CancellationToken,
    pub subscribers: Vec<SubscriberState>,
    pub work_runner: Option<WorkRunnerFn>,
}

pub struct MediaExecutorInner {
    pub capacity: usize,
    pub running_count: usize,
    pub running_by_class: HashMap<PriorityClass, usize>,
    pub queue: Vec<ActiveJob>,
    pub running_jobs: HashMap<String, ActiveJob>,
    pub consumer_to_job: HashMap<String, String>,
    pub consumer_owner: HashMap<String, String>,
    pub completed_jobs: u64,
    pub canceled_jobs: u64,
    pub coalesced_jobs: u64,
    pub execution_durations: VecDeque<u64>,
    pub queue_wait_durations: VecDeque<u64>,
    pub canceled_by_class: HashMap<String, u64>,
    pub is_shutdown: bool,
    pub worker_handles: Vec<std::thread::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct MediaExecutor {
    inner: Arc<Mutex<MediaExecutorInner>>,
}

fn create_listener<R: Send + Sync + Clone + 'static>(
    tx: std::sync::mpsc::Sender<Result<R, String>>,
) -> ListenerCallback {
    Box::new(move |res: AnyResult| {
        let typed_res = match res {
            Ok(arc_any) => match arc_any.downcast::<R>() {
                Ok(arc_r) => Ok((*arc_r).clone()),
                Err(_) => Err("Downcast failed".to_string()),
            },
            Err(err) => Err(err),
        };
        let _ = tx.send(typed_res);
    })
}

impl MediaExecutor {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MediaExecutorInner {
                capacity: capacity.max(1),
                running_count: 0,
                running_by_class: HashMap::new(),
                queue: Vec::new(),
                running_jobs: HashMap::new(),
                consumer_to_job: HashMap::new(),
                consumer_owner: HashMap::new(),
                completed_jobs: 0,
                canceled_jobs: 0,
                coalesced_jobs: 0,
                execution_durations: VecDeque::new(),
                queue_wait_durations: VecDeque::new(),
                canceled_by_class: HashMap::new(),
                is_shutdown: false,
                worker_handles: Vec::new(),
            })),
        }
    }

    pub fn spawn<F, R>(
        &self,
        consumer_id: String,
        priority: PriorityClass,
        job_key: String,
        work: F,
    ) -> (Arc<AtomicBool>, std::sync::mpsc::Receiver<Result<R, String>>)
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + Sync + Clone + 'static,
    {
        self.spawn_with_channel(consumer_id, priority, job_key, work)
    }

    pub fn spawn_with_channel<F, R>(
        &self,
        consumer_id: String,
        priority: PriorityClass,
        job_key: String,
        work: F,
    ) -> (Arc<AtomicBool>, std::sync::mpsc::Receiver<Result<R, String>>)
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + Sync + Clone + 'static,
    {
        self.spawn_with_channel_owner(consumer_id, priority, job_key, None, work)
    }

    pub fn spawn_with_channel_owner<F, R>(
        &self,
        consumer_id: String,
        priority: PriorityClass,
        job_key: String,
        owner_window: Option<String>,
        work: F,
    ) -> (Arc<AtomicBool>, std::sync::mpsc::Receiver<Result<R, String>>)
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + Sync + Clone + 'static,
    {
        self.spawn_with_policy_owner(
            consumer_id,
            priority,
            job_key,
            owner_window,
            CoalescingPolicy::ByContentKey,
            work,
        )
    }

    pub fn spawn_uncoalesced_with_channel_owner<F, R>(
        &self,
        consumer_id: String,
        priority: PriorityClass,
        job_key: String,
        owner_window: Option<String>,
        work: F,
    ) -> (Arc<AtomicBool>, std::sync::mpsc::Receiver<Result<R, String>>)
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + Sync + Clone + 'static,
    {
        self.spawn_with_policy_owner(
            consumer_id,
            priority,
            job_key,
            owner_window,
            CoalescingPolicy::Never,
            work,
        )
    }

    fn spawn_with_policy_owner<F, R>(
        &self,
        consumer_id: String,
        priority: PriorityClass,
        content_key: String,
        owner_window: Option<String>,
        coalescing: CoalescingPolicy,
        work: F,
    ) -> (Arc<AtomicBool>, std::sync::mpsc::Receiver<Result<R, String>>)
    where
        F: FnOnce(&CancellationToken) -> Result<R, String> + Send + 'static,
        R: Send + Sync + Clone + 'static,
    {
        let job_key = if coalescing == CoalescingPolicy::Never {
            format!("{}::unshared::{}", content_key, uuid::Uuid::new_v4().simple())
        } else {
            content_key
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let sub_token = Arc::new(AtomicBool::new(false));
        let sub_token_clone = sub_token.clone();

        let mut inner = self.inner.lock().unwrap();
        if inner.is_shutdown {
            let _ = tx.send(Err("Executor is shutdown".to_string()));
            return (sub_token_clone, rx);
        }

        let owner = owner_window.unwrap_or_else(|| "main".to_string());
        let scoped_id = format!("{}::{}", owner, consumer_id);
        if inner.consumer_to_job.contains_key(&scoped_id) {
            let _ = tx.send(Err(format!(
                "Duplicate live media request ID '{}' for window '{}'",
                consumer_id, owner
            )));
            return (sub_token_clone, rx);
        }
        inner.consumer_owner.insert(scoped_id.clone(), owner.clone());

        // Read-only work coalesces by stable content identity. Mutations always receive a unique
        // physical key even when their descriptive content keys happen to match.
        let mut attached = false;
        for job in &mut inner.queue {
            if coalescing == CoalescingPolicy::Never {
                break;
            }
            if job.job_key == job_key {
                let listener = create_listener(tx.clone());
                job.subscribers.push(SubscriberState {
                    consumer_id: scoped_id.clone(),
                    token: sub_token.clone(),
                    callback: listener,
                });
                inner.consumer_to_job.insert(scoped_id.clone(), job_key.clone());
                inner.coalesced_jobs += 1;
                attached = true;
                break;
            }
        }
        if !attached && coalescing == CoalescingPolicy::ByContentKey {
            if let Some(job) = inner.running_jobs.get_mut(&job_key) {
                let listener = create_listener(tx.clone());
                job.subscribers.push(SubscriberState {
                    consumer_id: scoped_id.clone(),
                    token: sub_token.clone(),
                    callback: listener,
                });
                inner.consumer_to_job.insert(scoped_id.clone(), job_key.clone());
                inner.coalesced_jobs += 1;
                attached = true;
            }
        }

        if attached {
            drop(inner);
            return (sub_token_clone, rx);
        }

        let listener = create_listener(tx);
        let work_runner = Box::new(move |cancel_tok: &CancellationToken| -> AnyResult {
            if cancel_tok.is_canceled() {
                Err("Operation canceled".to_string())
            } else {
                work(cancel_tok).map(|r| Arc::new(r) as Arc<dyn std::any::Any + Send + Sync>)
            }
        });

        let cancel_token = CancellationToken::new();
        let job = ActiveJob {
            job_key: job_key.clone(),
            priority,
            queued_at: std::time::Instant::now(),
            cancel_token,
            subscribers: vec![SubscriberState {
                consumer_id: scoped_id.clone(),
                token: sub_token.clone(),
                callback: listener,
            }],
            work_runner: Some(work_runner),
        };

        inner.consumer_to_job.insert(scoped_id, job_key);
        inner.queue.push(job);
        drop(inner);

        self.try_dispatch();

        (sub_token_clone, rx)
    }

    pub fn cancel_consumer_request(&self, consumer_id: &str, caller_window: Option<&str>) -> bool {
        let caller = caller_window.unwrap_or("main");
        let scoped_id = format!("{}::{}", caller, consumer_id);

        let mut inner = self.inner.lock().unwrap();
        let target_scoped_ids: Vec<String> = inner
            .consumer_to_job
            .contains_key(&scoped_id)
            .then_some(scoped_id)
            .into_iter()
            .collect();

        if target_scoped_ids.is_empty() {
            return false;
        }

        let mut canceled_any = false;
        for target_id in target_scoped_ids {
            let owner = inner.consumer_owner.get(&target_id).map(|s| s.as_str()).unwrap_or("main");
            if caller != "main" && owner != caller {
                continue;
            }

            if let Some(job_key) = inner.consumer_to_job.get(&target_id).cloned() {
                for job in &mut inner.queue {
                    if job.job_key == job_key {
                        for sub in &mut job.subscribers {
                            if sub.consumer_id == target_id {
                                sub.token.store(true, Ordering::SeqCst);
                                canceled_any = true;
                            }
                        }
                        if job.subscribers.iter().all(|s| s.token.load(Ordering::SeqCst)) {
                            job.cancel_token.cancel();
                        }
                    }
                }

                if let Some(job) = inner.running_jobs.get_mut(&job_key) {
                    let is_final_subscriber = job
                        .subscribers
                        .iter()
                        .filter(|subscriber| !subscriber.token.load(Ordering::SeqCst))
                        .count()
                        == 1;
                    if is_final_subscriber && !job.cancel_token.cancel() {
                        continue;
                    }
                    for sub in &mut job.subscribers {
                        if sub.consumer_id == target_id {
                            sub.token.store(true, Ordering::SeqCst);
                            canceled_any = true;
                        }
                    }
                    // The final-subscriber transition above linearizes cancellation against
                    // publication. Non-final cancellation leaves shared physical work running.
                }
            }
        }

        if canceled_any {
            inner.canceled_jobs += 1;
        }
        canceled_any
    }

    fn try_dispatch(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.is_shutdown {
            return;
        }

        while inner.running_count < inner.capacity && !inner.queue.is_empty() {
            let now = std::time::Instant::now();
            let mut best_idx = None;
            let mut best_score = i64::MAX;

            for (i, job) in inner.queue.iter().enumerate() {
                let class_running = inner.running_by_class.get(&job.priority).copied().unwrap_or(0);
                if class_running >= job.priority.max_concurrent_workers(inner.capacity) {
                    continue;
                }

                let wait_ms = now.duration_since(job.queued_at).as_millis() as i64;
                let priority_val = job.priority as i64 * 1000;
                let score = priority_val - wait_ms;
                if score < best_score {
                    best_score = score;
                    best_idx = Some(i);
                }
            }

            let idx = match best_idx {
                Some(i) => i,
                None => break,
            };

            let mut job = inner.queue.remove(idx);
            let wait_ms = now.duration_since(job.queued_at).as_millis() as u64;
            if inner.queue_wait_durations.len() >= 1000 {
                inner.queue_wait_durations.pop_front();
            }
            inner.queue_wait_durations.push_back(wait_ms);

            // If all subscribers have canceled, drop job without running
            if job.subscribers.iter().all(|s| s.token.load(Ordering::SeqCst)) {
                inner.canceled_jobs += 1;
                let class_name = format!("{:?}", job.priority);
                *inner.canceled_by_class.entry(class_name).or_insert(0) += 1;
                for sub in job.subscribers {
                    inner.consumer_to_job.remove(&sub.consumer_id);
                    inner.consumer_owner.remove(&sub.consumer_id);
                    (sub.callback)(Err("Operation canceled".to_string()));
                }
                continue;
            }

            inner.running_count += 1;
            *inner.running_by_class.entry(job.priority).or_insert(0) += 1;

            let job_key = job.job_key.clone();
            let priority = job.priority;
            let cancel_tok = job.cancel_token.clone();
            let work_runner = job.work_runner.take().expect("work_runner missing");

            inner.running_jobs.insert(job_key.clone(), job);

            let executor_clone = self.clone();

            let handle = thread::spawn(move || {
                let start_time = std::time::Instant::now();

                let panic_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    work_runner(&cancel_tok)
                }));

                let (is_panic, result) = match panic_res {
                    Ok(res) => (false, res),
                    Err(_) => (true, Err("Task panicked during execution".to_string())),
                };

                let duration_ms = start_time.elapsed().as_millis() as u64;
                executor_clone.on_job_completed(&job_key, priority, is_panic, duration_ms, result);
            });
            inner.worker_handles.push(handle);
        }
    }

    fn on_job_completed(
        &self,
        job_key: &str,
        priority: PriorityClass,
        is_panic: bool,
        duration_ms: u64,
        result: AnyResult,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if inner.running_count > 0 {
            inner.running_count -= 1;
        }
        if let Some(count) = inner.running_by_class.get_mut(&priority) {
            if *count > 0 {
                *count -= 1;
            }
        }

        let completed_job = inner.running_jobs.remove(job_key);

        if is_panic {
            inner.canceled_jobs += 1;
            let class_name = format!("{:?}", priority);
            *inner.canceled_by_class.entry(class_name).or_insert(0) += 1;
        } else {
            inner.completed_jobs += 1;
            if inner.execution_durations.len() >= 1000 {
                inner.execution_durations.pop_front();
            }
            inner.execution_durations.push_back(duration_ms);
        }

        if let Some(job) = completed_job {
            for sub in job.subscribers {
                inner.consumer_to_job.remove(&sub.consumer_id);
                inner.consumer_owner.remove(&sub.consumer_id);
                if sub.token.load(Ordering::SeqCst) {
                    (sub.callback)(Err("Operation canceled".to_string()));
                } else {
                    (sub.callback)(result.clone());
                }
            }
        }

        inner.worker_handles.retain(|h| !h.is_finished());

        drop(inner);
        self.try_dispatch();
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.is_shutdown = true;

        let mut queued = std::mem::take(&mut inner.queue);
        for job in queued.drain(..) {
            job.cancel_token.cancel();
            let class_name = format!("{:?}", job.priority);
            *inner.canceled_by_class.entry(class_name).or_insert(0) += 1;
            for sub in job.subscribers {
                inner.consumer_to_job.remove(&sub.consumer_id);
                inner.consumer_owner.remove(&sub.consumer_id);
                (sub.callback)(Err("Executor shutdown".to_string()));
            }
        }

        for job in inner.running_jobs.values() {
            job.cancel_token.cancel();
        }

        inner.consumer_owner.clear();

        let worker_handles = std::mem::take(&mut inner.worker_handles);
        drop(inner);

        for handle in worker_handles {
            let _ = handle.join();
        }
    }

    pub fn telemetry(&self) -> ExecutorTelemetry {
        let inner = self.inner.lock().unwrap();
        let mut sorted_durations: Vec<u64> = inner.execution_durations.iter().copied().collect();
        sorted_durations.sort_unstable();

        let len = sorted_durations.len();
        let p50 = if len > 0 { sorted_durations[len * 50 / 100] } else { 0 };
        let p95 = if len > 0 { sorted_durations[(len * 95 / 100).min(len - 1)] } else { 0 };
        let p99 = if len > 0 { sorted_durations[(len * 99 / 100).min(len - 1)] } else { 0 };

        let avg_wait = if !inner.queue_wait_durations.is_empty() {
            inner.queue_wait_durations.iter().sum::<u64>() / inner.queue_wait_durations.len() as u64
        } else {
            0
        };

        ExecutorTelemetry {
            queued_jobs: inner.queue.len(),
            running_jobs: inner.running_count,
            completed_jobs: inner.completed_jobs,
            canceled_jobs: inner.canceled_jobs,
            coalesced_jobs: inner.coalesced_jobs,
            p50_execution_ms: p50,
            p95_execution_ms: p95,
            p99_execution_ms: p99,
            average_queue_wait_ms: avg_wait,
            canceled_by_class: inner.canceled_by_class.clone(),
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
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[test]
    fn test_media_executor_concurrency_capacity_and_priority() {
        let executor = MediaExecutor::new(2);

        let (_tok1, rx1) = executor.spawn_with_channel(
            "sub_1".to_string(),
            PriorityClass::BackgroundPreload,
            "job_1".to_string(),
            move |_| {
                thread::sleep(Duration::from_millis(50));
                Ok::<&'static str, String>("job1")
            },
        );

        let (_tok2, rx2) = executor.spawn_with_channel(
            "sub_2".to_string(),
            PriorityClass::InteractivePreview,
            "job_2".to_string(),
            move |_| Ok::<&'static str, String>("job2"),
        );

        assert_eq!(rx1.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), "job1");
        assert_eq!(rx2.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), "job2");
    }

    #[test]
    fn test_media_executor_shared_consumer_coalescing_and_independent_cancellation() {
        let executor = MediaExecutor::new(1);
        let job_key = "dedup_asset_1".to_string();

        let (sub1, rx1) = executor.spawn_with_channel(
            "consumer_1".to_string(),
            PriorityClass::BackgroundPreload,
            job_key.clone(),
            move |_| {
                thread::sleep(Duration::from_millis(20));
                Ok::<i32, String>(42)
            },
        );

        let (_sub2, rx2) = executor.spawn_with_channel(
            "consumer_2".to_string(),
            PriorityClass::InteractivePreview,
            job_key,
            move |_| Ok::<i32, String>(42),
        );

        assert_eq!(executor.telemetry().coalesced_jobs, 1);

        // Cancel consumer 1 only - job should still complete for consumer 2
        assert!(executor.cancel_consumer_request("consumer_1", Some("main")));
        assert!(sub1.load(Ordering::SeqCst));

        assert_eq!(
            rx1.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),
            "Operation canceled"
        );
        assert_eq!(rx2.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), 42);
    }

    #[test]
    fn user_edits_with_the_same_content_key_are_never_coalesced() {
        let executor = MediaExecutor::new(2);
        let executions = Arc::new(AtomicUsize::new(0));
        let mut receivers = Vec::new();
        for consumer in ["edit-1", "edit-2"] {
            let executions = executions.clone();
            let (_, receiver) = executor.spawn_uncoalesced_with_channel_owner(
                consumer.to_string(),
                PriorityClass::UserEdit,
                "rotate_same_image".to_string(),
                Some("main".to_string()),
                move |_| {
                    executions.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, String>(())
                },
            );
            receivers.push(receiver);
        }
        for receiver in receivers {
            receiver.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
        }
        assert_eq!(executions.load(Ordering::SeqCst), 2);
        assert_eq!(executor.telemetry().coalesced_jobs, 0);
    }

    #[test]
    fn test_media_executor_panic_recovery() {
        let executor = MediaExecutor::new(1);

        let (_sub, rx) = executor.spawn_with_channel::<_, ()>(
            "consumer_panic".to_string(),
            PriorityClass::InteractivePreview,
            "job_panic".to_string(),
            move |_| {
                panic!("Simulated worker panic");
            },
        );

        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_err());

        // Ensure executor capacity was NOT leaked and next job executes cleanly
        let (_sub2, rx2) = executor.spawn_with_channel(
            "consumer_after_panic".to_string(),
            PriorityClass::InteractivePreview,
            "job_after_panic".to_string(),
            move |_| Ok::<&'static str, String>("success_after_panic"),
        );

        assert_eq!(
            rx2.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(),
            "success_after_panic"
        );
        assert_eq!(executor.telemetry().running_jobs, 0);
    }

    #[test]
    fn test_media_executor_shutdown_joins_workers_and_cancels_queue() {
        let executor = MediaExecutor::new(1);

        let (_tok1, rx1) = executor.spawn_with_channel(
            "sub_running".to_string(),
            PriorityClass::BackgroundPreload,
            "job_running".to_string(),
            move |_| {
                thread::sleep(Duration::from_millis(50));
                Ok::<&'static str, String>("completed")
            },
        );

        let (_tok2, rx2) = executor.spawn_with_channel(
            "sub_queued".to_string(),
            PriorityClass::BackgroundPreload,
            "job_queued".to_string(),
            move |_| Ok::<&'static str, String>("queued"),
        );

        executor.shutdown();

        // Queued job gets immediate shutdown error
        assert_eq!(
            rx2.recv_timeout(Duration::from_millis(100)).unwrap().unwrap_err(),
            "Executor shutdown"
        );

        // Shutdown waits for active worker thread to join
        let res1 = rx1.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(res1.is_ok() || res1.unwrap_err() == "Operation canceled");
    }

    #[test]
    fn test_media_executor_incremental_handle_reaping_and_fifo_ordering() {
        let executor = MediaExecutor::new(2);

        for i in 0..10 {
            let key = format!("job_{}", i);
            let consumer = format!("consumer_{}", i);
            let (_tok, rx) = executor.spawn_with_channel(
                consumer,
                PriorityClass::InteractivePreview,
                key,
                move |_| Ok::<usize, String>(i),
            );
            assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), i);
        }

        let inner = executor.inner.lock().unwrap();
        assert!(inner.worker_handles.len() <= 2);
    }

    #[test]
    fn test_media_executor_cancellation_queued_running_coalesced() {
        let executor = MediaExecutor::new(1);

        // 1. Running job cancellation
        let (_tok_run, rx_run) = executor.spawn_with_channel(
            "sub_run".to_string(),
            PriorityClass::BackgroundPreload,
            "job_run".to_string(),
            move |cancel_tok| {
                for _ in 0..50 {
                    if cancel_tok.is_canceled() {
                        return Err("Canceled in loop".to_string());
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Ok("done")
            },
        );

        // 2. Queued job
        let (_tok_queue, rx_queue) = executor.spawn_with_channel(
            "sub_queue".to_string(),
            PriorityClass::BackgroundPreload,
            "job_queue".to_string(),
            move |_| Ok("queued_done"),
        );

        // 3. Coalesced job with two consumers
        let (_tok_co1, rx_co1) = executor.spawn_with_channel(
            "sub_co1".to_string(),
            PriorityClass::BackgroundPreload,
            "job_coalesced".to_string(),
            move |_| Ok("coalesced_result"),
        );
        let (_tok_co2, rx_co2) = executor.spawn_with_channel(
            "sub_co2".to_string(),
            PriorityClass::BackgroundPreload,
            "job_coalesced".to_string(),
            move |_| Ok("coalesced_result"),
        );

        // Cancel both running and queued work before waiting, so the capacity handoff cannot
        // race the queued cancellation assertion.
        assert!(executor.cancel_consumer_request("sub_run", None));
        assert!(executor.cancel_consumer_request("sub_queue", None));
        let res_run = rx_run.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(res_run.is_err());

        // Cancel queued job before it starts
        let res_queue = rx_queue.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(res_queue.unwrap_err(), "Operation canceled");

        // Cancel one consumer of coalesced job, second consumer receives result
        assert!(executor.cancel_consumer_request("sub_co1", None));
        assert_eq!(
            rx_co1.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),
            "Operation canceled"
        );
        assert_eq!(
            rx_co2.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(),
            "coalesced_result"
        );
    }

    #[test]
    fn test_running_job_cancellation_with_barrier_prevents_cache_and_halts_worker() {
        use std::sync::{Arc, Barrier};
        let executor = MediaExecutor::new(1);
        let barrier = Arc::new(Barrier::new(2));
        let barrier_clone = barrier.clone();
        let file_was_published = Arc::new(AtomicBool::new(false));
        let file_published_clone = file_was_published.clone();

        let (_tok, rx) = executor.spawn_with_channel(
            "sub_barrier".to_string(),
            PriorityClass::InteractivePreview,
            "job_barrier".to_string(),
            move |cancel_tok| {
                barrier_clone.wait();
                for _ in 0..100 {
                    if cancel_tok.is_canceled() {
                        return Err("Operation canceled".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                file_published_clone.store(true, Ordering::SeqCst);
                Ok("published")
            },
        );

        barrier.wait();
        executor.cancel_consumer_request("sub_barrier", None);

        let res = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(res.unwrap_err(), "Operation canceled");
        assert!(
            !file_was_published.load(Ordering::SeqCst),
            "Canceled job must NOT publish output file!"
        );
    }

    #[test]
    fn test_cancellation_ownership_enforcement_foreign_and_unknown_rejection() {
        let executor = MediaExecutor::new(1);

        // 1. Spawn job owned by 'main' window
        let (_tok, rx_main) = executor.spawn_with_channel_owner(
            "sub_main_req".to_string(),
            PriorityClass::InteractivePreview,
            "job_main_owned".to_string(),
            Some("main".to_string()),
            move |cancel_tok| {
                for _ in 0..50 {
                    if cancel_tok.is_canceled() {
                        return Err("Operation canceled".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok("main_success")
            },
        );

        // 2. Secondary window attempts to cancel main window's request -> MUST BE REJECTED (returns false)
        let cancel_rejected = executor.cancel_consumer_request("sub_main_req", Some("secondary"));
        assert!(
            !cancel_rejected,
            "Secondary window MUST NOT be allowed to cancel main window's media request!"
        );

        // 3. Secondary window attempts to cancel unknown request -> MUST BE REJECTED (returns false)
        let unknown_rejected =
            executor.cancel_consumer_request("sub_unknown_id", Some("secondary"));
        assert!(
            !unknown_rejected,
            "Secondary window MUST NOT be allowed to cancel unknown request ID!"
        );

        // 4. Main window cancels its own request -> SUCCEEDS (returns true)
        let cancel_approved = executor.cancel_consumer_request("sub_main_req", Some("main"));
        assert!(cancel_approved, "Main window MUST be authorized to cancel its own request!");

        let res = rx_main.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(res.unwrap_err(), "Operation canceled");
    }

    #[test]
    fn test_consumer_id_namespacing_and_duplicate_collision_prevention() {
        let executor = MediaExecutor::new(2);
        let (main_started_tx, main_started_rx) = std::sync::mpsc::channel();
        let (main_release_tx, main_release_rx) = std::sync::mpsc::channel();
        let (secondary_started_tx, secondary_started_rx) = std::sync::mpsc::channel();
        let (secondary_release_tx, secondary_release_rx) = std::sync::mpsc::channel();

        // 1. Same consumer ID from main and secondary windows
        let (_tok_main, rx_main) = executor.spawn_with_channel_owner(
            "shared_req_id".to_string(),
            PriorityClass::InteractivePreview,
            "job_1".to_string(),
            Some("main".to_string()),
            move |cancel_token| {
                main_started_tx.send(()).unwrap();
                main_release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                if cancel_token.is_canceled() {
                    return Err("Operation canceled".to_string());
                }
                Ok("main_res")
            },
        );

        let (_tok_sec, rx_sec) = executor.spawn_with_channel_owner(
            "shared_req_id".to_string(),
            PriorityClass::InteractivePreview,
            "job_2".to_string(),
            Some("secondary".to_string()),
            move |cancel_token| {
                secondary_started_tx.send(()).unwrap();
                secondary_release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                if cancel_token.is_canceled() {
                    return Err("Operation canceled".to_string());
                }
                Ok("sec_res")
            },
        );
        main_started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        secondary_started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        // Secondary canceling its shared_req_id cancels secondary, not main
        assert!(executor.cancel_consumer_request("shared_req_id", Some("secondary")));
        assert!(executor.cancel_consumer_request("shared_req_id", Some("main")));
        main_release_tx.send(()).unwrap();
        secondary_release_tx.send(()).unwrap();
        assert_eq!(
            rx_main.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),
            "Operation canceled"
        );
        assert_eq!(
            rx_sec.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),
            "Operation canceled"
        );
    }

    #[test]
    fn duplicate_live_consumer_id_is_rejected_without_ambiguous_cancellation() {
        let executor = MediaExecutor::new(1);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (_first_token, first_rx) = executor.spawn_with_channel_owner(
            "duplicate".to_string(),
            PriorityClass::InteractivePreview,
            "job-first".to_string(),
            Some("main".to_string()),
            move |token| {
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                if token.is_canceled() {
                    Err("Operation canceled".to_string())
                } else {
                    Ok("first")
                }
            },
        );
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (_duplicate_token, duplicate_rx) = executor.spawn_with_channel_owner(
            "duplicate".to_string(),
            PriorityClass::InteractivePreview,
            "job-second".to_string(),
            Some("main".to_string()),
            move |_| Ok("second"),
        );

        assert!(duplicate_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err()
            .contains("Duplicate live media request ID"));
        assert!(executor.cancel_consumer_request("duplicate", Some("main")));
        release_tx.send(()).unwrap();
        assert_eq!(
            first_rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),
            "Operation canceled"
        );
    }
}
#[test]
fn cancellation_and_publication_commit_have_a_single_winner() {
    use std::sync::{Arc, Barrier};

    let token = CancellationToken::new();
    let barrier = Arc::new(Barrier::new(2));
    let worker_token = token.clone();
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        worker_token.try_commit()
    });
    barrier.wait();
    let canceled = token.cancel();
    let committed = worker.join().unwrap();

    assert_ne!(canceled, committed);
    assert_eq!(token.is_canceled(), canceled);

    let committed_first = CancellationToken::new();
    assert!(committed_first.try_commit());
    assert!(!committed_first.cancel());
    assert!(!committed_first.is_canceled());

    let canceled_first = CancellationToken::new();
    assert!(canceled_first.cancel());
    assert!(!canceled_first.try_commit());
    assert!(canceled_first.is_canceled());
}
