# interconnect — DSH 跨实例互通插件（独立源码仓库）

DSH「跨 session / 跨实例 / 跨机器消息互通与事件通知」能力的独立源码仓库。

**状态说明**：本仓库从 DSH monorepo 抽出（对应 commit 见下），源码与 DSH `master`
上 `packages/interconnect/` 保持一致。由于依赖的 `@deepseek-ai/dsh-*` 包**尚未发布
到 npm**（实测 `npm view @deepseek-ai/dsh-host-webserver` 返回 404），本仓库**当前
不能脱离 DSH monorepo 独立 build**——须在 DSH monorepo 内使用，或等依赖发布后再
真正独立。

## 这是什么

两个 DSH host 级 Cordis 插件，配套使用：

**`@deepseek-ai/dsh-interconnect`**（host 服务，`ctx.interconnect`）：

- `send` / `ping` HTTP 端点（`/interconnect/*`）——跨实例、跨机器投递消息
- `/interconnect/link` WebSocket 端点——双向实时事件推流 + 心跳 + 指数退避重连
- 事件 fan-out（HTTP + WS），入站 emit `interconnect/event`
- 共享密钥鉴权（`DSH_INTERCONNECT_TOKEN`，bearer，fail-closed、timing-safe）

**`@deepseek-ai/dsh-tool-interconnect`**（模型可见工具）：

- `interconnect_send`（baseUrl/sessionId/text → 投递）
- `interconnect_ping`（baseUrl → reachable/instance）

## 目录结构

- `package/` —— 服务包源码（`src/`、`tests/`、`package.json`、`tsconfig.json`）
- `tool-package/` —— 工具包源码（`src/`、`tests/`、`package.json`、`tsconfig.json`）
- `patches/` —— 接入 DSH monorepo 的三处接线补丁：
  - `tsconfig.base.patch`（新增 `interconnect` group 的 paths wildcard，2 行）
  - `tsconfig.host.patch`（新增两个包的 project reference）
  - `pnpm-lock.patch`（新增 `ws` + `@types/ws` 依赖锁定）

## 关键架构结论

1. **`interconnect` 服务必须放 host composition**（跨 session、跨机器的进程级能力，
   有 HTTP/WS 端点、被 host 侧消费）。放 agent preset 会在第二个 session 撞服务名。

2. **`tool-interconnect` 也必须放 host composition，不能放 agent preset。**
   原因（实测踩过）：`interconnect` 是普通 host Service，**没有 `@Remote`/TypeRT
   Gateway 绑定**。agent preset 的 isolate realm 里，tool 行 `inject: ['interconnect']`
   无法跨 realm 解析到它，mount 报 `cannot get property "interconnect" without inject`。
   所以两个包放同一 host insert 里，tool 直接 inject 同层的服务。

3. 工具包导出结构：`export const inject` + `export function apply`，无 `name` /
   `default export`（对齐 `tool-tasks`）。

## 依赖与 API 漂移

依赖 DSH monorepo（`workspace:^`），当前未发布到 npm：

- 服务包 `dependencies`: `@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/schemastery`、`ws`
- 服务包 `peerDependencies`: `dsh-agent`、`dsh-credentials`、`dsh-llm`、`dsh-session`、
  `dsh-subagent`、`dsh-host-webserver`、`cordis`
- 工具包 `dependencies`: `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`
- 工具包 `peerDependencies`: `dsh-interconnect`、`dsh-invariants`、`cordis`

**已在 master 上发生的 API 漂移（本仓库已对齐）**：

| 旧名 | 新名 |
|---|---|
| `httpServer` 服务 | `webServer`（`ctx.webServer.register/registerUpgrade`） |
| `Credentials` 抽象类 | `CredentialProvider` |
| `packages/support/invariants` | `packages/runtime-diagnostics/invariants` |
| `HttpServerService` 类型 | `WebServer` |

**运行时依赖的关键 DSH API**：

| API | 来源包 |
|---|---|
| `SubagentRunEndInfo`（含 `provider`/`id`/`stopReason`/`local`） | `@deepseek-ai/dsh-subagent` |
| `Session.header.parentSession` | `@deepseek-ai/dsh-session` |
| `clientRequestSchema` / `serverResponseSchema` / `RpcId` | `@deepseek-ai/dsh-host-apiproxy/api` |
| `registerUpgrade`（WebSocket 升级路由）、`WebRoute` | `@deepseek-ai/dsh-host-webserver` |
| `createUserMessage` | `@deepseek-ai/dsh-llm` |
| `credentialRef` / `CredentialProvider.resolve` | `@deepseek-ai/dsh-credentials` |
| `Agent.followup` / `Agent.inject` | `@deepseek-ai/dsh-agent` |
| `defineTool` / `ToolRegistry` | `@deepseek-ai/dsh-tools` |

## 迁移 / 交付形态

依赖发布后，三条路径可选：

1. **作为 DSH 官方 monorepo 的 PR**（把两个包放回
   `packages/interconnect/{interconnect,tool-interconnect}/`，加 `patches/` 接线）——
   这已经在 DSH `master` 上（feat + merge + rename-fix 三个 commit，尚未进 release tag）。
2. **作为独立 npm 包**（发布两个包，host composition 里 `insert` 引用）。
3. **作为个人仓库的可安装 profile bundle**。

**挂载**（两个包同一 host insert）：

```yaml
- insert:
    - id: interconnect
      name: '@deepseek-ai/dsh-interconnect'
      config:
        instanceId: <本实例名>
        requestTimeoutMs: 10000
    - id: tool-interconnect
      name: '@deepseek-ai/dsh-tool-interconnect'
```

**鉴权**：宿主 `.credentials.yaml`（或等价）设 `DSH_INTERCONNECT_TOKEN`，两端一致。
`ws` 是 `dependencies`，宿主需可用（pnpm install 或符号链接）。

## 验证状态

- 服务包 16/16 单测绿、工具包 5/5 单测绿；oxlint 干净；`tsc -b` 干净；tsdown 构建成功。
- 真双机跨公网实测：本机 Mac ↔ MomoiAiri（49.233.186.89），ping/send/WS 全部打通。
- **双向 agent 级回发实测**：本机发 MomoiAiri，MomoiAiri agent 真实调用
  `interconnect_send` 回发到本机 session，`delivered:true`、消息真实到达本机 inbox。
- 详见个人 `~/.dsh/MEMORY.md` 的 `interconnect` 各轮记录。

## 对应 DSH monorepo 状态

- 源码取自 commit `290643b5d0`（`fix(interconnect): align with master renames after merge`），
  HEAD 之上 merge 了 `origin/master`。
- DSH 已发布 `dsh-v0.1.0-rc.1` / `rc.2` / `rc.3`，但 `feat(interconnect)` 尚未进入任何
  release tag（`git tag --contains` 为空）。
