use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PRICE_SCALE: f64 = 100_000_000.0;
pub type Price = i64;
pub type Levels = Vec<(Price, f64)>;
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn price(value: &str) -> Result<Price> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || (fraction.len() > 8 && fraction[8..].bytes().any(|c| c != b'0'))
    {
        bail!("Unsupported price precision: {value}");
    }
    let fraction = &fraction[..fraction.len().min(8)];
    let raw = whole
        .parse::<i64>()?
        .checked_mul(100_000_000)
        .and_then(|v| {
            v.checked_add(
                fraction.parse::<i64>().unwrap_or(0) * 10_i64.pow(8 - fraction.len() as u32),
            )
        });
    match raw {
        Some(p) if p > 0 => Ok(p),
        _ => bail!("Invalid price: {value}"),
    }
}
pub fn as_price(p: Price) -> f64 {
    p as f64 / PRICE_SCALE
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SymbolInfo {
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub tick_size: String,
    pub price_decimals: usize,
    pub size_decimals: usize,
}
#[derive(Clone, Debug)]
pub struct Depth {
    pub first: u64,
    pub last: u64,
    pub ts: u64,
    pub bids: Levels,
    pub asks: Levels,
}
#[derive(Clone, Debug)]
pub struct BookSnapshot {
    pub last: u64,
    pub bids: Levels,
    pub asks: Levels,
    pub limit: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct Trade {
    pub id: u64,
    pub ts: u64,
    pub price: f64,
    pub size: f64,
    pub buy: bool,
    #[serde(skip)]
    pub key: Price,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct Ticker {
    pub last: f64,
    pub change_pct: f64,
    pub high: f64,
    pub low: f64,
    pub quote_volume: f64,
}
#[derive(Debug)]
pub enum MarketEvent {
    Depth(Depth),
    Trade(Trade),
    Ticker(Ticker),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decimal_prices_are_exact_and_reject_loss() {
        assert_eq!(price("0.00000001").unwrap(), 1);
        assert_eq!(price("99999.01000000").unwrap(), 9_999_901_000_000);
        assert!(price("1.000000001").is_err());
        assert!(price("-1").is_err());
        assert!(price("0").is_err());
    }
}
