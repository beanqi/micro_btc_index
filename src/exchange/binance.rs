use super::{Exchange, FeedMessage};
use crate::model::*;
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::Value;
use std::{collections::VecDeque, time::Duration};
use tokio::{
    sync::mpsc,
    time::{Instant, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub struct Binance {
    client: Client,
    rest: String,
    ws: String,
}
impl Binance {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(12)).build()?,
            rest: std::env::var("BINANCE_REST_URL")
                .unwrap_or_else(|_| "https://data-api.binance.vision".into()),
            ws: std::env::var("BINANCE_WS_URL")
                .unwrap_or_else(|_| "wss://data-stream.binance.vision".into()),
        })
    }
    async fn snapshot(&self, symbol: &str) -> Result<BookSnapshot> {
        let d: Value = self
            .client
            .get(format!("{}/api/v3/depth", self.rest))
            .query(&[("symbol", symbol), ("limit", "5000")])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(BookSnapshot {
            last: number(&d, "lastUpdateId")?,
            bids: levels(&d["bids"])?,
            asks: levels(&d["asks"])?,
            limit: 5000,
        })
    }
}
fn number(v: &Value, key: &str) -> Result<u64> {
    v[key]
        .as_u64()
        .with_context(|| format!("Missing integer {key}"))
}
fn numeric(v: &Value, key: &str) -> Result<f64> {
    let n: f64 = v[key]
        .as_str()
        .with_context(|| format!("Missing numeric {key}"))?
        .parse()?;
    ensure!(n.is_finite() && n >= 0.0, "Invalid number {key}");
    Ok(n)
}
fn levels(v: &Value) -> Result<Levels> {
    v.as_array()
        .context("Missing levels")?
        .iter()
        .map(|row| {
            let p = price(row[0].as_str().context("Missing level price")?)?;
            let q: f64 = row[1].as_str().context("Missing level quantity")?.parse()?;
            ensure!(q.is_finite() && q >= 0.0, "Invalid quantity");
            Ok((p, q))
        })
        .collect()
}
pub fn parse(v: &Value) -> Result<Option<MarketEvent>> {
    let d = v.get("data").unwrap_or(v);
    Ok(match d["e"].as_str().unwrap_or("") {
        "depthUpdate" => Some(MarketEvent::Depth(Depth {
            first: number(d, "U")?,
            last: number(d, "u")?,
            ts: number(d, "E")?,
            bids: levels(&d["b"])?,
            asks: levels(&d["a"])?,
        })),
        "trade" => {
            let key = price(d["p"].as_str().context("Missing trade price")?)?;
            Some(MarketEvent::Trade(Trade {
                id: number(d, "t")?,
                ts: number(d, "T")?,
                price: as_price(key),
                size: numeric(d, "q")?,
                buy: !d["m"].as_bool().context("Missing maker flag")?,
                key,
            }))
        }
        "24hrTicker" => Some(MarketEvent::Ticker(Ticker {
            last: numeric(d, "c")?,
            change_pct: d["P"].as_str().context("Missing change")?.parse()?,
            high: numeric(d, "h")?,
            low: numeric(d, "l")?,
            quote_volume: numeric(d, "q")?,
        })),
        "serverShutdown" => bail!("Binance announced server shutdown"),
        _ => None,
    })
}
#[async_trait]
impl Exchange for Binance {
    fn id(&self) -> &'static str {
        "binance"
    }
    async fn symbols(&self) -> Result<Vec<SymbolInfo>> {
        let d: Value = self
            .client
            .get(format!("{}/api/v3/exchangeInfo", self.rest))
            .query(&[("permissions", "SPOT")])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let mut result = Vec::new();
        for s in d["symbols"].as_array().context("Missing symbols")? {
            if s["status"] != "TRADING" || s["isSpotTradingAllowed"] == false {
                continue;
            }
            let tick = s["filters"]
                .as_array()
                .and_then(|v| v.iter().find(|x| x["filterType"] == "PRICE_FILTER"))
                .and_then(|v| v["tickSize"].as_str())
                .unwrap_or("0.00000001");
            let decimals = tick
                .trim_end_matches('0')
                .split_once('.')
                .map_or(0, |(_, v)| v.len());
            if decimals > 8 {
                continue;
            }
            result.push(SymbolInfo {
                symbol: s["symbol"].as_str().context("Missing symbol")?.into(),
                base: s["baseAsset"]
                    .as_str()
                    .context("Missing base asset")?
                    .into(),
                quote: s["quoteAsset"]
                    .as_str()
                    .context("Missing quote asset")?
                    .into(),
                tick_size: tick.into(),
                price_decimals: decimals,
                size_decimals: s["baseAssetPrecision"].as_u64().unwrap_or(8).min(8) as usize,
            });
        }
        result.sort_by(|a, b| a.symbol.cmp(&b.symbol));
        Ok(result)
    }
    async fn stream(&self, symbol: &str, tx: mpsc::Sender<FeedMessage>) -> Result<()> {
        let sym = symbol.to_lowercase();
        let url = format!(
            "{}/stream?streams={sym}@depth@100ms/{sym}@trade/{sym}@ticker",
            self.ws
        );
        let (mut socket, _) = timeout(Duration::from_secs(12), connect_async(url)).await??;
        let snapshot = self.snapshot(symbol);
        tokio::pin!(snapshot);
        let mut buffer = VecDeque::new();
        let mut ready = false;
        let mut last_message = Instant::now();
        let mut health = tokio::time::interval(Duration::from_secs(5));
        let lifetime = tokio::time::sleep(Duration::from_secs(23 * 3600 + 50 * 60));
        tokio::pin!(lifetime);
        loop {
            tokio::select! {
                _ = tx.closed() => return Ok(()),
                _ = &mut lifetime => bail!("Scheduled connection renewal"),
                _ = health.tick() => ensure!(last_message.elapsed() < Duration::from_secs(30), "Upstream silent for 30s"),
                result = &mut snapshot, if !ready => {
                    tx.send(FeedMessage::Snapshot(result?)).await?;
                    while let Some(event) = buffer.pop_front() { tx.send(FeedMessage::Event(event)).await?; }
                    ready = true;
                },
                msg = socket.next() => {
                    match msg.context("Upstream closed")?? {
                        Message::Text(text) => {
                            last_message = Instant::now();
                            if let Some(event) = parse(&serde_json::from_str::<Value>(&text)?)? {
                                if ready { tx.send(FeedMessage::Event(event)).await?; }
                                else { ensure!(buffer.len()<50_000, "Snapshot buffer overflow"); buffer.push_back(event); }
                            }
                        },
                        Message::Ping(p) => { last_message = Instant::now(); socket.send(Message::Pong(p)).await?; },
                        Message::Close(_) => bail!("Upstream closed connection"),
                        _ => {},
                    }
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buyer_maker_is_aggressive_sell() {
        let v = serde_json::json!({"e":"trade","t":17,"T":1000,"p":"10.01","q":"2","m":true});
        let Some(MarketEvent::Trade(t)) = parse(&v).unwrap() else {
            panic!()
        };
        assert!(!t.buy);
        assert_eq!(t.key, 1_001_000_000);
    }
}
