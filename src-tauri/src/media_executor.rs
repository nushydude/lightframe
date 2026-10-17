//! One bounded physical pool for media. One slot is reserved for current-image work;
//! every eighth dispatch admits the oldest eligible job, including edits/background.
//! Codecs cannot be interrupted internally: cancellation is checked between stages.
//! Exit cancels queued work and signals running work; uninterruptible workers may finish
//! with their owned Arc state after shutdown (the process never waits indefinitely).
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Instant;
use tokio::sync::oneshot;

pub const MAX_WORKERS: usize = 4;
const MAX_QUEUED: usize = 256;
const MAX_CONSUMERS: usize = 1024;
const CLASS_CAPS: [usize; 7] = [2, 2, 1, 2, 1, 1, 1];
const CANCELED: &str = "Media request canceled";

pub fn capacity_for_mode(mode: &str) -> usize {
    match mode {
        "fast" => 4,
        "lowMemory" => 2,
        _ => 3,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Priority {
    CurrentPreview,
    CurrentFull,
    CurrentMetadata,
    VisibleThumbnail,
    AdjacentDirectional,
    BackgroundPreload,
    ExplicitEdit,
}
impl Priority {
    fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequest {
    pub request_id: String,
    pub generation_token: Option<String>,
    pub priority: Priority,
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
impl MediaRequest {
    pub fn internal(priority: Priority) -> Self {
        Self {
            request_id: format!("native-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            generation_token: None,
            priority,
        }
    }
}
type Value = Arc<dyn Any + Send + Sync>;
type JobResult = Result<Value, String>;
type Work = Box<dyn FnOnce() -> JobResult + Send>;
struct Consumer {
    sender: oneshot::Sender<JobResult>,
}
struct Job {
    id: u64,
    key: Option<String>,
    priority: Priority,
    sequence: u64,
    queued_at: Instant,
    work: Option<Work>,
    consumers: HashMap<String, Consumer>,
    canceled: Arc<AtomicBool>,
    running: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    sample_count: usize,
    p50_ms: u64,
    p95_ms: u64,
    max_ms: u64,
}
fn timing(samples: &VecDeque<u64>) -> Timing {
    let mut sorted: Vec<_> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let n = sorted.len();
    if n == 0 {
        return Timing::default();
    }
    Timing {
        sample_count: n,
        p50_ms: sorted[(n - 1) / 2],
        p95_ms: sorted[((n - 1) * 95) / 100],
        max_ms: sorted[n - 1],
    }
}
fn sample(samples: &mut VecDeque<u64>, value: u64) {
    if samples.len() == 512 {
        samples.pop_front();
    }
    samples.push_back(value);
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStats {
    capacity: usize,
    pub(crate) queue_depth: usize,
    running: usize,
    queued_by_class: [usize; 7],
    running_by_class: [usize; 7],
    canceled_queued: u64,
    canceled_running: u64,
    coalesced_consumers: u64,
    queue_wait: Timing,
    execution: Timing,
}
struct State {
    jobs: Vec<Job>,
    capacity: usize,
    running: [usize; 7],
    sequence: u64,
    dispatches: u64,
    shutdown: bool,
    canceled_queued: u64,
    canceled_running: u64,
    coalesced: u64,
    waits: VecDeque<u64>,
    durations: VecDeque<u64>,
    early_cancels: VecDeque<String>,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}
#[derive(Clone)]
pub struct MediaExecutor {
    shared: Arc<Shared>,
}
static GLOBAL: OnceLock<MediaExecutor> = OnceLock::new();
thread_local! { static CANCEL: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) }; }

pub fn checkpoint() -> Result<(), String> {
    CANCEL.with(|slot| {
        if slot.borrow().as_ref().is_some_and(|flag| flag.load(Ordering::Acquire)) {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    })
}

impl Default for MediaExecutor {
    fn default() -> Self {
        Self::new(MAX_WORKERS)
    }
}
impl MediaExecutor {
    pub fn new(capacity: usize) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                jobs: vec![],
                capacity: capacity.clamp(2, MAX_WORKERS),
                running: [0; 7],
                sequence: 0,
                dispatches: 0,
                shutdown: false,
                canceled_queued: 0,
                canceled_running: 0,
                coalesced: 0,
                waits: VecDeque::new(),
                durations: VecDeque::new(),
                early_cancels: VecDeque::new(),
            }),
            wake: Condvar::new(),
        });
        for index in 0..MAX_WORKERS {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name(format!("media-{index}"))
                .spawn(move || worker(shared))
                .expect("media worker creation");
        }
        Self { shared }
    }
    pub fn install_global(&self) {
        let _ = GLOBAL.set(self.clone());
    }
    pub fn configure(&self, capacity: usize) {
        // Reducing the limit drains existing jobs before admitting more; never kills a codec.
        self.shared.state.lock().unwrap().capacity = capacity.clamp(2, MAX_WORKERS);
        self.shared.wake.notify_all();
    }
    pub fn stats(&self) -> ExecutorStats {
        let state = self.shared.state.lock().unwrap();
        let mut queued = [0; 7];
        for job in &state.jobs {
            if !job.running {
                queued[job.priority.index()] += 1;
            }
        }
        ExecutorStats {
            capacity: state.capacity,
            queue_depth: queued.iter().sum(),
            running: state.running.iter().sum(),
            queued_by_class: queued,
            running_by_class: state.running,
            canceled_queued: state.canceled_queued,
            canceled_running: state.canceled_running,
            coalesced_consumers: state.coalesced,
            queue_wait: timing(&state.waits),
            execution: timing(&state.durations),
        }
    }
    fn enqueue(
        &self,
        request: MediaRequest,
        key: Option<String>,
        work: Work,
    ) -> Result<oneshot::Receiver<JobResult>, String> {
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || request.generation_token.as_ref().is_some_and(|v| v.len() > 128)
        {
            return Err("Invalid media request identity".into());
        }
        let (sender, receiver) = oneshot::channel();
        let mut state = self.shared.state.lock().unwrap();
        if state.shutdown {
            return Err("Media executor stopped".into());
        }
        if let Some(index) = state.early_cancels.iter().position(|id| *id == request.request_id) {
            state.early_cancels.remove(index);
            return Err(CANCELED.into());
        }
        if state.jobs.iter().any(|job| job.consumers.contains_key(&request.request_id)) {
            return Err("Duplicate media request ID".into());
        }
        if state.jobs.iter().map(|job| job.consumers.len()).sum::<usize>() >= MAX_CONSUMERS {
            return Err("Media consumer limit reached".into());
        }
        // Generation is part of read identity, preventing old-generation results satisfying a
        // later generation. Individual cancellation leaves shared consumers intact.
        let key = if request.priority == Priority::ExplicitEdit {
            None
        } else {
            key.map(|k| format!("{k}|{:?}", request.generation_token))
        };
        if let Some(job) = state
            .jobs
            .iter_mut()
            .find(|job| key.is_some() && job.key == key && !job.canceled.load(Ordering::Acquire))
        {
            if !job.running && request.priority.index() < job.priority.index() {
                job.priority = request.priority;
            }
            job.consumers.insert(request.request_id, Consumer { sender });
            state.coalesced += 1;
        } else {
            let queue_limit =
                if request.priority.index() < 3 { MAX_QUEUED } else { MAX_QUEUED - 16 };
            if state.jobs.iter().filter(|job| !job.running).count() >= queue_limit {
                return Err("Media queue limit reached".into());
            }
            let sequence = state.sequence;
            state.sequence += 1;
            state.jobs.push(Job {
                id: sequence,
                key,
                priority: request.priority,
                sequence,
                queued_at: Instant::now(),
                work: Some(work),
                consumers: HashMap::from([(request.request_id, Consumer { sender })]),
                canceled: Arc::new(AtomicBool::new(false)),
                running: false,
            });
        }
        drop(state);
        self.shared.wake.notify_all();
        Ok(receiver)
    }
    pub async fn execute<T, F>(
        &self,
        request: Option<MediaRequest>,
        priority: Priority,
        key: Option<String>,
        work: F,
    ) -> Result<T, String>
    where
        T: Clone + Send + Sync + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        let mut request = request.unwrap_or_else(|| MediaRequest::internal(priority));
        // Edit classification is owned by the command, never trusted to the caller.
        if priority == Priority::ExplicitEdit {
            request.priority = priority;
        }
        let receiver =
            self.enqueue(request, key, Box::new(move || work().map(|v| Arc::new(v) as Value)))?;
        let result = receiver.await.map_err(|_| "Media worker disconnected".to_string())??;
        result.downcast_ref::<T>().cloned().ok_or_else(|| "Media result type mismatch".into())
    }
    pub fn cancel(&self, request_id: &str) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        let Some(index) = state.jobs.iter().position(|job| job.consumers.contains_key(request_id))
        else {
            if request_id.len() <= 128 {
                if state.early_cancels.len() == MAX_CONSUMERS {
                    state.early_cancels.pop_front();
                }
                state.early_cancels.push_back(request_id.to_owned());
            }
            return false;
        };
        let job = &mut state.jobs[index];
        if let Some(consumer) = job.consumers.remove(request_id) {
            let _ = consumer.sender.send(Err(CANCELED.into()));
        }
        if job.consumers.is_empty() {
            job.canceled.store(true, Ordering::Release);
            if job.running {
                state.canceled_running += 1;
            } else {
                state.jobs.remove(index);
                state.canceled_queued += 1;
            }
        }
        drop(state);
        self.shared.wake.notify_all();
        true
    }
    pub fn shutdown(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.shutdown = true;
        for job in &mut state.jobs {
            job.canceled.store(true, Ordering::Release);
            for (_, consumer) in job.consumers.drain() {
                let _ = consumer.sender.send(Err("Media executor stopped".into()));
            }
        }
        state.jobs.retain(|job| job.running);
        drop(state);
        self.shared.wake.notify_all();
    }
}
fn next_job(state: &State) -> Option<usize> {
    let total: usize = state.running.iter().sum();
    if total >= state.capacity {
        return None;
    }
    let eligible = |job: &&Job| {
        !job.running
            && state.running[job.priority.index()] < CLASS_CAPS[job.priority.index()]
            && (job.priority.index() < 3
                || state.running[3..].iter().sum::<usize>() < state.capacity - 1)
    };
    let oldest_turn = state.dispatches % 8 == 7;
    state
        .jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| eligible(job))
        .min_by_key(|(_, job)| (if oldest_turn { 0 } else { job.priority.index() }, job.sequence))
        .map(|(index, _)| index)
}
fn worker(shared: Arc<Shared>) {
    loop {
        let (id, priority, cancel, work) = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.shutdown {
                    return;
                }
                if let Some(index) = next_job(&state) {
                    let job = &mut state.jobs[index];
                    job.running = true;
                    let wait = job.queued_at.elapsed().as_millis() as u64;
                    let item =
                        (job.id, job.priority, job.canceled.clone(), job.work.take().unwrap());
                    state.running[item.1.index()] += 1;
                    state.dispatches += 1;
                    sample(&mut state.waits, wait);
                    break item;
                }
                state = shared.wake.wait(state).unwrap();
            }
        };
        let started = Instant::now();
        CANCEL.with(|slot| *slot.borrow_mut() = Some(cancel));
        let result = catch_unwind(AssertUnwindSafe(|| {
            checkpoint()?;
            work()
        }))
        .unwrap_or_else(|_| Err("Media worker panicked".into()));
        CANCEL.with(|slot| *slot.borrow_mut() = None);
        let consumers = {
            let mut state = shared.state.lock().unwrap();
            state.running[priority.index()] -= 1;
            sample(&mut state.durations, started.elapsed().as_millis() as u64);
            let index = state.jobs.iter().position(|job| job.id == id).unwrap();
            state.jobs.remove(index).consumers
        };
        for (_, consumer) in consumers {
            let _ = consumer.sender.send(result.clone());
        }
        shared.wake.notify_all();
    }
}

pub fn schedule_maintenance(key: String, work: impl FnOnce() + Send + 'static) -> bool {
    let Some(executor) = GLOBAL.get() else {
        return false;
    };
    executor
        .enqueue(
            MediaRequest::internal(Priority::BackgroundPreload),
            Some(format!("maintenance:{key}")),
            Box::new(move || {
                checkpoint()?;
                work();
                Ok(Arc::new(()) as Value)
            }),
        )
        .is_ok()
}

#[tauri::command]
pub fn cancel_media_request(executor: tauri::State<'_, MediaExecutor>, request_id: String) -> bool {
    executor.cancel(&request_id)
}
#[tauri::command]
pub fn configure_media_executor(executor: tauri::State<'_, MediaExecutor>, capacity: usize) {
    executor.configure(capacity);
}
#[tauri::command]
pub fn get_media_executor_stats(executor: tauri::State<'_, MediaExecutor>) -> ExecutorStats {
    executor.stats()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    fn submit(
        executor: &MediaExecutor,
        id: &str,
        priority: Priority,
        key: Option<&str>,
        work: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> oneshot::Receiver<JobResult> {
        executor
            .enqueue(
                MediaRequest { request_id: id.into(), generation_token: None, priority },
                key.map(str::to_owned),
                Box::new(move || work().map(|()| Arc::new(()) as Value)),
            )
            .unwrap()
    }
    fn blocked(
        executor: &MediaExecutor,
        id: &str,
        priority: Priority,
    ) -> (mpsc::Sender<()>, oneshot::Receiver<JobResult>) {
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let result = submit(executor, id, priority, None, move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
            Ok(())
        });
        ready.recv().unwrap();
        (release, result)
    }
    #[test]
    fn media_executor_capacity_priority_fifo_and_cancellation() {
        let executor = MediaExecutor::new(2);
        let (release1, first) = blocked(&executor, "hold1", Priority::CurrentPreview);
        let (release2, second) = blocked(&executor, "hold2", Priority::CurrentPreview);
        let (order, observed) = mpsc::channel();
        let tx = order.clone();
        let background =
            submit(&executor, "background", Priority::BackgroundPreload, None, move || {
                tx.send(3).unwrap();
                Ok(())
            });
        let tx = order.clone();
        let preview1 = submit(&executor, "preview1", Priority::CurrentPreview, None, move || {
            tx.send(1).unwrap();
            Ok(())
        });
        let preview2 = submit(&executor, "preview2", Priority::CurrentPreview, None, move || {
            order.send(2).unwrap();
            Ok(())
        });
        let canceled = submit(&executor, "cancel", Priority::CurrentPreview, None, || {
            panic!("queued canceled job ran")
        });
        assert_eq!(executor.stats().running, 2);
        assert_eq!(executor.stats().queue_depth, 4);
        assert!(executor.cancel("cancel"));
        assert!(canceled.blocking_recv().unwrap().is_err());
        release1.send(()).unwrap();
        first.blocking_recv().unwrap().unwrap();
        assert_eq!(observed.recv().unwrap(), 1);
        assert_eq!(observed.recv().unwrap(), 2);
        assert_eq!(observed.recv().unwrap(), 3);
        preview1.blocking_recv().unwrap().unwrap();
        preview2.blocking_recv().unwrap().unwrap();
        background.blocking_recv().unwrap().unwrap();
        release2.send(()).unwrap();
        second.blocking_recv().unwrap().unwrap();
        executor.shutdown();
    }
    #[test]
    fn media_executor_coalesces_shared_consumers_and_cancels_running_checkpoint() {
        let executor = MediaExecutor::new(2);
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let first =
            submit(&executor, "one", Priority::CurrentPreview, Some("preview"), move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                checkpoint()
            });
        ready.recv().unwrap();
        let second = submit(&executor, "two", Priority::CurrentPreview, Some("preview"), || {
            panic!("coalesced job ran")
        });
        executor.cancel("one");
        assert!(first.blocking_recv().unwrap().is_err());
        assert_eq!(executor.stats().coalesced_consumers, 1);
        release.send(()).unwrap();
        second.blocking_recv().unwrap().unwrap();
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let (checked, result) = mpsc::channel();
        let running = submit(&executor, "running", Priority::CurrentPreview, None, move || {
            started.send(()).unwrap();
            wait.recv().unwrap();
            checked.send(checkpoint().is_err()).unwrap();
            checkpoint()
        });
        ready.recv().unwrap();
        executor.cancel("running");
        release.send(()).unwrap();
        assert!(running.blocking_recv().unwrap().is_err());
        assert!(result.recv().unwrap());
        executor.shutdown();
    }
    #[test]
    fn media_executor_errors_panics_edits_and_shutdown_settle() {
        let executor = MediaExecutor::new(2);
        let (release, first) = blocked(&executor, "edit1", Priority::ExplicitEdit);
        let second =
            submit(&executor, "edit2", Priority::ExplicitEdit, Some("same-path"), || Ok(()));
        let third = submit(&executor, "edit3", Priority::ExplicitEdit, Some("same-path"), || {
            Err("expected".into())
        });
        assert_eq!(executor.stats().coalesced_consumers, 0);
        let panic =
            submit(&executor, "panic", Priority::CurrentPreview, None, || panic!("expected"));
        assert!(panic.blocking_recv().unwrap().is_err());
        release.send(()).unwrap();
        first.blocking_recv().unwrap().unwrap();
        second.blocking_recv().unwrap().unwrap();
        assert!(third.blocking_recv().unwrap().is_err());
        executor.shutdown();
        assert!(executor
            .enqueue(
                MediaRequest::internal(Priority::CurrentPreview),
                None,
                Box::new(|| Ok(Arc::new(())))
            )
            .is_err());
    }
    #[test]
    fn media_executor_fairness_reservation_queue_bound_and_security_limits() {
        let executor = MediaExecutor::new(2);
        executor.configure(usize::MAX);
        assert_eq!(executor.stats().capacity, MAX_WORKERS);
        executor.configure(0);
        assert_eq!(executor.stats().capacity, 2);
        let (release1, first) = blocked(&executor, "hold1", Priority::CurrentPreview);
        let (release2, second) = blocked(&executor, "hold2", Priority::CurrentPreview);
        let background =
            submit(&executor, "old-background", Priority::BackgroundPreload, None, || Ok(()));
        let mut jobs = vec![];
        for index in 0..MAX_QUEUED - 1 {
            jobs.push(submit(
                &executor,
                &format!("queued-{index}"),
                Priority::CurrentPreview,
                None,
                || Ok(()),
            ));
        }
        assert!(executor
            .enqueue(
                MediaRequest::internal(Priority::CurrentPreview),
                None,
                Box::new(|| Ok(Arc::new(())))
            )
            .is_err());
        {
            let mut state = executor.shared.state.lock().unwrap();
            state.running = [0; 7];
            state.dispatches = 7;
            let selected = next_job(&state).unwrap();
            assert_eq!(state.jobs[selected].priority, Priority::BackgroundPreload);
            state.running[Priority::BackgroundPreload.index()] = 1;
            assert!(next_job(&state).is_some()); // interactive can use the reserved slot
            state.running = [2, 0, 0, 0, 0, 0, 0];
        }
        executor.shutdown();
        assert!(background.blocking_recv().unwrap().is_err());
        for job in jobs {
            assert!(job.blocking_recv().unwrap().is_err());
        }
        release1.send(()).unwrap();
        release2.send(()).unwrap();
        let _ = first.blocking_recv();
        let _ = second.blocking_recv();
    }
    #[test]
    #[ignore = "repeatable synthetic benchmark; records timings without wall-clock assertions"]
    fn media_executor_navigation_benchmark() {
        let executor = MediaExecutor::default();
        let started = Instant::now();
        let (finish_edit, long_edit) = blocked(&executor, "long-edit", Priority::ExplicitEdit);
        for batch in 0..100 {
            let mut pending = vec![];
            for offset in 0..10 {
                let id = format!("navigation-{}", batch * 10 + offset);
                pending.push(submit(&executor, &id, Priority::CurrentPreview, Some(&id), || {
                    std::hint::black_box((0..10000u64).sum::<u64>());
                    checkpoint()
                }));
                if offset % 2 == 0 {
                    executor.cancel(&id);
                }
                pending.push(submit(
                    &executor,
                    &format!("thumb-{id}"),
                    Priority::VisibleThumbnail,
                    None,
                    || Ok(()),
                ));
            }
            for result in pending {
                let _ = result.blocking_recv();
            }
        }
        finish_edit.send(()).unwrap();
        long_edit.blocking_recv().unwrap().unwrap();
        eprintln!(
            "1,000-entry navigation, thumbnails, cancellation storm, edits: elapsed={:?}, stats={}",
            started.elapsed(),
            serde_json::to_string(&executor.stats()).unwrap()
        );
        executor.shutdown();
    }

    #[test]
    fn media_executor_background_runs_during_bounded_interactive_traffic() {
        let executor = MediaExecutor::new(2);
        let (release1, first) = blocked(&executor, "hold1", Priority::CurrentPreview);
        let (release2, second) = blocked(&executor, "hold2", Priority::CurrentPreview);
        let (order, observed) = mpsc::channel();
        let tx = order.clone();
        let background =
            submit(&executor, "old-background", Priority::BackgroundPreload, None, move || {
                tx.send(99).unwrap();
                Ok(())
            });
        let mut previews = Vec::new();
        for index in 0..16 {
            let tx = order.clone();
            previews.push(submit(
                &executor,
                &format!("interactive-{index}"),
                Priority::CurrentPreview,
                None,
                move || {
                    tx.send(index).unwrap();
                    Ok(())
                },
            ));
        }
        release1.send(()).unwrap();
        first.blocking_recv().unwrap().unwrap();
        let mut preceding = 0;
        while observed.recv().unwrap() != 99 {
            preceding += 1;
        }
        assert!(preceding < 8, "oldest eligible work gets a turn every eight dispatches");
        background.blocking_recv().unwrap().unwrap();
        for preview in previews {
            preview.blocking_recv().unwrap().unwrap();
        }
        release2.send(()).unwrap();
        second.blocking_recv().unwrap().unwrap();
        executor.shutdown();
    }

    #[test]
    fn media_executor_caps_reserve_a_slot_and_running_cancel_does_not_release_it_early() {
        let executor = MediaExecutor::new(4);
        let (background_release, background) =
            blocked(&executor, "background", Priority::BackgroundPreload);
        let (visible1_release, visible1) =
            blocked(&executor, "visible1", Priority::VisibleThumbnail);
        let (visible2_release, visible2) =
            blocked(&executor, "visible2", Priority::VisibleThumbnail);
        let edit = submit(&executor, "edit", Priority::ExplicitEdit, None, || Ok(()));
        assert_eq!(executor.stats().running, 3);
        assert_eq!(executor.stats().queue_depth, 1);
        let (preview_release, preview) = blocked(&executor, "preview", Priority::CurrentPreview);
        assert_eq!(executor.stats().running, 4);
        executor.cancel("preview");
        assert_eq!(executor.stats().running, 4); // actual codec still owns physical capacity
        preview_release.send(()).unwrap();
        let _ = preview.blocking_recv();
        background_release.send(()).unwrap();
        visible1_release.send(()).unwrap();
        visible2_release.send(()).unwrap();
        background.blocking_recv().unwrap().unwrap();
        visible1.blocking_recv().unwrap().unwrap();
        visible2.blocking_recv().unwrap().unwrap();
        edit.blocking_recv().unwrap().unwrap();
        executor.shutdown();
    }

    #[test]
    fn media_executor_prearrival_cancellation_and_generation_isolation() {
        let executor = MediaExecutor::new(2);
        executor.cancel("early");
        assert!(executor
            .enqueue(
                MediaRequest {
                    request_id: "early".into(),
                    generation_token: None,
                    priority: Priority::CurrentPreview
                },
                None,
                Box::new(|| panic!("pre-canceled request ran"))
            )
            .is_err());
        let (release1, first) = blocked(&executor, "hold1", Priority::CurrentPreview);
        let (release2, second) = blocked(&executor, "hold2", Priority::CurrentPreview);
        let mut results = vec![];
        for token in ["old", "new"] {
            results.push(
                executor
                    .enqueue(
                        MediaRequest {
                            request_id: token.into(),
                            generation_token: Some(token.into()),
                            priority: Priority::CurrentPreview,
                        },
                        Some("same-preview".into()),
                        Box::new(|| Ok(Arc::new(()))),
                    )
                    .unwrap(),
            );
        }
        assert_eq!(executor.stats().queue_depth, 2);
        assert_eq!(executor.stats().coalesced_consumers, 0);
        executor.cancel("old");
        release1.send(()).unwrap();
        release2.send(()).unwrap();
        first.blocking_recv().unwrap().unwrap();
        second.blocking_recv().unwrap().unwrap();
        assert!(results.remove(0).blocking_recv().unwrap().is_err());
        results.remove(0).blocking_recv().unwrap().unwrap();
        executor.shutdown();
    }

    #[test]
    fn media_executor_all_queued_consumers_cancel_and_shared_panics_settle() {
        let executor = MediaExecutor::new(2);
        let (release1, first) = blocked(&executor, "hold1", Priority::CurrentPreview);
        let (release2, second) = blocked(&executor, "hold2", Priority::CurrentPreview);
        let a = submit(&executor, "a", Priority::CurrentPreview, Some("shared"), || {
            panic!("canceled job ran")
        });
        let b = submit(&executor, "b", Priority::CurrentPreview, Some("shared"), || {
            panic!("duplicate ran")
        });
        assert_eq!(executor.stats().queue_depth, 1);
        executor.cancel("a");
        assert_eq!(executor.stats().queue_depth, 1);
        executor.cancel("b");
        assert_eq!(executor.stats().queue_depth, 0);
        assert!(a.blocking_recv().unwrap().is_err());
        assert!(b.blocking_recv().unwrap().is_err());
        let p = submit(&executor, "panic1", Priority::CurrentPreview, Some("panic"), || {
            panic!("expected shared panic")
        });
        let q = submit(&executor, "panic2", Priority::CurrentPreview, Some("panic"), || {
            panic!("duplicate ran")
        });
        release1.send(()).unwrap();
        first.blocking_recv().unwrap().unwrap();
        assert!(p.blocking_recv().unwrap().is_err());
        assert!(q.blocking_recv().unwrap().is_err());
        let healthy = submit(&executor, "healthy", Priority::CurrentPreview, None, || Ok(()));
        healthy.blocking_recv().unwrap().unwrap();
        release2.send(()).unwrap();
        second.blocking_recv().unwrap().unwrap();
        executor.shutdown();
    }
}
