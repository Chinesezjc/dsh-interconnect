# Changelog

本文件记录 dsh-interconnect 的版本演进。每次变更按时间倒序追加，说明 WHAT（改了什么）与 WHY（为什么），不变更的细节留在 README / commit 正文。

## 0.11.23（2026-09-15）

跟随 #3243 分支新 head（`f749a8c252`）：`linkUrl` 改用 `LINK_CHANNEL` 常量，不再重复字面量。

### 变更

- **`linkUrl` 用 `LINK_CHANNEL` 建拨号 URL**：原先写死 `new URL('/interconnect/link', origin)`，而 WebSocket 升级路由那一侧用的是常量 `LINK_CHANNEL = '/interconnect/link'`（`src/index.ts:122`）。现在两侧共用同一个常量——两处描述同一条路径，分开写就有漂移风险（改一处忘另一处会让拨号打到一个不存在的路由）。
- **行为不变**：常量值与被替换的字面量相同，170/170 tests 通过。改动仍会让产物变化（`.js` 里由常量引用取代字面量），所以按「版本号必须唯一标识一组产物」的既有口径发版——否则 `package.json` 的 0.11.22 会同时指两组不同的构建输出，hash 链判据随之失效。
- **同 head 的另一个文件是 monorepo 独有的**（`scripts/snapshot-http-fixtures.spec.ts`），不在镜像范围内。

### 验证

- `pnpm run check`（typecheck + 170/170 tests + build）全绿。
- 对齐门禁：`no behavioural drift against f749a8c252 across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`；`scripts/port-upstream-change.mjs --from 98de592a81 --to f749a8c252` 一次完成、**0 个被拒 hunk**。
- 构建产物与 0.11.22 比对：**3 个变**（`lib/index.js` `34dfba7d603e1787`→`08ce274bb37a5e34`、`lib/interconnect/index.js` `976081ad8f7906b4`→`417d233de9787746`、`lib/tool-interconnect/index.js` `e3cf1a069d165b8c`→`e32c539fed784db6`）；`lib/skill-interconnect/index.js`、`lib/types/interconnect/types.d.ts`、asset 与 patch 不变。

## 0.11.22（2026-09-15）

跟随 #3243 分支新 head（`01bb1b397e`）：让组合可以省略带 schema 默认值的 `Config` 字段。

### 变更

- **`Config` 的 `instanceId` 与 `requestTimeoutMs` 改为可选**：两个字段的 schema 都带 `.default(...)`（`'dsh'` / `10000`），但接口把它们声明成必填，与同处另外三个同样带默认值的字段（`peers?`/`delivery?`/`allowResume?`）不一致。现在改为 `readonly instanceId?: string` / `readonly requestTimeoutMs?: number`，并按仓库约定补 `@default 'dsh'` / `@default 10000`。
- **默认值提为模块常量**：新增 `DEFAULT_INSTANCE_ID = 'dsh'` 与 `DEFAULT_REQUEST_TIMEOUT_MS = 10_000`，schema 的 `.default(...)` 与构造器共用它们，避免同一字面量写两遍。
- **构造器补 `??` 兜底**：`this.instanceId = config.instanceId ?? DEFAULT_INSTANCE_ID`（timeout 同理），并照同处既有样式补 `/* v8 ignore next 1 */` —— schema 总在构造器运行前填好默认值，所以这个分支运行时不可达；补注释是为了让 monorepo 的 per-file 覆盖门禁不因死分支变红。
- **行为与 0.11.21 相同**：这是类型与接线的一致性修复，`??` 是死分支。发版是为了让已发布产物的构建输出与上游保持一致，而不是修一个运行时可观察的缺陷。
- **同 head 的另一个 commit 改了链路用例**（`8a21697806`）：`interconnect.host.spec.ts` 的用例改为按协议等 `ping`/`hello` 应答，不再用固定延迟，并新增一条「hello 未到不得报告 ready」的用例。`bb56bb0a37`（snapshot 助手）、`01bb1b397e`（doc graph 脚本）与各 `docs/**` 都是 monorepo 独有，不在镜像范围内。

### 验证

- `pnpm run check`（typecheck + 170/170 tests + build）全绿。
- 对齐门禁：`no behavioural drift against 01bb1b397e across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`；`scripts/port-upstream-change.mjs --from 4a335855 --to 01bb1b397e` 一次完成，**0 个被拒 hunk**。
- 构建产物与 0.11.21 比对：**4 个变**（`lib/index.js` `fa8f72b78e1d14b0`→`34dfba7d603e1787`、`lib/interconnect/index.js` `946fa483e8ed1b8c`→`976081ad8f7906b4`、`lib/tool-interconnect/index.js` `2353740801733d92`→`e3cf1a069d165b8c`、`lib/types/interconnect/types.d.ts` `4814ed410b65d7e0`→`33956ef458ccb9a8`），skill/asset/patch 不变。这 4 个新值在发版前一轮已用等价预演（`git apply` 未推改动）提前测出并**逐字命中** —— 预演只差了 spec 的写法，而没有 spec 不参与构建。
- 部署影响：三台（MomoiAiri、CI-Server、CI-Server-Windows）从 0.11.21 升到 0.11.22。

## 0.11.21（2026-09-15）

跟随 #3243 分支新 head（`03fb844ea1`）：companion skill 不再声明 `resourceBase`，因为它会把本机绝对路径写进 skill 工具结果。

### 变更

- **`skill-interconnect` 的候选不再带 `resourceBase`**：删掉 `RESOURCE_BASE`（`{kind: 'directory', path: fileURLToPath(new URL('../../assets/', import.meta.url))}`）与 `node:url` 的 `fileURLToPath` 引入，候选与 `get()` 返回的 `SkillDefinition` 都不再带该字段。调用 `skill({name:'dsh-interconnect'})` 时，skill 运行时对 `resourceBase !== undefined` 走 `Base directory for this skill: <绝对路径>` 分支；本插件的 `assets/` 目录里只有已内联进 `<skill_instructions>` 的正文，所以这条提示只暴露了检出目录的绝对路径——一个换机器就无法重放的值（上游在把手场景里为 skill 正文录快照时因此判红）。去掉后走 provider 托管分支，结果文案是 `Resources for this skill are managed by provider "dsh-interconnect".`。
- **同一 head 的另外两个 commit 只影响 monorepo 侧**：`src/interconnect/index.ts` 的改动是 JSDoc 合并（`shape` 改述为 `union`），构建产物逐字节不变（`lib/interconnect/index.js` 仍是 `946fa483e8ed1b8c`）；`scripts/snapshot-http-fixtures.spec.ts`、`snapshots/**` 是 monorepo 快照夹具，不在镜像范围内。

### 验证

- `pnpm run check`（typecheck + 167/167 tests + build）全绿。
- 对齐门禁：`no behavioural drift against 03fb844ea1 across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`；`scripts/port-upstream-change.mjs --from fc1d297290 --to 03fb844ea1` 有 2 个 hunk 被拒（都是相对路径适配造成的上下文差异），手工按适配后的上下文解掉。
- 构建产物与 0.11.20 比对：8 个受追踪产物里只有 `lib/skill-interconnect/index.js` 变了（`ac7f6b62698c99b2` → `f3503a044b6791e9`），其余 7 个逐字节相同，确认这是本版唯一的运行时改动。
- 部署影响：三台（MomoiAiri、CI-Server、CI-Server-Windows）从 0.11.20 升到 0.11.21。

## 0.11.20（2026-09-15）

跟随 #3243 分支新 head（`0454d30ab5fb`）：把 `no-sender-known` 从「接收方可以回答的线缆原因」里删掉，与 0.11.19 补的文档保持一致。

### 变更

- **`msgResultSchema` 不再接受 `no-sender-known`**：该联合类型里去掉 `z.const('no-sender-known')`。0.11.19 刚把「`message-too-large` 与 `no-sender-known` 是本实例本地产生、永远不过线」写进 `SendFailure` 的文档，但 schema 当时仍允许接收方回一个 `no-sender-known`；现在入站帧里出现这个原因会被判为 malformed（丢弃并按既有 `dropping malformed link frame` 记账），文档与线缆契约对齐。
- **同一处多了一行 JSDoc**：`msgResultSchema` 上方新增「Reasons one receiver can answer a `msg` with; the reply-side reasons stay local.」（上游把新注释加在原有注释之后，两行连排；按上游原文逐字移植，未整理）。

### 验证

- `pnpm run check`（typecheck + 167/167 tests + build）全绿。
- 对齐门禁：`no behavioural drift against 0454d30ab5 across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`；用 `scripts/port-upstream-change.mjs --from ce0d15780c --to 0454d30ab5` 一次完成，无被拒 hunk。
- 部署影响：三台升级直接跳到 0.11.20（MomoiAiri 从 0.11.19、CI-Server 与 Windows 从 0.11.18），不再单独铺 0.11.19，避免同一台机连着升两次。

## 0.11.19（2026-09-15）

跟随 #3243 分支新 head（`ce0d15780c03`）：skill 正文的身份来源规则改写，并补齐 0.11.18 之后上游写下的 JSDoc。

### 变更

- **skill 正文（`assets/dsh-interconnect.md`，模型可见）**：Rules 第一条从「不要编造 `instanceId`/`sessionId`/sender；用 `interconnect_list`/`interconnect_ping` 的返回值，或用收到的消息携带的值」改为分开说明三者的来源 —— **`instanceId` 来自派给你的任务或本实例配置的 peers**，`sessionId` 来自对该 peer 的 `interconnect_list`，sender 由收到的消息自动携带。原句把 `instanceId` 也说成"列表/探测返回值"，而 `interconnect_list` 列的是**那个 peer 上的**会话、`ping` 只回该 peer 自己的 id，照着做容易误推一个 id 出来。
- **JSDoc 补齐**（无运行时影响）：`send`/`reply` 的 `@returns` 现在写明还会返回本地的 `message-too-large`（编码后超链路帧上限时），`reply` 另注明本地会话无 sender 时是 `no-sender-known`；`SendFailure` 的文档新增一段说明 **`message-too-large` 与 `no-sender-known` 是本实例本地产生的，永远不会过线**（`msgResultSchema` 只接受接收方能给出的原因）。
- **含 0.11.18 发布后补的一处移植**：先前 0.11.18 发布之后才把 `src/interconnect/types.ts` 的一处 JSDoc 同步过来（当时只在仓库里、未随版本发布），本次一并发出去；因此 `lib/types/interconnect/types.d.ts` 与线上 0.11.18 不同（注释在 `.d.ts` 里保留、在 `.js` 里剥掉）。

### 验证

- `pnpm run check`（typecheck + 167/167 tests + build）全绿。
- 对齐门禁：`no behavioural drift against ce0d15780c across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`。
- 本次移植用新的 `scripts/port-upstream-change.mjs --from 4ebda9c4fe --to ce0d15780c` 一次完成（2 个文件 patch + 正文字节复制 + 门禁），无 hunk 被拒、无残留 `.orig`/`.rej`。

## 0.11.18（2026-09-15）

跟随 #3243 分支新 head（`4ebda9c4fe8c`）：**撤回** 0.11.17 引入的「按对端 announce 的 id 归属拨号链路」，改成对「配置键与 announce 值不一致」记一次警告。

### 变更

- **为什么撤回**：0.11.17 把对端在 `hello` 里 announce 的 id 也加入 `covered`，本意是让配置键与自称不一致的部署也能归属对端。但 announce 值是**对端自报**的：它因此能抑制**另一个** peer 的入站 socket，等于让自报身份具备静默别人链路的能力 —— 这与 `broadcast` 注释里「announcement can suppress nothing but a duplicate the controlled link already carries」的前提冲突。现在 `covered` **只**收配置键（`Config.peers` 的 key），没有拨号链路覆盖时每个入站 socket 都会收到事件。
- **不一致改为警告，不再静默**：新增 `mismatchWarned: WeakSet<WebSocket>`；`hello` 处理时若该拨号链路的配置键与对端 announce 的 id 不同，就**每条链路记一次** warn：`peer configured as <key> announces <sender>; list a peer under the instanceId it announces, or the duplicate inbound link is not recognised`。这样代价（该 peer 每个事件收到两份）是可见的，而不是被自报值悄悄吸收。
- **JSDoc 同步改写**：`broadcast` 的注释改为描述新规则（"a self-reported announcement can never silence another peer's link"）。
- **上游改写 1 条用例**（1:1 移植）：原先断言「按 announce 的 id 归属拨号对端」的用例，改为断言「配置键与 announce 不一致时产生一次警告」。

### 验证

- `pnpm run check`（typecheck + 167/167 tests + build）全绿。
- 对齐门禁：`no behavioural drift against 4ebda9c4fe8c across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`（`assets/dsh-interconnect.md` 未变）。
- 本仓三台部署的 `peers` 键与各自 announce 的 instanceId 一致（`momoairi`/`ci-server`/`ci-windows`），因此不会触发该警告。

## 0.11.17（2026-09-15）

跟随 #3243 分支新 head（`10625dbaf770`）：给 `instanceId` 加上与 `reqId` 对齐的长度上限，据此删掉列表应答里「信封都放不下」的分支；把事件订阅交给 Cordis 的 fiber 生命周期；并让拨号链路按对端**announce 的 id** 也能归属对端。

### 变更

- **`instanceId` 上限 256 字符**（`MAX_INSTANCE_ID_CHARS`，schema 加 `.max()`）：每帧本实例写出的内容都带 instanceId（`hello`、应答、结果），没有上限时一个超长 id 会在第一次写入时撞上链路帧上限，而不是在加载配置时就失败。错误暴露点前移到加载期。
- **删掉 `list` 应答的负预算分支**：两个会进入信封的 id 现在都有界（`reqId` 256、`instanceId` 256），信封必然放得下，于是 `listRowsBudgetBytes` 的返回值恒定为正，`@returns` 与调用点都不再需要「负值即无法作答」的路径（该分支与它的 warn 一并移除）。
- **事件订阅改用 Cordis 的 fiber 作用域**：删掉 `private readonly subscriptions: (() => void)[]` 与配套的 `ctx.effect(...)` 手工清理，六处 `ctx.on(...)` 直接调用。监听器随服务 fiber 自动注销，少一层需要自己维护的簿记——此前手工数组与服务生命周期是两套并行的清理路径。
- **拨号链路的对端归属按 announce 的 id 补齐**：`covered` 集合除配置键（`Config.peers` 的 key）外，现在还加入该链路对端在 `hello` 里 announce 的 id。部署完全可以把一个 peer 配在与其自称不同的键下（本仓三台恰好键与 announce 值相同，但配置并不要求如此），此时对端的入站 socket 通过两个名字中的任一个都可归属，事件扇出不会误发第二份。
- **上游新增/改写 4 条用例**（`tests/interconnect.host.spec.ts`，1:1 移植）：`delivery`/`allowResume`/`peers` 省略时取默认值；按对端 **announce 的 id**（而非仅配置键）归属拨号对端；超长 `instanceId` 被拒绝加载；恰好在上限的 `instanceId` 被接受。

### 验证

- `pnpm run check`（typecheck + 167/167 tests + build）全绿（用例数 166 → 167；上游本次新加 4 条并整合了旧用例）。
- 对齐门禁：`no behavioural drift against 10625dbaf770 across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`。`assets/dsh-interconnect.md` 未变（仍逐字节一致），skill 正文无需改动。

## 0.11.16（2026-09-15）

跟随 #3243 分支新 head（`6992f71eaeef`）：本地拒绝超出链路帧上限的 `msg` 帧，并把这个失败原因变成对模型可见、可据以行动的措辞。

### 变更

- **发送前本地检查帧大小**：新增 `frameFitsLink(frame)`，`msgRequest` 先按 `JSON.stringify` 实测编码后的 `msg` 帧，超过 `MAX_LINK_FRAME_BYTES`（1 MiB）就**不写任何东西**，直接返回 `{ delivered: false, instance, reason: 'message-too-large' }`。此前超限帧会被写出去，对端 ws 收到超限帧即断链，调用方把「消息本来就装不下」读成传输失败、还会以为重试有用。
- **新增失败原因 `message-too-large`**（`SendFailure` 联合类型新增一个成员，pre-1.0 属预期）：`send` 与 `reply` 的工具描述增加了这个分支的渲染——`the message is too large for the peer link (limit 1 MiB); shorten the text and try again` / 回复侧同义句；`interconnect_send` 的 `text` 参数描述也写明「编码后上限 1 MiB，超出以 `message-too-large` 拒绝」。
- **skill 正文（`assets/dsh-interconnect.md`）** 的 `reason` 列表新增 `message-too-large` 条目，说明应改写文本而不是原样重试。该文件仍按**字节级复制**移植（本仓不 patch 它）。
- **上游新增 2 条用例**（1:1 移植）：`tool-interconnect` 对 `message-too-large` 的 send/reply 渲染不出现 `retrying may succeed`；`interconnect.host` 对「刚好放下的消息送达、1 MiB 文本被拒且链路仍可用（后续小消息仍送达）」的端到端断言。

### 验证

- `pnpm run check`（typecheck + 166/166 tests + build）全绿（用例数 164 → 166）。
- 对齐门禁：`no behavioural drift against 6992f71eaeef across 7 ported files, 1 byte-exact asset, 1 patch row set, and 1 optional-peer set`（含字节级复制的 `assets/dsh-interconnect.md`）。

## 0.11.15（2026-09-15）

跟随 #3243 分支新 head（`7e671e5c72e9`）：把 `list` 应答的帧预算从固定常量改为按应答实测，并给入站 `reqId` 加上长度上限。

### 变更

- **`list` 应答按应答实测预算**：删除固定常量 `LIST_FRAME_ENVELOPE_BYTES` / `MAX_LIST_ROWS_BYTES`，改为 `listRowsBudgetBytes(reqId)` —— 用 `JSON.stringify` 实测这一条 `query-result` 的空信封（含peer 提供的 `reqId` 与本实例 id）占多少字节，再把 `MAX_LINK_FRAME_BYTES` 减去它作为行预算。原因是信封大小取决于对端送来的 `reqId`：预留固定常量既可能浪费预算、又挡不住超长 id 把整帧顶过上限（ws 收到超限帧会断开链路，发送方把截断读成传输失败）。信封本身都放不下时不再写任何东西（记一条 warn 后返回），让对端按超时处理，而不是写出一帧必然被断链的应答。
- **入站 `reqId` 加 256 字符上限**：四个带 `reqId` 的帧（`msg` / `msg-result` / `query` / `query-result`）schema 加 `.max(MAX_REQUEST_ID_CHARS)`。应答必须回显对端给的 id，无上限的 id 等于让对端决定本实例写出的帧有多大；本插件自己生成的 id 约 40 字符。超限的帧按既有 malformed 路径丢弃并记 `dropping malformed link frame`。
- **`@deepseek-ai/dsh-host-webserver` 标记为可选 peer**（`peerDependenciesMeta.optional`）：没有 webserver 的部署仍能安装本插件（服务照常拨号出站 peer，只是不接受入站链路）。门禁相应新增第 8 项校验：本仓 `package.json` 的 `peerDependenciesMeta` 必须与上游 `packages/experimental/interconnect/package.json` 一致（只比这张表，不比 peer 名——scoped 与 unscoped 的包名本就不同）。
- **上游新增 3 条用例**（`tests/interconnect.host.spec.ts`，1:1 移植）：最长可接受 `reqId` + 超长 instance id 下整帧仍在 1 MiB 以内且仍列出若干行；超限 `reqId` 被丢弃且不产生任何帧；信封本身就超限时不作答。

### 验证

- `pnpm run check`（typecheck + 164/164 tests + build）全绿（用例数 161 → 164）。
- 对齐门禁：`no behavioural drift against 7e671e5c72e9 across 7 ported files, 1 byte-exact asset, 1 patch row set, and 1 optional-peer set`。新增的 `peerDependenciesMeta` 检查做过负例（删掉该键 → DRIFT + exit 1，还原后绿）。
- 移植时 `src/interconnect/index.ts` 有 1 个 hunk 被拒：本仓该处 JSDoc 停留在更早的注释版本（注释漂移不被门禁视为行为差异），导致上下文不匹配；已按上游原文重写该段注释并补上 `listRowsBudgetBytes`，使该区域与上游逐字一致。

## 0.11.14（2026-09-15）

跟随 #3243 分支新 head（`2638a4273911`）移植措辞改动，并修复 0.11.13 引入的 CI 红灯。

### 变更

- **`resume-failed` 的模型可见文本更新**（`tool-interconnect`）：`not delivered: could not wake "<id>" on <instance> (no such persisted session, or another owner holds it)` → `(no persisted session under that id, or the wake itself failed)`。上游同时把「被别的 owner 占用」明确归属到 `session-owned-by-subagent` 分支，原措辞会让人以为这两种情况都落在 `resume-failed`。
- **两处 JSDoc 澄清**（无运行时影响）：`InterconnectService.broadcast` 补充「拨号链路已开、对端 `hello` 尚未到达」这个窗口内事件会经两个 socket 各发一次（瞬时重复，不是丢事件）；`Config.instanceId` 的唯一性说明改为描述实际的抑制规则（已有拨号链路的入站 socket 会被跳过）。
- **CI 修复：两个新 devDependency 改为从 npm 解析**。0.11.13 把 `@deepseek-ai/dsh-typert-protocol` 与 `@deepseek-ai/dsh-api-session-controller` 的 devDependency 写成了本机路径 `link:../.dsh/source/current/...`，而独立仓库 CI 只检出 public mirror 到 `dsh/`，该路径不存在 → `check` 在 typecheck 阶段以 TS2307 失败（3 处）。现改为发布版本 `^0.1.5-rc.2`。
- **为什么不是 `^0.1.6-alpha.1`**：该版本于 2026-09-15T03:09Z 发布，pnpm 11 默认 `minimumReleaseAge=1440` 会在本地与 CI 都拒装（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。`0.1.5-rc.2`（09-10 发布）已核实同时含 `remoteErrorOf`（根导出）与 `RemoteErrorDetailsMap` 合并声明（含 `session/agent-busy`），足以支撑 typecheck 与用例。
- **另含**（前一提交 `cdcaf4e`）：`scripts/probe-deployed-link.cjs` 默认改为解析 `ws` devDependency，不再硬编码某台宿主上的绝对路径。

### 验证

- `pnpm run check`（typecheck + 161/161 tests + build）全绿，devDependency 从 registry 解析。
- 对齐门禁：`no behavioural drift against 2638a4273911 across 7 ported files, 1 byte-exact asset, and 1 patch row set`（负例已在上游漂移时实际触发过一次：`tool-interconnect` 的消息字符串被门禁点名）。

## 0.11.13（2026-09-15）

跟随 #3243 分支新 head（`dddb32d80a`）：删除运行时 peer 路由 API、链路状态机重构、唤醒失败原因更准确，并澄清回复目标语义。

### 变更

- **删除运行时 peer 路由 API**：`InterconnectService.subscribe()` / `unsubscribe()` 与 `WebSocketLinkHandle` 类型移除；peer 只来自 `Config.peers`，激活时拨号一次，由链路状态自行重连（新增 `dialedPeerOf` 与 `attachDialedSocket`，`LinkState` 不再实现该句柄）。本包对外类型面因此少一个类型（pre-1.0，属预期）。
- **唤醒失败原因更准确**：Host 在恢复 subagent 占用的 session 时抛 `session/agent-busy`，现在经 `remoteErrorOf` 识别并返回 `session-owned-by-subagent`（此前落到 `resume-failed`）。
- **回复目标语义写进模型可见文本**（skill 正文 3 处 + `interconnect_reply` 工具描述）：recalled target **只记最近一个发送者**，不同对端的新消息会顶掉它、接收方重启即遗忘；多个对端可能给同一 session 发消息时应在回复文本里点名收件人。
- **新增 peer 依赖** `@deepseek-ai/dsh-typert-protocol`（`remoteErrorOf` 的来源）。
- **保留的一处适配**（与上游的差异，门禁中已登记）：上游本次把 `hasApiSessionSubagentOwner` 作为**值**从 `@deepseek-ai/dsh-api-session-controller` 入口导入，并在同一提交里给该包入口补了这条导出；本包安装所在的宿主仍解析旧入口，值导入会在加载时失败，故**保留镜像谓词**；另加一条**纯类型**子路径导入（`@deepseek-ai/dsh-api-session-controller/types`）加载 `session/agent-busy` 的 `RemoteErrorDetailsMap` 合并声明，零运行时代价。

### 验证

- `pnpm run check`（typecheck + 161/161 tests + build）全绿；用例数由 168 降至 161，是因为上游本次删除了 `subscribe`/`unsubscribe` 相关用例。
- 对齐门禁：`no behavioural drift against dddb32d80a across 7 ported files, 1 byte-exact asset, and 1 patch row set`。
- 产物：`lib/` 有 3 个文件与 0.11.12 不同（服务、根 bundle、tool），确认本版有真实行为变化。
- 三台部署升级后复核五种线上帧探测与链路。

## 0.11.12（2026-09-15）

跟随 #3243 分支新 head（`aeefb65bde`）：把 live 口径的措辞统一收尾（纯文档，无行为变化）。

### 变更

- `interconnect/types.ts`：`resume` 文档与 `session-not-live` 说明里的 `no running agent` → `no live agent`。
- **skill 正文**（`assets/dsh-interconnect.md`，模型可见且随包发布）：`persisted but not-running session` → `persisted session with no live agent`；失败原因说明里的 `no running agent` → `no live agent`。
- `tests/tool-interconnect.spec.ts`：一行注释改写（断言未变）。
- 上游同批还改了 monorepo 的两个 README（含 zh 与 i18n 配对文件），不进本包。

### 验证

- `pnpm run check`（typecheck + 168/168 tests + build）全绿。
- 对齐门禁：`no behavioural drift against aeefb65bde across 7 ported files, 1 byte-exact asset, and 1 patch row set`（其中 asset 是逐字节比较，移植前必红）。
- **产物核实**：新构建的 `lib/**/*.js` 与 0.11.11 的已发布产物 **7/7 哈希一致** —— 本版确实无行为变化，唯一随包变化的是 skill 正文（三台部署上模型读到的文本）。

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

## 0.8.0（2026-08-19，未单独发布）

此版本未发布到 npm，也没有对应 tag；下列改动随 0.9.0 发布。

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
