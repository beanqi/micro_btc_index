use crate::{book::Book, model::*};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Default)]
struct FlowBucket {
    ts: u64,
    buy: f64,
    sell: f64,
    count: u64,
}
#[derive(Serialize)]
pub struct Flow {
    window_s: u64,
    complete: bool,
    buy_notional: f64,
    sell_notional: f64,
    delta_notional: Option<f64>,
    buy_share: Option<f64>,
    tfi: Option<f64>,
    trades: u64,
}
#[derive(Serialize, Clone)]
pub struct Point {
    ts: u64,
    mid: f64,
    pressure: f64,
    rotation: f64,
    volatility: f64,
    expansion: f64,
}
struct Phase {
    prev: Option<Point>,
    eu: f64,
    ev: f64,
    mids: VecDeque<f64>,
    history: VecDeque<Point>,
}
impl Default for Phase {
    fn default() -> Self {
        Self {
            prev: None,
            eu: 1e-6,
            ev: 1e-10,
            mids: VecDeque::new(),
            history: VecDeque::new(),
        }
    }
}
impl Phase {
    fn sample(&mut self, ts: u64, mid: f64, pressure: f64) {
        if self
            .prev
            .as_ref()
            .is_some_and(|p| ts.saturating_sub(p.ts) < 100)
        {
            return;
        }
        if self
            .prev
            .as_ref()
            .is_some_and(|p| ts.saturating_sub(p.ts) > 3000)
        {
            *self = Self::default();
        }
        let mut returns = Vec::with_capacity(20);
        let mut last = None;
        for m in self.mids.iter().copied().chain(std::iter::once(mid)) {
            if let Some(p) = last {
                returns.push(f64::ln(m / p));
            }
            last = Some(m);
        }
        let sigma = if returns.len() > 2 {
            let mean = returns.iter().sum::<f64>() / returns.len() as f64;
            (returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64).sqrt()
        } else {
            0.0
        };
        let (mut rotation, mut expansion) = (0.0, 0.0);
        if let Some(p) = &self.prev {
            let dt = (ts.saturating_sub(p.ts) as f64 / 1000.0).clamp(0.05, 2.0);
            let u = (pressure - p.pressure) / dt;
            let v = (sigma - p.volatility) / dt;
            self.eu = 0.97 * self.eu + 0.03 * u * u;
            self.ev = 0.97 * self.ev + 0.03 * v * v;
            let alpha = 1.0 - (-dt / 0.8).exp();
            rotation =
                p.rotation + alpha * ((u / (2.0 * self.eu.sqrt().max(1e-6))).tanh() - p.rotation);
            expansion = p.expansion
                + alpha * ((v / (2.0 * self.ev.sqrt().max(1e-10))).tanh() - p.expansion);
        }
        let p = Point {
            ts,
            mid,
            pressure,
            rotation,
            volatility: sigma,
            expansion,
        };
        self.prev = Some(p.clone());
        self.history.push_back(p);
        self.mids.push_back(mid);
        if self.mids.len() > 20 {
            self.mids.pop_front();
        }
        if self.history.len() > 1800 {
            self.history.pop_front();
        }
    }
}
#[derive(Serialize)]
pub struct DepthBand {
    bps: f64,
    bid_size: f64,
    ask_size: f64,
    bid_notional: f64,
    ask_notional: f64,
    complete: bool,
}
#[derive(Serialize)]
pub struct LevelView {
    side: &'static str,
    price: f64,
    size: f64,
    notional: f64,
    age_s: f64,
    refresh_count: u32,
    retention: f64,
    defense_heat: f64,
    absorption: Option<f64>,
    reload_count: u32,
    replenish_ratio: Option<f64>,
    attack_size: f64,
}
#[derive(Serialize, Clone)]
pub struct LiquidityEvent {
    id: u64,
    side: &'static str,
    price: f64,
    start_ts: u64,
    confirm_ts: u64,
    start_size: f64,
    attack_volume: f64,
    remaining_size: f64,
    absorption_score: f64,
    reload_count: u32,
    reload_size: f64,
    replenish_ratio: f64,
    repeated_reload: bool,
    mid_at_confirm: f64,
    return_1s_bps: Option<f64>,
    return_5s_bps: Option<f64>,
    return_15s_bps: Option<f64>,
    max_adverse_move_bps: f64,
}
pub struct Engine {
    pub book: Book,
    pub ticker: Option<Ticker>,
    pub started: u64,
    phase: Phase,
    flows: VecDeque<FlowBucket>,
    tape: VecDeque<Trade>,
    events: VecDeque<LiquidityEvent>,
    last_trade: Option<(u64, u64)>,
    pub trade_gaps: u64,
    pub unmatched_trades: u64,
    pub messages: u64,
    flow_start: u64,
    event_seq: u64,
}
impl Engine {
    pub fn new(s: BookSnapshot, now: u64) -> Result<Self> {
        Ok(Self {
            book: Book::from_snapshot(s, now)?,
            ticker: None,
            started: now,
            phase: Phase::default(),
            flows: VecDeque::new(),
            tape: VecDeque::new(),
            events: VecDeque::new(),
            last_trade: None,
            trade_gaps: 0,
            unmatched_trades: 0,
            messages: 0,
            flow_start: now,
            event_seq: 0,
        })
    }
    pub fn on_event(&mut self, e: MarketEvent, now: u64) -> Result<()> {
        self.messages += 1;
        match e {
            MarketEvent::Depth(d) => {
                let gap =
                    self.book.source_ts > 0 && d.ts.saturating_sub(self.book.source_ts) > 3000;
                if self.book.apply(d, now)? {
                    if gap {
                        self.book.reset_attacks();
                        self.events.clear();
                    }
                    if let (Some(m), Some(p)) = (self.book.mid(), self.book.pressure()) {
                        self.phase.sample(self.book.source_ts, m, p);
                    }
                }
            }
            MarketEvent::Ticker(t) => self.ticker = Some(t),
            MarketEvent::Trade(t) => {
                if let Some((id, ts)) = self.last_trade {
                    if t.id <= id {
                        return Ok(());
                    }
                    ensure!(t.ts >= ts, "Trade timestamp moved backwards");
                    if t.id != id + 1 {
                        self.trade_gaps += 1;
                        self.flows.clear();
                        self.flow_start = t.ts;
                        self.book.reset_attacks();
                    }
                }
                self.last_trade = Some((t.id, t.ts));
                if self.book.synced && !self.book.attack(&t) {
                    self.unmatched_trades += 1;
                }
                let n = t.price * t.size;
                if self.flows.back().is_none_or(|b| b.ts != t.ts) {
                    self.flows.push_back(FlowBucket {
                        ts: t.ts,
                        ..Default::default()
                    });
                }
                let bucket = self.flows.back_mut().unwrap();
                if t.buy {
                    bucket.buy += n;
                } else {
                    bucket.sell += n;
                }
                bucket.count += 1;
                self.prune_flows(now);
                ensure!(
                    self.flows.len() <= 20_000,
                    "Trade clock or buffer capacity invalid"
                );
                self.tape.push_front(t);
                if self.tape.len() > 60 {
                    self.tape.pop_back();
                }
            }
        }
        Ok(())
    }
    fn prune_flows(&mut self, now: u64) {
        while self
            .flows
            .front()
            .is_some_and(|b| b.ts <= now.saturating_sub(10_000))
        {
            self.flows.pop_front();
        }
    }
    fn flow(&self, now: u64, seconds: u64) -> Flow {
        let (mut buy, mut sell, mut trades) = (0.0, 0.0, 0);
        for b in self
            .flows
            .iter()
            .rev()
            .take_while(|b| b.ts > now.saturating_sub(seconds * 1000))
        {
            if b.ts <= now {
                buy += b.buy;
                sell += b.sell;
                trades += b.count;
            }
        }
        let total = buy + sell;
        let complete = now.saturating_sub(self.flow_start) >= seconds * 1000;
        Flow {
            window_s: seconds,
            complete,
            buy_notional: buy,
            sell_notional: sell,
            delta_notional: (complete && total > 0.0).then_some(buy - sell),
            buy_share: (complete && total > 0.0).then_some(buy / total),
            tfi: (complete && total > 0.0).then_some((buy - sell) / total),
            trades,
        }
    }
    fn level_view(&self, bid: bool, p: Price, l: &crate::book::Level, now: u64) -> LevelView {
        let a = l
            .attack
            .as_ref()
            .filter(|a| now.saturating_sub(a.start) <= 3000);
        LevelView {
            side: if bid { "bid" } else { "ask" },
            price: as_price(p),
            size: l.size,
            notional: as_price(p) * l.size,
            age_s: now.saturating_sub(l.first) as f64 / 1000.0,
            refresh_count: l.refreshes,
            retention: (l.size / l.peak).clamp(0.0, 1.0),
            defense_heat: l.heat(now, self.book.meaningful),
            absorption: a.map(|a| a.volume / a.initial),
            reload_count: a.map_or(0, |a| a.reloads),
            replenish_ratio: a.map(|a| a.replenished / a.initial),
            attack_size: a.map_or(0.0, |a| a.volume),
        }
    }
    fn depth(&self, bps: f64, mid: f64) -> DepthBand {
        let low = mid * (1.0 - bps / 10000.0);
        let high = mid * (1.0 + bps / 10000.0);
        let b: f64 = self
            .book
            .bids
            .iter()
            .rev()
            .take_while(|(p, _)| as_price(**p) >= low)
            .map(|(_, l)| l.size)
            .sum();
        let a: f64 = self
            .book
            .asks
            .iter()
            .take_while(|(p, _)| as_price(**p) <= high)
            .map(|(_, l)| l.size)
            .sum();
        DepthBand {
            bps,
            bid_size: b,
            ask_size: a,
            bid_notional: b * mid,
            ask_notional: a * mid,
            complete: as_price(self.book.bid_boundary) <= low
                && as_price(self.book.ask_boundary) >= high,
        }
    }
    fn collect_events(&mut self, now: u64, mid: f64) {
        for (bid, levels) in [(true, &mut self.book.bids), (false, &mut self.book.asks)] {
            for (p, l) in levels.iter_mut() {
                let Some(a) = l.attack.as_mut() else {
                    continue;
                };
                if now.saturating_sub(a.start) > 3000
                    || self.book.source_ts < a.last_trade
                    || a.initial < self.book.meaningful
                    || a.volume / a.initial < 0.7
                {
                    continue;
                }
                let event = LiquidityEvent {
                    id: a.event_id.unwrap_or(self.event_seq + 1),
                    side: if bid { "bid" } else { "ask" },
                    price: as_price(*p),
                    start_ts: a.start,
                    confirm_ts: now,
                    start_size: a.initial,
                    attack_volume: a.volume,
                    remaining_size: l.size,
                    absorption_score: a.volume / a.initial,
                    reload_count: a.reloads,
                    reload_size: a.replenished,
                    replenish_ratio: a.replenished / a.initial,
                    repeated_reload: a.reloads >= 2 && a.replenished / a.initial >= 0.5,
                    mid_at_confirm: mid,
                    return_1s_bps: None,
                    return_5s_bps: None,
                    return_15s_bps: None,
                    max_adverse_move_bps: 0.0,
                };
                if let Some(id) = a.event_id {
                    if let Some(old) = self.events.iter_mut().find(|e| e.id == id) {
                        old.attack_volume = event.attack_volume;
                        old.remaining_size = event.remaining_size;
                        old.absorption_score = event.absorption_score;
                        old.reload_count = event.reload_count;
                        old.reload_size = event.reload_size;
                        old.replenish_ratio = event.replenish_ratio;
                        old.repeated_reload = event.repeated_reload;
                    }
                } else {
                    self.event_seq += 1;
                    a.event_id = Some(self.event_seq);
                    self.events.push_front(event);
                    if self.events.len() > 80 {
                        self.events.pop_back();
                    }
                }
            }
        }
        for e in &mut self.events {
            let dt = now.saturating_sub(e.confirm_ts);
            // Raw midpoint returns; adverse means price moved against the defending side.
            let r = 10000.0 * (mid / e.mid_at_confirm).ln();
            if dt <= 15_200 {
                e.max_adverse_move_bps =
                    e.max_adverse_move_bps
                        .max(if e.side == "bid" { -r } else { r });
            }
            for (h, value) in [
                (1000, &mut e.return_1s_bps),
                (5000, &mut e.return_5s_bps),
                (15000, &mut e.return_15s_bps),
            ] {
                if (h..=h + 500).contains(&dt) && value.is_none() {
                    *value = Some(r);
                }
            }
        }
    }
    pub fn snapshot(&mut self, info: &SymbolInfo, venue: &str, now: u64) -> serde_json::Value {
        self.prune_flows(now);
        self.book.update_meaningful();
        let source_age = now as i128 - self.book.source_ts as i128;
        let age = now.saturating_sub(self.book.received);
        let reason = if !self.book.synced {
            Some("正在衔接 REST 快照与增量深度")
        } else if age > 3000 {
            Some("深度超过 3 秒未更新")
        } else if source_age > 5000 {
            Some("源数据延迟超过 5 秒")
        } else if source_age < -2000 {
            Some("本机与交易所时钟偏差过大")
        } else {
            None
        };
        let valid = reason.is_none();
        if !valid {
            return serde_json::json!({"type":"snapshot","venue":venue,"product":"spot","symbol":info.symbol,"info":info,"ts":now,"valid":false,"status":"syncing","invalid_reason":reason,"feed_age_ms":age,"source_age_ms":source_age,"sequence":self.book.last.to_string(),"history":[],"events":[]});
        }
        let mid = self.book.mid().unwrap();
        let (bid, ask) = self.book.best().unwrap();
        self.collect_events(now, mid);
        let bids: Vec<_> = self
            .book
            .bids
            .iter()
            .rev()
            .take(20)
            .map(|(p, l)| self.level_view(true, *p, l, now))
            .collect();
        let asks: Vec<_> = self
            .book
            .asks
            .iter()
            .take(20)
            .map(|(p, l)| self.level_view(false, *p, l, now))
            .collect();
        let mut defense: Vec<_> = self
            .book
            .bids
            .iter()
            .rev()
            .take(120)
            .map(|(p, l)| self.level_view(true, *p, l, now))
            .chain(
                self.book
                    .asks
                    .iter()
                    .take(120)
                    .map(|(p, l)| self.level_view(false, *p, l, now)),
            )
            .filter(|l| l.size >= self.book.meaningful)
            .collect();
        defense.sort_by(|a, b| b.defense_heat.total_cmp(&a.defense_heat));
        defense.truncate(12);
        let bands = [self.depth(1.0, mid), self.depth(5.0, mid)];
        let curve: Vec<_> = (0..=40).map(|i| self.depth(i as f64 * 0.5, mid)).collect();
        let phase = self.phase.prev.as_ref();
        let flows: Vec<_> = [1, 5, 10].iter().map(|s| self.flow(now, *s)).collect();
        serde_json::json!({"type":"snapshot","venue":venue,"product":"spot","symbol":info.symbol,"info":info,"ts":now,"valid":true,"status":"live","invalid_reason":null,
            "feed_age_ms":age,"source_age_ms":source_age,"source_ts":self.book.source_ts,"sequence":self.book.last.to_string(),"session_started":self.started,
            "mid":mid,"spread":as_price(ask-bid),"spread_bps":10000.0*as_price(ask-bid)/mid,"pressure":self.book.pressure(),
            "rotation":phase.map(|p|p.rotation),"short_volatility":phase.map(|p|p.volatility),"volatility_expansion":phase.map(|p|p.expansion),"phase_samples":self.phase.mids.len(),
            "depth":bands,"coverage_complete":bands.iter().all(|b|b.complete),"curve":curve,"flow":flows,"ticker":self.ticker,
            "bids":bids,"asks":asks,"defense":defense,"trades":self.tape,"events":self.events,
            "history":self.phase.history.iter().rev().take(2).cloned().collect::<Vec<_>>(),
            "quality":{"book_levels":self.book.bids.len()+self.book.asks.len(),"messages":self.messages,"trade_gaps":self.trade_gaps,"unmatched_trades":self.unmatched_trades,"meaningful_size":self.book.meaningful,"snapshot_limit":5000}
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> Engine {
        Engine::new(
            BookSnapshot {
                last: 1,
                bids: vec![(price("99").unwrap(), 30.0), (price("98").unwrap(), 3.0)],
                asks: vec![(price("101").unwrap(), 10.0), (price("102").unwrap(), 1.0)],
                limit: 5000,
            },
            1000,
        )
        .unwrap()
    }
    fn trade(id: u64, ts: u64, buy: bool, size: f64) -> MarketEvent {
        let p = if buy { "101" } else { "99" };
        let key = price(p).unwrap();
        MarketEvent::Trade(Trade {
            id,
            ts,
            buy,
            size,
            price: as_price(key),
            key,
        })
    }
    #[test]
    fn pressure_matches_document_example() {
        assert!((engine().book.pressure().unwrap() - 0.5).abs() < 1e-12);
    }
    #[test]
    fn depth_uses_midpoint_not_individual_level_prices() {
        let e = engine();
        let band = e.depth(100.0, 100.0);
        assert!(band.complete);
        assert_eq!(band.bid_notional, 3000.0);
        assert_eq!(band.ask_notional, 1000.0);
        let narrow = e.depth(1.0, 100.0);
        assert!(narrow.complete);
        assert_eq!(narrow.bid_size, 0.0);
        assert_eq!(narrow.ask_size, 0.0);
    }
    #[test]
    fn volatility_is_population_std_of_log_returns() {
        let mut p = Phase::default();
        for (i, mid) in [100.0, 102.0, 101.0, 104.0].into_iter().enumerate() {
            p.sample(1000 + i as u64 * 100, mid, 0.0);
        }
        let r = [
            (102.0_f64 / 100.0).ln(),
            (101.0_f64 / 102.0).ln(),
            (104.0_f64 / 101.0).ln(),
        ];
        let mean = r.iter().sum::<f64>() / 3.0;
        let expected = (r.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / 3.0).sqrt();
        assert!((p.prev.unwrap().volatility - expected).abs() < 1e-12);
    }
    #[test]
    fn removed_queue_does_not_confirm_absorption() {
        let mut e = engine();
        e.book.synced = true;
        e.on_event(trade(1, 1200, false, 40.0), 1200).unwrap();
        e.on_event(
            MarketEvent::Depth(Depth {
                first: 2,
                last: 2,
                ts: 1300,
                bids: vec![(price("99").unwrap(), 0.0)],
                asks: vec![],
            }),
            1300,
        )
        .unwrap();
        e.collect_events(1300, 100.0);
        assert!(e.events.is_empty());
    }
    #[test]
    fn flow_deduplicates_and_uses_open_left_time_window() {
        let mut e = engine();
        e.flow_start = 0;
        e.on_event(trade(1, 5000, true, 2.0), 5000).unwrap();
        e.on_event(trade(1, 5000, true, 2.0), 5000).unwrap();
        e.on_event(trade(2, 6000, false, 1.0), 6000).unwrap();
        let f = e.flow(6000, 5);
        assert_eq!(f.trades, 2);
        assert_eq!(f.delta_notional, Some(103.0));
        let f = e.flow(6000, 1);
        assert_eq!(f.trades, 1);
        assert_eq!(f.delta_notional, Some(-99.0));
        assert!(e.flow(20000, 5).buy_share.is_none());
    }
    #[test]
    fn missing_trade_rewarms_all_windows() {
        let mut e = engine();
        e.on_event(trade(1, 2000, true, 2.0), 2000).unwrap();
        e.on_event(trade(3, 2100, false, 1.0), 2100).unwrap();
        assert_eq!(e.trade_gaps, 1);
        assert!(!e.flow(2500, 1).complete);
        assert_eq!(e.flow(3200, 1).delta_notional, None);
    }
    #[test]
    fn no_future_queue_and_no_future_returns() {
        let mut e = engine();
        let info = SymbolInfo {
            symbol: "TEST".into(),
            base: "A".into(),
            quote: "B".into(),
            tick_size: "1".into(),
            price_decimals: 0,
            size_decimals: 2,
        };
        e.on_event(
            MarketEvent::Depth(Depth {
                first: 2,
                last: 2,
                ts: 1100,
                bids: vec![],
                asks: vec![],
            }),
            1100,
        )
        .unwrap();
        e.on_event(trade(1, 1200, false, 25.0), 1200).unwrap();
        let s = e.snapshot(&info, "test", 1200);
        assert!(s["events"].as_array().unwrap().is_empty());
        e.on_event(
            MarketEvent::Depth(Depth {
                first: 3,
                last: 3,
                ts: 1250,
                bids: vec![],
                asks: vec![],
            }),
            1250,
        )
        .unwrap();
        let s = e.snapshot(&info, "test", 1250);
        assert_eq!(s["events"].as_array().unwrap().len(), 1);
        assert!(s["events"][0]["return_1s_bps"].is_null());
        let s = e.snapshot(&info, "test", 2250);
        assert_eq!(s["events"][0]["return_1s_bps"], 0.0);
        let s = e.snapshot(&info, "test", 6000);
        assert_eq!(s["valid"], false);
        assert!(s.get("pressure").is_none());
    }
    #[test]
    fn rotation_bounded_and_gap_resets_history() {
        let mut p = Phase::default();
        for i in 0..100 {
            p.sample(
                1000 + i * 100,
                100.0 + i as f64 * 0.01,
                if i % 2 == 0 { 0.8 } else { -0.8 },
            );
        }
        assert!(p.prev.as_ref().unwrap().rotation.abs() <= 1.0);
        p.sample(30000, 101.0, 0.3);
        assert_eq!(p.prev.as_ref().unwrap().rotation, 0.0);
        assert_eq!(p.history.len(), 1);
    }
}
