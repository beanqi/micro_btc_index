// Public market data only. Start the application first: cargo run --release.
import assert from "node:assert/strict";
const origin = process.env.MONITOR_URL || "http://127.0.0.1:3000";
const get = async (path) => {
  const r = await fetch(origin + path);
  assert.equal(r.status, 200, path);
  return r.json();
};
const health = await get("/api/health");
assert.equal(health.publish_hz, 10);
const symbols = (await get("/api/symbols")).symbols;
assert(symbols.some((s) => s.symbol === "BTCUSDT"));
assert.equal((await fetch(origin + "/api/symbols?venue=unknown")).status, 400);
const sockets = [];
function observe(symbol, count = 25) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      origin.replace(/^http/, "ws") + "/ws?symbol=" + symbol,
    );
    sockets.push(socket);
    let first = 0,
      last = 0;
    const frames = [];
    const deadline = setTimeout(() => {
      socket.close();
      reject(new Error(symbol + " timeout"));
    }, 25000);
    socket.onmessage = (event) => {
      const d = JSON.parse(event.data);
      if (d.status === "blocked") {
        clearTimeout(deadline);
        reject(new Error(d.message));
        return;
      }
      if (!d.valid) return;
      assert.equal(d.symbol, symbol);
      assert.equal(d.product, "spot");
      assert(d.bids[0].price < d.asks[0].price);
      assert(Math.abs(d.pressure) <= 1);
      assert(Math.abs(d.rotation) <= 1);
      if (last) assert(BigInt(d.sequence) >= last);
      last = BigInt(d.sequence);
      if (!first) first = performance.now();
      frames.push({ ...d, bytes: event.data.length });
      if (frames.length >= count) {
        clearTimeout(deadline);
        socket.onmessage = null;
        resolve({
          symbol,
          frames,
          hz: ((count - 1) * 1000) / (performance.now() - first),
        });
      }
    };
    socket.onerror = () => {
      clearTimeout(deadline);
      reject(new Error(symbol + " socket error"));
    };
  });
}
try {
  const [btc, second, ethbtc] = await Promise.all([
    observe("BTCUSDT", 120),
    observe("BTCUSDT", 120),
    observe("ETHBTC", 120),
  ]);
  for (const result of [btc, ethbtc]) {
    const frame = result.frames.at(-1);
    assert(frame.flow.every((f) => f.complete));
    assert.equal(frame.info.quote, result.symbol === "ETHBTC" ? "BTC" : "USDT");
    const costs = result.frames.map((f) => f.compute_us).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        symbol: result.symbol,
        frames: result.frames.length,
        publish_hz: +result.hz.toFixed(2),
        compute_p95_us: costs[Math.floor(costs.length * 0.95)],
        frame_bytes: Math.round(
          result.frames.reduce((s, f) => s + f.bytes, 0) / result.frames.length,
        ),
        coverage_complete: frame.coverage_complete,
        trade_gaps: frame.quality.trade_gaps,
        mid: frame.mid,
      }),
    );
  }
  const shared = btc.frames.some((a) =>
    second.frames.some(
      (b) => a.ts === b.ts && a.sequence === b.sequence && a.mid === b.mid,
    ),
  );
  assert(shared, "Same market subscribers must share snapshots");
  const status = await get("/api/health");
  assert(status.active_markets >= 2);
  console.log(
    JSON.stringify({
      shared_snapshots: true,
      active_markets: status.active_markets,
      clients: status.clients,
    }),
  );
} finally {
  for (const s of sockets) {
    s.onerror = () => {};
    s.close();
  }
}
