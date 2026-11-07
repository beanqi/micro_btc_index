const $ = (id) => document.getElementById(id);
const C = {
  mint: "#79dfb8",
  coral: "#ec8891",
  lavender: "#a8a0ef",
  grid: "#22313a",
  muted: "#607e90",
  text: "#a8bdca",
};
const ui = {
  latest: null,
  shown: null,
  history: [],
  flowHistory: [],
  deltaHistory: [],
  symbols: [],
  ws: null,
  generation: 0,
  retries: 0,
  retryTimer: 0,
  window: 5,
  seconds: 60,
  filter: "all",
  paused: false,
  dirty: true,
  connected: false,
  lastReceive: 0,
  received: 0,
  bytes: 0,
  renders: [],
  frames: 0,
  selected: "BTCUSDT",
  venue: "binance",
  session: 0,
  mouse: null,
  benchmark: false,
};
const cache = new Map();
function text(id, value) {
  const el = $(id);
  const s = String(value);
  if (el && el.textContent !== s) el.textContent = s;
}
function html(id, value) {
  if (cache.get(id) !== value) {
    $(id).innerHTML = value;
    cache.set(id, value);
  }
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const numberFormats = new Map();
function numberFormat(min, max = min) {
  const key = min + ":" + max;
  if (!numberFormats.has(key))
    numberFormats.set(
      key,
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: min,
        maximumFractionDigits: max,
      }),
    );
  return numberFormats.get(key);
}
const fmt = (n, d = 2) => (finite(n) ? numberFormat(d).format(n) : "—");
function compact(n, d = 2) {
  if (!finite(n)) return "—";
  const a = Math.abs(n);
  for (const [limit, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ])
    if (a >= limit) return fmt(n / limit, d) + unit;
  return fmt(n, d);
}
const signed = (n, d = 2) => (finite(n) ? (n > 0 ? "+" : "") + fmt(n, d) : "—");
const signCompact = (n) => (finite(n) ? (n > 0 ? "+" : "") + compact(n) : "—");
const pct = (n) => (finite(n) ? fmt(n * 100, 1) + "%" : "—");
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});
const time = (t) => timeFormat.format(t);
const price = (n) => fmt(n, ui.shown?.info?.price_decimals ?? 2);
const size = (n) =>
  finite(n)
    ? numberFormat(0, Math.min(8, ui.shown?.info?.size_decimals ?? 6)).format(n)
    : "—";
const visibleHistory = () =>
  ui.paused && ui.frozen ? ui.frozen.history : ui.history;
function tone(id, n) {
  const el = $(id);
  el.classList.toggle("positive", finite(n) && n > 0);
  el.classList.toggle("negative", finite(n) && n < 0);
}
function toast(message) {
  text("toast", message);
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 3200);
}
function notice(message, error = false, retry = false) {
  $("notice").hidden = !message;
  $("notice").classList.toggle("error", error);
  text("notice-text", message);
  $("retry-button").hidden = !retry;
}
function connection(label, state = "") {
  text("connection-text", label);
  $("connection").className = "connection " + state;
}
function resetView() {
  ui.latest = null;
  ui.shown = null;
  ui.history = [];
  ui.flowHistory = [];
  ui.deltaHistory = [];
  ui.session = 0;
  ui.lastReceive = 0;
  ui.dirty = true;
  cache.clear();
  renderInvalid();
  drawAll();
}
async function loadSymbols() {
  const response = await fetch(
    "/api/symbols?venue=" + encodeURIComponent(ui.venue),
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法加载交易对");
  ui.symbols = data.symbols;
  updateSuggestions();
}
function updateSuggestions() {
  const q = $("symbol")
    .value.toUpperCase()
    .replace(/[/_\-\s]/g, "");
  const matches = ui.symbols.filter((s) => s.symbol.includes(q)).slice(0, 60);
  html(
    "symbol-list",
    matches
      .map(
        (s) =>
          `<option value="${esc(s.symbol)}">${esc(s.base)} / ${esc(s.quote)}</option>`,
      )
      .join(""),
  );
}
async function connect(symbol, manual = true) {
  const normalized = symbol
    .trim()
    .replace(/[/_\-\s]/g, "")
    .toUpperCase();
  if (!normalized) {
    toast("请输入 Binance 现货 Symbol，例如 ETHUSDT");
    return;
  }
  if (ui.symbols.length && !ui.symbols.some((s) => s.symbol === normalized)) {
    const message = `未找到可交易的现货 Symbol：${normalized}。请从候选项选择。`;
    $("symbol").setCustomValidity(message);
    $("symbol").setAttribute("aria-invalid", "true");
    $("symbol").reportValidity();
    toast(message);
    return;
  }
  $("symbol").setCustomValidity("");
  $("symbol").removeAttribute("aria-invalid");
  ui.generation++;
  const gen = ui.generation;
  clearTimeout(ui.retryTimer);
  if (ui.ws) {
    ui.ws.onclose = null;
    ui.ws.close();
  }
  ui.selected = normalized;
  ui.venue = $("venue").value;
  ui.connected = false;
  ui.paused = false;
  ui.frozen = null;
  if (manual) ui.retries = 0;
  $("symbol").value = normalized;
  $("pause-button").innerHTML = "<span>Ⅱ</span> 暂停观察";
  document.body.classList.remove("paused");
  resetView();
  connection("正在连接");
  notice("正在连接 " + normalized + "，并衔接深度快照…");
  const info = ui.symbols.find((s) => s.symbol === normalized);
  if (info) updateIdentity(info);
  document
    .querySelectorAll("[data-symbol]")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.symbol === normalized),
    );
  try {
    localStorage.setItem(
      "microscope.market",
      JSON.stringify({ symbol: normalized, venue: ui.venue }),
    );
  } catch {}
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?venue=${encodeURIComponent(ui.venue)}&symbol=${encodeURIComponent(normalized)}`,
  );
  ui.ws = ws;
  ws.onopen = () => {
    if (gen !== ui.generation) return;
    ui.connected = true;
    connection("同步订单簿");
  };
  ws.onmessage = (e) => {
    if (gen !== ui.generation) return;
    try {
      const d = JSON.parse(e.data);
      ui.lastReceive = performance.now();
      ui.received++;
      ui.bytes += e.data.length;
      if (d.symbol !== ui.selected) return;
      if (d.type === "status") {
        ui.latest = null;
        ui.dirty = true;
        if (d.status === "blocked") {
          ui.connected = false;
          connection("连接已停止", "error");
          notice(d.message, true, true);
        } else {
          connection(d.status === "reconnecting" ? "正在重连" : "同步订单簿");
          notice(
            d.message + (d.attempt > 1 ? `（第 ${d.attempt}/3 次）` : ""),
            d.status === "reconnecting",
          );
        }
        return;
      }
      if (d.type !== "snapshot") return;
      ui.latest = d;
      if (d.valid) {
        ui.retries = 0;
        if (ui.session !== d.session_started) {
          ui.history = [];
          ui.flowHistory = [];
          ui.deltaHistory = [];
          ui.session = d.session_started;
        }
        for (const p of [...d.history].reverse())
          if (!ui.history.length || p.ts > ui.history.at(-1).ts)
            ui.history.push(p);
        if (ui.history.length > 9000)
          ui.history.splice(0, ui.history.length - 9000);
        const second = Math.floor(d.ts / 1000),
          f = d.flow[0];
        if (ui.flowHistory.at(-1)?.second !== second)
          ui.flowHistory.push({
            second,
            buy: f.complete ? f.buy_notional : 0,
            sell: f.complete ? f.sell_notional : 0,
          });
        if (ui.flowHistory.length > 900)
          ui.flowHistory.splice(0, ui.flowHistory.length - 900);
        const flow = d.flow.find((f) => f.window_s === ui.window);
        ui.deltaHistory.push(flow?.delta_notional ?? null);
        if (ui.deltaHistory.length > 120) ui.deltaHistory.shift();
        if (!ui.paused) {
          connection("实时连接", "live");
          notice("");
        }
      } else if (!ui.paused) {
        connection("数据暂不可用");
        notice(d.invalid_reason || "正在同步行情");
      }
      ui.dirty = true;
    } catch (error) {
      console.error("Invalid monitor frame", error);
      connection("消息解析失败", "error");
      notice("收到无法解析的数据，请重新连接。", true, true);
    }
  };
  ws.onclose = () => {
    if (gen !== ui.generation) return;
    ui.connected = false;
    ui.latest = null;
    ui.dirty = true;
    if (ui.retries >= 3) {
      connection("连接已停止", "error");
      notice(
        "连续 3 次连接失败，请确认本地服务与 Binance 网络可用，然后重新连接。",
        true,
        true,
      );
      return;
    }
    ui.retries++;
    connection("正在重连");
    notice(
      `连接中断，${2 ** ui.retries} 秒后重新连接（${ui.retries}/3）…`,
      true,
      true,
    );
    ui.retryTimer = setTimeout(
      () => connect(ui.selected, false),
      2 ** ui.retries * 1000,
    );
  };
  ws.onerror = () => {};
}
function updateIdentity(info) {
  if (updateIdentity.symbol === info.symbol) return;
  updateIdentity.symbol = info.symbol;
  text("base-name", info.base);
  text("quote-name", " / " + info.quote);
  text(
    "coin-icon",
    info.base === "BTC"
      ? "₿"
      : info.base === "ETH"
        ? "Ξ"
        : info.base.slice(0, 2),
  );
  document.querySelectorAll(".quote-unit").forEach((e) => {
    e.textContent = info.quote;
  });
  document.querySelectorAll(".base-unit").forEach((e) => {
    e.textContent = info.base;
  });
  document.title = `${info.base}/${info.quote} · μScope`;
}
const bookRows = {};
for (const side of ["asks", "bids"]) {
  bookRows[side] = Array.from({ length: 20 }, () => {
    const el = document.createElement("div");
    el.className = "book-row " + (side === "asks" ? "ask" : "bid");
    el.innerHTML =
      '<i class="depth-bar"></i><span class="price">—</span><span class="size">—</span><span class="cumulative">—</span>';
    $(side).append(el);
    return {
      el,
      bar: el.children[0],
      p: el.children[1],
      s: el.children[2],
      c: el.children[3],
    };
  });
}
function renderBook(d) {
  for (const side of ["bids", "asks"]) {
    let cumulative = 0;
    let rows = (d?.[side] ?? []).map((l) => ({
      ...l,
      cumulative: (cumulative += l.size),
    }));
    const max = cumulative || 1;
    if (side === "asks") rows.reverse();
    bookRows[side].forEach((row, i) => {
      const l = rows[i];
      row.p.textContent = l ? price(l.price) : "—";
      row.s.textContent = l ? size(l.size) : "—";
      row.c.textContent = l ? compact(l.cumulative, 3) : "—";
      row.bar.style.width = (l ? (l.cumulative / max) * 100 : 0) + "%";
    });
  }
  const b = (d?.bids ?? []).reduce((a, l) => a + l.size, 0),
    a = (d?.asks ?? []).reduce((s, l) => s + l.size, 0);
  text("book-bid-share", a + b ? pct(b / (a + b)) : "—");
  text("book-ask-share", a + b ? pct(a / (a + b)) : "—");
  $("book-balance-fill").style.width = (a + b ? (100 * b) / (a + b) : 50) + "%";
  text("book-mid", price(d?.mid));
  text("book-spread", d ? "价差 " + fmt(d.spread_bps, 3) + " bp" : "价差 —");
}
function renderInvalid() {
  document.body.classList.add("stale");
  ui.shown = null;
  for (const id of [
    "mid-price",
    "pressure",
    "delta",
    "rotation",
    "expansion",
    "volume24",
    "feed-age",
    "source-age",
    "chart-price",
    "sigma",
    "sequence",
    "level-count",
    "trade-gaps",
    "unmatched",
    "flow-buy",
    "flow-sell",
    "absorption-max",
    "reload-max",
    "reload-events",
  ])
    text(id, "—");
  text("high-low", "— / —");
  text("spread", "— bp");
  text("price-change", "等待有效行情");
  text("pressure-tag", "等待数据");
  text("rotation-tag", "等待数据");
  text("expansion-tag", "等待数据");
  text("buy-share-text", "主动买入 —");
  text("sell-share-text", "卖出 —");
  text("tfi", "TFI —");
  text("coverage", "待同步");
  text("tps", "— trades/s");
  text("flow-trades", "等待成交窗口预热");
  text("quality-label", "数据暂不可用");
  $("quality-dot").className = "quality-dot";
  $("pressure-fill").style.width = "0%";
  $("buy-share-fill").style.width = "50%";
  renderBook(null);
  html(
    "depth-bands",
    [1, 5]
      .map(
        (b) =>
          `<div class="depth-band"><span>${b} bp</span><span>—<small>—</small></span><span>—<small>—</small></span></div>`,
      )
      .join(""),
  );
  html("events-body", "");
  html("defense-body", "");
  html("tape", "");
  $("events-empty").hidden = false;
  $("defense-empty").hidden = false;
  $("chart-empty").hidden = false;
}
function render(d) {
  if (!d?.valid) {
    renderInvalid();
    return;
  }
  ui.shown = d;
  document.body.classList.remove("stale");
  $("chart-empty").hidden = ui.history.length > 1;
  updateIdentity(d.info);
  text("mid-price", price(d.mid));
  text("chart-price", price(d.mid));
  text(
    "price-change",
    d.ticker ? signed(d.ticker.change_pct) + "% · 24h" : "等待 24h 行情",
  );
  tone("price-change", d.ticker?.change_pct);
  text(
    "high-low",
    d.ticker ? price(d.ticker.high) + " / " + price(d.ticker.low) : "— / —",
  );
  text("volume24", compact(d.ticker?.quote_volume));
  text("spread", fmt(d.spread_bps, 3) + " bp");
  text("feed-age", d.feed_age_ms + " ms");
  text("pressure", signed(d.pressure * 100, 1) + "%");
  tone("pressure", d.pressure);
  text(
    "pressure-tag",
    d.pressure > 0.1 ? "BID 占优" : d.pressure < -0.1 ? "ASK 占优" : "近端均衡",
  );
  const bar = $("pressure-fill");
  bar.style.width = Math.abs(d.pressure) * 50 + "%";
  bar.style.left = (d.pressure < 0 ? 50 + d.pressure * 50 : 50) + "%";
  bar.style.background = d.pressure < 0 ? C.coral : C.mint;
  text("rotation", signed(d.rotation, 3));
  tone("rotation", d.rotation);
  text(
    "rotation-tag",
    d.phase_samples < 4
      ? "采样预热"
      : d.rotation > 0.03
        ? "向 BID 转移"
        : d.rotation < -0.03
          ? "向 ASK 转移"
          : "变化平缓",
  );
  text("expansion", signed(d.volatility_expansion, 3));
  $("expansion").style.color =
    d.volatility_expansion > 0.05
      ? "var(--amber)"
      : d.volatility_expansion < -0.05
        ? "var(--lavender)"
        : "var(--text)";
  text(
    "expansion-tag",
    d.phase_samples < 4
      ? "采样预热"
      : d.volatility_expansion > 0.03
        ? "波动扩张"
        : d.volatility_expansion < -0.03
          ? "波动收缩"
          : "变化平缓",
  );
  text("sigma", "σ " + fmt(d.short_volatility * 10000, 3) + " bp");
  const flow = d.flow.find((f) => f.window_s === ui.window);
  text("delta", signCompact(flow.delta_notional));
  tone("delta", flow.delta_notional);
  text("delta-unit", ui.window + "s · " + d.info.quote);
  text("buy-share-text", "主动买入 " + pct(flow.buy_share));
  text(
    "sell-share-text",
    "卖出 " + (finite(flow.buy_share) ? pct(1 - flow.buy_share) : "—"),
  );
  text("tfi", "TFI " + signed(flow.tfi, 2));
  $("buy-share-fill").style.width =
    (finite(flow.buy_share) ? flow.buy_share * 100 : 50) + "%";
  text("flow-buy", compact(flow.buy_notional));
  text("flow-sell", compact(flow.sell_notional));
  text(
    "flow-trades",
    flow.complete
      ? `${flow.trades.toLocaleString()} 笔 / ${ui.window}s · ${d.info.quote}`
      : `窗口预热中 · ${ui.window}s 完整后生效`,
  );
  text("tps", d.flow[0].trades + " trades/s");
  html(
    "depth-bands",
    d.depth
      .map(
        (b) =>
          `<div class="depth-band"><span>${b.bps} bp${!b.complete ? "<small>覆盖不完整</small>" : ""}</span><span class="positive">${compact(b.bid_notional)}<small>${size(b.bid_size)} ${esc(d.info.base)}</small></span><span class="negative">${compact(b.ask_notional)}<small>${size(b.ask_size)} ${esc(d.info.base)}</small></span></div>`,
      )
      .join(""),
  );
  text("coverage", d.coverage_complete ? "1 / 5 bp 完整" : "部分覆盖");
  $("coverage").style.color = d.coverage_complete
    ? "var(--mint)"
    : "var(--amber)";
  renderBook(d);
  renderEvents(d);
  renderDefense(d);
  renderTape(d);
  text("sequence", d.sequence);
  text("level-count", d.quality.book_levels.toLocaleString());
  text("trade-gaps", d.quality.trade_gaps);
  text("unmatched", d.quality.unmatched_trades);
  text("source-age", d.source_age_ms + " ms");
  text(
    "quality-label",
    d.coverage_complete
      ? "序列连续 · 深度覆盖完整"
      : "序列连续 · 近价深度部分覆盖",
  );
  $("quality-dot").className = "quality-dot live";
  text(
    "server-performance",
    "Rust compute " + fmt(d.compute_us / 1000, 2) + " ms",
  );
}
function renderEvents(d) {
  const active = d.events.filter((e) => d.ts - e.start_ts <= 3000);
  text(
    "absorption-max",
    active.length
      ? fmt(Math.max(...active.map((e) => e.absorption_score))) + "×"
      : "—",
  );
  text(
    "reload-max",
    active.length
      ? fmt(Math.max(...active.map((e) => e.replenish_ratio))) + "×"
      : "—",
  );
  text("reload-events", d.events.filter((e) => e.repeated_reload).length);
  const events = d.events.filter(
    (e) => ui.filter === "all" || e.side === ui.filter,
  );
  html(
    "events-body",
    events
      .map(
        (e) =>
          `<tr><td><div class="event-kind"><span class="event-time">${time(e.confirm_ts)}</span><span class="side-chip ${e.side}">${e.side === "bid" ? "BID" : "ASK"} 承接</span>${e.repeated_reload ? '<span class="repeated">补量</span>' : ""}</div></td><td>${price(e.price)}</td><td class="${e.side === "bid" ? "positive" : "negative"}" title="攻击 ${size(e.attack_volume)} / 初始 ${size(e.start_size)}；确认后最新剩余 ${size(e.remaining_size)}">${fmt(e.absorption_score)}×</td><td>${fmt(e.replenish_ratio)}× <span class="muted">/ ${e.reload_count}</span></td><td><div class="returns">${[e.return_1s_bps, e.return_5s_bps, e.return_15s_bps].map((r) => `<span class="${r > 0 ? "positive" : r < 0 ? "negative" : "muted"}">${signed(r, 2)}</span>`).join("")}</div></td></tr>`,
      )
      .join(""),
  );
  $("events-empty").hidden = events.length > 0;
}
function renderDefense(d) {
  html(
    "defense-body",
    d.defense
      .map(
        (l) =>
          `<tr><td><span class="side-chip ${l.side}">${l.side.toUpperCase()}</span>${price(l.price)}</td><td>${size(l.size)}</td><td>${fmt(l.age_s, 1)}s</td><td>${l.refresh_count}</td><td>${pct(l.retention)}</td><td><div class="heat-cell"><span class="heat-track"><i style="width:${l.defense_heat * 100}%"></i></span><b>${fmt(l.defense_heat * 100, 0)}</b></div></td></tr>`,
      )
      .join(""),
  );
  $("defense-empty").hidden = d.defense.length > 0;
}
function renderTape(d) {
  html(
    "tape",
    d.trades
      .map(
        (t) =>
          `<div class="tape-row ${t.buy ? "buy" : "sell"}"><span>${time(t.ts)}<small>.${String(t.ts % 1000).padStart(3, "0")}</small></span><span>${price(t.price)}</span><span>${size(t.size)}</span><span class="direction">${t.buy ? "买" : "卖"}</span></div>`,
      )
      .join(""),
  );
}

const canvases = new Map();
const resizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const item = canvases.get(e.target.id);
    if (!item) continue;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    item.w = e.contentRect.width;
    item.h = e.contentRect.height;
    item.dpr = dpr;
    e.target.width = Math.max(1, Math.round(item.w * dpr));
    e.target.height = Math.max(1, Math.round(item.h * dpr));
  }
  ui.dirty = true;
});
for (const canvas of document.querySelectorAll("canvas")) {
  canvases.set(canvas.id, {
    canvas,
    ctx: canvas.getContext("2d"),
    w: 0,
    h: 0,
    dpr: 1,
  });
  resizeObserver.observe(canvas);
}
function context(id) {
  const c = canvases.get(id);
  const { ctx, w, h, dpr } = c;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
  ctx.lineWidth = 1;
  return c;
}
function line(ctx, points, color, width = 1.5) {
  if (points.length < 2) return;
  ctx.beginPath();
  let open = false;
  for (const p of points) {
    if (!p || !Number.isFinite(p[1])) {
      open = false;
      continue;
    }
    if (!open) {
      ctx.moveTo(...p);
      open = true;
    } else ctx.lineTo(...p);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
function grid(ctx, w, h, left = 0, right = 0, rows = 4) {
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 4]);
  for (let i = 0; i <= rows; i++) {
    const y = 12 + (i * (h - 25)) / rows;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
function spark(id, values, color) {
  const { ctx, w, h } = context(id);
  const nums = values.filter(finite);
  if (nums.length < 2) return;
  let min = Math.min(...nums),
    max = Math.max(...nums);
  if (max === min) {
    max += 0.01;
    min -= 0.01;
  }
  const pts = values.map((v, i) =>
    finite(v)
      ? [
          (i / (values.length - 1)) * w,
          h - 3 - ((v - min) / (max - min)) * (h - 6),
        ]
      : null,
  );
  line(ctx, pts, color, 1.4);
}
// Draw the extrema in each horizontal pixel, retaining spikes and outage gaps.
// Statistics and exported history continue to use every original sample.
function plotPoints(history, field, x, y) {
  const result = [];
  let bucket = [],
    pixel = null,
    previousTs = 0;
  const flush = () => {
    if (!bucket.length) return;
    let low = bucket[0],
      high = bucket[0];
    for (const p of bucket) {
      if (p[field] < low[field]) low = p;
      if (p[field] > high[field]) high = p;
    }
    const chosen = [...new Set([bucket[0], low, high, bucket.at(-1)])].sort(
      (a, b) => a.ts - b.ts,
    );
    for (const p of chosen) result.push([x(p.ts), y(p[field])]);
    bucket = [];
  };
  for (const p of history) {
    const px = Math.floor(x(p.ts));
    if (previousTs && p.ts - previousTs > 3000) {
      flush();
      result.push(null);
    }
    if (pixel !== px) {
      flush();
      pixel = px;
    }
    bucket.push(p);
    previousTs = p.ts;
  }
  flush();
  return result;
}
function drawPrice() {
  const { ctx, w, h } = context("price-chart");
  if (!w || !h) return;
  const left = 9,
    right = 75,
    top = 13,
    bottom = 25,
    pH = h * 0.64,
    pressureTop = h * 0.77,
    pressureH = h * 0.14;
  const end = ui.shown?.source_ts ?? Date.now(),
    start = end - ui.seconds * 1000;
  const hist = visibleHistory().filter((p) => p.ts >= start && p.ts <= end);
  grid(ctx, w, pH, left, right, 3);
  if (hist.length < 2) return;
  let min = Infinity,
    max = -Infinity;
  for (const p of hist) {
    min = Math.min(min, p.mid);
    max = Math.max(max, p.mid);
  }
  const pad = Math.max(
    (max - min) * 0.13,
    10 ** -(ui.shown?.info.price_decimals ?? 2) * 4,
  );
  min -= pad;
  max += pad;
  const x = (ts) => left + ((ts - start) / (end - start)) * (w - left - right),
    y = (v) => top + ((max - v) / (max - min)) * (pH - top - 10);
  const points = plotPoints(hist, "mid", x, y);
  // Fill each continuous segment separately, so outages never look like normal continuity.
  const grad = ctx.createLinearGradient(0, 0, 0, pH);
  grad.addColorStop(0, "#79dfb827");
  grad.addColorStop(1, "#79dfb800");
  let segment = [];
  const fill = () => {
    if (segment.length > 1) {
      ctx.beginPath();
      ctx.moveTo(segment[0][0], pH);
      for (const p of segment) ctx.lineTo(...p);
      ctx.lineTo(segment.at(-1)[0], pH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    segment = [];
  };
  for (const p of [...points, null]) {
    if (p) segment.push(p);
    else fill();
  }
  line(ctx, points, C.mint, 1.6);
  ctx.textAlign = "left";
  ctx.fillStyle = C.muted;
  for (let i = 0; i <= 3; i++) {
    const v = max - ((max - min) * i) / 3;
    ctx.fillText(price(v), w - right + 9, y(v) + 3);
  }
  const latest = hist.at(-1);
  ctx.setLineDash([3, 4]);
  line(
    ctx,
    [
      [left, y(latest.mid)],
      [w - right, y(latest.mid)],
    ],
    "#79dfb855",
    0.7,
  );
  ctx.setLineDash([]);
  ctx.fillStyle = "#224137";
  ctx.fillRect(w - right + 3, y(latest.mid) - 8, right - 5, 17);
  ctx.fillStyle = C.mint;
  ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
  ctx.fillText(price(latest.mid), w - right + 8, y(latest.mid) + 3);
  ctx.fillStyle = "#536e7e";
  ctx.font = "8px sans-serif";
  ctx.fillText("PRESSURE", left, pressureTop - 8);
  ctx.fillText("+1", w - right + 9, pressureTop + 3);
  ctx.fillText("−1", w - right + 9, pressureTop + pressureH + 3);
  const pY = (v) => pressureTop + ((1 - v) * pressureH) / 2;
  ctx.setLineDash([3, 4]);
  line(
    ctx,
    [
      [left, pY(0)],
      [w - right, pY(0)],
    ],
    C.grid,
    0.6,
  );
  ctx.setLineDash([]);
  line(ctx, plotPoints(hist, "pressure", x, pY), C.lavender, 1.1);
  ctx.font = "8px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = C.muted;
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const ts = start + ((end - start) * i) / 4;
    ctx.fillText(
      time(ts).slice(ui.seconds <= 180 ? 3 : 0),
      Math.max(25, Math.min(w - right - 12, x(ts))),
      h - 5,
    );
  }
  const dur = (hist.at(-1).ts - hist[0].ts) / 1000;
  text(
    "history-duration",
    "已积累 " + (dur < 60 ? Math.floor(dur) + "s" : fmt(dur / 60, 1) + "min"),
  );
  if (ui.mouse) {
    const ts =
      start + ((ui.mouse.x - left) / (w - left - right)) * (end - start);
    let near = hist[0];
    for (const p of hist)
      if (Math.abs(p.ts - ts) < Math.abs(near.ts - ts)) near = p;
    ctx.setLineDash([3, 4]);
    line(
      ctx,
      [
        [x(near.ts), top],
        [x(near.ts), h - bottom],
      ],
      "#8caab877",
      0.8,
    );
    ctx.setLineDash([]);
    const tip = $("chart-tooltip");
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(6, x(near.ts) + 10), w - 180) + "px";
    tip.style.top = "14px";
    tip.innerHTML = `${time(near.ts)}<br><span class="positive">${price(near.mid)}</span> ${esc(ui.shown?.info.quote ?? "")}<br>Pressure ${signed(near.pressure * 100, 1)}%`;
  }
}
function drawDepth() {
  const { ctx, w, h } = context("depth-chart");
  grid(ctx, w, h, 4, 6, 2);
  const d = ui.shown;
  if (!d) return;
  const rows = d.curve;
  const max = Math.max(
    1,
    ...rows.map((r) => Math.max(r.bid_notional, r.ask_notional)),
  );
  const x = (i) => 9 + (i / 40) * (w - 24),
    y = (v) => h - 20 - (v / max) * (h - 30);
  for (const [field, color, fill] of [
    ["bid_notional", C.mint, "#79dfb810"],
    ["ask_notional", C.coral, "#ec889110"],
  ]) {
    const pts = rows.map((r, i) => (r.complete ? [x(i), y(r[field])] : null));
    line(ctx, pts, color, 1.5);
    ctx.beginPath();
    ctx.moveTo(x(0), h - 20);
    for (const p of pts) {
      if (!p) break;
      ctx.lineTo(...p);
    }
    const last = pts.filter(Boolean).at(-1);
    if (last) {
      ctx.lineTo(last[0], h - 20);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }
  ctx.fillStyle = C.muted;
  ctx.textAlign = "left";
  ctx.font = "8px ui-monospace, monospace";
  for (let i = 0; i <= 4; i++)
    ctx.fillText(i * 5 + " bp", Math.min(w - 35, x(i * 10)), h - 4);
}
function drawFlow() {
  const { ctx, w, h } = context("flow-chart");
  grid(ctx, w, h, 5, 5, 2);
  const data = (
    ui.paused && ui.frozen ? ui.frozen.flowHistory : ui.flowHistory
  ).slice(-40);
  const max = Math.max(1, ...data.map((p) => Math.max(p.buy, p.sell)));
  const middle = h * 0.48;
  ctx.fillStyle = C.muted;
  ctx.font = "7px ui-monospace, monospace";
  ctx.fillText("滚动 1s 窗口 · 每秒采样", 6, h - 4);
  const step = (w - 15) / 40;
  for (let i = 0; i < data.length; i++) {
    const p = data[i],
      x = 7 + (i + 40 - data.length) * step;
    ctx.fillStyle = "#79dfb89c";
    ctx.fillRect(
      x,
      middle - (p.buy / max) * (middle - 7),
      Math.max(1, step - 3),
      (p.buy / max) * (middle - 7),
    );
    ctx.fillStyle = "#ec88919c";
    ctx.fillRect(
      x,
      middle + 1,
      Math.max(1, step - 3),
      (p.sell / max) * (middle - 13),
    );
  }
  line(
    ctx,
    [
      [5, middle],
      [w - 5, middle],
    ],
    "#56718077",
    0.8,
  );
}
function drawPhase() {
  const { ctx, w, h } = context("phase-chart");
  if (!w || !h) return;
  const pad = 35,
    cx = w / 2,
    cy = h / 2,
    rx = (w - 2 * pad) / 2,
    ry = (h - 2 * pad) / 2;
  ctx.fillStyle = "#152421";
  ctx.fillRect(cx, pad, rx, ry);
  ctx.fillStyle = "#241d26";
  ctx.fillRect(pad, cy, rx, ry);
  ctx.setLineDash([3, 4]);
  line(
    ctx,
    [
      [pad, cy],
      [w - pad, cy],
    ],
    "#3a5361",
    0.8,
  );
  line(
    ctx,
    [
      [cx, pad],
      [cx, h - pad],
    ],
    "#3a5361",
    0.8,
  );
  ctx.setLineDash([]);
  ctx.strokeStyle = "#233640";
  ctx.lineWidth = 0.7;
  ctx.strokeRect(pad, pad, w - 2 * pad, h - 2 * pad);
  ctx.fillStyle = "#587584";
  ctx.font = "8px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Rotation +1", cx, 17);
  ctx.fillText("−1", cx, h - pad + 13);
  ctx.fillText("Pressure", cx, h - 5);
  ctx.fillText("−1", pad - 14, cy + 3);
  ctx.fillText("+1", w - pad + 14, cy + 3);
  ctx.textAlign = "left";
  ctx.font = "7px sans-serif";
  ctx.fillStyle = "#416f60";
  ctx.fillText("买侧优势增强", cx + 8, pad + 15);
  ctx.fillStyle = "#775362";
  ctx.fillText("卖侧优势增强", pad + 8, h - pad - 10);
  const latest = ui.shown?.source_ts ?? 0;
  const pts = visibleHistory().filter(
    (p) => p.ts > latest - 60000 && p.ts <= latest,
  );
  if (!pts.length) return;
  const sampled = pts.filter((_, i) => i % 3 === 0);
  for (let i = 1; i < sampled.length; i++) {
    if (sampled[i].ts - sampled[i - 1].ts > 3000) continue;
    const a = sampled[i - 1],
      b = sampled[i];
    ctx.globalAlpha = 0.08 + (0.55 * i) / sampled.length;
    line(
      ctx,
      [
        [cx + a.pressure * rx, cy - a.rotation * ry],
        [cx + b.pressure * rx, cy - b.rotation * ry],
      ],
      C.mint,
      0.9,
    );
  }
  ctx.globalAlpha = 1;
  const p = pts.at(-1),
    x = cx + p.pressure * rx,
    y = cy - p.rotation * ry;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#79dfb822";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = C.mint;
  ctx.fill();
}
function drawAll() {
  drawPrice();
  drawDepth();
  drawFlow();
  drawPhase();
  const h = ui.shown ? visibleHistory().slice(-100) : [];
  spark(
    "spark-pressure",
    h.map((p) => p.pressure),
    C.mint,
  );
  spark(
    "spark-rotation",
    h.map((p) => p.rotation),
    C.lavender,
  );
  spark(
    "spark-expansion",
    h.map((p) => p.expansion),
    "#d9bc85",
  );
  spark(
    "spark-delta",
    ui.shown
      ? ui.paused && ui.frozen
        ? ui.frozen.deltaHistory
        : ui.deltaHistory
      : [],
    C.mint,
  );
}
function animation() {
  if (ui.dirty && !document.hidden && !ui.benchmark) {
    ui.dirty = false;
    const start = performance.now();
    if (!ui.paused) render(ui.latest);
    drawAll();
    ui.frames++;
    const cost = performance.now() - start;
    ui.renders.push(cost);
    if (ui.renders.length > 600) ui.renders.shift();
  }
  requestAnimationFrame(animation);
}
requestAnimationFrame(animation);
setInterval(() => {
  text("clock", time(Date.now()) + " CST");
  if (
    ui.connected &&
    ui.lastReceive &&
    performance.now() - ui.lastReceive > 4000 &&
    !ui.paused
  ) {
    connection("推送已过期", "error");
    notice("超过 4 秒未收到服务端推送，当前指标已停止显示。", true, true);
    ui.latest = null;
    ui.dirty = true;
  }
  if (ui.renders.length) {
    const sorted = [...ui.renders].sort((a, b) => a - b);
    text(
      "performance",
      `JS render p95 ${fmt(sorted[Math.floor(sorted.length * 0.95)], 2)} ms · 10 Hz`,
    );
  }
}, 1000);
$("price-chart").addEventListener("pointermove", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  ui.mouse = { x: e.clientX - rect.left };
  ui.dirty = true;
});
$("price-chart").addEventListener("pointerleave", () => {
  ui.mouse = null;
  $("chart-tooltip").hidden = true;
  ui.dirty = true;
});
$("market-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ui.symbols.length) {
    try {
      await loadSymbols();
    } catch (error) {
      notice(error.message, true, true);
      return;
    }
  }
  connect($("symbol").value);
});
$("symbol").addEventListener("input", () => {
  $("symbol").setCustomValidity("");
  $("symbol").removeAttribute("aria-invalid");
  updateSuggestions();
});
$("venue").addEventListener("change", async () => {
  ui.venue = $("venue").value;
  try {
    await loadSymbols();
  } catch (e) {
    notice(e.message, true, true);
  }
});
for (const button of document.querySelectorAll("[data-symbol]"))
  button.addEventListener("click", () => connect(button.dataset.symbol));
$("retry-button").addEventListener("click", async () => {
  if (!ui.symbols.length) {
    try {
      await loadSymbols();
    } catch (e) {
      notice(e.message, true, true);
      return;
    }
  }
  connect(ui.selected);
});
$("pause-button").addEventListener("click", () => {
  if (!ui.latest?.valid && !ui.paused) {
    toast("收到有效行情后可以暂停观察");
    return;
  }
  ui.paused = !ui.paused;
  document.body.classList.toggle("paused", ui.paused);
  $("pause-button").innerHTML = ui.paused
    ? "<span>▶</span> 恢复实时"
    : "<span>Ⅱ</span> 暂停观察";
  if (ui.paused) {
    ui.frozen = {
      history: [...ui.history],
      flowHistory: [...ui.flowHistory],
      deltaHistory: [...ui.deltaHistory],
    };
    connection("观察已暂停");
    notice(
      "观察已暂停，当前画面冻结。后台仍在接收和计算，恢复后跳转到最新状态。",
    );
  } else {
    ui.frozen = null;
    ui.dirty = true;
    connection(
      ui.latest?.valid ? "实时连接" : "同步中",
      ui.latest?.valid ? "live" : "",
    );
    notice(ui.latest?.valid ? "" : "等待有效行情");
  }
});
for (const [id, attribute, property] of [
  ["timeframe", "seconds", "seconds"],
  ["flow-window", "window", "window"],
  ["event-filter", "filter", "filter"],
]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ui[property] =
      attribute === "filter"
        ? b.dataset[attribute]
        : Number(b.dataset[attribute]);
    $(id)
      .querySelectorAll("button")
      .forEach((x) => x.classList.toggle("active", x === b));
    if (property === "window") ui.deltaHistory = [];
    ui.dirty = true;
    if (ui.paused && ui.shown) {
      render(ui.shown);
      drawAll();
    }
  });
}
$("export-button").addEventListener("click", () => {
  const d = ui.shown;
  if (!d?.valid) {
    toast("当前没有可导出的有效快照");
    return;
  }
  const blob = new Blob(
    [
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          source: "Binance public spot market data",
          snapshot: d,
          history: visibleHistory().filter((p) => p.ts <= d.ts),
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `microscope-${d.symbol}-${d.ts}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("当前指标、事件和会话走势已导出");
});
const descriptions = {
  pressure: [
    "加权盘口失衡 · Pressure",
    "两侧各取最近 12 档，权重 wᵢ = 1/√i。",
    "<code>Pressure = (Σ wᵢqᵇᵢ − Σ wᵢqᵃᵢ) / (Σ wᵢqᵇᵢ + Σ wᵢqᵃᵢ)</code>",
    "正值表示近端可见 Bid 较多，负值表示 Ask 较多。权重按档位排名，不按价格距离；大量挂单可能撤走，必须结合实际成交与价格反应。",
  ],
  depth: [
    "近价深度 · 1 bp / 5 bp",
    "1 bp = 0.01%。以中间价为中心，统计指定距离内的基础币数量，同时以数量 × 中间价换算报价币金额。",
    "<code>Bid ≥ mid × (1 − d/10000)<br>Ask ≤ mid × (1 + d/10000)</code>",
    "初始快照每侧最多 5000 档；覆盖边界固定，不会因远端零散更新扩大。页面明确区分完整与部分覆盖；价差较宽时范围内确实可能没有挂单。",
  ],
  delta: [
    "主动成交净额 · Trade Delta",
    "使用 Binance @trade 的原始逐笔成交。m=true 表示买方为 maker，因此主动方为卖方。按成交 ID 去重，同时计算 1s / 5s / 10s 窗口。",
    "<code>Delta = 主动买入金额 − 主动卖出金额<br>BuyShare = 买额 / (买额 + 卖额)<br>TFI = 2 × BuyShare − 1</code>",
    "窗口为 (t−W, t]，金额 = 成交价格 × 数量。窗口未预热或没有成交时比例与 Delta 显示缺失。最近 60 笔仅为展示，统计使用完整时间窗口；成交 ID 缺口会清空并重新预热。",
  ],
  absorption: [
    "吸收强度 · Absorption",
    "主动卖出攻击 Bid，主动买入攻击 Ask。同侧、同价位启动约 3 秒的攻击窗口。Q₀ 使用成交之前最近观察到的可见量；若最近观察来自成交之后，则不用于匹配。",
    "<code>Absorption = 该价位攻击成交量 / Q₀</code>",
    "Q₀ 至少达到有意义数量（盘口数量上中位数的 0.5 倍），吸收比 ≥0.70，且确认时价位仍可见，才记录事件。大于 1 很正常，因为期间可能补单。100ms 深度与逐笔成交的到达顺序限制了精度；此分数不能证明价位持续守住。",
  ],
  reload: [
    "补单强度 · Replenishment",
    "对连续可见的同侧价位，只有净增加超过容差才计入。攻击窗口内单独累计补量和次数。",
    "<code>ε = max(2.5% × 峰值量, 5% × 有意义量, εmachine)<br>ReplenishRatio = 攻击期间有效净增加量 / Q₀</code>",
    "重复补量标记还要求已满足吸收条件、补量次数 ≥2、补量比 ≥0.5。短暂消失后重新出现只计入生命周期刷新，不直接增加本轮攻击补量。净变化会漏掉同一更新间隔内被成交抵消的新增挂单，不能证明原生冰山订单。",
  ],
  defense: [
    "防守热度 · Defense Heat",
    "综合价位存续、生命周期刷新和当前量相对峰值的保留比例。只对有意义的当前可见档位计算。",
    "<code>Heat = 0.4 × min(age/60s,1)<br>+ 0.4 × min(refreshes/6,1)<br>+ 0.2 × min(current/peak,1)</code>",
    "两秒内重新出现延续生命周期；移除历史最多保留 15 秒。热度可在没有真实攻击时积累，应结合吸收事件一起看。表格从两侧最近 120 档挑选热度最高的 12 个价位；热度展示为 0–100。",
  ],
  rotation: [
    "压力变化 · Rotation",
    "每次有新深度且距前次采样至少 100ms 时，计算 Pressure 的时间变化率，按指数二阶矩归一化后平滑。",
    "<code>u = ΔPressure / Δt<br>Eᵘ = 0.97 Eᵘ + 0.03 u²<br>y ← y + (1−exp(−Δt/0.8)) × (tanh(u/(2√Eᵘ))−y)</code>",
    "Δt 限制在 0.05–2 秒；初始二阶矩 10⁻⁶。正值表示优势向 Bid 转移，负值表示向 Ask 转移。Rotation 描述挂单变化，并不是价格动量或主动成交方向。断流后重新预热。",
  ],
  volatility: [
    "波动扩张 · Volatility Expansion",
    "使用最多 20 个中间价对数收益的总体标准差 σ，不年化。对 σ 的时间变化率使用与 Rotation 相同的归一化与平滑。",
    "<code>σ = std_population(ln(mᵢ / mᵢ₋₁))<br>v = Δσ / Δt<br>Eᵛ = 0.97 Eᵛ + 0.03 v²</code>",
    "初始二阶矩 10⁻¹⁰，标准差不足 3 个收益时为 0。扩张分数为正表示短期波动率上升，接近零不代表波动率水平低。页面同时显示 σ（换算成 bp）和扩张分数。",
  ],
  phase: [
    "压力相图 · Phase Space",
    "横轴为 Pressure，纵轴为 Rotation。右侧表示 Bid 占优，上方表示相对优势向 Bid 转移；颜色较亮的位置是较新的状态。",
    "",
    "轨迹仅取当前页面最近 60 秒。相图帮助理解当前优势及其变化，不增加一份独立证据，也不是买卖信号。",
  ],
};
function showHelp(key) {
  const keys = descriptions[key] ? [key] : Object.keys(descriptions);
  text("help-title", descriptions[key]?.[0] ?? "指标与数据口径");
  html(
    "help-content",
    keys
      .map((k) => {
        const [title, ...paragraphs] = descriptions[k];
        return `<h4>${title}</h4>${paragraphs
          .filter(Boolean)
          .map((p) => `<p>${p}</p>`)
          .join("")}`;
      })
      .join("") +
      (!key
        ? '<h4>数据与有效性</h4><p>先建立 WebSocket，再获取 REST 快照，衔接连续增量序号。序列断裂会重新同步；超过 3 秒没有深度更新、源延迟超过 5 秒或时钟异常时，相关指标暂不展示。重连后窗口与生命周期重新开始。页面历史从打开时积累，最多 15 分钟。</p><h4>事件后价格反应</h4><p>以事件确认时的中间价为基准，显示之后 1s / 5s / 15s 的 10000 × ln(mid / initialMid)，单位 bp。到达相应时刻才填充；正数是价格上涨，不代表对应防守方向一定获利。采样分辨率约 100ms，断流期间不补造结果。</p><h4>渲染与性能</h4><p>Rust 连续接收原始行情并计算，网页通过 WebSocket 最多每秒接收 10 次最新状态。JavaScript 在 requestAnimationFrame 中批量更新固定盘口节点和 Canvas；隐藏标签页暂停绘制。底部 p95 是 JS 更新及 Canvas 提交耗时，不包含 GPU 合成；延迟指标也不是交易请求 RTT。</p><p><a href="https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams" target="_blank" rel="noreferrer">Binance WebSocket 数据说明 ↗</a></p>'
        : ""),
  );
  $("help-dialog").showModal();
}
for (const b of document.querySelectorAll("[data-help-button]"))
  b.addEventListener("click", () => showHelp(b.dataset.helpButton));
$("help-button").addEventListener("click", () => showHelp());
$("help-rail").addEventListener("click", () => showHelp());
$("close-help").addEventListener("click", () => $("help-dialog").close());
$("help-dialog").addEventListener("click", (e) => {
  if (e.target === $("help-dialog")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ui.dirty = true;
});
window.addEventListener("pagehide", () => ui.ws?.close());
// Read-only telemetry and an explicit, bounded stress probe for repeatable browser QA.
window.microScope = {
  stats: () => ({
    symbol: ui.selected,
    valid: !!ui.shown?.valid,
    frames: ui.frames,
    messages: ui.received,
    bytes: ui.bytes,
    history: ui.history.length,
    domNodes: document.querySelectorAll("*").length,
    renderMs: [...ui.renders],
    snapshot: ui.shown,
  }),
  async benchmark(frames = 180) {
    if (!ui.shown?.valid) throw new Error("Live market data is required");
    const current = ui.shown;
    const original = ui.history;
    const samples = [...original];
    if (!samples.length) throw new Error("No history");
    // Repeat real observed samples to exercise the full 15-minute rendering capacity.
    ui.history = Array.from({ length: 9000 }, (_, i) => ({
      ...samples[i % samples.length],
      ts: current.source_ts - (8999 - i) * 100,
    }));
    const before = ui.seconds;
    ui.seconds = 900;
    ui.benchmark = true;
    notice("正在运行 60Hz 绘制压测：使用真实样本重复填满 15 分钟缓存。");
    const costs = [],
      domCosts = [],
      drawCosts = [];
    try {
      for (let i = 0; i < Math.min(frames, 600); i++) {
        await new Promise(requestAnimationFrame);
        const start = performance.now();
        render(current);
        const drawn = performance.now();
        drawAll();
        const end = performance.now();
        costs.push(end - start);
        domCosts.push(drawn - start);
        drawCosts.push(end - drawn);
      }
    } finally {
      ui.history = original;
      ui.seconds = before;
      ui.benchmark = false;
      ui.dirty = true;
      notice("");
    }
    costs.sort((a, b) => a - b);
    domCosts.sort((a, b) => a - b);
    drawCosts.sort((a, b) => a - b);
    return {
      frames: costs.length,
      historyPoints: 9000,
      p50_ms: costs[Math.floor(costs.length * 0.5)],
      p95_ms: costs[Math.floor(costs.length * 0.95)],
      dom_p95_ms: domCosts[Math.floor(domCosts.length * 0.95)],
      canvas_p95_ms: drawCosts[Math.floor(drawCosts.length * 0.95)],
      max_ms: costs.at(-1),
      under16_7ms: costs.filter((t) => t < 16.7).length / costs.length,
    };
  },
};
async function boot() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("microscope.market") || "null",
    );
    if (saved?.symbol) {
      ui.selected = saved.symbol;
      $("symbol").value = saved.symbol;
    }
  } catch {}
  try {
    const r = await fetch("/api/venues");
    const d = await r.json();
    html(
      "venue",
      d.venues
        .map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`)
        .join(""),
    );
    await loadSymbols();
    await connect(ui.selected);
  } catch (error) {
    connection("无法加载市场", "error");
    notice(error.message, true, true);
  }
}
boot();
