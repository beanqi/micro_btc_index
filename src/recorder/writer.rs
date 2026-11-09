//! Hourly, crash-tolerant `jsonl.zst` files for one recorded market.
//!
//! Lines are buffered and periodically compressed as independent zstd frames, so
//! a crash loses at most the unflushed buffer and every complete frame stays
//! readable. Files are written as `*.part` and renamed once closed cleanly.

use super::{
    StreamStats,
    format::{GapReason, Header, Line, Record},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use zstd::{bulk::Compressor, stream::raw::CParameter};

const HOUR_MS: u64 = 3_600_000;
/// After a disk error, inputs are counted as lost until a new file can be opened.
const RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
pub struct WriterConfig {
    pub level: i32,
    /// Upper bound on what a crash can lose.
    pub flush_interval: Duration,
    pub flush_bytes: usize,
}
impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            level: 3,
            flush_interval: Duration::from_secs(5),
            flush_bytes: 1 << 20,
        }
    }
}

pub struct StreamWriter {
    /// `{root}/{venue}/{product}/{symbol}`
    dir: PathBuf,
    header: Header,
    config: WriterConfig,
    stats: Arc<StreamStats>,
    segment: Option<Segment>,
    buffer: Vec<u8>,
    /// Lines in `buffer`.
    pending: u64,
    last_flush: Instant,
    failure: Option<Failure>,
}
struct Failure {
    retry_at: Instant,
    lost: u64,
}
impl StreamWriter {
    pub fn new(root: &Path, header: Header, config: WriterConfig, stats: Arc<StreamStats>) -> Self {
        let dir = root
            .join(&header.venue)
            .join(&header.product)
            .join(&header.info.symbol);
        Self {
            dir,
            header,
            config,
            stats,
            segment: None,
            buffer: Vec::with_capacity(config.flush_bytes + 64 * 1024),
            pending: 0,
            last_flush: Instant::now(),
            failure: None,
        }
    }

    pub fn write(&mut self, line: &Line) {
        if let Some(failure) = &mut self.failure
            && Instant::now() < failure.retry_at
        {
            failure.lost += 1;
            self.stats.add_lost(1);
            return;
        }
        if self
            .segment
            .as_ref()
            .is_some_and(|s| s.hour != line.t / HOUR_MS)
        {
            self.close();
        }
        if self.segment.is_none() && !self.open(line.t) {
            return;
        }
        self.push(line);
        if self.buffer.len() >= self.config.flush_bytes {
            self.flush();
        }
    }

    pub fn flush_if_due(&mut self, now: Instant) {
        if self.pending > 0 && now.duration_since(self.last_flush) >= self.config.flush_interval {
            self.flush();
        }
    }

    /// Flushes, syncs and publishes the current file under its final name.
    pub fn close(&mut self) {
        self.flush();
        let Some(segment) = self.segment.take() else {
            return;
        };
        let (records, raw, compressed) = (segment.records, segment.raw, segment.compressed);
        match segment.finish() {
            Ok(path) => tracing::info!(
                path = %path.display(),
                records,
                raw_bytes = raw,
                compressed_bytes = compressed,
                "Recording file closed"
            ),
            Err(error) => {
                tracing::error!(%error, "Recording file could not be finalized; data stays in the .part file");
                self.stats.set_error(format!("{error}"));
            }
        }
        self.stats.set_file(None);
    }

    /// Opens a file for an input at `t`, starting it with a header and any pending gap.
    fn open(&mut self, t: u64) -> bool {
        let segment = match Segment::create(&self.dir, t, self.config.level) {
            Ok(segment) => segment,
            Err(error) => {
                self.fail(&error, 1);
                return false;
            }
        };
        self.stats.set_file(Some(segment.part.clone()));
        self.stats.clear_error();
        self.segment = Some(segment);
        self.last_flush = Instant::now();
        self.push(&Line {
            t,
            record: Record::Header(Box::new(self.header.clone())),
        });
        if let Some(failure) = self.failure.take() {
            self.push(&Line {
                t,
                record: Record::Gap {
                    lost: failure.lost,
                    reason: GapReason::Io,
                },
            });
        }
        true
    }

    fn push(&mut self, line: &Line) {
        let start = self.buffer.len();
        match serde_json::to_writer(&mut self.buffer, line) {
            Ok(()) => {
                self.buffer.push(b'\n');
                self.pending += 1;
            }
            Err(error) => {
                self.buffer.truncate(start);
                tracing::error!(%error, "Recording line could not be serialized");
            }
        }
    }

    fn flush(&mut self) {
        if self.pending == 0 {
            return;
        }
        let pending = std::mem::take(&mut self.pending);
        let result = match &mut self.segment {
            Some(segment) => segment.append(&self.buffer, pending),
            None => Err(io::Error::other("no open recording file")),
        };
        self.buffer.clear();
        self.last_flush = Instant::now();
        match result {
            Ok(compressed) => self.stats.add_written(pending, compressed),
            Err(error) => self.fail(&error, pending),
        }
    }

    fn fail(&mut self, error: &io::Error, lost: u64) {
        let earlier = self.failure.take().map_or(0, |f| f.lost);
        if earlier == 0 {
            tracing::error!(%error, dir = %self.dir.display(), "Recording write failed; retrying in 30s");
        }
        self.stats.add_lost(lost);
        self.stats.set_error(format!("{error}"));
        self.stats.set_file(None);
        // Keep whatever reached the disk as a `.part` file; a fresh file follows the retry.
        self.segment = None;
        self.failure = Some(Failure {
            retry_at: Instant::now() + RETRY_AFTER,
            lost: earlier + lost,
        });
    }
}

/// One output file.
struct Segment {
    file: File,
    part: PathBuf,
    path: PathBuf,
    hour: u64,
    compressor: Compressor<'static>,
    records: u64,
    raw: u64,
    compressed: u64,
}
impl Segment {
    /// `{dir}/{YYYY-MM-DD}/{HHMMSS}.jsonl.zst` in UTC, named after the first input.
    /// A name that is already taken gets `_1`, `_2`, … which still sorts after it.
    fn create(dir: &Path, t: u64, level: i32) -> io::Result<Self> {
        let (date, time) = utc_names(t);
        let dir = dir.join(date);
        fs::create_dir_all(&dir)?;
        let mut compressor = Compressor::new(level)?;
        compressor.set_parameter(CParameter::ChecksumFlag(true))?;
        for n in 0_u32.. {
            let stem = if n == 0 {
                time.clone()
            } else {
                format!("{time}_{n}")
            };
            let path = dir.join(format!("{stem}.jsonl.zst"));
            let part = dir.join(format!("{stem}.jsonl.zst.part"));
            if path.exists() {
                continue;
            }
            match OpenOptions::new().write(true).create_new(true).open(&part) {
                Ok(file) => {
                    return Ok(Self {
                        file,
                        part,
                        path,
                        hour: t / HOUR_MS,
                        compressor,
                        records: 0,
                        raw: 0,
                        compressed: 0,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!("file name suffixes exhausted")
    }

    /// Writes `count` buffered lines as one self-contained zstd frame; returns its compressed size.
    fn append(&mut self, lines: &[u8], count: u64) -> io::Result<u64> {
        let frame = self.compressor.compress(lines)?;
        self.file.write_all(&frame)?;
        self.records += count;
        self.raw += lines.len() as u64;
        self.compressed += frame.len() as u64;
        Ok(frame.len() as u64)
    }

    fn finish(self) -> io::Result<PathBuf> {
        self.file.sync_all()?;
        fs::rename(&self.part, &self.path)?;
        Ok(self.path)
    }
}

/// `("YYYY-MM-DD", "HHMMSS")` in UTC for Unix milliseconds.
fn utc_names(ms: u64) -> (String, String) {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's days-to-civil algorithm, specialised to dates after 1970.
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!("{:02}{:02}{:02}", rem / 3_600, rem % 3_600 / 60, rem % 60),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::SymbolInfo,
        recorder::format::{FORMAT, VERSION},
    };
    use std::io::Read;

    /// 2026-11-09T12:59:59Z
    const T: u64 = 1_794_229_199_000;

    fn header() -> Header {
        Header {
            format: FORMAT.into(),
            version: VERSION,
            venue: "binance".into(),
            product: "spot".into(),
            info: SymbolInfo {
                symbol: "BTCUSDT".into(),
                base: "BTC".into(),
                quote: "USDT".into(),
                tick_size: "0.01".into(),
                price_decimals: 2,
                size_decimals: 8,
            },
            session: 1,
            app_version: "test".into(),
        }
    }
    fn writer(root: &Path, config: WriterConfig) -> (StreamWriter, Arc<StreamStats>) {
        let stats = Arc::new(StreamStats::new("binance", "BTCUSDT"));
        (
            StreamWriter::new(root, header(), config, stats.clone()),
            stats,
        )
    }
    fn tick(t: u64) -> Line {
        Line {
            t,
            record: Record::Tick,
        }
    }
    fn read(path: &Path) -> Vec<Line> {
        let mut text = String::new();
        zstd::stream::read::Decoder::new(File::open(path).unwrap())
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn utc_names_follow_the_civil_calendar() {
        assert_eq!(utc_names(0), ("1970-01-01".into(), "000000".into()));
        assert_eq!(utc_names(T), ("2026-11-09".into(), "125959".into()));
        assert_eq!(
            utc_names(1_709_210_096_000),
            ("2024-02-29".into(), "123456".into())
        );
        assert_eq!(
            utc_names(4_107_542_399_999),
            ("2100-02-28".into(), "235959".into())
        );
    }

    #[test]
    fn rotates_hourly_with_a_header_per_file() {
        let root = tempfile::tempdir().unwrap();
        let (mut w, stats) = writer(root.path(), WriterConfig::default());
        for t in [T, T + 500, T + 1_000, T + 1_100] {
            w.write(&tick(t));
        }
        w.close();

        let day = root.path().join("binance/spot/BTCUSDT/2026-11-09");
        assert_eq!(files(&day), ["125959.jsonl.zst", "130000.jsonl.zst"]);
        let first = read(&day.join("125959.jsonl.zst"));
        let second = read(&day.join("130000.jsonl.zst"));
        assert_eq!(first[0].record, Record::Header(Box::new(header())));
        assert_eq!(first[1..], [tick(T), tick(T + 500)]);
        assert_eq!(second[0].t, T + 1_000);
        assert!(matches!(second[0].record, Record::Header(_)));
        assert_eq!(second[1..], [tick(T + 1_000), tick(T + 1_100)]);
        assert_eq!(stats.records(), 6);
    }

    #[test]
    fn flushed_frames_survive_a_crash() {
        let root = tempfile::tempdir().unwrap();
        let config = WriterConfig {
            flush_bytes: 1,
            ..WriterConfig::default()
        };
        let (mut w, _) = writer(root.path(), config);
        w.write(&tick(T));
        w.write(&tick(T + 100));
        let part = root
            .path()
            .join("binance/spot/BTCUSDT/2026-11-09/125959.jsonl.zst.part");
        // The process "crashes" here: the writer is never closed.
        std::mem::forget(w);
        assert_eq!(read(&part)[1..], [tick(T), tick(T + 100)]);
    }

    #[test]
    fn restarts_never_overwrite_existing_files() {
        let root = tempfile::tempdir().unwrap();
        for _ in 0..2 {
            let (mut w, _) = writer(root.path(), WriterConfig::default());
            w.write(&tick(T));
            w.close();
        }
        let day = root.path().join("binance/spot/BTCUSDT/2026-11-09");
        assert_eq!(files(&day), ["125959.jsonl.zst", "125959_1.jsonl.zst"]);
    }

    #[test]
    fn disk_failures_are_recorded_as_a_gap() {
        let root = tempfile::tempdir().unwrap();
        // A regular file where the venue directory should be makes every open fail.
        let blocker = root.path().join("binance");
        fs::write(&blocker, b"").unwrap();
        let (mut w, stats) = writer(root.path(), WriterConfig::default());
        w.write(&tick(T));
        w.write(&tick(T + 100));
        assert_eq!(stats.lost(), 2);
        assert!(stats.error().is_some());

        fs::remove_file(&blocker).unwrap();
        w.failure.as_mut().unwrap().retry_at = Instant::now();
        w.write(&tick(T + 200));
        w.close();
        let lines = read(
            &root
                .path()
                .join("binance/spot/BTCUSDT/2026-11-09/125959.jsonl.zst"),
        );
        assert_eq!(
            lines[1].record,
            Record::Gap {
                lost: 2,
                reason: GapReason::Io
            }
        );
        assert_eq!(lines[2], tick(T + 200));
        assert!(stats.error().is_none());
    }
}
