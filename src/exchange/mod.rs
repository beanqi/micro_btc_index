pub mod binance;
use crate::model::{BookSnapshot, MarketEvent, SymbolInfo};
use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;

/// Exchange adapters own transport, protocol sequencing and normalization.
/// Engines only consume normalized spot events; no venue-specific JSON enters them.
#[async_trait]
pub trait Exchange: Send + Sync {
    fn id(&self) -> &'static str;
    async fn symbols(&self) -> Result<Vec<SymbolInfo>>;
    async fn stream(&self, symbol: &str, tx: mpsc::Sender<FeedMessage>) -> Result<()>;
}
#[derive(Debug)]
pub enum FeedMessage {
    Snapshot(BookSnapshot),
    Event(MarketEvent),
}
