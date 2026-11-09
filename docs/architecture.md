# 实现与接口

## 模块职责

| 文件 | 职责 |
|---|---|
| `src/main.rs` | Axum HTTP/WS、交易所注册、市场共享、重连、空闲回收、静态资产 |
| `src/exchange/mod.rs` | 可扩展的异步 Exchange 接口与标准消息 |
| `src/exchange/binance.rs` | 公共 REST、combined WS、快照期间缓冲、Ping/Pong、字段校验与转换 |
| `src/model.rs` | 交易对、快照、增量、原始成交、ticker，以及精确价位键 |
| `src/book.rs` | BTreeMap 订单簿、序号检查、覆盖边界、价位生命周期与攻击窗口 |
| `src/metrics.rs` | 全部八项指标、时间窗口、相空间、事件与延迟验证 |
| `src/recorder/mod.rs` | 录制配置、写盘线程、各市场非阻塞录制句柄、健康统计 |
| `src/recorder/format.rs` | 录制行格式（version 1）及与引擎输入之间的转换 |
| `src/recorder/writer.rs` | 按 UTC 小时滚动的 `jsonl.zst` 文件、独立 zstd 帧、`.part` 改名与磁盘故障恢复 |
| `web/app.js` | WS 客户端、交互状态、批量渲染、Canvas、导出和性能测量 |
| `web/style.css` | 自适应监控台样式 |

所有订单簿和指标状态只由同一个 Tokio 任务写入。上游读取任务通过容量 8,192 的通道交付归一化事件；不会在计算前主动采样或丢弃逐笔成交。慢订阅者只影响展示。初始快照缓冲上限为 50,000 条，超过上限会显式停止本轮同步。

开启录制的市场在把输入交给引擎之前，先用同一个本机时间值把它交给录制句柄，包括快照、深度、成交、ticker、每次出帧和连接状态。录制句柄只做非阻塞入队，压缩和文件 I/O 都在独立的写盘线程中完成。录制市场常驻运行，不参与空闲回收，并持续重连。

后端每 100ms 创建一次完整的当前指标帧，发送给 `watch` 通道。每市场每帧只序列化一次；每个客户端发送超时为 3 秒，避免积压。曲线每帧只传最近两个采样点，浏览器按时间戳去重；展示帧跳过时曲线可以稀疏，但不会改变后端指标计算。

## 数据来源

| 输入 | 接口 | 字段与转换 |
|---|---|---|
| 可交易现货列表 | `GET /api/v3/exchangeInfo?permissions=SPOT` | `symbol/status/baseAsset/quoteAsset/baseAssetPrecision/PRICE_FILTER.tickSize`；仅 `TRADING`；缓存 10 分钟 |
| 初始完整快照 | `GET /api/v3/depth?symbol=…&limit=5000` | `lastUpdateId/bids/asks`；记录已知最远边界 |
| L2 增量 | `<symbol>@depth@100ms` | `U/u/E/b/a`；数量为更新后的绝对值，零表示删除 |
| 原始逐笔成交 | `<symbol>@trade` | `t/T/p/q/m`；`buy = !m`，不用 `aggTrade` 冒充原始成交 |
| 市场概况 | `<symbol>@ticker` | `c/P/h/l/q` → 最新价、24h 涨跌百分比、高、低、报价币成交额 |

公共专用主机为 `data-api.binance.vision` 和 `data-stream.binance.vision`。连接在 23h50m 时主动更新，收到 serverShutdown 或异常断开也会重建。客户端响应 Ping，并检查上游 30 秒静默。深度新鲜度独立于 WS 是否仍有 ticker 或 Ping。

## 指标映射

| 指标 | 输入与计算 | 帧字段 |
|---|---|---|
| Pressure | 最近两侧各 12 档，以 `1/sqrt(rank)` 加权 | `pressure` |
| 近价深度 | 固定快照覆盖区域，mid±1/5bp，金额按 mid 换算 | `depth[].bid_size/ask_size/bid_notional/ask_notional/complete` |
| Delta | 去重原始成交，按毫秒聚合买卖金额与笔数，再按 `(t−W,t]` 汇总 | `flow[]`，W=1/5/10；`complete/delta_notional/buy_share/tfi` |
| Absorption | 同侧价位 3s 攻击量/攻击前最近可见量；后续深度仍可见才确认 | `events[].start_size/attack_volume/remaining_size/absorption_score` |
| Replenishment | 增加量超过 `max(.025*peak,.05*M,epsilon)`，且在攻击窗口内 | `reload_count/reload_size/replenish_ratio/repeated_reload` |
| Defense | `.4*age + .4*refresh + .2*retention`，各项归一化 | `defense[]`、`bids[]/asks[]` 的 `defense_heat`（0–1） |
| Rotation | 压力变化率、0.97/0.03 二阶矩、tanh、0.8s 时间常数 | `rotation` |
| Vol Expansion | 最多 20 个收益总体标准差及其变化率，同类归一化平滑 | `short_volatility`、`volatility_expansion` |

价位生命周期：连续可见时有效净增加计入 `refresh_count`；消失后 2 秒内重现延续年龄，增加生命周期刷新，但清空攻击窗口。移除历史保留不超过 15 秒。意义阈值 `M` 是当前可信订单簿正数量的上中位数乘以 0.5，约每 100ms 更新。

吸收事件至少满足 `initial >= M`、攻击比≥0.70、当前量>0，且 `book.source_ts >= attack.last_trade`。重复补量标记另要求次数≥2、补量比≥0.5。阈值为原文默认值，并未宣称具有预测能力。

事件历史最多 80 个。价格验证从确认时的 mid 出发：`10000*ln(current_mid/confirm_mid)`。仅在到期后 500ms 内首次有可用帧时填写，超期保持 `null`；最大不利变化按防守方向计算（Bid 下跌 / Ask 上涨）。此实现记录可观察的约 100ms 采样路径，不能保证捕捉每次撮合时刻的最差价格。

## HTTP / WS

- `GET /api/health`：本地服务状态、活动市场数、客户端数、10Hz 配置；开启录制时，`recording.streams[]` 给出每个交易对已写入的行数、压缩字节数、丢弃和丢失计数、当前文件及最近一次错误。`status=ok` 只表示本地服务健康，不能据此判定 Binance 已连通。
- `GET /api/venues`：已实现并注册的交易所列表。
- `GET /api/symbols?venue=binance`：现货元信息列表；不支持的交易所返回 400。
- `GET /ws?venue=binance&symbol=BTCUSDT`：升级为 WebSocket；非法交易对返回 400，不创建上游连接。

连接状态帧：

```json
{"type":"status","status":"connecting","symbol":"BTCUSDT","valid":false,"message":"正在同步订单簿快照与实时增量","attempt":1,"ts":1793780000000}
```

`status` 可能为 `connecting/reconnecting/blocked`。指标帧为 `type=snapshot`；必须先检查 `valid`。无效帧不包含看似正常的压力、Delta 或盘口数据；`invalid_reason` 用于提示。有效帧包含：

- 标识：`venue/product/symbol/info/ts/source_ts/session_started/sequence`。序号是字符串，避免 JS 大整数精度风险。
- 基础：`mid/spread/spread_bps/feed_age_ms/source_age_ms`。
- 指标：`pressure/rotation/short_volatility/volatility_expansion/phase_samples/depth/flow`。
- 图表：`curve/bids/asks/trades/defense/events/history/ticker`。
- 诊断：`quality.book_levels/messages/trade_gaps/unmatched_trades/meaningful_size/snapshot_limit`；`compute_us` 包含指标帧组装，不含 JSON 文本序列化和网络发送。

`feed_age_ms` 从后端最近应用的深度接收时间计算；`source_age_ms` 是后端墙钟减 Binance 事件时间，包含本机时钟误差与源延迟，不是 RTT。页面断开或超过 4 秒未收到服务端帧会清除有效显示；暂停观察时明确显示冻结状态。

## 容量与边界

- 深度可信边界固定；已维护档位最多 30,000，超过则重建，不静默裁掉仍然可能影响指标的近端档位。
- 成交按同一源毫秒压缩金额与计数，保留 10 秒统计。独立最近 60 笔供展示。桶数额外限制 20,000，异常时显式失败。
- 后端相空间历史最多 1,800 点；前端最多 9,000 点。没有历史数据库或浏览器打开前的行情回填；长期数据通过[数据录制](recording.md)保存引擎输入。
- 当前同时监控 8 个市场。5000 档 REST 权重较高，部署多实例时需要在反向代理或统一接入层协调 IP 额度。429/418 或其他 HTTP 错误会停止该轮连接，并受最多 3 次连续重试限制。
- 新交易所必须在适配器中归一化更新序列。不能把期货张数直接塞入现货数量模型。不同市场独立计算，不聚合成虚假的可执行订单簿。
