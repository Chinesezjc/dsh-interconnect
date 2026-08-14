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

- `interconnect_send`：向对端实例的指定 session 投递消息
- `interconnect_ping`：探测对端实例活性与身份

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
