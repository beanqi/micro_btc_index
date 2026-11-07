// Deterministic integration fixture: snapshot buffering, gaps, retry bounds, reset, idle cleanup.
// This script starts an isolated local monitor and a local HTTP/WS fixture; it never calls Binance.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
let upstreamConnections = 0,
  fixtureMode = "gap",
  serverLog = "";
const connections = new Set();
const fixture = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/api/v3/exchangeInfo"))
    res.end(
      JSON.stringify({
        symbols: [
          {
            symbol: "TESTUSDT",
            status: "TRADING",
            isSpotTradingAllowed: true,
            baseAsset: "TEST",
            quoteAsset: "USDT",
            baseAssetPrecision: 8,
            filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }],
          },
        ],
      }),
    );
  else if (req.url.startsWith("/api/v3/depth"))
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            lastUpdateId: 10,
            bids: [
              ["99", "10"],
              ["98", "2"],
            ],
            asks: [
              ["101", "20"],
              ["102", "3"],
            ],
          }),
        ),
      180,
    );
  else {
    res.statusCode = 404;
    res.end("{}");
  }
});
function send(socket, value) {
  const data = Buffer.from(JSON.stringify({ data: value }));
  const header =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([header, data]));
}
fixture.on("upgrade", (req, socket) => {
  upstreamConnections++;
  connections.add(socket);
  socket.on("error", () => {});
  const accept = createHash("sha1")
    .update(
      req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
    )
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );
  let seq = 10,
    ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    if (fixtureMode === "gap" && ticks === 9) seq += 5;
    send(socket, {
      e: "depthUpdate",
      s: "TESTUSDT",
      E: Date.now(),
      U: seq,
      u: seq,
      b: [["99", "10"]],
      a: [["101", "20"]],
    });
    seq++;
  }, 70);
  socket.on("close", () => {
    clearInterval(interval);
    connections.delete(socket);
  });
  socket.on("end", () => socket.destroy());
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fixturePort = fixture.address().port;
const reserved = http.createServer();
await new Promise((r) => reserved.listen(0, "127.0.0.1", r));
const port = reserved.address().port;
await new Promise((r) => reserved.close(r));
const child = spawn("./target/release/micro_btc_index", [], {
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${port}`,
    BINANCE_REST_URL: `http://127.0.0.1:${fixturePort}`,
    BINANCE_WS_URL: `ws://127.0.0.1:${fixturePort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));
let ws;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture monitor did not start: " + serverLog)),
      6000,
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          "Fixture monitor exited: " + code + " " + signal + " " + serverLog,
        ),
      );
    });
    child.stdout.on("data", (d) => {
      if (String(d).includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/health`)).status,
    200,
  );
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?symbol=TESTUSDT`);
  const statuses = [],
    frames = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Retry test timeout")),
      12000,
    );
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Client WS failure"));
    };
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.valid) frames.push(d);
      else if (d.type === "status") statuses.push(d);
      if (d.status === "blocked") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  assert.equal(upstreamConnections, 3);
  assert(frames.length > 0, "Buffered snapshot must bridge to live frames");
  assert(statuses.some((s) => s.status === "reconnecting"));
  assert.equal(statuses.at(-1).attempt, 3);
  assert.equal(
    new Set(frames.map((f) => f.session_started)).size,
    3,
    "Each reconnect resets state",
  );
  const attempts = upstreamConnections;
  await sleep(500);
  assert.equal(
    upstreamConnections,
    attempts,
    "Blocked stream must not retry again",
  );
  ws.onerror = () => {};
  ws.close();
  fixtureMode = "healthy";
  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?symbol=TESTUSDT`);
    const timer = setTimeout(
      () => reject(new Error("Manual recovery timeout")),
      3000,
    );
    ws.onmessage = (e) => {
      if (JSON.parse(e.data).valid) {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.onerror = reject;
  });
  assert.equal(
    upstreamConnections,
    4,
    "New subscription can explicitly recover",
  );
  ws.onerror = () => {};
  ws.close();
  await sleep(16000);
  const health = await (
    await fetch(`http://127.0.0.1:${port}/api/health`)
  ).json();
  assert.equal(health.active_markets, 0);
  assert.equal(connections.size, 0);
  console.log(
    JSON.stringify({
      buffered_snapshot: true,
      sequence_gap_detected: true,
      retry_attempts: 3,
      reconnect_reset: true,
      manual_recovery: true,
      idle_cleanup: true,
    }),
  );
} catch (e) {
  console.error(serverLog);
  throw e;
} finally {
  ws?.close();
  child.kill("SIGTERM");
  for (const s of connections) s.destroy();
  fixture.close();
}
