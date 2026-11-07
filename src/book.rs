use crate::model::*;
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug)]
pub struct Attack {
    pub start: u64,
    pub last_trade: u64,
    pub initial: f64,
    pub volume: f64,
    pub reloads: u32,
    pub replenished: f64,
    pub event_id: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Level {
    pub size: f64,
    pub peak: f64,
    pub first: u64,
    pub updated: u64,
    pub refreshes: u32,
    pub attack: Option<Attack>,
}
impl Level {
    fn new(size: f64, ts: u64) -> Self {
        Self {
            size,
            peak: size,
            first: ts,
            updated: ts,
            refreshes: 0,
            attack: None,
        }
    }
    pub fn heat(&self, ts: u64, meaningful: f64) -> f64 {
        if self.size < meaningful || self.peak <= 0.0 {
            return 0.0;
        }
        0.4 * (ts.saturating_sub(self.first) as f64 / 60_000.0).min(1.0)
            + 0.4 * (self.refreshes as f64 / 6.0).min(1.0)
            + 0.2 * (self.size / self.peak).clamp(0.0, 1.0)
    }
}
#[derive(Default)]
pub struct Book {
    pub bids: BTreeMap<Price, Level>,
    pub asks: BTreeMap<Price, Level>,
    retired: HashMap<(bool, Price), (Level, u64)>,
    pub last: u64,
    pub source_ts: u64,
    pub received: u64,
    pub synced: bool,
    pub bid_boundary: Price,
    pub ask_boundary: Price,
    pub meaningful: f64,
}
impl Book {
    pub fn from_snapshot(s: BookSnapshot, now: u64) -> Result<Self> {
        ensure!(!s.bids.is_empty() && !s.asks.is_empty(), "Empty snapshot");
        let bid_boundary = if s.bids.len() < s.limit {
            0
        } else {
            s.bids.iter().map(|(p, _)| *p).min().unwrap()
        };
        let ask_boundary = if s.asks.len() < s.limit {
            i64::MAX
        } else {
            s.asks.iter().map(|(p, _)| *p).max().unwrap()
        };
        let mut b = Self {
            last: s.last,
            bid_boundary,
            ask_boundary,
            ..Self::default()
        };
        for (p, q) in s.bids {
            if q > 0.0 {
                b.bids.insert(p, Level::new(q, now));
            }
        }
        for (p, q) in s.asks {
            if q > 0.0 {
                b.asks.insert(p, Level::new(q, now));
            }
        }
        b.update_meaningful();
        Ok(b)
    }
    pub fn update_meaningful(&mut self) {
        let mut sizes: Vec<f64> = self
            .bids
            .values()
            .chain(self.asks.values())
            .map(|l| l.size)
            .collect();
        self.meaningful = if sizes.is_empty() {
            f64::EPSILON
        } else {
            let n = sizes.len() / 2;
            let (_, m, _) = sizes.select_nth_unstable_by(n, f64::total_cmp);
            (*m * 0.5).max(f64::EPSILON)
        };
    }
    pub fn apply(&mut self, d: Depth, received: u64) -> Result<bool> {
        if d.last <= self.last {
            return Ok(false);
        }
        ensure!(
            d.first <= self.last + 1 && d.first <= d.last,
            "Depth sequence gap: expected {}, got {}..{}",
            self.last + 1,
            d.first,
            d.last
        );
        ensure!(d.ts >= self.source_ts, "Depth timestamp moved backwards");
        self.update_side(true, d.bids, d.ts);
        self.update_side(false, d.asks, d.ts);
        self.last = d.last;
        self.source_ts = d.ts;
        self.received = received;
        ensure!(
            self.bids.len() + self.asks.len() < 30_000,
            "Book capacity exceeded; resnapshot required"
        );
        ensure!(
            matches!(self.best(), Some((b,a)) if b<a),
            "Missing or crossed book"
        );
        self.synced = true;
        self.retired
            .retain(|_, (_, ts)| d.ts.saturating_sub(*ts) <= 15_000);
        Ok(true)
    }
    fn update_side(&mut self, bid: bool, changes: Levels, ts: u64) {
        let side = if bid { &mut self.bids } else { &mut self.asks };
        for (p, q) in changes {
            // The snapshot boundary is fixed. Farther updates cannot make unknown levels complete.
            if (bid && p < self.bid_boundary) || (!bid && p > self.ask_boundary) {
                continue;
            }
            if q == 0.0 {
                if let Some(mut old) = side.remove(&p) {
                    old.attack = None;
                    self.retired.insert((bid, p), (old, ts));
                }
                continue;
            }
            if let Some(l) = side.get_mut(&p) {
                if l.attack
                    .as_ref()
                    .is_some_and(|a| ts.saturating_sub(a.start) > 3000)
                {
                    l.attack = None;
                }
                let increase = q - l.size;
                let tolerance = (0.025 * l.peak)
                    .max(0.05 * self.meaningful)
                    .max(f64::EPSILON);
                if increase > tolerance {
                    l.refreshes = l.refreshes.saturating_add(1);
                    if let Some(a) = l.attack.as_mut() {
                        a.reloads += 1;
                        a.replenished += increase;
                    }
                }
                l.size = q;
                l.peak = l.peak.max(q);
                l.updated = ts;
            } else {
                let l = match self.retired.remove(&(bid, p)) {
                    Some((mut old, removed)) if ts.saturating_sub(removed) <= 2000 => {
                        old.size = q;
                        old.peak = old.peak.max(q);
                        old.updated = ts;
                        old.refreshes = old.refreshes.saturating_add(1);
                        old.attack = None;
                        old
                    }
                    _ => Level::new(q, ts),
                };
                side.insert(p, l);
            }
        }
    }
    pub fn best(&self) -> Option<(Price, Price)> {
        Some((
            *self.bids.last_key_value()?.0,
            *self.asks.first_key_value()?.0,
        ))
    }
    pub fn mid(&self) -> Option<f64> {
        self.best().map(|(b, a)| (as_price(b) + as_price(a)) / 2.0)
    }
    pub fn pressure(&self) -> Option<f64> {
        let b: f64 = self
            .bids
            .values()
            .rev()
            .take(12)
            .enumerate()
            .map(|(i, l)| l.size / ((i + 1) as f64).sqrt())
            .sum();
        let a: f64 = self
            .asks
            .values()
            .take(12)
            .enumerate()
            .map(|(i, l)| l.size / ((i + 1) as f64).sqrt())
            .sum();
        (a + b > 0.0).then_some((b - a) / (b + a))
    }
    pub fn attack(&mut self, t: &Trade) -> bool {
        let side = if t.buy {
            &mut self.asks
        } else {
            &mut self.bids
        };
        let Some(l) = side.get_mut(&t.key) else {
            return false;
        };
        // Never use an observation from the future as the attack's starting queue.
        if l.updated > t.ts {
            return false;
        }
        if l.attack
            .as_ref()
            .is_none_or(|a| t.ts.saturating_sub(a.start) > 3000)
        {
            l.attack = Some(Attack {
                start: t.ts,
                last_trade: t.ts,
                initial: l.size,
                volume: 0.0,
                reloads: 0,
                replenished: 0.0,
                event_id: None,
            });
        }
        let attack = l.attack.as_mut().unwrap();
        attack.volume += t.size;
        attack.last_trade = t.ts;
        true
    }
    pub fn reset_attacks(&mut self) {
        for l in self.bids.values_mut().chain(self.asks.values_mut()) {
            l.attack = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn book() -> Book {
        Book::from_snapshot(
            BookSnapshot {
                last: 10,
                bids: vec![(100, 10.0), (90, 4.0)],
                asks: vec![(110, 10.0), (120, 4.0)],
                limit: 2,
            },
            100,
        )
        .unwrap()
    }
    fn depth(first: u64, last: u64, ts: u64, bids: Levels) -> Depth {
        Depth {
            first,
            last,
            ts,
            bids,
            asks: vec![],
        }
    }
    #[test]
    fn overlap_duplicates_gap_and_zero_removal() {
        let mut b = book();
        assert!(!b.apply(depth(1, 10, 200, vec![]), 200).unwrap());
        assert!(b.apply(depth(9, 12, 200, vec![(100, 0.0)]), 200).unwrap());
        assert_eq!(b.best(), Some((90, 110)));
        assert!(b.apply(depth(14, 15, 300, vec![]), 300).is_err());
    }
    #[test]
    fn coverage_does_not_expand_from_isolated_updates() {
        let mut b = book();
        b.apply(depth(11, 12, 200, vec![(80, 1000.0)]), 200)
            .unwrap();
        assert_eq!(b.bid_boundary, 90);
        assert!(!b.bids.contains_key(&80));
    }
    #[test]
    fn defense_matches_document_example() {
        let mut l = Level::new(10.0, 1000);
        l.size = 8.0;
        l.refreshes = 3;
        assert!((l.heat(31_000, 1.0) - 0.56).abs() < 1e-12);
        assert_eq!(l.heat(31_000, 9.0), 0.0);
    }
    #[test]
    fn future_queue_cannot_start_an_attack() {
        let mut b = book();
        b.apply(depth(11, 11, 300, vec![(100, 12.0)]), 300).unwrap();
        assert!(!b.attack(&Trade {
            id: 1,
            ts: 200,
            price: as_price(100),
            size: 10.0,
            buy: false,
            key: 100
        }));
        assert!(b.bids[&100].attack.is_none());
    }
    #[test]
    fn reload_and_reappearance_have_different_attack_semantics() {
        let mut b = book();
        b.meaningful = 1.0;
        let t = Trade {
            id: 1,
            ts: 150,
            price: 0.000001,
            size: 8.0,
            buy: false,
            key: 100,
        };
        assert!(b.attack(&t));
        b.apply(depth(11, 11, 200, vec![(100, 14.0)]), 200).unwrap();
        let a = b.bids[&100].attack.as_ref().unwrap();
        assert_eq!(a.reloads, 1);
        assert_eq!(a.replenished, 4.0);
        b.apply(depth(12, 12, 300, vec![(100, 0.0)]), 300).unwrap();
        b.apply(depth(13, 13, 400, vec![(100, 12.0)]), 400).unwrap();
        assert_eq!(b.bids[&100].first, 100);
        assert_eq!(b.bids[&100].refreshes, 2);
        assert!(b.bids[&100].attack.is_none());
    }
}
