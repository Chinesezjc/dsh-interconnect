# dsh-interconnect

跨实例消息互通与事件通知插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)。
让一个 DSH 实例能向同一个实例、另一台机器、或另一台机器上的别的 DSH 实例发送消息、探测活性，并在实例之间双向推送事件。

## 包含两个插件

**`interconnect`** —— host 服务（`ctx.interconnect`）：

- `send` / `ping` HTTP 端点（`/interconnect/*`）：跨实例、跨机器投递消息、探测活性
- `/interconnect/link` WebSocket 端点：双向实时事件推流，含心跳与指数退避重连
- 事件 fan-out（HTTP + WebSocket），入站事件以 `interconnect/event` 发出
- 共享密钥鉴权（`DSH_INTERCONNECT_TOKEN`，bearer，fail-closed，timing-safe 比较）

**`tool-interconnect`** —— 模型可见工具：

- `interconnect_send`：向对端实例的指定 session 投递消息，可选 `delivery` 指定投递模式
- `interconnect_list`：列出对端实例的 live session（id + 标题 + 状态），用于在不预先知道 session id 时寻址
- `interconnect_ping`：探测对端实例活性与身份

### 寻址

`interconnect_send` 需要一个 session id，而调用方通常并不知道。`interconnect_list` 返回对端
**当前 live** 的 session，每一行的 `sessionId` 在调用时刻都是合法的投递目标：

```
session-264d37b0-…  重构 interconnect 插件  [idle]
session-b07326da-…                          [running]
```

`title` 与 `status` 是尽力而为的：标题来自可选的 title projection 服务，对端没装该服务、或
该 session 还没有标题时，**整个键不出现**（而不是空字符串），所以「无标题」与「该对端不提供
标题」可以区分。projection 抛错只会让那一行降级成只有 id，不会让整个列表失败。

只列 live session 是有意的：`send` 能到达的正好是这些。对端存在但没有运行 agent 的 session
不会出现在列表里，也收不到消息。

### 投递失败的原因

`delivered: false` 单独一个布尔值无法据以行动，因为不同失败需要不同应对，所以
`SendResult.reason` 会指明是哪一种：

| `reason` | 含义 | 应对 |
|---|---|---|
| `session-not-live` | 对端**答复了**，但那个 session 没有运行中的 agent | 重试同一个 id 无用；用 `interconnect_list` 换目标，或带 `resume` |
| `unreachable` | 没拿到可用答复（传输失败，或鉴权被拒） | 目标 session 可能完好，重试可能成功 |
| `resume-refused` | 请求了唤醒，但对端不允许（`allowResume: false`） | 再带 `resume` 也没用 |
| `resume-failed` | 允许唤醒且尝试了，但没得到 live agent（无此持久化 session，或被别的 owner 持有） | 换目标 |

`reason` 恰好在 `delivered` 为 false 时出现。

### 唤醒离线 session（`resume`，默认关）

`SendPayload.resume: true` 让对端唤醒一个已持久化但没有运行 agent 的 session。

**默认关闭是有意的。** 实测确认：消息投递到 session 后会触发一次**完整的 agent 回合**——
`wakeDriver()` → `kick()` → `turn()` → `llm.stream()`，即一次计费的模型调用，且 assembly
里带着该 session 的完整工具集。在一个用户没打开、看不到、也无法中断的会话里启动这些，和
「推一下已经开着的会话」不是一个量级，所以必须由发送方显式请求。

两侧都有控制权：

- **发送方**按消息决定 `resume`（默认不唤醒）
- **接收方**用 `Config.allowResume`（默认 `true`）一票否决——因为花钱和跑工具的是它那台机器；
  拒绝时在跑 lookup 之前就短路，回 `resume-refused`

唤醒**不是**调本插件的 `ctx.agents.resume()`，而是走 Host 已配置的 `agent` lookup
（`typert.lookups.get('agent')`）。这一点是关键：`resume()` 返回的 handle 由**调用方
context** 拥有，实测确认插件 fiber 被 dispose 时会把 resume 出来的 agent 和 session 一起
拆掉（同一调用改用根 ctx 则两者都存活）。交给 Host 的 resolver 之后 owner 是 api-proxy，
而且它会按 session 日志里记录的 preset 重建工具集——不是空壳。

没有 Host lookup 的部署（headless、无 api-proxy 的 profile）会降级为 `session-not-live`，
不会报错。

### 投递模式

`delivery` 的三个取值各自对应一个 `Agent` 方法，即 `(inbox target, wakeup)` 组合：

| 模式 | inbox target | 唤醒 | 行为 |
|---|---|---|---|
| `followup` | `next-turn` | 是 | 排队成独立一轮，等接收方当前那轮结束 |
| `steer` | `next-step` | 是 | 插进运行中那轮的最近 step 边界，不等整轮结束；接收方 idle 时起新一轮 |
| `inject` | `next-step` | 否 | 只写入上下文，不唤醒 idle 的 agent，可能一直不被读到 |

紧急程度属于单条消息而非整条链路，所以发送方可以按消息覆盖接收方的默认模式；不带
该字段时沿用接收方 `Config.delivery` 的配置。`SendResult.delivery` 回报实际生效的
模式，发送方据此判断覆盖是否被采纳。

## 安装

本包已发布到 npm：[`dsh-interconnect`](https://www.npmjs.com/package/dsh-interconnect)。
本仓库是一个 DSH profile bundle（根 `package.json` 声明 `dsh.bundle.patch` 指向
根 `cordis.patch.yml`，后者 `insert` 两个插件行）。

```bash
# 从 npm
dsh plugin --profile <name> add dsh-interconnect

# 或从本地路径（已实测）
dsh plugin --profile <name> add file:/path/to/dsh-interconnect
```

registry 上的 tarball 自带 `lib/*.js` 与 `lib/types/**/*.d.ts`，安装时不跑构建。

`dsh plugin add` 会把仓库识别为 bundle 并追加进 profile 的 `dsh.profile.bundles`。重启
web 服务使 host 侧生效。两端实例的 `.credentials.yaml`（或等价凭据源）设置相同的
`DSH_INTERCONNECT_TOKEN` 作为共享密钥。

## 开发

依赖 [公开的 DeepSeek Harness monorepo](https://github.com/deepseek-ai/deepseek-harness)
作为 sibling checkout：`package.json` 的 `devDependencies` 用 `link:../dsh/...` 指向它，
peer 依赖由该 checkout 提供，构建与测试都跑在这份源码上。

```bash
ln -s /path/to/deepseek-harness ../dsh
pnpm install --config.auto-install-peers=false   # peer @deepseek-ai/dsh-* 由 sibling checkout 提供
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/
```

## 架构说明

- 两个插件都挂在 **host composition**：`interconnect` 是跨 session、跨机器的进程级
  服务（有 HTTP/WS 端点），必须 host 级；`tool-interconnect` 也放 host，因为
  `interconnect` 未做 TypeRT `@Remote`/Gateway 绑定，放进 agent preset 的 isolate
  realm 会导致工具行无法 inject 到该服务。
- `ws` 是运行依赖，由宿主的 node_modules 提供（构建时 external）。

## 验证

- 22/22 单测通过（服务 17 + 工具 5）；类型检查、构建均干净。
- 已在两台机器之间实测双向互通：消息投递、WebSocket 事件推流、以及 agent 经
  `interconnect_send` 工具反向回发，均验证通过。
- CI（GitHub Actions）：clone 公开 DSH 仓库作为 sibling，跑 `pnpm run check`。
- 已发布版本：从 registry 下载的 tarball 与本地构建 shasum 一致；干净消费端
  解析 `.`、`./tool-interconnect` 两个入口的类型均通过，负例（把 `string` 赋给
  `number`）如期报 `TS2322`。
- 投递消息的 `source` 为 `{ kind: 'plugin', plugin: 'dsh-interconnect' }`，不是
  `{ kind: 'user' }`——接收方 agent 据此区分跨实例投递与本地用户输入。负例：把
  该 source 改回 `kind: 'user'`，对应断言转红。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
