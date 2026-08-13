# dsh-interconnect

跨实例消息互通与事件通知插件，用于 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) (DSH)。
让一个 DSH 实例能向同一个实例、另一台机器、或另一台机器上的别的 DSH 实例发送消息、探测活性，并在实例之间双向推送事件。

## 包含两个插件

**`interconnect`** —— host 服务（`ctx.interconnect`）：

- `send` / `ping` HTTP 端点（`/interconnect/*`）：跨实例、跨机器投递消息、探测活性
- `/interconnect/link` WebSocket 端点：双向实时事件推流，含心跳与指数退避重连
- 事件 fan-out（HTTP + WebSocket），入站事件以 `interconnect/event` 发出
- 共享密钥鉴权（`DSH_INTERCONNECT_TOKEN`，bearer，fail-closed，timing-safe 比较）

**`tool-interconnect`** —— 模型可见工具：

- `interconnect_send`：向对端实例的指定 session 投递消息
- `interconnect_ping`：探测对端实例活性与身份

## 安装

本仓库是一个 DSH profile bundle（`dsh.bundle.patch` 指向根 `cordis.patch.yml`）。

```bash
dsh plugin --profile <name> add file:/path/to/dsh-interconnect
```

重启 web 服务使 host 侧与前端 bundle 生效。两端实例的 `.credentials.yaml`（或等价
凭据源）设置相同的 `DSH_INTERCONNECT_TOKEN` 作为共享密钥。

## 开发

依赖一个 sibling DSH checkout（`link:../dsh/...`，见 `package.json` 的
`devDependencies`）。把插件目录放在 DSH monorepo 旁边，或建软链接 `../dsh` 指向它：

```bash
ln -s /path/to/deepseek-harness ../dsh
pnpm install --config.auto-install-peers=false   # peer @deepseek-ai/dsh-* 由 sibling checkout 提供
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/
```

`@deepseek-ai/dsh-*` 未经 npm 发布，故 peer 依赖由宿主的 DSH checkout / profile
workspace 提供（`autoInstallPeers: false`），与社区 `dsh-plugin` 的通用做法一致。

## 架构说明

- 两个插件都挂在 **host composition**：`interconnect` 是跨 session、跨机器的进程级
  服务（有 HTTP/WS 端点），必须 host 级；`tool-interconnect` 也放 host，因为
  `interconnect` 未做 TypeRT `@Remote`/Gateway 绑定，放进 agent preset 的 isolate
  realm 会导致工具行无法 inject 到该服务。
- `ws` 是运行依赖，宿主需可用。

## 验证

- 21/21 单测通过（服务 16 + 工具 5）；类型检查、构建均干净。
- 已在两台机器之间实测双向互通：消息投递、WebSocket 事件推流、以及 agent 经
  `interconnect_send` 工具反向回发，均验证通过。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
