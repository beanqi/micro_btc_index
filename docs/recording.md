# 数据录制

录制保存的是**指标引擎的全部输入**：订单簿快照、深度增量、逐笔成交、ticker、每次出帧的时刻，以及连接状态。指标结果不落盘，需要时通过回放重新计算。这样以后可以换参数、加新特征、重新生成标签，而 L2 盘口历史没法事后补录。

## 开启

```sh
RECORD_SYMBOLS=BTCUSDT,ETHUSDT cargo run --release
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `RECORD_SYMBOLS` | 空（不录制） | 逗号分隔；接受 `BTC/USDT` 等写法，可加交易所前缀 `binance:BTCUSDT` |
| `RECORD_DIR` | `data/raw` | 录制根目录，相对于启动时的工作目录 |

- 录制的市场常驻运行：没有页面打开也保持连接，不受 15 秒空闲回收限制。断线后无限重试，等待时间依次为 2、4、8…秒，最长 60 秒。打开同一交易对的页面直接共享这份计算结果。
- 录制市场与页面订阅市场合计最多 8 个。
- 交易对无效，或启动时无法访问 exchangeInfo，程序会直接退出，不会带病运行。部署在服务器上时，交给 systemd 等服务管理器负责重启。
- 用 Ctrl-C 或 SIGTERM 停止时，会写完缓冲区、fsync，并把文件改为正式名称。

## 文件布局

```
data/raw/binance/spot/BTCUSDT/2026-11-09/130000.jsonl.zst
                                          ^ 本文件第一条输入的 UTC 时间
```

- 日期和文件名都用 UTC，每个 UTC 整点换一个文件。按文件名排序就是时间顺序。
- 正在写入的文件带 `.part` 后缀，正常关闭后改名。看到 `.part` 文件，说明进程当时没有正常退出，详见下面的“可靠性”。
- 进程重启会开新文件，不会覆盖旧文件；同一秒内的重名文件依次加 `_1`、`_2`。
- 文件由多个独立的 zstd 帧拼接而成，每帧都带校验和；标准 zstd 工具和库都能直接读取。

## 行格式（version 1）

每行一个 JSON 对象，都有 `t` 和 `k` 两个字段：

- `t`：引擎处理这条输入时使用的**本机墙钟**，Unix 毫秒。
- `k`：记录类型。

价格是精确的十进制字符串；数量是基础币数量，以 JSON 数字保存，读回后与解析出的 f64 完全一致。

| `k` | 字段 | 含义 |
|---|---|---|
| `header` | `format`、`version`、`venue`、`product`、`info`、`session`、`app_version` | 每个文件的第一行。`info` 是交易对元信息；`session` 是录制进程启动时间，进程每次重启都会变 |
| `status` | `state`（`connecting`/`error`）、`attempt`、`message?` | 连接生命周期 |
| `gap` | `lost`、`reason`（`backpressure`/`io`） | 有 `lost` 条输入没能写入文件 |
| `snapshot` | `last`、`limit`、`bids`、`asks` | REST 全量订单簿，标志一个新引擎实例的开始 |
| `depth` | `first`、`last`、`ts`、`bids`、`asks` | 覆盖序号 `first..=last` 的深度增量。数量是更新后的绝对值，0 表示删除该档 |
| `trade` | `id`、`ts`、`price`、`size`、`buy` | 原始逐笔成交；`buy=true` 表示主动买入 |
| `ticker` | `last`、`change_pct`、`high`、`low`、`quote_volume` | 24h 概况。只用于展示，不参与指标计算 |
| `tick` | — | 引擎在时刻 `t` 生成了一帧，即调用了 `Engine::snapshot` |

示例：

```json
{"t":1794229200103,"k":"depth","first":91001,"last":91003,"ts":1794229200050,"bids":[["80504.01",0.0]],"asks":[["80504.02",1.25]]}
{"t":1794229200118,"k":"trade","id":6820762988,"ts":1794229200110,"price":"80504.02","size":0.00029,"buy":true}
{"t":1794229200200,"k":"tick"}
```

`ts` 是交易所时间，`t` 是本机时间，两者都要保留。引擎同时使用这两个时钟：成交按交易所时间归桶，而成交窗口截止、事件确认、数据新鲜度判断都用本机时间。只保留交易所时间，就无法精确复现指标。

## 回放规则

按顺序读取同一交易对的所有文件，跨小时文件不要重置状态：

1. `header`：读取 `info` 和 `venue`。`session` 改变说明上一个进程已经结束。
2. `status`：丢弃当前引擎。线上引擎此时已经结束，或者正在重新连接。
3. `gap`：之后的状态不再完整。严格回放应丢弃引擎，等下一个 `snapshot`；近似分析也可以选择继续。
4. `snapshot`：`Engine::new(snapshot, t)`。
5. `depth`、`trade`、`ticker`：`engine.on_event(event, t)`。如果返回错误就丢弃引擎，线上此时也会重连。
6. `tick`：`engine.snapshot(info, venue, t)`。**每个 tick 都必须调用**，即使不需要它的输出：这一步会推进事件确认、成交窗口清理和意义阈值，跳过 tick 会让后续结果偏离线上。

引擎实例只能从 `snapshot` 开始。要从某个小时开始分析，应先找到它之前最近的那个 `snapshot`，从那里开始回放。连接最长 23 小时 50 分就会主动更新，因此最多需要往回找约一天。

上述规则已经验证可以复现线上的每一帧：单元测试 `replaying_a_recording_reproduces_live_frames`，以及[验证记录](verification.md)中的真实行情对比。回放工具和可调参数尚未实现。

## 可靠性

- **录制不阻塞行情计算。** 所有市场共用一个最多 65,536 条输入的队列，由单独的写盘线程负责压缩和文件 I/O。队列满时丢弃新输入，并在之后写一条 `reason=backpressure` 的 `gap`。
- **磁盘出错时**（例如磁盘满或没有权限），记录错误日志，期间的输入计为丢失，30 秒后尝试打开新文件；新文件开头会写一条 `reason=io` 的 `gap`。
- **每 5 秒或缓冲满 1 MiB，写出一个独立的 zstd 帧。** 进程崩溃最多丢失最后约 5 秒的数据，之前的帧都能完整读出。崩溃后留下的 `.part` 文件末尾可能有一个不完整的帧，解码器会在读到末尾时报错，但之前的数据完整。断电时，还可能丢失操作系统尚未写入磁盘的部分。
- **`/api/health` 的 `recording.streams[]`** 包含每个交易对的 `records`、`compressed_bytes`、`dropped`（队列满丢弃）、`lost`（磁盘错误丢失）、当前 `file` 和最近的 `error`。长时间录制时，`dropped` 和 `lost` 都应保持为 0。
- `t` 是本机时钟，机器应开启 NTP 时间同步。时钟跳变也会原样记录下来，回放结果不受影响；但按 `t` 做时间序列分析时需要留意。

## 读取

命令行：

```sh
zstd -dc data/raw/binance/spot/BTCUSDT/2026-11-09/130000.jsonl.zst | head
```

Python 3.14+ 标准库：

```python
import json
from compression import zstd

with zstd.open(path, "rt", encoding="utf-8") as f:
    for line in f:
        record = json.loads(line)
        if record["k"] == "trade":
            ...
```

较早的 Python 可以使用 `zstandard` 包：

```python
import io, json, zstandard

with open(path, "rb") as raw:
    reader = zstandard.ZstdDecompressor().stream_reader(raw, read_across_frames=True)
    for line in io.TextIOWrapper(reader, encoding="utf-8"):
        record = json.loads(line)
```

## 磁盘用量

2026-11-09 11:17 UTC 实测 157 秒。当时行情非常活跃：BTCUSDT 约 150 笔成交/秒，深度增量平均每条 144 档。

| 交易对 | 写入速度（压缩后） | 若全天保持这个速度 |
|---|---:|---:|
| BTCUSDT | 8.3 KB/s | 约 0.7 GB/天 |
| ETHUSDT | 7.4 KB/s | 约 0.64 GB/天 |

平静时段只有它的几分之一，日均值取决于行情活跃度。建议每个交易对按两周 10 GB 预留空间。帧大小对压缩率几乎没有影响：与把整个文件压成一帧相比，大小差距不到 1%。

不再写入的旧文件可以用 `zstd -19` 重新压缩，大约再省 28%：

```sh
zstd -dc 130000.jsonl.zst | zstd -19 -q -o 130000.jsonl.zst.tmp && mv 130000.jsonl.zst.tmp 130000.jsonl.zst
```

## 边界

- 记录的是交易所适配器归一化后的引擎输入，不是交易所的原始报文。如果适配器解析有误，错误也会被一起记录下来。
- 录制只覆盖开启之后的行情，无法回填以前的数据。
- 文件格式变化时，`version` 会随之提升；读取方应先检查 `header.version`。
