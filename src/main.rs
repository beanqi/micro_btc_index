mod book;
mod exchange;
mod metrics;
mod model;

use anyhow::{Context, Result, bail};
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
    async fn subscribe(&self, venue: &str, symbol: &str) -> Result<watch::Receiver<Arc<str>>> {
        let info = self
            .symbols(venue)
            .await?
            .into_iter()
            .find(|s| s.symbol == symbol)
            .context("无效或未开放交易的现货 Symbol")?;
        let key = format!("{venue}:{symbol}");
        let mut markets = self.markets.lock().await;
        markets.retain(|_, entry| !entry.task.is_finished());
        if let Some(entry) = markets.get(&key) {
            return Ok(entry.tx.subscribe());
        }
        if markets.len() >= MAX_MARKETS {
            bail!("同时监控的交易对已达上限 8，请关闭不用的页面，等待 15 秒释放订阅");
        }
        let adapter = self
            .exchanges
            .get(venue)
            .context("Unknown exchange")?
            .clone();
        let (tx,rx)=watch::channel(Arc::<str>::from(json!({"type":"status","status":"connecting","symbol":symbol,"valid":false,"message":"正在建立行情连接"}).to_string()));
        let task = tokio::spawn(run_market(adapter, info, tx.clone()));
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
) -> Result<()> {
    let (events, mut rx) = mpsc::channel(8192);
    let (done, mut end) = mpsc::channel(1);
    let symbol = info.symbol.clone();
    let venue = adapter.id();
    let _task = AbortTask(tokio::spawn(async move {
        let result = adapter.stream(&symbol, events).await;
        let _ = done.send(result).await;
    }));
    let mut engine: Option<Engine> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut idle = None;
    loop {
        tokio::select! {
            result=end.recv()=>return result.context("行情任务已退出")?,
            message=rx.recv()=>match message.context("行情通道已关闭")? {
                FeedMessage::Snapshot(s)=>engine=Some(Engine::new(s,now_ms())?),
                FeedMessage::Event(e)=>if let Some(engine)=&mut engine {engine.on_event(e,now_ms())?;},
            },
            _=tick.tick()=>{
                if tx.receiver_count()==0 {
                    if idle.is_none(){idle=Some(Instant::now());}
                    if idle.is_some_and(|t|t.elapsed()>Duration::from_secs(15)){return Ok(());}
                } else {idle=None;}
                if let Some(engine)=&mut engine {
                    let start=Instant::now();
                    let mut frame=engine.snapshot(info,venue,now_ms());
                    frame["compute_us"]=json!(start.elapsed().as_micros());
                    tx.send_replace(Arc::from(serde_json::to_string(&frame)?));
                }
            }
        }
    }
}
async fn run_market(adapter: Arc<dyn Exchange>, info: SymbolInfo, tx: watch::Sender<Arc<str>>) {
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
        match run_attempt(adapter.clone(), &info, &tx).await {
            Ok(()) => break,
            Err(error) => {
                if started.elapsed() > Duration::from_secs(60) {
                    failures = 0;
                }
                failures += 1;
                tracing::warn!(symbol=%info.symbol,failures,error=%error,"Market stream stopped");
                let message = format!("{error:#}");
                if failures >= 3 {
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
                tokio::time::sleep(Duration::from_secs(2_u64.pow(failures))).await;
                if tx.receiver_count() == 0 {
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
        json!({"status":"ok","service":"micro_btc_index","active_markets":markets.values().filter(|e|!e.task.is_finished()).count(),"clients":markets.values().map(|e|e.tx.receiver_count()).sum::<usize>(),"publish_hz":10,"max_markets":MAX_MARKETS}),
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
    let symbol = q.symbol.trim().replace(['/', '-', '_'], "").to_uppercase();
    if symbol.len() > 80 || symbol.is_empty() || !symbol.chars().all(char::is_alphanumeric) {
        return api_error(anyhow::anyhow!("Symbol 格式不正确"));
    }
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
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("../web/index.html"),
    )
}
async fn javascript() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("../web/app.js"),
    )
}
async fn css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("../web/style.css"),
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
    let hub = Arc::new(Hub {
        exchanges: HashMap::from([("binance".into(), binance)]),
        symbols: Mutex::new(HashMap::new()),
        markets: Mutex::new(HashMap::new()),
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(javascript))
        .route("/style.css", get(css))
        .route("/api/health", get(health))
        .route("/api/venues", get(venues))
        .route("/api/symbols", get(symbols))
        .route("/ws", get(ws))
        .with_state(hub);
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("无法监听 {bind}，请检查端口占用"))?;
    tracing::info!(%bind,"Microstructure monitor ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
