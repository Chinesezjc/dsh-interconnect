# Changelog

本文件记录 dsh-interconnect 的版本演进。每次变更按时间倒序追加，说明 WHAT（改了什么）与 WHY（为什么），不变更的细节留在 README / commit 正文。

## 0.9.0（2026-08-19）

破坏性大版本。本次重写解决了「接收方无法确认发送方、reply 链式回信（A→B→A→B）断链」的根因。

### 行为变化（破坏性）

- **全走 WebSocket，删除全部 HTTP 端点**：`send`/`reply`/`ping`/`list` 全部经 `/interconnect/link` 的 `msg` / `query` 帧完成，由 `reqId` 关相关联。对旧 HTTP 端点（如 `/interconnect/ping`）发请求返回 405。
- **寻址从 `baseUrl` 改为 `instanceId`**：
  - `Config.peers` 从 `string[]`（origin 列表）改为 `{ [instanceId]: origin }` 映射。
  - `peers` 在服务激活时**自动 `link()` 每个对端**，建立持久双向 WebSocket（心跳 + 指数退避重连）。
  - 到未配置 / 未联通的 `instanceId` 的调用返回 `unreachable`（无 HTTP 回退）。
- **`sender` 去掉 `baseUrl`**，变为 `{ instanceId, sessionId }` 无地址身份。reply 回信走**本机到对端的持久链接**，不再解析或携带对端地址——这使 `reply` 双向多轮链式真正成立，且不再需要 `selfBaseUrl` 或 per-peer 地址映射。
- **工具参数**：`interconnect_send` / `interconnect_ping` / `interconnect_list` 的 `baseUrl` 参数改为 `instanceId`。

### 修复

- 此前 `sender.baseUrl` 在 SSH 隧道 mesh 中无法表达「对端回我时的可达地址」（隧道端口每对非对称），导致 `reply` 之后对端无法再 reply（链式断在第二环）。0.9.0 将寻址下沉到链接层，彻底移除地址依赖。
- 此前 `peers` 只用于 event fan-out，跨机互通需手动 `link()`；0.9.0 激活即自动建链。

### 验证

- 本地 `pnpm run check`（typecheck + 34/34 tests + build）全绿，负例已构造（移除 `peers` 激活自动 `link()` → 3 条测试转红）。
- 实机端到端：ci-server 经 `interconnect_send(instanceId=..., resume:true)` 投递到 momoairi 持久会话成功，对端 agent 确认收到。

## 0.8.0（2026-08-19）

在 0.7 的 reply 基础上，让消息通道优先复用持久 WebSocket 长连接。

- `LinkFrame` 增加 `msg` / `msg-result` 帧，`send` / `reply` 优先走已建立的 `/interconnect/link`，否则回退 HTTP。
- 心跳与指数退避重连沿用既有实现，消息与事件共用同一根持久连接。
- 通道仍保留 HTTP 回退；`sender` 仍带 `baseUrl`（单值），此时链式回信仍受地址可达性限制——该限制在 0.9.0 才移除。

## 0.7.0（2026-08-19）

为 `interconnect` 引入「消息可回复」能力，解决「消息匿名、不知道如何回复」。

- `SendPayload` 增加 `sender` 身份（`baseUrl` + `instanceId` + `sessionId`）。
- 新增 `/interconnect/reply` 端点与 `interconnect_reply` 工具：接收方只需本地 session id + 文本，回信目标从记录的 `sender` 解析。
- `Config` 增加 `selfBaseUrl`（本机对外可达 origin，用于到源回信归因）。
- 新增失败原因 `no-sender-known`。
