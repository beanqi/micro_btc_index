const $ = (id) => document.getElementById(id);
const C = {
  mint: "#79dfb8",
  coral: "#ec8891",
  lavender: "#a8a0ef",
  amber: "#dbb576",
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
  chartMode: "candles",
  overlays: {
    defense: true,
    events: true,
  },
  focusPrice: null,
  focusTs: null,
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
  if (!el) return;
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
  ui.focusPrice = null;
  ui.focusTs = null;
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
      '<i class="depth-bar"></i><span class="price">—</span><span class="size">—</span><span class="cumulative">—</span><div class="level-meta"><span class="lvl-badge" hidden></span><span class="lvl-heat-bar"><i></i></span><span class="lvl-heat-num">—</span></div>';
    const meta = el.children[4];
    const rowObj = {
      el,
      bar: el.children[0],
      p: el.children[1],
      s: el.children[2],
      c: el.children[3],
      badge: meta.children[0],
      heatFill: meta.children[1].children[0],
      heatNum: meta.children[2],
      rawPrice: null,
    };
    el.addEventListener("pointerenter", () => {
      if (rowObj.rawPrice !== null) {
        ui.focusPrice = rowObj.rawPrice;
        ui.focusTs = null;
        ui.dirty = true;
      }
    });
    el.addEventListener("pointerleave", () => {
      if (ui.focusPrice !== null) {
        ui.focusPrice = null;
        ui.dirty = true;
      }
    });
    $(side).append(el);
    return rowObj;
  });
}

function renderBook(d) {
  const allLevels = [...(d?.bids ?? []), ...(d?.asks ?? [])];
  const avgSize = allLevels.length
    ? allLevels.reduce((s, l) => s + l.size, 0) / allLevels.length
    : 1;
  const meaningful = Math.max(d?.quality?.meaningful_size ?? 0, avgSize * 0.2);
  const recentEvents = new Map();
  if (d?.events) {
    for (const e of d.events) {
      if (d.ts - e.confirm_ts <= 15000) {
        const key = `${e.side}:${e.price}`;
        if (!recentEvents.has(key)) recentEvents.set(key, e);
      }
    }
  }
  const topWalls = new Set();
  if (d?.defense) {
    for (const w of d.defense) topWalls.add(`${w.side}:${w.price}`);
  }

  for (const side of ["bids", "asks"]) {
    const sideKey = side === "bids" ? "bid" : "ask";
    let cumulative = 0;
    const rows = (d?.[side] ?? []).map((l) => ({
      ...l,
      cumulative: (cumulative += l.size),
    }));
    const max = cumulative || 1;
    if (side === "asks") rows.reverse();
    bookRows[side].forEach((row, i) => {
      const l = rows[i];
      row.rawPrice = l ? l.price : null;
      row.p.textContent = l ? price(l.price) : "—";
      row.s.textContent = l ? size(l.size) : "—";
      row.s.classList.toggle("whale", !!l && l.size >= avgSize * 1.8);
      row.c.textContent = l ? compact(l.cumulative, 2) : "—";
      row.bar.style.width = (l ? (l.cumulative / max) * 100 : 0) + "%";

      if (!l) {
        row.badge.hidden = true;
        row.heatFill.style.width = "0%";
        row.heatNum.textContent = "—";
        row.heatNum.classList.remove("hot");
        row.el.classList.remove("is-wall", "is-focus");
        return;
      }

      const isMeaningfulLevel = l.size >= meaningful;
      const heatScore = isMeaningfulLevel
        ? Math.round((l.defense_heat || 0) * 100)
        : 0;
      row.heatFill.style.width = heatScore + "%";
      row.heatNum.textContent = heatScore >= 5 ? String(heatScore) : "·";
      row.heatNum.classList.toggle("hot", heatScore >= 60);

      const ev = recentEvents.get(`${sideKey}:${l.price}`);
      const absScore = l.absorption ?? ev?.absorption_score ?? null;
      const reloads = l.reload_count || ev?.reload_count || 0;

      if (absScore && absScore >= 0.45) {
        row.badge.hidden = false;
        row.badge.className = "lvl-badge absorb";
        row.badge.textContent = `吸${fmt(absScore, 1)}×`;
      } else if (reloads > 0) {
        row.badge.hidden = false;
        row.badge.className = "lvl-badge reload";
        row.badge.textContent = `补×${reloads}`;
      } else if (isMeaningfulLevel && l.refresh_count > 0) {
        row.badge.hidden = false;
        row.badge.className = "lvl-badge refresh";
        row.badge.textContent = `↻${l.refresh_count}`;
      } else {
        row.badge.hidden = true;
      }

      const isWall =
        (isMeaningfulLevel && heatScore >= 55) ||
        topWalls.has(`${sideKey}:${l.price}`);
      row.el.classList.toggle("is-wall", isWall);
      row.el.classList.toggle(
        "is-focus",
        ui.focusPrice !== null && Math.abs(l.price - ui.focusPrice) < 1e-8,
      );
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
          `<tr data-price="${e.price}" data-ts="${e.confirm_ts}" class="${ui.focusPrice !== null && Math.abs(ui.focusPrice - e.price) < 1e-8 ? "is-focus" : ""}"><td><div class="event-kind"><span class="event-time">${time(e.confirm_ts)}</span><span class="side-chip ${e.side}">${e.side === "bid" ? "BID" : "ASK"} 承接</span>${e.repeated_reload ? '<span class="repeated">补量</span>' : ""}</div></td><td class="${e.side === "bid" ? "positive" : "negative"}">${price(e.price)}</td><td class="${e.side === "bid" ? "positive" : "negative"}" title="攻击 ${size(e.attack_volume)} / 初始 ${size(e.start_size)}；确认后最新剩余 ${size(e.remaining_size)}">${fmt(e.absorption_score)}×</td><td>${fmt(e.replenish_ratio)}× <span class="muted">/ ${e.reload_count}</span></td><td><div class="returns">${[e.return_1s_bps, e.return_5s_bps, e.return_15s_bps].map((r) => `<span class="${r > 0 ? "positive" : r < 0 ? "negative" : "muted"}">${signed(r, 2)}</span>`).join("")}</div></td></tr>`,
      )
      .join(""),
  );
  $("events-empty").hidden = events.length > 0;
}

function renderDefense(d) {
  const allLevels = [...(d?.bids ?? []), ...(d?.asks ?? [])];
  const avgSize = allLevels.length
    ? allLevels.reduce((s, l) => s + l.size, 0) / allLevels.length
    : 0;
  const rows = (d.defense ?? []).filter((l) => l.size >= avgSize * 0.15);
  html(
    "defense-body",
    rows
      .map(
        (l) =>
          `<tr data-price="${l.price}" class="${ui.focusPrice !== null && Math.abs(ui.focusPrice - l.price) < 1e-8 ? "is-focus" : ""}"><td><span class="side-chip ${l.side}">${l.side.toUpperCase()}</span><span class="${l.side === "bid" ? "positive" : "negative"}">${price(l.price)}</span></td><td>${size(l.size)}</td><td>${fmt(l.age_s, 1)}s</td><td>${l.refresh_count}</td><td>${pct(l.retention)}</td><td><div class="heat-cell"><span class="heat-track"><i style="width:${l.defense_heat * 100}%"></i></span><b>${fmt(l.defense_heat * 100, 0)}</b></div></td></tr>`,
      )
      .join(""),
  );
  $("defense-empty").hidden = rows.length > 0;
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

function buildCandles(hist, bucketMs) {
  const candles = [];
  let current = null,
    prevTs = 0;
  for (const p of hist) {
    const bStart = Math.floor(p.ts / bucketMs) * bucketMs;
    const gap = prevTs && p.ts - prevTs > 3000;
    if (!current || current.startTs !== bStart || gap) {
      const openPrice = !gap && current ? current.close : p.mid;
      current = {
        startTs: bStart,
        ts: bStart + bucketMs / 2,
        open: openPrice,
        high: Math.max(openPrice, p.mid),
        low: Math.min(openPrice, p.mid),
        close: p.mid,
        pressure: p.pressure,
      };
      candles.push(current);
    } else {
      if (p.mid > current.high) current.high = p.mid;
      if (p.mid < current.low) current.low = p.mid;
      current.close = p.mid;
      current.pressure = p.pressure;
    }
    prevTs = p.ts;
  }
  return candles;
}

function drawPrice() {
  const { ctx, w, h } = context("price-chart");
  if (!w || !h) return;
  const left = 10,
    right = 78,
    top = 14,
    bottom = 22,
    pH = Math.round(h * 0.7),
    pressureTop = Math.round(h * 0.77),
    pressureH = Math.round(h * 0.14);
  const d = ui.shown;
  const end = d?.source_ts ?? Date.now(),
    start = end - ui.seconds * 1000;
  const hist = visibleHistory().filter((p) => p.ts >= start && p.ts <= end);
  grid(ctx, w, pH, left, right, 4);
  if (hist.length < 2) return;

  let min = Infinity,
    max = -Infinity;
  for (const p of hist) {
    min = Math.min(min, p.mid);
    max = Math.max(max, p.mid);
  }
  if (d?.bids?.[0] && d?.asks?.[0]) {
    min = Math.min(min, d.bids[0].price);
    max = Math.max(max, d.asks[0].price);
  }

  const histStart = Math.max(start, hist[0].ts - 1000);
  const visibleEvents =
    ui.overlays.events && d?.events
      ? d.events.filter(
          (e) =>
            e.confirm_ts >= histStart &&
            e.confirm_ts <= end &&
            (ui.filter === "all" || e.side === ui.filter),
        )
      : [];
  const priceSpan = Math.max(
    max - min,
    10 ** -(d?.info?.price_decimals ?? 2) * 6,
  );
  for (const e of visibleEvents) {
    if (Math.abs(e.price - (min + max) / 2) <= priceSpan * 1.5) {
      min = Math.min(min, e.price);
      max = Math.max(max, e.price);
    }
  }
  if (
    ui.focusPrice !== null &&
    Math.abs(ui.focusPrice - (min + max) / 2) <= priceSpan * 1.8
  ) {
    min = Math.min(min, ui.focusPrice);
    max = Math.max(max, ui.focusPrice);
  }

  const pad = Math.max(
    (max - min) * 0.16,
    10 ** -(d?.info?.price_decimals ?? 2) * 4,
  );
  min -= pad;
  max += pad;

  const x = (ts) => left + ((ts - start) / (end - start)) * (w - left - right),
    y = (v) => top + ((max - v) / (max - min)) * (pH - top - 10);

  // Layer 1: Defense Heat Profile Bars & Key Wall Lines
  if (ui.overlays.defense && d) {
    const allBookLevels = [...(d.bids ?? []), ...(d.asks ?? [])];
    const avgTopSize = allBookLevels.length
      ? allBookLevels.reduce((s, l) => s + l.size, 0) / allBookLevels.length
      : 0;
    const minWallSize = Math.max(
      d.quality?.meaningful_size ?? 0,
      avgTopSize * 0.15,
    );

    const wallMap = new Map();
    for (const l of d.defense ?? []) {
      if (l.size >= minWallSize && l.defense_heat >= 0.45) {
        wallMap.set(`${l.side}:${l.price}`, l);
      }
    }
    for (const side of ["bids", "asks"]) {
      for (const l of d[side] ?? []) {
        if (
          l.size >= minWallSize &&
          l.defense_heat >= 0.5 &&
          !wallMap.has(`${l.side}:${l.price}`)
        ) {
          wallMap.set(`${l.side}:${l.price}`, l);
        }
      }
    }

    const scoreWall = (l) =>
      l.defense_heat * Math.sqrt(l.size / (minWallSize || 1));
    const inViewBids = [...wallMap.values()]
      .filter((l) => l.side === "bid" && l.price >= min && l.price <= max)
      .sort((a, b) => scoreWall(b) - scoreWall(a))
      .slice(0, 3);
    const inViewAsks = [...wallMap.values()]
      .filter((l) => l.side === "ask" && l.price >= min && l.price <= max)
      .sort((a, b) => scoreWall(b) - scoreWall(a))
      .slice(0, 3);
    const topWalls = [...inViewBids, ...inViewAsks];
    const maxWallSize = Math.max(1e-9, ...topWalls.map((l) => l.size));
    const plotW = w - left - right;

    const labeledYs = [];
    ctx.font = "8px ui-monospace, SFMono-Regular, monospace";
    for (const l of topWalls) {
      const ly = y(l.price);
      const heat = l.defense_heat;
      const barLen = Math.max(
        48,
        Math.min(plotW * 0.34, plotW * 0.34 * (l.size / maxWallSize)),
      );
      const barH = 3 + heat * 4;

      // Subtle dashed line across chart
      ctx.strokeStyle =
        l.side === "bid"
          ? `rgba(121, 223, 184, ${0.14 + heat * 0.22})`
          : `rgba(236, 136, 145, ${0.14 + heat * 0.22})`;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(left, ly);
      ctx.lineTo(w - right, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      // Right-anchored Defense Heat & Size Profile Bar
      ctx.fillStyle =
        l.side === "bid"
          ? `rgba(121, 223, 184, ${0.14 + heat * 0.24})`
          : `rgba(236, 136, 145, ${0.14 + heat * 0.24})`;
      ctx.fillRect(w - right - barLen, ly - barH / 2, barLen, barH);

      if (!labeledYs.some((py) => Math.abs(py - ly) < 13)) {
        labeledYs.push(ly);
        const label = `🛡${l.side === "bid" ? "BID" : "ASK"} 热度${Math.round(heat * 100)} · ${size(l.size)}${l.refresh_count ? ` ↻${l.refresh_count}` : ""}`;
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = l.side === "bid" ? "#11241fe6" : "#27171de6";
        ctx.fillRect(w - right - tw - 4, ly - 10, tw, 11);
        ctx.fillStyle = l.side === "bid" ? C.mint : C.coral;
        ctx.textAlign = "right";
        ctx.fillText(label, w - right - 8, ly - 2);
      }
    }

    // Off-screen strongest meaningful defense wall callouts
    const highAskWall = (d.defense ?? [])
      .filter((l) => l.side === "ask" && l.price > max && l.size >= minWallSize)
      .sort((a, b) => scoreWall(b) - scoreWall(a))[0];
    if (highAskWall) {
      const txt = `▲ 上方防守墙 ${price(highAskWall.price)} (热度${Math.round(highAskWall.defense_heat * 100)} · ${size(highAskWall.size)})`;
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = "#29181ed9";
      ctx.fillRect(left + 4, top, tw, 12);
      ctx.fillStyle = C.coral;
      ctx.textAlign = "left";
      ctx.fillText(txt, left + 9, top + 9);
    }
    const lowBidWall = (d.defense ?? [])
      .filter((l) => l.side === "bid" && l.price < min && l.size >= minWallSize)
      .sort((a, b) => scoreWall(b) - scoreWall(a))[0];
    if (lowBidWall) {
      const txt = `▼ 下方防守墙 ${price(lowBidWall.price)} (热度${Math.round(lowBidWall.defense_heat * 100)} · ${size(lowBidWall.size)})`;
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = "#122621d9";
      ctx.fillRect(left + 4, pH - 14, tw, 12);
      ctx.fillStyle = C.mint;
      ctx.textAlign = "left";
      ctx.fillText(txt, left + 9, pH - 5);
    }
  }

  // Layer 2: K-Line Candlesticks or Mid-Price Line
  const bucketMs = ui.seconds <= 60 ? 2000 : ui.seconds <= 180 ? 5000 : 15000;
  const candles = buildCandles(hist, bucketMs);
  const points = plotPoints(hist, "mid", x, y);

  if (ui.chartMode === "candles" && candles.length >= 1) {
    // Subtle mid-price trace behind candles
    line(ctx, points, "#79dfb840", 1.0);
    const totalBuckets = Math.max(10, (end - start) / bucketMs);
    const candleW = Math.max(
      2.5,
      Math.min(12, ((w - left - right) / totalBuckets) * 0.66),
    );
    for (const c of candles) {
      const cx = x(c.ts);
      if (cx < left || cx > w - right) continue;
      const up = c.close >= c.open;
      const color = up ? C.mint : C.coral;
      const highY = y(c.high),
        lowY = y(c.low),
        openY = y(c.open),
        closeY = y(c.close);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, highY);
      ctx.lineTo(cx, lowY);
      ctx.stroke();

      const bodyTop = Math.min(openY, closeY);
      const bodyH = Math.max(1.6, Math.abs(closeY - openY));
      ctx.fillStyle = up ? "#79dfb8d9" : "#ec8891d9";
      ctx.fillRect(cx - candleW / 2, bodyTop, candleW, bodyH);
    }
  } else {
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
  }

  // Layer 3: Liquidity Event Markers directly on K-Line
  if (visibleEvents.length) {
    const labeledXs = [];
    for (const e of visibleEvents) {
      const ex = x(e.confirm_ts);
      if (ex < left || ex > w - right) continue;
      const ey = Math.max(top + 8, Math.min(pH - 8, y(e.price)));
      const color = e.side === "bid" ? C.mint : C.coral;

      // Connector down to pressure pane
      ctx.setLineDash([2, 3]);
      line(
        ctx,
        [
          [ex, ey],
          [ex, pressureTop + pressureH],
        ],
        e.side === "bid" ? "#79dfb844" : "#ec889144",
        0.8,
      );
      ctx.setLineDash([]);

      // Outer amber ring for repeated reload
      const r = Math.min(6.5, 3.8 + e.absorption_score * 0.7);
      if (e.repeated_reload) {
        ctx.beginPath();
        ctx.arc(ex, ey, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }

      // Diamond marker
      ctx.beginPath();
      ctx.moveTo(ex, ey - r);
      ctx.lineTo(ex + r, ey);
      ctx.lineTo(ex, ey + r);
      ctx.lineTo(ex - r, ey);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#0b1014";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (!labeledXs.some((px) => Math.abs(px - ex) < 52)) {
        labeledXs.push(ex);
        const tag = `${e.side === "bid" ? "B吸" : "A吸"}${fmt(e.absorption_score, 1)}×${e.repeated_reload ? "·补" : ""}`;
        ctx.font = "8px ui-monospace, SFMono-Regular, monospace";
        ctx.textAlign = "center";
        const tw = ctx.measureText(tag).width + 6;
        const ty =
          e.side === "bid"
            ? Math.min(pH - 4, ey + r + 10)
            : Math.max(top + 9, ey - r - 5);
        const bx = Math.max(left + tw / 2, Math.min(w - right - tw / 2, ex));
        ctx.fillStyle = e.side === "bid" ? "#142b24eb" : "#2d1a21eb";
        ctx.fillRect(bx - tw / 2, ty - 8, tw, 10);
        ctx.fillStyle = e.repeated_reload ? C.amber : color;
        ctx.fillText(tag, bx, ty);
      }
    }
  }

  // Layer 4: Cross-Highlight from Order Book / Events / Defense table hover
  if (ui.focusPrice !== null && ui.focusPrice >= min && ui.focusPrice <= max) {
    const fy = y(ui.focusPrice);
    ctx.setLineDash([4, 3]);
    line(
      ctx,
      [
        [left, fy],
        [w - right, fy],
      ],
      C.amber,
      1.1,
    );
    ctx.setLineDash([]);
    ctx.fillStyle = "#3a2f1b";
    ctx.fillRect(w - right + 3, fy - 8, right - 5, 16);
    ctx.fillStyle = C.amber;
    ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "left";
    ctx.fillText(price(ui.focusPrice), w - right + 7, fy + 3);
  }
  if (ui.focusTs !== null && ui.focusTs >= start && ui.focusTs <= end) {
    const fx = x(ui.focusTs);
    ctx.setLineDash([3, 3]);
    line(
      ctx,
      [
        [fx, top],
        [fx, h - bottom],
      ],
      C.amber,
      1.0,
    );
    ctx.setLineDash([]);
  }

  // Right Y-axis Price Labels & Latest Mid Price Callout
  ctx.textAlign = "left";
  ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = C.muted;
  for (let i = 0; i <= 4; i++) {
    const v = max - ((max - min) * i) / 4;
    ctx.fillText(price(v), w - right + 8, y(v) + 3);
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

  // Sub-pane: Pressure Curve
  ctx.fillStyle = "#536e7e";
  ctx.font = "8px sans-serif";
  ctx.fillText("PRESSURE", left, pressureTop - 6);
  ctx.fillText("+1", w - right + 8, pressureTop + 3);
  ctx.fillText("−1", w - right + 8, pressureTop + pressureH + 3);
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
  line(ctx, plotPoints(hist, "pressure", x, pY), C.lavender, 1.15);

  // Bottom X-axis Time Labels
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

  // Interactive Mouse Crosshair & Enriched Microstructure Tooltip
  if (ui.mouse) {
    const ts =
      start + ((ui.mouse.x - left) / (w - left - right)) * (end - start);
    let near = hist[0];
    for (const p of hist)
      if (Math.abs(p.ts - ts) < Math.abs(near.ts - ts)) near = p;

    let nearCandle = null;
    for (const c of candles)
      if (!nearCandle || Math.abs(c.ts - ts) < Math.abs(nearCandle.ts - ts))
        nearCandle = c;

    let nearEvent = null;
    for (const e of visibleEvents) {
      if (Math.abs(x(e.confirm_ts) - ui.mouse.x) <= 14) {
        nearEvent = e;
        break;
      }
    }

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
    tip.style.left =
      Math.min(Math.max(6, x(near.ts) + 12), Math.max(6, w - 245)) + "px";
    tip.style.top = "12px";

    let tipHtml = `${time(near.ts)} · 中价 <span class="positive">${price(near.mid)}</span> ${esc(d?.info?.quote ?? "")}`;
    if (ui.chartMode === "candles" && nearCandle) {
      tipHtml += `<br>K线 O ${price(nearCandle.open)} / H ${price(nearCandle.high)} / L ${price(nearCandle.low)} / C ${price(nearCandle.close)}`;
    }
    tipHtml += `<br>Pressure <span class="${near.pressure >= 0 ? "positive" : "negative"}">${signed(near.pressure * 100, 1)}%</span>`;
    if (nearEvent) {
      tipHtml += `<br><span class="${nearEvent.side === "bid" ? "positive" : "negative"}">◆ ${nearEvent.side === "bid" ? "BID" : "ASK"} 承接 @ ${price(nearEvent.price)}</span> · 吸收 ${fmt(nearEvent.absorption_score)}× · 补量 ${fmt(nearEvent.replenish_ratio)}× (${nearEvent.reload_count}次)`;
    }
    tip.innerHTML = tipHtml;
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
    y = (v) => h - 18 - (v / max) * (h - 26);
  for (const [field, color, fill] of [
    ["bid_notional", C.mint, "#79dfb810"],
    ["ask_notional", C.coral, "#ec889110"],
  ]) {
    const pts = rows.map((r, i) => (r.complete ? [x(i), y(r[field])] : null));
    line(ctx, pts, color, 1.5);
    ctx.beginPath();
    ctx.moveTo(x(0), h - 18);
    for (const p of pts) {
      if (!p) break;
      ctx.lineTo(...p);
    }
    const last = pts.filter(Boolean).at(-1);
    if (last) {
      ctx.lineTo(last[0], h - 18);
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
  const pad = 26,
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
  ctx.fillText("Rotation +1", cx, 13);
  ctx.fillText("−1", cx, h - pad + 11);
  ctx.fillText("Pressure", cx, h - 3);
  ctx.fillText("−1", pad - 11, cy + 3);
  ctx.fillText("+1", w - pad + 11, cy + 3);
  ctx.textAlign = "left";
  ctx.font = "7px sans-serif";
  ctx.fillStyle = "#416f60";
  ctx.fillText("买侧优势增强", cx + 6, pad + 12);
  ctx.fillStyle = "#775362";
  ctx.fillText("卖侧优势增强", pad + 6, h - pad - 6);
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
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#79dfb822";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 2.8, 0, Math.PI * 2);
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
  ui.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  ui.dirty = true;
});
$("price-chart").addEventListener("pointerleave", () => {
  ui.mouse = null;
  $("chart-tooltip").hidden = true;
  ui.dirty = true;
});

for (const tbodyId of ["events-body", "defense-body"]) {
  const el = $(tbodyId);
  el.addEventListener("pointerover", (e) => {
    const tr = e.target.closest("tr[data-price]");
    if (!tr) return;
    const p = Number(tr.dataset.price);
    const ts = tr.dataset.ts ? Number(tr.dataset.ts) : null;
    if (finite(p)) {
      ui.focusPrice = p;
      ui.focusTs = finite(ts) ? ts : null;
      ui.dirty = true;
    }
  });
  el.addEventListener("pointerleave", () => {
    ui.focusPrice = null;
    ui.focusTs = null;
    ui.dirty = true;
  });
}

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
  ["chart-mode", "mode", "chartMode"],
]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ui[property] =
      attribute === "filter" || attribute === "mode"
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

$("chart-overlays").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-overlay]");
  if (!b) return;
  const key = b.dataset.overlay;
  ui.overlays[key] = !ui.overlays[key];
  b.classList.toggle("active", ui.overlays[key]);
  ui.dirty = true;
  if (ui.paused && ui.shown) {
    drawAll();
  }
});

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

const helpGroups = [
  { id: "core", label: "核心方向与状态指标" },
  { id: "events", label: "流动性与承接事件" },
  { id: "book", label: "盘口与防守结构" },
  { id: "aux", label: "辅助视图与数据质量" },
  { id: "visuals", label: "视觉符号与标记图鉴" },
];

const helpCatalog = {
  pressure: {
    group: "core",
    navLabel: "加权盘口失衡",
    navSub: "PRESSURE",
    title: "加权盘口失衡 · Pressure",
    code: "WEIGHTED BOOK IMBALANCE",
    badge: "范围 −100% ~ +100% · 前 12 档",
    shortQuestion:
      "附近 12 档被动挂单中，买方（Bid）和卖方（Ask）谁的账面防线更厚？",
    shortFormula:
      "wᵢ = 1/√i (i=1…12)\nPressure = (Σ wᵢ·qᵢᵇ − Σ wᵢ·qᵢᵃ) / (Σ wᵢ·qᵢᵇ + Σ wᵢ·qᵢᵃ)",
    question:
      "回答 <strong>“当前距离市价最近的被动挂单中，买方和卖方谁的账面力量更厚？”</strong> 仅看买一/卖一极易被单次小额挂撤单干扰；把前 12 档纳入计算并按档位距离递减权重，能更稳健地刻画近端被动流动性的整体偏向。",
    formula:
      "wᵢ = 1 / √i  (i = 1, 2, …, 12)<br>B_w = Σ wᵢ · qᵢᵇ,   A_w = Σ wᵢ · qᵢᵃ<br>Pressure = (B_w − A_w) / (B_w + A_w)",
    example:
      "<b>算例</b>：第 1 档权重 1.00、第 4 档 0.50、第 12 档约 0.29。若加权买量 B_w = 30 BTC、加权卖量 A_w = 10 BTC，则 Pressure = (30 − 10) / (30 + 10) = <b>+50.0%</b>。",
    signals: [
      [
        "positive",
        "> +10% · BID 占优",
        "近端买盘挂单明显厚于卖盘，下方账面支撑较强。",
      ],
      [
        "negative",
        "< −10% · ASK 占优",
        "近端卖盘挂单明显厚于买盘，上方账面压制较重。",
      ],
      ["neutral", "−10% ~ +10% · 均衡", "买卖两侧近端挂单规模基本相当。"],
    ],
    caveats:
      "<strong>警惕假墙（Spoofing）与撤单</strong>：盘口挂单只是“未成交的意愿”，大额买单随时可以撤走，也可能被大额主动卖单直接砸穿。此外权重基于<strong>档位排名</strong>而非绝对价格距离。看到 Pressure 偏正时，必须结合 <strong>Delta（主动成交）</strong> 与 <strong>Absorption（吸收强度）</strong> 验证买盘是否在真实承接。",
  },
  delta: {
    group: "core",
    navLabel: "主动成交净额",
    navSub: "DELTA / TFI",
    title: "主动成交净额 · Trade Delta & TFI",
    code: "AGGRESSIVE ORDER FLOW",
    badge: "1s / 5s / 10s · 报价币金额",
    shortQuestion:
      "最近真正动手用市价单“扫货”或“砸盘”的资金，净买入和净卖出了多少？",
    shortFormula:
      "Delta(W) = 主动买入金额 − 主动卖出金额\nBuyShare = 买额 / 总成交额,  TFI = 2×BuyShare − 1",
    question:
      "回答 <strong>“最近真正发起进攻的市价单，到底偏向买入还是卖出？规模有多大？”</strong> 盘口挂单只代表静态防守姿态，而主动成交（Order Flow）代表已经发生的真金白银交火，用于判断进攻方向以及进攻是否顺利推动了价格。",
    formula:
      "V_buy(W) = Σ pₖ·qₖ (主动买),   V_sell(W) = Σ pₖ·qₖ (主动卖)<br>Delta(W) = V_buy(W) − V_sell(W)<br>BuyShare = V_buy / (V_buy + V_sell),   TFI = (V_buy − V_sell) / (V_buy + V_sell)",
    example:
      "<b>算例</b>：5 秒内主动买入 80 万 USDT、主动卖出 20 万 USDT，则 <b>Delta = +600K USDT</b>，买入占比 <b>BuyShare = 80.0%</b>，归一化成交失衡 <b>TFI = +0.60</b>（范围 −1 ~ +1）。",
    signals: [
      [
        "positive",
        "Delta > 0 且价格上涨",
        "主动买盘有效消耗上方卖单，顺利向上推进价格。",
      ],
      [
        "amber",
        "Delta > 0 但价格不涨",
        "买方猛烈扫货却推不动价格，说明上方存在强力被动卖单吸收（Ask 承接/冰山单）。",
      ],
      [
        "negative",
        "Delta < 0 但价格不跌",
        "卖方猛烈砸盘却砸不穿，说明下方存在强力被动买单承接（Bid 承接）。",
      ],
    ],
    caveats:
      "<strong>方向映射与去重</strong>：基于 Binance <code>@trade</code> 原始逐笔流（<code>m=true</code> 代表买方为挂单 Maker，因此主动方为卖方），按成交 ID 严格去重。若检测到成交 ID 跳号缺口，系统会自动清空窗口并重新预热；窗口未满时显示预热状态，绝不拿残缺窗口当作 0 输出。",
  },
  rotation: {
    group: "core",
    navLabel: "压力变化",
    navSub: "ROTATION",
    title: "压力变化 · Rotation",
    code: "PRESSURE MOMENTUM",
    badge: "范围 −1 ~ +1 · 优势转移速率",
    shortQuestion: "当前的盘口挂单优势，正在加速增强还是正在悄悄流失？",
    shortFormula:
      "uₜ = ΔPressure / Δt,  Eᵘₜ = 0.97·Eᵘₜ₋₁ + 0.03·uₜ²\nRotation = EMA₀.₈ₛ( tanh( uₜ / (2√Eᵘₜ) ) )",
    question:
      "回答 <strong>“盘口控制权正在向哪一侧转移？转移速度有多快？”</strong> <code>Pressure</code> 只反映当前瞬间的静态厚度对比，而 <code>Rotation</code> 捕捉优势的边际变化——例如当买盘虽仍占优（Pressure > 0），但正被快速消耗或撤退时，Rotation 会率先转负预警。",
    formula:
      "Δt = clamp(tₜ − tₜ₋₁, 0.05s, 2.0s),   uₜ = (Pressureₜ − Pressureₜ₋₁) / Δt<br>Eᵘₜ = 0.97 · Eᵘₜ₋₁ + 0.03 · uₜ²<br>Rotationₜ = Rotationₜ₋₁ + (1 − e^(−Δt/0.8)) · [tanh(uₜ / (2√Eᵘₜ)) − Rotationₜ₋₁]",
    example:
      "<b>算例</b>：若 Pressure 从 +60% 快速滑落至 +25%，虽然买方账面仍厚于卖方（Pressure 仍为正），但压力变化率 uₜ 显著为负，<b>Rotation 会跌至 −0.50 以下</b>，提示“买盘优势正在快速瓦解”。",
    signals: [
      [
        "positive",
        "> +0.03 · 向 BID 转移",
        "近端买盘正在增厚，或卖盘挂单正在撤退/被吃掉。",
      ],
      [
        "negative",
        "< −0.03 · 向 ASK 转移",
        "近端卖压正在加重，或买盘支撑正在减弱/撤离。",
      ],
      [
        "lavender",
        "|Rotation| 接近 1",
        "相对近期波动尺度，盘口挂单结构正在发生剧烈切换。",
      ],
    ],
    caveats:
      "<strong>挂单变化 ≠ 价格动量</strong>：Rotation 衡量的是被动挂单结构的变化率，并非价格涨跌速度或主动买卖流。买侧优势丢失既可能因为被主动卖单砸穿，也可能因为买方主动撤单，需结合 <code>Delta</code> 与 <code>Replenishment</code> 区分。",
  },
  volatility: {
    group: "core",
    navLabel: "波动扩张",
    navSub: "VOL EXPANSION",
    title: "波动扩张 · Volatility Expansion & σ",
    code: "REGIME INSTABILITY",
    badge: "范围 −1 ~ +1 · 20 步对数收益",
    shortQuestion:
      "短期价格状态是否正在变得剧烈动荡？当前盘口挂单环境是否容易失稳？",
    shortFormula:
      "σₜ = std(ln(mᵢ/mᵢ₋₁)) (最近20步未年化)\nVolExpansion = EMA₀.₈ₛ( tanh( (Δσ/Δt) / (2√Eᵛₜ) ) )",
    question:
      "回答 <strong>“市场短期波动率是在急剧放大，还是在收敛平息？”</strong> 同样的盘口挂单厚度，在平静市场中是可靠支撑，但在波动急剧扩张期极易被瞬间扫穿。该指标提供环境风险背景，避免把动荡期的静态挂单当成稳固承接。",
    formula:
      "rᵢ = ln(mᵢ / mᵢ₋₁),   σₜ = √[ (1/n) · Σ(rᵢ − r̄)² ]  (最多 20 个对数收益)<br>vₜ = (σₜ − σₜ₋₁) / Δt,   Eᵛₜ = 0.97 · Eᵛₜ₋₁ + 0.03 · vₜ²<br>VolExpansionₜ = EMA₀.₈ₛ( tanh( vₜ / (2√Eᵛₜ) ) )",
    example:
      "<b>算例</b>：卡片下方 <code>σ</code> 直接显示当前短期波动率绝对水平（换算为 bp = 万分之一）；主数字显示波动率变化趋势：正值代表波动正在加速放大，负值代表市场回归平静。",
    signals: [
      [
        "amber",
        "> +0.03 · 波动扩张",
        "短期价格跳动幅度加速放大，盘口挂单更容易被击穿或频繁撤单。",
      ],
      [
        "lavender",
        "< −0.03 · 波动收缩",
        "剧烈波动正在平息，盘口挂单结构的稳定性上升。",
      ],
      [
        "neutral",
        "≈ 0 · 变化平缓",
        "波动率变化较小（注意：若 σ 本身很高但保持恒定，扩张分数也接近 0，需同时看 σ）。",
      ],
    ],
    caveats:
      "<strong>结合绝对波动率 σ 观察</strong>：当扩张分数与 <code>|Rotation|</code> 同时升高时，往往意味着价格剧烈摆动且盘口控制力快速易手。数据断流重连后会自动重置预热，不会把断流跳空误算为暴涨暴跌。",
  },
  absorption: {
    group: "events",
    navLabel: "吸收强度",
    navSub: "ABSORPTION",
    title: "吸收强度 · Absorption",
    code: "PASSIVE ABSORPTION",
    badge: "确认门槛 ≥ 0.70× · 3s 窗口",
    shortQuestion:
      "大量主动市价单砸向某价位时，被动挂单是在真金白银硬扛承接，还是瞬间被击穿？",
    shortFormula:
      "Absorption = 3s窗口内该价位主动攻击成交量 V_attack / 受攻击前初始可见量 Q₀",
    question:
      "回答 <strong>“某个挂单大墙在遭遇真实市价单进攻时，是否真的在承接对手盘？”</strong> 单纯看盘口挂单很容易被假墙欺骗，而吸收事件证明该价位<strong>已经承受了大量真实成交轰炸且依然没有失守</strong>，是识别主力被动建仓/出货的核心证据。",
    formula:
      "Absorption = V_attack,p / Q₀,p   (3 秒攻击窗口)<br>确认条件：① Q₀ ≥ 有意义规模 M；② Absorption ≥ 0.70×；③ 确认时该价位仍有剩余可见挂单",
    example:
      "<b>算例</b>：某买档受攻击前最近可见量为 <code>Q₀ = 10 BTC</code>，随后 3 秒内主动卖单在该价位成交了 <code>25 BTC</code>，且该买档仍未破位，则 <b>Absorption = 25 / 10 = 2.5×</b>（分数 > 1× 说明期间边挨打边补单）。",
    signals: [
      [
        "positive",
        "BID 承接 (绿标)",
        "被动买方在该价位大量吃下主动卖单抛压（下方强支撑承接）。",
      ],
      [
        "negative",
        "ASK 承接 (红标)",
        "被动卖方在该价位大量拦截主动买单扫货（上方强阻力压制）。",
      ],
      [
        "amber",
        "吸收比 ≥ 1.5×",
        "高强度吸收：实际吃下的攻击量远超初始挂单，防守方持续补单死守。",
      ],
    ],
    caveats:
      "<strong>高吸收比 ≠ 100% 永远守住</strong>：它只证明“过去 3 秒内该价位扛住了高强度进攻且暂未破位”。如果对手盘继续加码而防守方停止补单，防线仍可能失守。因此必须结合右侧 <strong>1s / 5s / 15s 价格反应</strong> 与 <strong>补单强度</strong> 综合判断。",
  },
  reload: {
    group: "events",
    navLabel: "补单与重复补量",
    navSub: "REPLENISHMENT",
    title: "补单强度与重复补量 · Replenishment",
    code: "RELOAD & ICEBERG BEHAVIOR",
    badge: "补量比 ≥ 0.5× 且 ≥ 2 次 → 重复补量",
    shortQuestion:
      "挂单被主动成交消耗后，防守方是否立刻把单子补回来（类冰山单行为）？",
    shortFormula:
      "ε_Q = max(2.5%·Q_peak, 5%·M)\nReplenishRatio = 攻击窗口内有效净加单总量 R_reload / 初始量 Q₀",
    question:
      "回答 <strong>“防守方在挂单被吃掉后，是否在持续补充弹药？”</strong> 相比一次性亮出底牌的大挂单，大资金或算法（如冰山单 Iceberg）更喜欢挂中等规模单子，<strong>每被吃掉一部分就立即补回</strong>。补单强度专门捕捉这种持续供给能力。",
    formula:
      "有意义门槛 M = 0.5 × median_upper(全盘口档位数量)<br>有效加单容差 ε_Q = max(2.5% × Q_peak, 5% × M, ε_machine)<br>ReplenishRatio = Σ(Qₜ − Qₜ₋₁) [仅计入 > ε_Q 的有效增加] / Q₀",
    example:
      "<b>算例</b>：初始挂单 <code>10 BTC</code>，3s 攻击窗口内观察到 2 次超过容差的净加单（<code>+3 BTC</code> 与 <code>+4 BTC</code>），则补量次数 <code>= 2</code>，<b>补量比 = (3+4)/10 = 0.7×</b>。同时满足吸收条件、次数 ≥ 2、补量比 ≥ 0.5× 时，触发琥珀色 <b>「补量 / ◎ 重复补量」</b> 标记。",
    signals: [
      [
        "amber",
        "重复补量 (补量比≥0.5× 且 ≥2次)",
        "典型类冰山算法承接形态：边被消耗边分批补回，防守意愿极强。",
      ],
      [
        "positive",
        "高补量比 + 价格反弹",
        "被动方补单成功耗尽对手盘进攻动能，推动价格反向运动。",
      ],
      [
        "neutral",
        "次数高但补量比极低",
        "仅为小额零散刷新，实际补充的流动性规模有限。",
      ],
    ],
    caveats:
      "<strong>可见净增加的物理边界</strong>：统计基于 100ms 深度快照间的净增加量；若同一 100ms 内“成交消耗 5 BTC”与“新补入 5 BTC”完全抵消，快照净变化为 0 会漏计。此外，它代表反复补量的行为形态，不能直接测算底层隐藏订单的剩余总量。",
  },
  returns: {
    group: "events",
    navLabel: "事件后价格反应",
    navSub: "1S / 5S / 15S BP",
    title: "事件后价格反应 · Post-Event Returns",
    code: "PRICE REACTION VERIFICATION",
    badge: "单位 bp (1 bp = 0.01%) · 延迟填充",
    shortQuestion:
      "承接事件确认后 1秒、5秒、15秒，市场价格究竟是顺着防守方向反弹，还是被砸穿？",
    shortFormula:
      "Return_bps(h) = 10000 × ln( mid(t_confirm + h) / mid(t_confirm) ),  h ∈ {1s, 5s, 15s}",
    question:
      "回答 <strong>“这波被动承接最终成功了吗？”</strong> 吸收和补单只说明防守方投入了兵力，而事件发生后 1s / 5s / 15s 的实际价格变化，是检验防线是否真正守住、进攻方是否力竭的客观试金石。",
    formula:
      "Return_bps(h) = 10000 × ln( mid_{t₀ + h} / mid_{t₀} )<br>其中 t₀ 为事件确认时刻，h 分别为 1s、5s、15s（1 bp = 0.01% 价格变化）",
    example:
      "<b>算例</b>：在 <code>100,000 USDT</code> 确认一笔 <code>BID 承接</code>，5 秒后中间价涨至 <code>100,050 USDT</code>，则 5s 价格反应为 <b>+5.00 bp</b>（绿色），验证买方防守成功并开启反弹。",
    signals: [
      [
        "positive",
        "绿色正值 (+bp)",
        "确认后中间价上涨：对 BID 承接代表支撑有效反弹；对 ASK 承接代表防线被突破上行。",
      ],
      [
        "negative",
        "红色负值 (−bp)",
        "确认后中间价下跌：对 ASK 承接代表压制有效回落；对 BID 承接代表支撑失守下破。",
      ],
      [
        "neutral",
        "显示 — (未到期)",
        "事件刚刚发生，尚未走完对应的 1s / 5s / 15s 验证时间窗口。",
      ],
    ],
    caveats:
      "<strong>无未来函数</strong>：所有反应数值均在真实时间到达 <code>t₀ + 1s/5s/15s</code> 后才实时回填，绝不使用未来价格提前筛选事件。",
  },
  defense: {
    group: "book",
    navLabel: "防守热度与防守墙",
    navSub: "DEFENSE HEAT",
    title: "防守热度与 120 档防守墙 · Defense Heat",
    code: "LEVEL LIFECYCLE & PERSISTENCE",
    badge: "0 ~ 100 分 · 存续40% + 刷新40% + 保留20%",
    shortQuestion:
      "面对数量相同的两档挂单，哪一档是“一闪而过的假单”，哪一档是“长期驻守并反复补量的真防线”？",
    shortFormula:
      "Heat = 0.4×clamp(存续/60s,0,1) + 0.4×clamp(刷新/6,0,1) + 0.2×clamp(当前量/峰值量,0,1)",
    question:
      "回答 <strong>“这档挂单在盘口里驻守了多久？有没有反复维护补量？”</strong> 静态订单簿看不出时间维度；Defense Heat 综合<strong>存续时长（Age）</strong>、<strong>有效刷新次数（Refresh）</strong>和<strong>峰值保留率（Retention）</strong>，把真正长期驻守的核心墙从闪烁噪音中分离出来。",
    formula:
      "Age = clamp(age_s / 60s, 0, 1),   Refresh = clamp(refresh_count / 6, 0, 1)<br>Retention = clamp(Q_current / Q_peak, 0, 1)<br>DefenseHeat = (0.4 × Age + 0.4 × Refresh + 0.2 × Retention) × 100",
    example:
      "<b>算例</b>：某买档已连续存在 <code>30s</code>（Age = 0.5）、期间有效刷新补量 <code>3 次</code>（Refresh = 0.5）、当前挂单量仍保留历史峰值的 <code>80%</code>（Retention = 0.8），则热度 = <b>(0.4×0.5 + 0.4×0.5 + 0.2×0.8) × 100 = 56 分</b>。",
    signals: [
      [
        "amber",
        "热度 ≥ 60 (高热防线)",
        "长期驻守、多次补充且规模完好的核心价位（盘口热度分呈琥珀色高亮）。",
      ],
      [
        "positive",
        "120 档核心防守墙 (Top 12)",
        "扫描买卖各前 120 档，提前锁定尚未进入前 20 档的远端高热大墙。",
      ],
      [
        "neutral",
        "热度 · 或 0",
        "挂单量低于有意义门槛，或刚挂出不久、尚未经历时间与刷新检验。",
      ],
    ],
    caveats:
      "<strong>历史背景 vs 实战交火</strong>：某档位短暂消失后 <strong>2 秒内</strong>重现会延续原生命周期；移除超 15 秒则清空。注意：远离现价、从未被成交测试过的挂单也能靠挂满 60 秒获得约 60 分热度，因此应重点关注<strong>靠近现价且配合吸收事件</strong>的高热度价位。",
  },
  depth: {
    group: "book",
    navLabel: "近价流动性深度",
    navSub: "1 BP / 5 BP DEPTH",
    title: "近价流动性深度 · 1 bp / 5 bp Depth",
    code: "NEAR-TOUCH LIQUIDITY",
    badge: "0 ~ 20 bp 累计曲线 · 名义金额",
    shortQuestion:
      "距离当前中间价极近的 0.01% (1 bp) 和 0.05% (5 bp) 范围内，究竟摆了多少真金白银的承接盘？",
    shortFormula:
      "Bid范围 ≥ mid×(1 − d/10000),  Ask范围 ≤ mid×(1 + d/10000)\n名义深度金额 = 范围内累计基础币数量 × 中间价 mid",
    question:
      "回答 <strong>“当前市价往上下推动 1 bp 或 5 bp，需要吃掉多少金额的挂单？”</strong> <code>Pressure</code> 只反映买卖相对比例（买 1 BTC vs 卖 0.1 BTC 与买 100 BTC vs 卖 10 BTC 的失衡度相同），而近价深度补上了<strong>绝对资金厚度</strong>，衡量盘口抗冲击能力。",
    formula:
      "Q_bid(d) = Σ qᵢᵇ  (满足 bᵢ ≥ mid × (1 − d/10⁴))<br>Q_ask(d) = Σ qᵢᵃ  (满足 aᵢ ≤ mid × (1 + d/10⁴))<br>D_bid(d) = mid × Q_bid(d),   D_ask(d) = mid × Q_ask(d)  (d ∈ {1, 5} bp)",
    example:
      "<b>算例</b>：BTC 中间价为 <code>100,000 USDT</code> 时，<code>1 bp (0.01%)</code> 对应上下 <code>10 USDT</code>（即 <code>99,990 ~ 100,010</code>）。若该区间内买单共 5 BTC、卖单共 2 BTC，则 1 bp 深度为 <b>500K USDT / 200K USDT</b>。",
    signals: [
      [
        "positive",
        "BID 远厚于 ASK",
        "下方近端垫单扎实，上方卖盘稀疏，同等资金量更容易向上推升价格。",
      ],
      [
        "amber",
        "1 bp 极薄但 5 bp 极厚",
        "最前排买一/卖一容易出现小幅快速滑点，但稍远处有厚墙拦截。",
      ],
      [
        "negative",
        "双侧近价深度均极薄",
        "流动性真空：小额市价单或撤单即可引发价格剧烈跳动。",
      ],
    ],
    caveats:
      "<strong>可信覆盖边界</strong>：本地维护最多 5000 档深度并严格记录可信价格边界。若行情剧烈波动导致快照边界未能完整覆盖 1/5 bp，右上角徽章会明确提示 <code>部分覆盖</code>，绝不把未同步区域当成 0 深度。",
  },
  phase: {
    group: "aux",
    navLabel: "压力相图",
    navSub: "PHASE SPACE",
    title: "压力相图 · Phase Space",
    code: "PRESSURE × ROTATION TRAJECTORY",
    badge: "横轴 Pressure × 纵轴 Rotation · 60s",
    shortQuestion:
      "如何在一张二维图上同时看清“当前谁占优（X轴）”与“优势正在往哪边转（Y轴）”？",
    shortFormula:
      "横轴 X = Pressure (−1 卖优 ↔ +1 买优)\n纵轴 Y = Rotation (−1 转卖 ↔ +1 转买)",
    question:
      "回答 <strong>“过去 60 秒内，盘口力量是如何演化和轮动的？”</strong> 将静态失衡（Pressure）与动态变化率（Rotation）合成为二维相空间轨迹，一眼识别买盘强化、高位衰竭、卖盘强化与底部企稳四个阶段。",
    formula:
      "Point(t) = ( X: Pressureₜ ∈ [−1, 1],  Y: Rotationₜ ∈ [−1, 1] )<br>保留最近 60 秒采样轨迹，最新状态以高亮圆点标记，历史轨迹随时间淡出",
    example:
      "<b>象限解读</b>：圆点位于<strong>右上象限</strong>代表买方既占优且优势仍在扩大；当圆点从右上滑向<strong>右下象限</strong>，代表买盘虽仍厚但优势正在快速流失。",
    signals: [
      [
        "positive",
        "右上象限 (P>0, R>0)",
        "买侧优势增强：买盘挂单占优，且力量仍在向买方聚集。",
      ],
      [
        "amber",
        "右下象限 (P>0, R<0)",
        "买侧优势衰减：买盘账面仍厚，但正在被消耗或主动撤退。",
      ],
      [
        "negative",
        "左下象限 (P<0, R<0)",
        "卖侧优势增强：卖盘压制占优，且卖压仍在继续加码。",
      ],
      [
        "lavender",
        "左上象限 (P<0, R>0)",
        "卖侧优势衰减：卖方虽仍占优，但买盘正在恢复或卖单正在撤离。",
      ],
    ],
    caveats:
      "<strong>状态可视化工具</strong>：相图是 Pressure 与 Rotation 的联合投影，用于直观观察盘口周期轮动，不构成独立于两者的额外计分项。",
  },
  quality: {
    group: "aux",
    navLabel: "数据有效性與质量",
    navSub: "DATA QUALITY",
    title: "数据有效性、价差与质量监控 · Data Quality",
    code: "INTEGRITY & LATENCY GUARDRAILS",
    badge: "REST+WS 序号衔接 · 实时监控",
    shortQuestion:
      "当前看到的盘口与成交指标是否建立在连续、无缺口、低延迟的可靠数据之上？",
    shortFormula:
      "买卖价差(bp) = 10000 × (Ask₁ − Bid₁) / Mid\n接收年龄 = 本地时间 − 最近收到深度时间",
    question:
      "回答 <strong>“此刻的指标数字可信吗？有没有发生丢包、断流或时序错乱？”</strong> 微观结构指标对订单簿序号断裂和逐笔成交漏单极其敏感；系统内置严格的完整性护栏，一旦数据失真立即挂起展示并告警。",
    formula:
      "SpreadBps = 10⁴ × (Ask₁ − Bid₁) / Mid<br>FeedAge = t_now − t_received,   SourceAge = t_now − t_exchange_event",
    example:
      "<b>未匹配盘口成交说明</b>：由于深度流为 100ms 切片而成交为实时逐笔流，若某笔成交到达时对应价位无可见挂单或盘口快照时间戳晚于该成交，则归入 <code>未匹配盘口成交</code>——<strong>它们仍 100% 计入 Delta 与主动成交流</strong>，仅不用于触发单价位吸收事件，防止误判。",
    signals: [
      [
        "positive",
        "序列连续 · 深度覆盖完整",
        "增量深度序号严格连续，1/5 bp 区间完全在 5000 档可信边界内。",
      ],
      [
        "amber",
        "未匹配盘口成交 > 0",
        "100ms 深度更新与逐笔成交存在微秒级时序差，属正常高频现象，不影响 Delta。",
      ],
      [
        "negative",
        "成交缺口 / 自动重连",
        "检测到成交 ID 跳号或深度断流 > 3s，自动清空关联窗口并重新预热。",
      ],
    ],
    caveats:
      "<strong>失效保护机制</strong>：当超过 3 秒未收到深度更新、源延迟超过 5 秒或本机时钟偏差过大时，所有核心指标会自动停止显示（置为 <code>—</code>），绝不展示过期或虚假的 0 值。",
  },
  visuals: {
    group: "visuals",
    navLabel: "视觉符号与标记图鉴",
    navSub: "VISUAL LEGEND",
    title: "主图与盘口视觉符号图鉴 · Visual Legend",
    code: "CHART OVERLAYS & ORDER BOOK BADGES",
    badge: "K线主图图层 + 订单簿内嵌徽章",
    shortQuestion:
      "K 线主图上的防守虚线、菱形、琥珀色光环，以及订单簿里的 吸/补/↻ 徽章分别代表什么？",
    shortFormula:
      "🛡 防守线 = 高热大单墙 | ◆ 承接点 = 吸收≥0.7× | ◎ 外圈 = 重复补量 | 吸/补/↻ = 实时档位状态",
    customBody: `
      <div class="visual-guide-list">
        <div class="visual-guide-row">
          <div class="vg-preview">
            <span class="vg-wall-demo">🛡BID 热度78 · 12.4 ↻3</span>
          </div>
          <div class="vg-meta">
            <b>K 线主图 · 防守热力线</b>
            <small>图层：🛡 防守线 (Top 3/侧)</small>
          </div>
          <div class="vg-desc">
            从买卖各前 120 档中筛选<strong>挂单量达标且防守热度 ≥ 45</strong> 的核心防守墙。<strong>贯穿虚线</strong>标出防守价位；<strong>右侧水平色柱长度</strong>代表当前挂单量大小，<strong>颜色不透明度与数字</strong>代表防守热度（0–100）。若最强防守墙在当前视野外，主图上下边缘会自动浮现 <code>▲ 上方防守墙</code> / <code>▼ 下方防守墙</code> 提示。
          </div>
        </div>
        <div class="visual-guide-row">
          <div class="vg-preview">
            <span class="vg-diamond-demo">◆ B吸1.6×</span>
          </div>
          <div class="vg-meta">
            <b>K 线主图 · 已确认承接点</b>
            <small>图层：◆ 承接点 (Absorption)</small>
          </div>
          <div class="vg-desc">
            当某价位在 3 秒内扛住主动攻击且<strong>吸收比 ≥ 0.70×、确认时仍未破位</strong>，在 K 线对应时间与价格处绘制实心菱形（<span class="positive">绿色 = Bid 买方承接卖压</span>，<span class="negative">红色 = Ask 卖方拦截买盘</span>）。菱形尺寸随吸收倍数放大，并向下连接至底部 Pressure 曲线。
          </div>
        </div>
        <div class="visual-guide-row">
          <div class="vg-preview">
            <span class="vg-reload-ring">◎ B吸2.1×·补</span>
          </div>
          <div class="vg-meta">
            <b>K 线主图 · 重复补量光环</b>
            <small>类冰山承接 (Repeated Reload)</small>
          </div>
          <div class="vg-desc">
            在确认吸收的基础上，若 3 秒攻击窗口内<strong>有效补单次数 ≥ 2 次且补量比 ≥ 0.5×</strong>，菱形外围会额外套上一圈<strong>琥珀色光环 ◎</strong> 且标签附带 <code>·补</code>，代表主力在该价位边被消耗边反复补单，属最高级别防守信号。
          </div>
        </div>
        <div class="visual-guide-row">
          <div class="vg-preview">
            <span class="vg-wall-demo" style="font-weight:600;color:#e6f0f5">左边框高亮 + 亮白粗体数量</span>
          </div>
          <div class="vg-meta">
            <b>实时订单簿 · 核心墙与巨单</b>
            <small>is-wall & Whale Size</small>
          </div>
          <div class="vg-desc">
            订单簿某行左侧出现<strong>绿色/红色竖条边框</strong>，代表该档位热度 ≥ 55 或入选全市场 Top 12 防守墙；挂单数量呈<strong>亮白色加粗</strong>（Whale）代表该档数量 ≥ 当前可见盘口均值的 <code>1.8 倍</code>。鼠标悬停任意盘口行或事件行，K 线主图会同步以琥珀色虚线标出该价位。
          </div>
        </div>
        <div class="visual-guide-row">
          <div class="vg-preview">
            <span class="lvl-badge absorb">吸1.4×</span>
            <span class="lvl-badge reload">补×2</span>
            <span class="lvl-badge refresh">↻4</span>
          </div>
          <div class="vg-meta">
            <b>实时订单簿 · 档位行为徽章</b>
            <small>防守热度 / 承接列</small>
          </div>
          <div class="vg-desc">
            <strong><code>吸1.4×</code></strong>：该档位正在或刚刚承受主动攻击，吸收比达 1.4 倍（≥ 0.45× 即实时亮起）；<br>
            <strong><code>补×2</code></strong>：本轮 3 秒攻击窗口内已观察到 2 次有效净补单；<br>
            <strong><code>↻4</code> + 进度条 + 数字</strong>：该价位生命周期内的累计刷新次数与综合防守热度分（0–100，≥ 60 分呈琥珀色高亮）。
          </div>
        </div>
      </div>
    `,
    signals: [
      [
        "positive",
        "🛡 防守线 + ◆ 承接点重叠",
        "长期驻守的高热度大墙正在经受真实市价单考验并成功承接，支撑/阻力极强。",
      ],
      [
        "amber",
        "◎ 琥珀色外圈 / 补×N",
        "被动方在交火中反复补回流动性（类冰山单），重点观察随后 5s/15s 价格反应。",
      ],
    ],
  },
};

const hoverExtras = {
  tfi: {
    targetKey: "delta",
    title: "成交失衡指数 · TFI",
    badge: "范围 −1.00 ~ +1.00",
    shortQuestion:
      "将主动买卖净额归一化为 −1 到 +1 的比例，方便跨币种、跨时段对比进攻单边程度。",
    shortFormula:
      "TFI = (主动买额 − 主动卖额) / (主动买额 + 主动卖额) = 2 × BuyShare − 1",
    signals: [
      [
        "positive",
        "TFI > +0.30",
        "主动买盘显著主导近期成交（买入占比 > 65%）。",
      ],
      [
        "negative",
        "TFI < −0.30",
        "主动卖盘显著主导近期成交（卖出占比 > 65%）。",
      ],
      ["neutral", "TFI ≈ 0", "近期主动买单与主动卖单金额基本势均力敌。"],
    ],
  },
  overlay_defense: {
    targetKey: "visuals",
    title: "主图图层 · 🛡 防守热力墙",
    badge: "前 120 档 Top 3/侧",
    shortQuestion:
      "在 K 线图上直接标出上方最硬的卖压墙与下方最厚的买盘支撑墙。",
    shortFormula:
      "筛选条件：前120档中有意义档位 且 防守热度 ≥ 45\n右侧色柱长度 ∝ 当前挂单量，亮度 ∝ 防守热度",
    signals: [
      [
        "positive",
        "绿色虚线 + 右侧绿柱",
        "下方高热度 Bid 买盘防守墙（标注热度分、挂单量与 ↻ 刷新次数）。",
      ],
      [
        "negative",
        "红色虚线 + 右侧红柱",
        "上方高热度 Ask 卖盘防守墙；视野外强墙会在图顶/图底显示 ▲/▼ 提示。",
      ],
    ],
  },
  overlay_events: {
    targetKey: "visuals",
    title: "主图图层 · ◆ 承接点与 ◎ 重复补量",
    badge: "确认吸收 ≥ 0.70×",
    shortQuestion:
      "在 K 线发生交火的精确时间与价位上，标出真金白银扛住市价单进攻的承接位置。",
    shortFormula:
      "◆ 实心菱形 = 已确认吸收事件 (尺寸 ∝ 吸收比)\n◎ 琥珀色外圈 = 3s内补单 ≥ 2次 且 补量比 ≥ 0.5×",
    signals: [
      [
        "positive",
        "绿色 ◆ (如 B吸1.5×)",
        "被动买单在此价位成功吃下大量主动卖盘且未破位。",
      ],
      [
        "negative",
        "红色 ◆ (如 A吸1.8×)",
        "被动卖单在此价位成功拦截大量主动买盘且未破位。",
      ],
      [
        "amber",
        "外圈琥珀色环 ◎ (带 ·补)",
        "防守方边挨打边多次补单（类冰山行为），防守强度最高。",
      ],
    ],
  },
  book_badges: {
    targetKey: "visuals",
    title: "盘口内嵌标记 · 热度与承接徽章",
    badge: "实时 20 档微观状态",
    shortQuestion:
      "无需离开订单簿，直接识别哪一档是长期驻守的真墙、哪一档正在挨打承接或补单。",
    shortFormula:
      "吸X.X× (吸收比≥0.45) | 补×N (攻击期补单) | ↻N (生命周期刷新) | 0~100 (防守热度)",
    signals: [
      [
        "positive",
        "吸1.2× / 补×2",
        "该档位正在承受主动市价单攻击，或已在交火中补充挂单。",
      ],
      [
        "amber",
        "热度分 ≥ 60 (琥珀色)",
        "存续久、刷新多、保留率高的核心防线（行左侧同步亮起竖条边框）。",
      ],
    ],
  },
  spread: {
    targetKey: "quality",
    title: "买卖价差 · Spread (bp)",
    badge: "1 bp = 0.01% = 万分之一",
    shortQuestion:
      "当前最优卖一价（Ask₁）与最优买一价（Bid₁）之间的相对宽度，反映盘口即时摩擦成本。",
    shortFormula: "Spread (bp) = 10000 × (Ask₁ − Bid₁) / Mid",
    signals: [
      ["positive", "价差极窄 (< 0.5 bp)", "流动性极佳，买卖盘紧密咬合。"],
      [
        "amber",
        "价差突然拉宽",
        "前排挂单被瞬间扫空或做市商紧急撤单避险，短期波动往往加剧。",
      ],
    ],
  },
  feed_age: {
    targetKey: "quality",
    title: "接收年龄与源时间差 · Feed & Source Age",
    badge: "毫秒级实时性监控",
    shortQuestion:
      "监控当前画面数据距离最近一次收到推送、以及距离交易所撮合引擎出单过了多少毫秒。",
    shortFormula:
      "接收年龄 = 本地当前时间 − 最近收到深度包时间\n源时间差 = 本地当前时间 − 交易所事件时间 E",
    signals: [
      ["positive", "几毫秒 ~ 数十毫秒", "数据流实时同步健康。"],
      [
        "negative",
        "接收年龄 > 3000 ms",
        "深度流断流超时，系统将自动暂停展示过期指标并重连。",
      ],
    ],
  },
  unmatched: {
    targetKey: "quality",
    title: "未匹配盘口成交 · Unmatched Trades",
    badge: "时序严谨性保护",
    shortQuestion: "为什么会有成交未匹配到盘口档位？这会影响 Delta 统计吗？",
    shortFormula:
      "触发原因：100ms 深度切片与逐笔成交存在微小到达时序差，成交时该价位无历史可见量 Q₀",
    signals: [
      [
        "positive",
        "100% 计入 Delta",
        "所有未匹配成交依然完整计入主动成交净额（Delta / TFI / 成交流）。",
      ],
      [
        "amber",
        "不虚构吸收事件",
        "为防止用成交之后的未来挂单去倒推吸收比，此类成交不参与单价位吸收计算。",
      ],
    ],
  },
};

function renderHelpCard(key) {
  const item = helpCatalog[key];
  if (!item) return "";
  const signalsHtml = (item.signals ?? [])
    .map(
      ([toneName, pill, desc]) =>
        `<div class="signal-item"><span class="signal-pill ${toneName}">${esc(pill)}</span><span>${desc}</span></div>`,
    )
    .join("");
  if (item.customBody) {
    return `
      <article class="help-card" id="help-card-${key}" data-card-key="${key}">
        <div class="help-card-head">
          <h4>${esc(item.title)} <small>${esc(item.code)}</small></h4>
          <span class="help-badge">${esc(item.badge)}</span>
        </div>
        ${item.customBody}
      </article>
    `;
  }
  return `
    <article class="help-card" id="help-card-${key}" data-card-key="${key}">
      <div class="help-card-head">
        <h4>${esc(item.title)} <small>${esc(item.code)}</small></h4>
        <span class="help-badge">${esc(item.badge)}</span>
      </div>
      <div class="help-grid">
        <div class="help-block question">
          <div class="help-block-title"><i></i>说明什么问题（核心用途）</div>
          <p>${item.question}</p>
        </div>
        <div class="help-block formula">
          <div class="help-block-title"><i></i>计算方式（公式与口径）</div>
          <div class="formula-box">${item.formula}</div>
          ${item.example ? `<div class="example-box">${item.example}</div>` : ""}
        </div>
        <div class="help-block signals">
          <div class="help-block-title"><i></i>数值与信号解读</div>
          <div class="signal-list">${signalsHtml}</div>
        </div>
        <div class="help-block caveats">
          <div class="help-block-title"><i></i>局限与实战排坑</div>
          <p>${item.caveats}</p>
        </div>
      </div>
    </article>
  `;
}

let helpInitialized = false;
function ensureHelpRendered() {
  if (helpInitialized) return;
  helpInitialized = true;
  const navHtml = helpGroups
    .map((g) => {
      const buttons = Object.entries(helpCatalog)
        .filter(([, v]) => v.group === g.id)
        .map(
          ([k, v]) =>
            `<button type="button" class="help-nav-btn" data-nav-key="${k}"><span>${esc(v.navLabel)}</span><small>${esc(v.navSub)}</small></button>`,
        )
        .join("");
      return `<div class="help-nav-group">${esc(g.label)}</div>${buttons}`;
    })
    .join("");
  html("help-nav", navHtml);

  const contentHtml =
    helpGroups
      .map((g) => {
        const cards = Object.keys(helpCatalog)
          .filter((k) => helpCatalog[k].group === g.id)
          .map(renderHelpCard)
          .join("");
        return `<div class="help-section-header"><h3>${esc(g.label)}</h3><span>点击左侧目录可快速跳转</span></div>${cards}`;
      })
      .join("") +
    `<div class="help-card">
      <div class="help-card-head">
        <h4>渲染架构与数据源说明 <small>ARCHITECTURE & PUBLIC STREAM</small></h4>
        <span class="help-badge">Rust 10Hz + Canvas</span>
      </div>
      <div class="help-block full">
        <p>后端使用 Rust 连续消费 Binance 现货公共 WebSocket（<code>@depth@100ms</code> 与 <code>@trade</code>），衔接 5000 档 REST 快照并在内存完成全部指标计算，最多以 10Hz（每 100ms）向前端广播最新状态快照。前端在 <code>requestAnimationFrame</code> 中批量更新固定 DOM 节点与 Canvas。支持<a href="https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams" target="_blank" rel="noreferrer">查阅 Binance 官方 WebSocket 数据文档 ↗</a>。</p>
      </div>
    </div>`;
  html("help-content", contentHtml);
}

function focusHelpKey(key, smooth = true) {
  const targetKey = helpCatalog[key]
    ? key
    : (hoverExtras[key]?.targetKey ?? null);
  text(
    "help-title",
    targetKey ? helpCatalog[targetKey].title : "微观结构指标与视觉标记手册",
  );
  document.querySelectorAll(".help-nav-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      b.dataset.navKey === (targetKey ?? "pressure"),
    );
  });
  document.querySelectorAll(".help-card").forEach((c) => {
    c.classList.toggle("is-target", c.dataset.cardKey === targetKey);
  });
  if (targetKey) {
    const card = $("help-card-" + targetKey);
    if (card) {
      card.scrollIntoView({
        behavior: smooth ? "smooth" : "instant",
        block: "start",
      });
    }
  } else {
    $("help-content").scrollTop = 0;
  }
}

function showHelp(key) {
  hideHelpPopover(true);
  ensureHelpRendered();
  const dialog = $("help-dialog");
  const alreadyOpen = dialog.open;
  if (!alreadyOpen) dialog.showModal();
  focusHelpKey(key, alreadyOpen);
}

$("help-nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-nav-key]");
  if (!btn) return;
  focusHelpKey(btn.dataset.navKey, true);
});

// Lightweight Hover Popover for non-intrusive live monitoring
const popover = $("help-popover");
let popShowTimer = 0;
let popHideTimer = 0;
let activeTrigger = null;

function getPopoverData(key) {
  if (hoverExtras[key]) return hoverExtras[key];
  const item = helpCatalog[key];
  if (!item) return null;
  return {
    targetKey: key,
    title: item.title,
    badge: item.badge,
    shortQuestion: item.shortQuestion,
    shortFormula: item.shortFormula,
    signals: item.signals?.slice(0, 3) ?? [],
  };
}

function renderPopover(key, anchorEl) {
  const data = getPopoverData(key);
  if (!data || $("help-dialog").open) return;
  const sigHtml = (data.signals ?? [])
    .map(([toneName, label, desc]) => {
      const cls =
        toneName === "positive"
          ? "positive"
          : toneName === "negative"
            ? "negative"
            : toneName === "amber"
              ? "amber-text"
              : "muted";
      return `<div class="pop-sig"><b class="${cls}">${esc(label)}</b><span>${esc(desc)}</span></div>`;
    })
    .join("");
  popover.innerHTML = `
    <div class="pop-head">
      <strong>${esc(data.title)}</strong>
      <span>${esc(data.badge)}</span>
    </div>
    <div class="pop-row">
      <span class="pop-label">🎯 说明什么问题</span>
      <div class="pop-question">${esc(data.shortQuestion)}</div>
    </div>
    <div class="pop-row">
      <span class="pop-label">🧮 计算方式</span>
      <div class="pop-formula">${esc(data.shortFormula).replace(/\n/g, "<br>")}</div>
    </div>
    ${sigHtml ? `<div class="pop-signals">${sigHtml}</div>` : ""}
    <div class="pop-foot">
      <span>悬停速查 · 不中断盯盘</span>
      <button type="button" class="pop-more" data-open-help="${esc(data.targetKey)}">查看完整算例与排坑指南 ↗</button>
    </div>
  `;
  popover.hidden = false;

  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 10;
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  left = Math.max(
    margin,
    Math.min(window.innerWidth - popRect.width - margin, left),
  );
  let top = rect.bottom + 8;
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popRect.height - 8);
  }
  popover.style.left = Math.round(left) + "px";
  popover.style.top = Math.round(top) + "px";
}

function hideHelpPopover(immediate = false) {
  clearTimeout(popShowTimer);
  clearTimeout(popHideTimer);
  if (immediate) {
    popover.hidden = true;
    activeTrigger = null;
    return;
  }
  popHideTimer = setTimeout(() => {
    popover.hidden = true;
    activeTrigger = null;
  }, 110);
}

for (const el of document.querySelectorAll(
  "[data-help-button], [data-help-hover]",
)) {
  const hoverKey = el.dataset.helpHover || el.dataset.helpButton;
  const clickKey = el.dataset.helpButton || el.dataset.helpHover;
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    clearTimeout(popHideTimer);
    if (activeTrigger === el && !popover.hidden) return;
    clearTimeout(popShowTimer);
    popShowTimer = setTimeout(() => {
      activeTrigger = el;
      renderPopover(hoverKey, el);
    }, 120);
  });
  el.addEventListener("pointerleave", () => {
    hideHelpPopover(false);
  });
  if (
    el.hasAttribute("data-help-button") &&
    !el.closest("button[data-overlay]")
  ) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showHelp(clickKey);
    });
  }
}

popover.addEventListener("pointerenter", () => {
  clearTimeout(popHideTimer);
});
popover.addEventListener("pointerleave", () => {
  hideHelpPopover(false);
});
popover.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-open-help]");
  if (btn) showHelp(btn.dataset.openHelp);
});
window.addEventListener("scroll", () => hideHelpPopover(true), {
  passive: true,
});

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
