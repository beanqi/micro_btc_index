//! Records every input the metrics engine consumes, for offline replay,
//! backtesting and model training.
//!
//! A market loop hands its inputs to a [`StreamRecorder`] without blocking; one
//! writer thread owns all compression and file I/O. Recording never slows down or
//! fails the live engine: when the writer falls behind, inputs are dropped and the
//! loss is written into the file as a gap. Layout and schema: `docs/recording.md`.

mod format;
mod writer;

pub use format::Status;

use crate::model::{BookSnapshot, MarketEvent, SymbolInfo, normalize_symbol, now_ms};
use anyhow::{Context, Result};
use format::{FORMAT, GapReason, Header, Line, Record, VERSION};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering::Relaxed},
        mpsc::{self, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};
use writer::{StreamWriter, WriterConfig};

/// Inputs queued across all markets before new ones are dropped; minutes at normal rates.
const QUEUE_CAPACITY: usize = 65_536;
/// How often an idle writer wakes up to flush buffered lines.
const WAKE_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq)]
pub struct RecordConfig {
    pub dir: PathBuf,
    pub markets: Vec<RecordedMarket>,
}
#[derive(Debug, PartialEq)]
pub struct RecordedMarket {
    pub venue: String,
    pub symbol: String,
}
impl RecordConfig {
    /// `RECORD_SYMBOLS=BTCUSDT,binance:ETHUSDT` enables recording; `RECORD_DIR` sets the root.
    pub fn from_env(default_venue: &str) -> Result<Option<Self>> {
        let symbols = std::env::var("RECORD_SYMBOLS").unwrap_or_default();
        let dir = std::env::var("RECORD_DIR").unwrap_or_else(|_| "data/raw".into());
        Self::parse(&symbols, dir.into(), default_venue)
    }
    fn parse(symbols: &str, dir: PathBuf, default_venue: &str) -> Result<Option<Self>> {
        let mut markets = Vec::new();
        for entry in symbols.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let (venue, symbol) = entry.split_once(':').unwrap_or((default_venue, entry));
            let market = RecordedMarket {
                venue: venue.trim().to_lowercase(),
                symbol: normalize_symbol(symbol)
                    .with_context(|| format!("RECORD_SYMBOLS 中的 `{entry}` 无效"))?,
            };
            if !markets.contains(&market) {
                markets.push(market);
            }
        }
        Ok((!markets.is_empty()).then_some(Self { dir, markets }))
    }
}

enum Command {
    Write { stream: Arc<StreamMeta>, line: Line },
    Close(u64),
    Shutdown,
}
struct StreamMeta {
    id: u64,
    header: Header,
    stats: Arc<StreamStats>,
}

/// Owns the writer thread. Dropping it writes out everything queued so far,
/// publishes every open file and joins the thread.
pub struct Recorder {
    tx: SyncSender<Command>,
    thread: Option<thread::JoinHandle<()>>,
    session: u64,
    next_id: AtomicU64,
    monitor: Monitor,
}
impl Recorder {
    pub fn start(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("无法创建录制目录 {}", dir.display()))?;
        let (tx, rx) = mpsc::sync_channel(QUEUE_CAPACITY);
        let root = dir.clone();
        let thread = thread::Builder::new()
            .name("recorder".into())
            .spawn(move || run_writer(&rx, &root, WriterConfig::default()))?;
        Ok(Self {
            tx,
            thread: Some(thread),
            session: now_ms(),
            next_id: AtomicU64::new(0),
            monitor: Monitor {
                dir,
                streams: Arc::default(),
            },
        })
    }

    /// A handle for one market; it writes to `{dir}/{venue}/spot/{symbol}/`.
    pub fn stream(&self, venue: &str, info: &SymbolInfo) -> StreamRecorder {
        let stats = Arc::new(StreamStats::new(venue, &info.symbol));
        lock(&self.monitor.streams).push(stats.clone());
        let header = Header {
            format: FORMAT.into(),
            version: VERSION,
            venue: venue.into(),
            product: "spot".into(),
            info: info.clone(),
            session: self.session,
            app_version: env!("CARGO_PKG_VERSION").into(),
        };
        StreamRecorder {
            meta: Arc::new(StreamMeta {
                id: self.next_id.fetch_add(1, Relaxed),
                header,
                stats,
            }),
            tx: self.tx.clone(),
            dropped: 0,
        }
    }

    pub fn monitor(&self) -> Monitor {
        self.monitor.clone()
    }

    /// Flushes and closes all files; equivalent to dropping the recorder.
    pub fn shutdown(self) {}
}
impl Drop for Recorder {
    fn drop(&mut self) {
        // Blocks only while the writer drains what is already queued.
        let _ = self.tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("Recorder thread panicked; open files remain as .part");
        }
    }
}

fn run_writer(rx: &mpsc::Receiver<Command>, root: &Path, config: WriterConfig) {
    let mut writers: HashMap<u64, StreamWriter> = HashMap::new();
    loop {
        match rx.recv_timeout(WAKE_INTERVAL) {
            Ok(Command::Write { stream, line }) => writers
                .entry(stream.id)
                .or_insert_with(|| {
                    StreamWriter::new(root, stream.header.clone(), config, stream.stats.clone())
                })
                .write(&line),
            Ok(Command::Close(id)) => {
                if let Some(mut writer) = writers.remove(&id) {
                    writer.close();
                }
            }
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        writers.values_mut().for_each(|w| w.flush_if_due(now));
    }
    writers.values_mut().for_each(StreamWriter::close);
}

/// Per-market recording handle, used only by that market's task.
/// Every method returns immediately; it never blocks the engine.
pub struct StreamRecorder {
    meta: Arc<StreamMeta>,
    tx: SyncSender<Command>,
    /// Inputs dropped since the last successful enqueue.
    dropped: u64,
}
impl StreamRecorder {
    /// A new order book snapshot, i.e. a new engine instance.
    pub fn snapshot(&mut self, t: u64, snapshot: &BookSnapshot) {
        self.send(t, snapshot.into());
    }
    /// An event passed to `Engine::on_event` with clock `t`.
    pub fn event(&mut self, t: u64, event: &MarketEvent) {
        self.send(t, event.into());
    }
    /// `Engine::snapshot` was called with clock `t`.
    pub fn tick(&mut self, t: u64) {
        self.send(t, Record::Tick);
    }
    pub fn status(&mut self, t: u64, state: Status, attempt: u32, message: Option<String>) {
        self.send(
            t,
            Record::Status {
                state,
                attempt,
                message,
            },
        );
    }

    fn send(&mut self, t: u64, record: Record) {
        if self.dropped > 0 {
            let gap = Record::Gap {
                lost: self.dropped,
                reason: GapReason::Backpressure,
            };
            if !self.enqueue(t, gap) {
                return self.lose();
            }
            self.dropped = 0;
        }
        if !self.enqueue(t, record) {
            self.lose();
        }
    }
    /// False only when the queue is full; after shutdown inputs are discarded silently.
    fn enqueue(&self, t: u64, record: Record) -> bool {
        let command = Command::Write {
            stream: self.meta.clone(),
            line: Line { t, record },
        };
        !matches!(self.tx.try_send(command), Err(TrySendError::Full(_)))
    }
    fn lose(&mut self) {
        if self.dropped == 0 {
            tracing::warn!(symbol = %self.meta.header.info.symbol, "Recording queue full; dropping inputs");
        }
        self.dropped += 1;
        self.meta.stats.dropped.fetch_add(1, Relaxed);
    }
}
impl Drop for StreamRecorder {
    fn drop(&mut self) {
        let _ = self.tx.try_send(Command::Close(self.meta.id));
    }
}

/// Live counters for one recorded market, shared with the health endpoint.
struct StreamStats {
    venue: String,
    symbol: String,
    records: AtomicU64,
    compressed_bytes: AtomicU64,
    dropped: AtomicU64,
    lost: AtomicU64,
    file: Mutex<Option<PathBuf>>,
    error: Mutex<Option<String>>,
}
impl StreamStats {
    fn new(venue: &str, symbol: &str) -> Self {
        Self {
            venue: venue.into(),
            symbol: symbol.into(),
            records: AtomicU64::new(0),
            compressed_bytes: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            lost: AtomicU64::new(0),
            file: Mutex::new(None),
            error: Mutex::new(None),
        }
    }
    fn add_written(&self, records: u64, compressed_bytes: u64) {
        self.records.fetch_add(records, Relaxed);
        self.compressed_bytes.fetch_add(compressed_bytes, Relaxed);
    }
    fn add_lost(&self, n: u64) {
        self.lost.fetch_add(n, Relaxed);
    }
    fn set_file(&self, file: Option<PathBuf>) {
        *lock(&self.file) = file;
    }
    fn set_error(&self, error: String) {
        *lock(&self.error) = Some(error);
    }
    fn clear_error(&self) {
        *lock(&self.error) = None;
    }
    #[cfg(test)]
    fn records(&self) -> u64 {
        self.records.load(Relaxed)
    }
    #[cfg(test)]
    fn lost(&self) -> u64 {
        self.lost.load(Relaxed)
    }
    #[cfg(test)]
    fn error(&self) -> Option<String> {
        lock(&self.error).clone()
    }
}

/// Read-only view of the recorder for `/api/health`.
#[derive(Clone)]
pub struct Monitor {
    dir: PathBuf,
    streams: Arc<Mutex<Vec<Arc<StreamStats>>>>,
}
#[derive(Serialize)]
pub struct RecordingStatus {
    dir: PathBuf,
    streams: Vec<StreamStatus>,
}
#[derive(Serialize)]
struct StreamStatus {
    venue: String,
    symbol: String,
    /// Lines that reached the disk.
    records: u64,
    compressed_bytes: u64,
    /// Inputs dropped because the queue was full.
    dropped: u64,
    /// Inputs lost to disk errors.
    lost: u64,
    file: Option<PathBuf>,
    error: Option<String>,
}
impl Monitor {
    pub fn status(&self) -> RecordingStatus {
        let streams = lock(&self.streams)
            .iter()
            .map(|s| StreamStatus {
                venue: s.venue.clone(),
                symbol: s.symbol.clone(),
                records: s.records.load(Relaxed),
                compressed_bytes: s.compressed_bytes.load(Relaxed),
                dropped: s.dropped.load(Relaxed),
                lost: s.lost.load(Relaxed),
                file: lock(&s.file).clone(),
                error: lock(&s.error).clone(),
            })
            .collect();
        RecordingStatus {
            dir: self.dir.clone(),
            streams,
        }
    }
}

/// Stats stay usable even if a thread panicked while holding the lock.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn info() -> SymbolInfo {
        SymbolInfo {
            symbol: "BTCUSDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            tick_size: "0.01".into(),
            price_decimals: 2,
            size_decimals: 8,
        }
    }

    #[test]
    fn config_is_optional_normalized_and_deduplicated() {
        assert_eq!(
            RecordConfig::parse(" , ", "d".into(), "binance").unwrap(),
            None
        );
        let config =
            RecordConfig::parse("btc/usdt, Binance:ETHUSDT,BTCUSDT", "d".into(), "binance")
                .unwrap()
                .unwrap();
        let markets: Vec<_> = config
            .markets
            .iter()
            .map(|m| format!("{}:{}", m.venue, m.symbol))
            .collect();
        assert_eq!(markets, ["binance:BTCUSDT", "binance:ETHUSDT"]);
        assert!(RecordConfig::parse("BTC USDT", "d".into(), "binance").is_err());
    }

    #[test]
    fn a_full_queue_becomes_a_gap_line() {
        let root = tempfile::tempdir().unwrap();
        let recorder = Recorder::start(root.path().into()).unwrap();
        let (tx, rx) = mpsc::sync_channel(2);
        let mut stream = recorder.stream("binance", &info());
        stream.tx = tx;
        for t in 1..=4 {
            stream.tick(t);
        }
        assert_eq!(stream.meta.stats.dropped.load(Relaxed), 2);
        let drain = |rx: &mpsc::Receiver<Command>| -> Vec<Line> {
            rx.try_iter()
                .filter_map(|c| match c {
                    Command::Write { line, .. } => Some(line),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(drain(&rx).iter().map(|l| l.t).collect::<Vec<_>>(), [1, 2]);
        stream.tick(5);
        let gap = Record::Gap {
            lost: 2,
            reason: GapReason::Backpressure,
        };
        assert_eq!(
            drain(&rx),
            [
                Line { t: 5, record: gap },
                Line {
                    t: 5,
                    record: Record::Tick
                }
            ]
        );
    }

    #[test]
    fn shutdown_publishes_complete_files() {
        let root = tempfile::tempdir().unwrap();
        let recorder = Recorder::start(root.path().into()).unwrap();
        let monitor = recorder.monitor();
        let mut stream = recorder.stream("binance", &info());
        stream.status(1_000, Status::Connecting, 1, None);
        stream.tick(1_100);
        recorder.shutdown();

        let day = root.path().join("binance/spot/BTCUSDT/1970-01-01");
        let names: Vec<_> = std::fs::read_dir(&day)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["000001.jsonl.zst"]);
        let mut text = String::new();
        zstd::stream::read::Decoder::new(std::fs::File::open(day.join(&names[0])).unwrap())
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        let kinds: Vec<_> = text
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["k"].clone())
            .collect();
        assert_eq!(kinds, ["header", "status", "tick"]);
        let status = monitor.status();
        assert_eq!(status.streams[0].records, 3);
        assert_eq!(status.streams[0].file, None);
    }
}
