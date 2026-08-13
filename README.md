# dsh-interconnect

跨实例消息互通与事件通知插件，用于 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) (DSH)。
让一个 DSH 实例能向同一个实例、另一台机器、或另一台机器上的别的 DSH 实例发送消息、探测活性，并在实例之间双向推送事件。

## 包含两个插件

**`@deepseek-ai/dsh-interconnect`** —— host 服务（`ctx.interconnect`）：

- `send` / `ping` HTTP 端点（`/interconnect/*`）：跨实例、跨机器投递消息、探测活性
- `/interconnect/link` WebSocket 端点：双向实时事件推流，含心跳与指数退避重连
- 事件 fan-out（HTTP + WebSocket），入站事件以 `interconnect/event` 发出
- 共享密钥鉴权（`DSH_INTERCONNECT_TOKEN`，bearer，fail-closed，timing-safe 比较）

**`@deepseek-ai/dsh-tool-interconnect`** —— 模型可见工具：

- `interconnect_send`：向对端实例的指定 session 投递消息
- `interconnect_ping`：探测对端实例活性与身份

## 快速开始

1. 把两个包放进 DSH monorepo 的 `packages/interconnect/{interconnect,tool-interconnect}/`，
   并在 `tsconfig.base.json` / `tsconfig.host.json` 里补上接线（见 `patches/` 下的三个补丁）。

2. 在 host 的 `cordis.patch.yml` 里挂载（两个包放同一 `insert`）：

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

3. 两端实例的 `.credentials.yaml`（或等价凭据源）设置相同的
   `DSH_INTERCONNECT_TOKEN`，作为共享密钥。

## 架构说明

- 两个插件都挂在 **host composition**：`interconnect` 是跨 session、跨机器的进程级
  服务（有 HTTP/WS 端点），必须 host 级；`tool-interconnect` 也放 host，因为
  `interconnect` 未做 TypeRT `@Remote`/Gateway 绑定，放进 agent preset 的 isolate
  realm 会导致工具行无法 inject 到该服务。
- `ws` 是运行依赖，宿主需可用。

## 验证

- 服务包 16/16 单测、工具包 5/5 单测通过；lint、类型检查、构建均干净。
- 已在两台机器之间实测双向互通：消息投递、WebSocket 事件推流、以及 agent 经
  `interconnect_send` 工具反向回发，均验证通过。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
