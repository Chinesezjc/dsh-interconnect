# Changelog

本文件记录 dsh-interconnect 的版本演进。每次变更按时间倒序追加，说明 WHAT（改了什么）与 WHY（为什么），不变更的细节留在 README / commit 正文。

## 0.11.11（2026-09-15）

跟随 #3243 分支新 head（`c4ddb1dd7f`）：修 review 指出的文档/文案不一致，并给 `unreachable` 的渲染补回重试提示。

### 变更

- **导入注释去重**：`tool-interconnect` 里旧的一行「Activates the `Context.interconnect` merge …」与新增的两行注释说同一件事，删掉旧行（review 指出上一轮是"追加"而非"替换"）。
- **口径统一为 live session**：send 描述 `Only a session with a running agent receives directly` → `Only a live session receives directly`；两处 `resume` 说明 `persisted but has no running agent` → `persisted but not live`。依据是 `ctx.agents.list()` 含可被 followup/steer 唤醒的 idle live agent，而 `resume` 针对的是**没有 live agent** 的持久化 session。
- **`unreachable` 渲染补回重试提示**：send 与 reply 两处 render 由 `… did not answer (unreachable)` 改为 `… did not answer (unreachable); retrying may succeed`。review 指出「README 声称重试可能有用，而 render 现在只报事实」的不一致；上游选择把提示补进 render（而非从 README 删除），本版跟随；spec 新增对应断言。
- `interconnect/types.ts` 的 `resume` 文档未改（上游亦未改）。

### 验证

- `pnpm run check`（typecheck + 168/168 tests + build）全绿。
- 对齐门禁：`no behavioural drift against c4ddb1dd7f across 7 ported files and 1 byte-exact asset`。
- 负例验证：把 send 路径的 render 退回不含 `; retrying may succeed` 的版本 → 新增断言变红；还原后通过。

## 0.11.10（2026-09-15）

跟随 #3243 分支新 head（`3f13d1c4b4`）：移植 `interconnect/event` 的异步 listener 修复与去鉴权词汇的文案，并修掉发布流程漏 bump 清单的缺陷。

### 变更

- **`interconnect/event` 改用 `ctx.parallel` 派发**：`ctx.emit` 不 await listener，异步 listener 的 rejection 会变成 unhandledRejection（Node ≥15 默认终止进程）—— 与同步抛错同属「远端 peer 可触发进程退出」这一类，此前只兜住了同步那条。现在 `parallel` 结算每个 listener，并用 AggregateError 聚合失败后记 warn；push 路径原先的 try/catch 随之删除（由 `receiveEvent` 自行上报失败）。
- **模型可见文本去掉鉴权词汇**：`unreachable or unauthorized` → `unreachable`（send/reply/list 的 render 四处，以及 ping/list 的失败渲染），`interconnect_list` 描述里的 "Only sessions with a running agent appear" 改为 "Only live sessions appear"（服务端列的是 `agents.list()`，包含可被 followup/steer 唤醒的 idle agent）。
- `interconnect_reply` 在无执行会话时返回 `no-sender-known` 的注释精简为上游措辞。
- **修复发布缺陷**：0.11.9 的 tarball 里 `dsh.plugin.json` 仍写 `0.11.8`（历史上每次发布都 bump 过，仅该次漏掉）。本版对齐为 0.11.10，并新增 `tests/release-consistency.spec.ts` 守卫（清单的 name/version 必须等于 `package.json`，`files` 必须含清单与 patch）。
- 新增两个仓库内工具（不随包发布）：`scripts/check-upstream-alignment.mjs` 对上游 head 断言四个源文件与三个 spec 的骨架一致、skill 正文逐字节一致；`scripts/probe-deployed-link.cjs` 对在跑实例做协议级探测。

### 验证

- `pnpm run check`（typecheck + 168/168 tests + build）全绿。
- 对齐门禁：`no behavioural drift against 3f13d1c4b4 across 7 ported files and 1 byte-exact asset`。
- 新用例负例验证：把 `receiveEvent` 退回 `ctx.emit` → 新用例 `waitUntil timed out`，且 vitest 报 `Unhandled Errors: Error: async listener exploded`；还原后通过。
- 制品审计：`npm pack --dry-run` 仍为 35 个文件，无 src/tests/scripts 泄漏。

## 0.11.9（2026-09-15）

跟随 #3243 分支 head（`04c675d471`），同步 `list` 满页截断提示与 ping 文案。

### 变更

- `MAX_LISTED_SESSIONS` 由模块内部常量改为导出，`interconnect_list` 的渲染按它判断是否满页。
- `interconnect_list` 在行数达到上限时追加一行提示：满页可能已被截断，缺失的目标仍可能在线。
- `interconnect_ping` 的描述改为上游措辞（不再声明 shared-secret 通道）；ping 与 list 的 `instanceId` 参数说明统一为「按本实例的 peers 配置」。
- `SendFailure` 的 `no-sender-known` 文档补充：没有执行会话的调用方同样报该原因。

### 验证

- `pnpm run check`（typecheck + 164/164 tests + build）全绿。
- 与上游 head 的增删行逐行比对，唯一差异是 import 路径适配（`@deepseek-ai/dsh-experimental-interconnect` → `../interconnect/index.ts`）。

## 0.11.8（2026-09-15）

跟随 #3243 分支 head（`70ed636169`），同步 `tool-interconnect` 的模型可见文案。

### 变更

- `interconnect_send` 的描述回到上游措辞（不再额外声明 shared-secret 通道）；`instanceId` 参数说明改为「按本实例的 peers 映射配置，投递走该实例的持久链接」。
- `interconnect_list` 的描述不再提 size bound（截断细节留在包 README）；`no-sender-known` 的工具渲染改为上游文案。

### 验证

- `pnpm run check`（typecheck + 163/163 tests + build）全绿。
- 全口径（四源 + 三测试 + skill 正文）对 head 的实质差异为 0。

## 0.11.7（2026-09-15）

文档修正，无代码变化。

### 变更

- README 的 `list` 说明改为**行数与字节双上限**：补充 `MAX_LIST_ROWS_BYTES`（链路帧上限减去 4 KiB 的 `query-result` 信封）以及「标题很长时会提前截断」的行为；验证章节的单测数更新为 163。

### 验证

- `pnpm run check`（typecheck + 163/163 tests + build）全绿。

## 0.11.6（2026-09-15）

跟随 #3243 分支 head（`71f5326444`）。

### 变更

- **`list` 答案的上限改为按字节**：此前按行数（`MAX_LISTED_SESSIONS` = 100）加逐行累加，无法保证整帧仍落在链路帧上限内（标题的字节上限可被部署调高）；现在按实际字节预算截断行。
- skill 正文（`assets/dsh-interconnect.md`）同步为上游的中性措辞（去掉 `host plugin` 这类实现词汇），并补齐「发送身份由插件自动附到线负载」的表述。

### 验证

- `pnpm run check`（typecheck + 163/163 tests + build）全绿。
- 四个源文件、三个测试文件与 skill 正文对 head 的实质差异全部为 0。

## 0.11.5（2026-09-15）

跟随 #3243 分支 head（`c83b249064`）同步 skill 正文——这是此前只核对四个 `.ts` 时漏掉的文件。

### 变更

- `assets/dsh-interconnect.md`（模型可见的 skill 正文）与上游逐字节一致：`interconnect_reply` 的说明回到上游措辞（`…recalled automatically; do not try to look up or pass an address again.`），不再用独立仓库特有的 `sender` 表述。

### 验证

- `pnpm run check`（typecheck + 158/158 tests + build）全绿。
- 该文件与 head 逐字节 diff 为 0。

## 0.11.4（2026-09-15）

跟随 #3243 分支 head（`c83b249064`）。

### 变更

- **查询结果改为「校验并投影」**：ping/list 的答复先按调用方问的 kind 校验形状（`parseQueryResult`），再投影成 `PingResult` / `ListResult`（`projectPingResult` / `projectListResult`），替代此前只返回布尔值的 `acceptsQueryResult`。
- `interconnect_send` / `interconnect_reply` 的 sender 改为先取 `selfSender(...)` 再带上，不再用条件展开构造。

### 验证

- `pnpm run check`（typecheck + 158/158 tests + build）全绿。
- 与 head `c83b249064` 逐文件对照：四个源文件的 monorepo 独有实质差异为 0。

## 0.11.3（2026-09-14）

跟随 #3243 分支 head 的又一批改动（重建 commit `56bac7eabe`）。

### 变更

- **`SendResult` 改为判别联合**：`delivered: true` 分支带可选 `delivery`，`delivered: false` 分支必须带 `reason`。此前是可选字段的 interface，类型层面无法阻止「失败却无原因」的组合。
- **入站帧投影**：`handleFrame` 解析后先过滤 null 字段（`withoutNullFields`），并把 `msg-result` 的 `SendResult` 规范化成上述判别联合（`projectMsgResult`），使异版本对端送来的字段组合不会落到错误分支。

### 验证

- `pnpm run check`（typecheck + 156/156 tests + build）全绿。
- 与 head `56bac7eabe` 逐文件对照：四个源文件的 monorepo 独有实质差异为 0。

## 0.11.2（2026-09-14）

跟随 #3243 分支 head 的最新状态同步（该分支本轮又推进了重建 commit）。

### 变更

- **删除 `ListRequest` 导出**：该类型在仓库内无任何消费者（服务的 `list(instanceId: string)` 收字符串，工具直接传 `args.instanceId`），上游按「Require a current owner and need」删除，独立仓库跟随以保持两侧类型面一致。这是导出面收缩，无已知消费者。
- `interconnect_reply` 的工具描述改为与上游一致的措辞（`the sending instance id and session id`）。

### 验证

- `pnpm run check`（typecheck + 154/154 tests + build）全绿。
- 与 #3243 head（`176ea91f6b`）逐文件对照：四个源文件的实质差异只剩镜像谓词与内部路径适配。

## 0.11.1（2026-09-14）

补齐 0.11.0 遗漏的 review 收尾加固。0.11.0 只回移到 #3243 分支 08-30 的状态，漏了 09-10 的收尾提交；本版以分支最新 head（`f6fdeaf7de`）重新对齐。

### 修复

- **`list` 答案有行数上限**：单个答案最多 `MAX_LISTED_SESSIONS`（100）行。整帧必须待在链路的帧上限内，ws 对超限帧会直接关闭链路，所以 live session 极多的对端改为只回答前若干行，而不是把传输打断。
- **ping/list 结果按请求类型校验**：帧联合体会合并未知键，`list` 形状的负载此前能满足 `ping` 请求；现在按调用方问的 kind 校验结果，形状不符视为无答复。
- **upgrade 失败不再逃逸**：入站升级处理器返回的 promise 被捕获，失败时告警并销毁 socket。
- **服务已 dispose 时的入站升级返回 503**，不再继续 `handleUpgrade`。
- **binary 与字符串帧**：`message` 回调直接忽略 binary；帧长度按字符串与分片正确累加。
- **无共享 token 时只告警一次**（`warnedNoToken`），不再每次重连刷日志。
- 删除已无用的 `INTERCONNECT_CHANNEL` 导出。

### 验证

- 单测 145 → 154（补齐 09-10 收尾的回归用例）。
- 负例实测：摘除 `list` 上限后 `caps a list answer at the row limit the link frame can carry` 转红。
- 与 monorepo #3243 分支 head 逐文件对照，功能差异只剩镜像谓词、依赖来源与内部路径适配。
- `pnpm run check`（typecheck + 154/154 tests + build）全绿。

## 0.11.0（2026-09-14）

把 monorepo #3243 分支（08-28～08-30 两轮 review 收敛）的全部加固回移到独立仓库，使合入主仓库之前的现役版本不再带可被对端触发的崩溃。

### 修复（安全与健壮性）

- **拒绝畸形帧**：JSON `null` 帧此前会被解引用（`TypeError: Cannot read properties of null (reading 'type')`），在 socket 的 message 回调里逃逸为 uncaughtException——任何持共享 token 的对端都能触发进程崩溃；现在解析后拒绝非对象帧。同时拒绝超出上限的帧，并在装载期拒绝非 WebSocket 协议的 origin。
- **心跳不再对非 OPEN socket 调 `ping()`**：`reroute()`/`close()` 此前用 `removeAllListeners()`，连带剥掉池清理 handler，terminated socket 留在 live pool，30 秒心跳对其 `ping()` 同步抛异常。改为按引用移除 dial 注册的 handler，并在 sweep 前检查 `readyState`。
- **结果帧绑定到请求类型**：`msg-result` 只结算 `msg` pending、`query-result` 只结算 `query` pending，错形答复不再串进错误的 pending。
- **dial epoch**：reroute 之后，被取代的 dial epoch 的 token 读取失败不再触发重拨，避免双拨。
- **auth 比较**改为 SHA-256 摘要上的常数时间比较。
- **帧判别式必填**：`type` / `kind` 不再可选，避免缺失字段落到解引用分支。

### 变更（破坏性）

- **`interconnect_reply` 不再接受 `sessionId`**：回信 session 是执行该工具的 agent 自己的 session；线上的 `reply` 变体已移除，远端无法借本机 sender map 转发任意文本。模型只需传 `text`。
- **服务不再强依赖 webServer**：`inject` 从 `['webServer', 'agents', 'credentials']` 改为 `['agents', 'credentials']`（`dsh.plugin.json` 同步）。有 webserver 时注册入站升级路由，没有时仍会拨号已配置对端并经出站链接投递，即仅出站模式。

### 验证

- 单测从 40 增至 145（移植上游全部回归用例）。
- 两条 P0 负例实测：摘除 null 帧守卫、摘除心跳 `readyState` 守卫，对应用例各自转红，再还原。
- `pnpm run check`（typecheck + 145/145 tests + build）全绿。

## 0.10.1（2026-09-01）

修复发布版本在真实 DSH 运行时无法加载的问题（issue #5）。

### 修复

- **移除对 `hasApiRemoteSubagentOwner` 的 import**：该导出在 `@deepseek-ai/dsh-api-remotes`
  任何已发布版本中都不存在（Host 已把该谓词移入 `dsh-api-session-controller` 且不公开导出），
  导致 0.6.1～0.10.0 发布版加载时抛 `SyntaxError: does not provide an export named
  'hasApiRemoteSubagentOwner'`。改为在插件内逐字镜像 Host 的 `hasApiSessionSubagentOwner`
  （`isSessionOwnedBySubagent`），行为不变。
- **清掉不再被 import 的 peer/dev 依赖**：`@deepseek-ai/dsh-api-remotes` 与
  `@deepseek-ai/dsh-host-apiproxy` 已无任何源码引用（apiproxy 自 0.9.0 起移除），继续声明只会
  让 pnpm 在无这两个包的运行时里报 unmet peer。

### 验证

- 新增 `tests/interconnect.host.spec.ts` 两条封栏用例：`list` 排除 origin=subagent 与
  parent-owned 会话（含 parentSession 但无所有权的会话仍列出）；`send` 到被封栏会话返回
  `session-owned-by-subagent` 且不入 inbox。摘除封栏后两条用例均转红（负例验证通过）。
- `pnpm run check`（typecheck + 40/40 tests + build）全绿。
- npm pack + 干净目录安装 tarball 后各入口可正常 import，无 `ERR_MODULE_NOT_FOUND` 与
  missing-export 错误。

## 0.10.0（2026-08-24）

新增配套 skill 插件，落实 issue #3 的「告诉模型如何使用」与「工具调用自动注入发送者身份」两部分。

### 新增

- 新增 **`skill-interconnect`** 插件（`dsh-interconnect/skill-interconnect`），向 `ctx.skills`
  注册 `dsh-interconnect` skill，告诉模型如何用 `interconnect_list` / `interconnect_ping` /
  `interconnect_send` / `interconnect_reply`，以及 `delivery`、`resume`、失败原因的处理。
- skill 明确写出：`interconnect_send` 会自动注入发送方的 `instanceId` 和 `sessionId`，
  接收方凭记录的 sender 即可用 `interconnect_reply` 回信，不需要手工传地址。
- 该插件 `inject: ['skills', 'interconnect']`，只有 interconnect 服务存在时才注册 skill。
- 包新增 `./skill-interconnect` 与 `./skill-interconnect/invariant` 两个导出入口；
  tarball 的 `files` 增加 `assets`，随包携带 skill 正文。

### 验证

- 新增 `tests/skill-interconnect.spec.ts` 覆盖：注册/卸载、正文加载、资源文件存在。
- `pnpm run check`（typecheck + 全量 tests + build）保持全绿。

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
