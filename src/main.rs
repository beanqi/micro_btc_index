mod book;
mod exchange;
mod metrics;
mod model;
mod recorder;

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use exchange::{Exchange, FeedMessage, binance::Binance};
use futures_util::{SinkExt, StreamExt};
use metrics::Engine;
use model::*;
use recorder::{Monitor, RecordConfig, Recorder, StreamRecorder};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};

const MAX_MARKETS: usize = 8;
struct Entry {
    tx: watch::Sender<Arc<str>>,
    task: JoinHandle<()>,
}
struct Hub {
    exchanges: HashMap<String, Arc<dyn Exchange>>,
    symbols: Mutex<HashMap<String, (Instant, Vec<SymbolInfo>)>>,
    markets: Mutex<HashMap<String, Entry>>,
    recording: Option<Monitor>,
}
impl Hub {
    async fn symbols(&self, venue: &str) -> Result<Vec<SymbolInfo>> {
        let adapter = self.exchanges.get(venue).context("暂不支持该交易所")?;
        let mut cache = self.symbols.lock().await;
        if let Some((time, symbols)) = cache.get(venue)
            && time.elapsed() < Duration::from_secs(600)
        {
            return Ok(symbols.clone());
        }
        let symbols = adapter
            .symbols()
            .await
            .context("无法读取 Binance 现货交易对列表，请检查公共 API 连通性")?;
        cache.insert(venue.into(), (Instant::now(), symbols.clone()));
        Ok(symbols)
    }
    async fn info(&self, venue: &str, symbol: &str) -> Result<SymbolInfo> {
        self.symbols(venue)
            .await?
            .into_iter()
            .find(|s| s.symbol == symbol)
            .context("无效或未开放交易的现货 Symbol")
    }
    async fn subscribe(&self, venue: &str, symbol: &str) -> Result<watch::Receiver<Arc<str>>> {
        let info = self.info(venue, symbol).await?;
        let mut markets = self.markets.lock().await;
        markets.retain(|_, entry| !entry.task.is_finished());
        if let Some(entry) = markets.get(&format!("{venue}:{symbol}")) {
            return Ok(entry.tx.subscribe());
        }
        self.start_market(&mut markets, venue, info, None)
    }
    /// Starts a market whose engine inputs are recorded; it runs until shutdown.
    async fn record(&self, venue: &str, info: SymbolInfo, recorder: &Recorder) -> Result<()> {
        let mut markets = self.markets.lock().await;
        ensure!(
            !markets.contains_key(&format!("{venue}:{}", info.symbol)),
            "{venue}:{} 已在运行",
            info.symbol
        );
        let stream = recorder.stream(venue, &info);
        self.start_market(&mut markets, venue, info, Some(stream))?;
        Ok(())
    }
    fn start_market(
        &self,
        markets: &mut HashMap<String, Entry>,
        venue: &str,
        info: SymbolInfo,
        recording: Option<StreamRecorder>,
    ) -> Result<watch::Receiver<Arc<str>>> {
        if markets.len() >= MAX_MARKETS {
            bail!("同时监控的交易对已达上限 8，请关闭不用的页面，等待 15 秒释放订阅");
        }
        let adapter = self
            .exchanges
            .get(venue)
            .context("Unknown exchange")?
            .clone();
        let key = format!("{venue}:{}", info.symbol);
        let (tx,rx)=watch::channel(Arc::<str>::from(json!({"type":"status","status":"connecting","symbol":info.symbol,"valid":false,"message":"正在建立行情连接"}).to_string()));
        let task = tokio::spawn(run_market(adapter, info, tx.clone(), recording));
        markets.insert(key, Entry { tx, task });
        Ok(rx)
    }
}
fn status(tx: &watch::Sender<Arc<str>>, symbol: &str, state: &str, message: &str, attempt: u32) {
    tx.send_replace(Arc::from(json!({"type":"status","status":state,"symbol":symbol,"valid":false,"message":message,"attempt":attempt,"ts":now_ms()}).to_string()));
}
struct AbortTask(JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn run_attempt(
    adapter: Arc<dyn Exchange>,
    info: &SymbolInfo,
    tx: &watch::Sender<Arc<str>>,
    mut recording: Option<&mut StreamRecorder>,
) -> Result<()> {
    let (events, mut rx) = mpsc::channel(8192);
    let (done, mut end) = mpsc::channel(1);
    let symbol = info.symbol.clone();
    let venue = adapter.id();
    let pinned = recording.is_some();
    let _task = AbortTask(tokio::spawn(async move {
        let result = adapter.stream(&symbol, events).await;
        let _ = done.send(result).await;
    }));
    let mut engine: Option<Engine> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut idle = None;
    // Every engine input is recorded with the same clock value the engine receives.
    loop {
        tokio::select! {
            result=end.recv()=>return result.context("行情任务已退出")?,
            message=rx.recv()=>match message.context("行情通道已关闭")? {
                FeedMessage::Snapshot(s)=>{
                    let now=now_ms();
                    if let Some(r)=recording.as_deref_mut(){r.snapshot(now,&s);}
                    engine=Some(Engine::new(s,now)?);
                },
                FeedMessage::Event(e)=>if let Some(engine)=&mut engine {
                    let now=now_ms();
                    if let Some(r)=recording.as_deref_mut(){r.event(now,&e);}
                    engine.on_event(e,now)?;
                },
            },
            _=tick.tick()=>{
                if !pinned && tx.receiver_count()==0 {
                    if idle.is_none(){idle=Some(Instant::now());}
                    if idle.is_some_and(|t|t.elapsed()>Duration::from_secs(15)){return Ok(());}
                } else {idle=None;}
                if let Some(engine)=&mut engine {
                    let now=now_ms();
                    if let Some(r)=recording.as_deref_mut(){r.tick(now);}
                    let start=Instant::now();
                    let mut frame=engine.snapshot(info,venue,now);
                    frame["compute_us"]=json!(start.elapsed().as_micros());
                    tx.send_replace(Arc::from(serde_json::to_string(&frame)?));
                }
            }
        }
    }
}
/// Recorded markets are pinned: they ignore the idle timeout and retry forever,
/// so a closed tab or a transient upstream failure never ends the recording.
async fn run_market(
    adapter: Arc<dyn Exchange>,
    info: SymbolInfo,
    tx: watch::Sender<Arc<str>>,
    mut recording: Option<StreamRecorder>,
) {
    let pinned = recording.is_some();
    let mut failures = 0;
    loop {
        let started = Instant::now();
        status(
            &tx,
            &info.symbol,
            "connecting",
            "正在同步订单簿快照与实时增量",
            failures + 1,
        );
        if let Some(r) = &mut recording {
            r.status(now_ms(), recorder::Status::Connecting, failures + 1, None);
        }
        match run_attempt(adapter.clone(), &info, &tx, recording.as_mut()).await {
            Ok(()) => break,
            Err(error) => {
                if started.elapsed() > Duration::from_secs(60) {
                    failures = 0;
                }
                failures += 1;
                tracing::warn!(symbol=%info.symbol,failures,error=%error,"Market stream stopped");
                let message = format!("{error:#}");
                if let Some(r) = &mut recording {
                    r.status(
                        now_ms(),
                        recorder::Status::Error,
                        failures,
                        Some(message.clone()),
                    );
                }
                if !pinned && failures >= 3 {
                    status(
                        &tx,
                        &info.symbol,
                        "blocked",
                        &format!(
                            "连续 3 次连接或同步失败。请检查网络／公共接口后点击重新连接。{message}"
                        ),
                        failures,
                    );
                    break;
                }
                status(&tx, &info.symbol, "reconnecting", &message, failures);
                // 2s, 4s, 8s … capped at 60s; on-demand markets stop after the third failure.
                let delay = 2_u64.pow(failures.min(6)).min(60);
                tokio::time::sleep(Duration::from_secs(delay)).await;
                if !pinned && tx.receiver_count() == 0 {
                    break;
                }
            }
        }
    }
}
#[derive(Deserialize)]
struct Subscription {
    #[serde(default = "default_venue")]
    venue: String,
    #[serde(default = "default_symbol")]
    symbol: String,
}
fn default_venue() -> String {
    "binance".into()
}
fn default_symbol() -> String {
    "BTCUSDT".into()
}
fn api_error(error: anyhow::Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":format!("{error:#}")})),
    )
        .into_response()
}
async fn symbols(State(hub): State<Arc<Hub>>, Query(q): Query<Subscription>) -> Response {
    match hub.symbols(&q.venue).await {
        Ok(symbols) => Json(json!({"venue":q.venue,"symbols":symbols})).into_response(),
        Err(e) => api_error(e),
    }
}
async fn venues(State(hub): State<Arc<Hub>>) -> Json<serde_json::Value> {
    Json(
        json!({"venues":hub.exchanges.keys().map(|id|json!({"id":id,"name":if id=="binance" {"Binance"}else{id},"products":["spot"]})).collect::<Vec<_>>() }),
    )
}
async fn health(State(hub): State<Arc<Hub>>) -> Json<serde_json::Value> {
    let markets = hub.markets.lock().await;
    Json(
        json!({"status":"ok","service":"micro_btc_index","active_markets":markets.values().filter(|e|!e.task.is_finished()).count(),"clients":markets.values().map(|e|e.tx.receiver_count()).sum::<usize>(),"publish_hz":10,"max_markets":MAX_MARKETS,"recording":hub.recording.as_ref().map(Monitor::status)}),
    )
}
async fn ws(
    State(hub): State<Arc<Hub>>,
    Query(q): Query<Subscription>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|x| x.to_str().ok()) {
        let host = headers
            .get(header::HOST)
            .and_then(|x| x.to_str().ok())
            .unwrap_or("");
        if origin != format!("http://{host}") && origin != format!("https://{host}") {
            return (StatusCode::FORBIDDEN, "Origin mismatch").into_response();
        }
    }
    let symbol = match normalize_symbol(&q.symbol) {
        Ok(symbol) => symbol,
        Err(e) => return api_error(e),
    };
    match hub.subscribe(&q.venue, &symbol).await {
        Ok(rx) => upgrade
            .max_message_size(4096)
            .on_upgrade(|socket| serve_socket(socket, rx))
            .into_response(),
        Err(e) => api_error(e),
    }
}
async fn serve_socket(socket: WebSocket, mut rx: watch::Receiver<Arc<str>>) {
    let (mut sender, mut receiver) = socket.split();
    let initial = rx.borrow_and_update().to_string();
    if sender.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            change=rx.changed()=>{
                if change.is_err(){break;}
                let frame=rx.borrow_and_update().to_string();
                // A slow browser receives the latest state, never an unbounded backlog.
                if !matches!(tokio::time::timeout(Duration::from_secs(3),sender.send(Message::Text(frame.into()))).await,Ok(Ok(()))){break;}
            },
            incoming=receiver.next()=>match incoming {
                Some(Ok(Message::Ping(v)))=>if sender.send(Message::Pong(v)).await.is_err(){break;},
                Some(Ok(Message::Close(frame)))=>{let _=sender.send(Message::Close(frame)).await;break;},
                None|Some(Err(_))=>break,
                _=>{},
            }
        }
    }
}
async fn index() -> impl IntoResponse {
    let body = std::fs::read_to_string("web/index.html")
        .unwrap_or_else(|_| include_str!("../web/index.html").to_owned());
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
}
async fn javascript() -> impl IntoResponse {
    let body = std::fs::read_to_string("web/app.js")
        .unwrap_or_else(|_| include_str!("../web/app.js").to_owned());
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
}
async fn css() -> impl IntoResponse {
    let body = std::fs::read_to_string("web/style.css")
        .unwrap_or_else(|_| include_str!("../web/style.css").to_owned());
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "micro_btc_index=info".into()),
        )
        .init();
    let binance: Arc<dyn Exchange> = Arc::new(Binance::new()?);
    let recording = match RecordConfig::from_env(&default_venue())? {
        Some(config) => {
            ensure!(
                config.markets.len() <= MAX_MARKETS,
                "RECORD_SYMBOLS 最多 {MAX_MARKETS} 个交易对"
            );
            let recorder = Recorder::start(config.dir.clone())?;
            Some((config, recorder))
        }
        None => None,
    };
    let hub = Arc::new(Hub {
        exchanges: HashMap::from([("binance".into(), binance)]),
        symbols: Mutex::new(HashMap::new()),
        markets: Mutex::new(HashMap::new()),
        recording: recording.as_ref().map(|(_, recorder)| recorder.monitor()),
    });
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("无法监听 {bind}，请检查端口占用"))?;
    if let Some((config, recorder)) = &recording {
        // Validate every symbol before connecting any, so a typo records nothing.
        let mut targets = Vec::new();
        for m in &config.markets {
            let info = (hub.info(&m.venue, &m.symbol).await)
                .with_context(|| format!("无法开始录制 {}:{}", m.venue, m.symbol))?;
            targets.push((m.venue.as_str(), info));
        }
        for (venue, info) in targets {
            tracing::info!(venue,symbol=%info.symbol,dir=%config.dir.display(),"Recording engine inputs");
            hub.record(venue, info, recorder).await?;
        }
    }
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(javascript))
        .route("/style.css", get(css))
        .route("/api/health", get(health))
        .route("/api/venues", get(venues))
        .route("/api/symbols", get(symbols))
        .route("/ws", get(ws))
        .with_state(hub);
    tracing::info!(%bind,"Microstructure monitor ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    if let Some((_, recorder)) = recording {
        recorder.shutdown();
        tracing::info!("Recording files closed");
    }
    Ok(())
}
/// Ctrl-C, or SIGTERM from a service manager, so recordings are closed cleanly.
async fn shutdown_signal() {
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate => {},
    }
}
