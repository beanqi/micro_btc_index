//! On-disk schema of an engine-input recording: one JSON object per line.
//!
//! A recording holds exactly what `Engine` consumed and the local clock value it
//! used, so feeding the lines back in order reproduces every live frame. The
//! schema is deliberately independent of the in-memory model types; bump
//! [`VERSION`] for any incompatible change. Field reference: `docs/recording.md`.

use crate::model::{
    BookSnapshot, Levels, MarketEvent, Price, SymbolInfo, Ticker, Trade, format_price, price,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

pub const FORMAT: &str = "micro_btc_index.engine_input";
pub const VERSION: u32 = 1;

/// One line. `t` is the local wall clock (Unix ms) the engine used for this input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub t: u64,
    #[serde(flatten)]
    pub record: Record,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum Record {
    /// First line of every file (boxed: it is rare and keeps queued inputs small).
    Header(Box<Header>),
    /// Connection lifecycle. The live engine never survives a status change.
    Status {
        state: Status,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// `lost` inputs never reached the file; engine state is unreliable until the next snapshot.
    Gap { lost: u64, reason: GapReason },
    /// REST order book snapshot; starts a new engine instance.
    Snapshot {
        last: u64,
        limit: usize,
        #[serde(with = "levels")]
        bids: Levels,
        #[serde(with = "levels")]
        asks: Levels,
    },
    /// Incremental depth covering update IDs `first..=last`; `ts` is the exchange event time.
    Depth {
        first: u64,
        last: u64,
        ts: u64,
        #[serde(with = "levels")]
        bids: Levels,
        #[serde(with = "levels")]
        asks: Levels,
    },
    /// Raw trade; `ts` is the exchange trade time and `buy` means buyer-initiated.
    Trade {
        id: u64,
        ts: u64,
        #[serde(with = "decimal")]
        price: Price,
        size: f64,
        buy: bool,
    },
    Ticker {
        last: f64,
        change_pct: f64,
        high: f64,
        low: f64,
        quote_volume: f64,
    },
    /// The engine produced a frame (`Engine::snapshot`) at `t`.
    Tick,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub venue: String,
    pub product: String,
    pub info: SymbolInfo,
    /// Unix ms when the recording process started; changes on every restart.
    pub session: u64,
    pub app_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Connecting,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    /// The writer could not keep up and the bounded queue was full.
    Backpressure,
    /// Writing to disk failed.
    Io,
}

impl From<&BookSnapshot> for Record {
    fn from(s: &BookSnapshot) -> Self {
        Record::Snapshot {
            last: s.last,
            limit: s.limit,
            bids: s.bids.clone(),
            asks: s.asks.clone(),
        }
    }
}
impl From<&MarketEvent> for Record {
    fn from(e: &MarketEvent) -> Self {
        match e {
            MarketEvent::Depth(d) => Record::Depth {
                first: d.first,
                last: d.last,
                ts: d.ts,
                bids: d.bids.clone(),
                asks: d.asks.clone(),
            },
            MarketEvent::Trade(Trade {
                id,
                ts,
                size,
                buy,
                key,
                ..
            }) => Record::Trade {
                id: *id,
                ts: *ts,
                price: *key,
                size: *size,
                buy: *buy,
            },
            MarketEvent::Ticker(Ticker {
                last,
                change_pct,
                high,
                low,
                quote_volume,
            }) => Record::Ticker {
                last: *last,
                change_pct: *change_pct,
                high: *high,
                low: *low,
                quote_volume: *quote_volume,
            },
        }
    }
}

/// Prices travel as exact decimal strings so no reader has to trust float rounding.
mod decimal {
    use super::*;
    pub fn serialize<S: Serializer>(p: &Price, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_price(*p))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Price, D::Error> {
        price(&String::deserialize(d)?).map_err(D::Error::custom)
    }
}
/// `[["97000.01", 0.5], ...]`: decimal price string and base-asset size.
mod levels {
    use super::*;
    struct Decimal(Price);
    impl Serialize for Decimal {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            decimal::serialize(&self.0, s)
        }
    }
    impl<'de> Deserialize<'de> for Decimal {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            decimal::deserialize(d).map(Decimal)
        }
    }
    pub fn serialize<S: Serializer>(levels: &Levels, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(levels.iter().map(|&(p, q)| (Decimal(p), q)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Levels, D::Error> {
        let rows = Vec::<(Decimal, f64)>::deserialize(d)?;
        Ok(rows.into_iter().map(|(p, q)| (p.0, q)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        metrics::Engine,
        model::{Depth, as_price},
    };

    fn info() -> SymbolInfo {
        SymbolInfo {
            symbol: "TEST".into(),
            base: "A".into(),
            quote: "B".into(),
            tick_size: "1".into(),
            price_decimals: 0,
            size_decimals: 2,
        }
    }
    fn trade(id: u64, ts: u64, buy: bool, size: f64) -> MarketEvent {
        let key = price(if buy { "101" } else { "99" }).unwrap();
        MarketEvent::Trade(Trade {
            id,
            ts,
            price: as_price(key),
            size,
            buy,
            key,
        })
    }
    fn depth(id: u64, ts: u64, bids: &[(&str, f64)], asks: &[(&str, f64)]) -> MarketEvent {
        let side = |v: &[(&str, f64)]| v.iter().map(|(p, q)| (price(p).unwrap(), *q)).collect();
        MarketEvent::Depth(Depth {
            first: id,
            last: id,
            ts,
            bids: side(bids),
            asks: side(asks),
        })
    }

    #[test]
    fn lines_have_a_flat_stable_shape() {
        let line = Line {
            t: 1_000,
            record: (&trade(7, 990, false, 0.5)).into(),
        };
        assert_eq!(
            serde_json::to_string(&line).unwrap(),
            r#"{"t":1000,"k":"trade","id":7,"ts":990,"price":"99","size":0.5,"buy":false}"#
        );
        let tick = Line {
            t: 1_100,
            record: Record::Tick,
        };
        assert_eq!(
            serde_json::to_string(&tick).unwrap(),
            r#"{"t":1100,"k":"tick"}"#
        );
        let d = Line {
            t: 1_200,
            record: (&depth(3, 1_150, &[("98.5", 0.0)], &[("100.25", 1.5)])).into(),
        };
        assert_eq!(
            serde_json::to_string(&d).unwrap(),
            r#"{"t":1200,"k":"depth","first":3,"last":3,"ts":1150,"bids":[["98.5",0.0]],"asks":[["100.25",1.5]]}"#
        );
    }

    #[test]
    fn every_record_kind_round_trips() {
        let lines = [
            Record::Header(Box::new(Header {
                format: FORMAT.into(),
                version: VERSION,
                venue: "binance".into(),
                product: "spot".into(),
                info: info(),
                session: 5,
                app_version: "0.1.0".into(),
            })),
            Record::Status {
                state: Status::Error,
                attempt: 2,
                message: Some("Upstream closed".into()),
            },
            Record::Status {
                state: Status::Connecting,
                attempt: 1,
                message: None,
            },
            Record::Gap {
                lost: 3,
                reason: GapReason::Backpressure,
            },
            (&BookSnapshot {
                last: 1,
                bids: vec![(price("0.00000001").unwrap(), 0.1 + 0.2)],
                asks: vec![(price("12345678.12345678").unwrap(), 1e-8)],
                limit: 5000,
            })
                .into(),
            (&depth(2, 3, &[("99", 0.0)], &[])).into(),
            (&trade(9, 4, true, 0.123456789)).into(),
            Record::Ticker {
                last: 1.5,
                change_pct: -2.25,
                high: 2.0,
                low: 1.0,
                quote_volume: 1e9,
            },
            Record::Tick,
        ];
        for (t, record) in lines.into_iter().enumerate() {
            let line = Line {
                t: t as u64,
                record,
            };
            let text = serde_json::to_string(&line).unwrap();
            assert_eq!(serde_json::from_str::<Line>(&text).unwrap(), line, "{text}");
        }
    }

    /// Replays recorded lines into a fresh engine, returning the frame emitted at every tick.
    fn replay(lines: &[String]) -> Vec<serde_json::Value> {
        let mut engine = None;
        let mut frames = Vec::new();
        for text in lines {
            let Line { t, record } = serde_json::from_str(text).unwrap();
            let event = match record {
                Record::Snapshot {
                    last,
                    limit,
                    bids,
                    asks,
                } => {
                    let s = BookSnapshot {
                        last,
                        bids,
                        asks,
                        limit,
                    };
                    engine = Some(Engine::new(s, t).unwrap());
                    continue;
                }
                Record::Tick => {
                    frames.push(engine.as_mut().unwrap().snapshot(&info(), "test", t));
                    continue;
                }
                Record::Depth {
                    first,
                    last,
                    ts,
                    bids,
                    asks,
                } => MarketEvent::Depth(Depth {
                    first,
                    last,
                    ts,
                    bids,
                    asks,
                }),
                Record::Trade {
                    id,
                    ts,
                    price,
                    size,
                    buy,
                } => MarketEvent::Trade(Trade {
                    id,
                    ts,
                    price: as_price(price),
                    size,
                    buy,
                    key: price,
                }),
                other => panic!("unexpected {other:?}"),
            };
            engine.as_mut().unwrap().on_event(event, t).unwrap();
        }
        frames
    }

    #[test]
    fn replaying_a_recording_reproduces_live_frames() {
        let snapshot = BookSnapshot {
            last: 1,
            bids: vec![(price("99").unwrap(), 30.0), (price("98").unwrap(), 3.0)],
            asks: vec![(price("101").unwrap(), 10.0), (price("102").unwrap(), 1.0)],
            limit: 5000,
        };
        let inputs = [
            (1_150, Some(depth(2, 1_140, &[("99", 32.0)], &[]))),
            (1_200, None),
            (1_210, Some(trade(1, 1_205, false, 25.0))),
            (
                1_250,
                Some(depth(3, 1_245, &[("99", 9.0)], &[("101.5", 4.0)])),
            ),
            (1_300, None),
            (1_330, Some(trade(2, 1_325, true, 3.0))),
            (
                1_400,
                Some(depth(4, 1_395, &[("99", 20.0)], &[("101", 7.0)])),
            ),
            (1_500, None),
            (2_400, None),
            (2_500, None),
        ];

        let mut recorded = vec![
            serde_json::to_string(&Line {
                t: 1_000,
                record: (&snapshot).into(),
            })
            .unwrap(),
        ];
        let mut live = Engine::new(snapshot, 1_000).unwrap();
        let mut frames = Vec::new();
        for (t, input) in inputs {
            let record = input.as_ref().map_or(Record::Tick, Record::from);
            recorded.push(serde_json::to_string(&Line { t, record }).unwrap());
            match input {
                Some(e) => live.on_event(e, t).unwrap(),
                None => frames.push(live.snapshot(&info(), "test", t)),
            }
        }

        assert!(frames.iter().any(|f| f["valid"] == true));
        assert!(
            frames
                .iter()
                .any(|f| !f["events"].as_array().unwrap().is_empty())
        );
        assert_eq!(replay(&recorded), frames);
    }
}
