# DSH Interconnect 联邦协议草案（A：跨管理域）

状态：Draft 0.1，未实现  
日期：2026-11-06  
范围：不同管理域之间的消息投递。同一域内继续使用现有的直连 WebSocket 与 `peers` 模型。

本文只定义协议语义与最小 HTTP 绑定，不定义任何代码结构。字段名、错误码和 JSON 形状是草案，落地前可以改。

核心决策：

- 地址是 `instance@domain`，发现走域名的 well-known 文档；没有 DNS 域时 `domain` 退化为命名空间，用 relay 提供的命名空间或静态配置的 relay/公钥。
- 共享注册商是可选的默认入口：域级 well-known 只给出 `registry` 指针，公钥按 instance 查询；用户也可以自建注册商。
- 信封用 Ed25519 签名，规范化用 JCS；relay 原样转发，只追加 `trace`。
- 同步提交只有 `accepted` / `deferred` / `rejected` 三态；投递结果用接收方签名的异步回执。
- 跨域默认 deny，跨域 `wake` 默认 false；所有永久拒收发生在计费之前。
- relay 持久化后才返回 `accepted`，禁止开放中继；v1 的 relay 默认可见正文。

## 1. 目标

- 发送方不需要知道接收方当前的 `IP:port`。
- 接收方可以在**计费或唤醒会话之前**接受、延迟或拒收。
- 消息在 TTL 内可以经过 relay 存储转发。
- 接受（accepted）与投递（delivered）分离，投递结果通过签名回执返回。
- 跨域默认拒绝，按域/实例显式放行。
- 不要求与 SMTP 或 email 线缆兼容。

## 2. 非目标

- SMTP/email 互通、25 端口、MX 记录。
- 强制的全局 `instanceId` 注册表；共享注册商是可选入口，不是唯一权威。
- 匿名发送、开放中继。
- 严格全局顺序或 exactly-once。
- 附件、富媒体、代码执行；v1 只传文本。
- 跨域强制 `steer` 或其它本地投递模式。

这些约束会让协议自然地长得像 email：存储转发、信封、relay、回执、接受/延迟/拒收。相似性来自需求，
不是要复刻 SMTP。v1 只借这些语义，不实现 SMTP 线缆、MX 发现或开放中继。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 域（domain） | 一个 DNS 名，代表一个管理/信任边界 |
| 实例（instance） | 域内唯一的 DSH 实例，联邦地址为 `instance@domain` |
| 会话（session） | 实例内的 agent 会话；session id 只在实例内有意义 |
| relay | 接收、排队、转发信封的节点；可以是域的边缘，也可以是独立中继 |
| mailbox | relay 上按接收实例划分的持久队列 |
| envelope | 发送方签名的消息信封 |
| receipt | 接收方签名、异步返回的投递回执 |
| acceptor | 对某次提交做出同步接受/延迟/拒收决定的节点（通常是接收域的 relay） |

## 4. 身份与寻址

### 4.1 地址

```
instance@domain
```

- `domain`：命名空间标签。默认是小写 DNS 名（IDNA A-label，最长 253 字符）；没有 DNS 域时也可以是配置里的静态命名空间（见 4.3），字符集 `[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?`。
- `instance`：`[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?`，最长 64 字符；区分大小写，但推荐全小写。
- 现有 `Config.instanceId` 允许更宽的字符集和 256 字符；跨域实例必须另外配置一个符合上述规则的 `federatedId`，不能直接把本地 id 当联邦地址。
- `session`：opaque，`[A-Za-z0-9._:-]{1,128}`；只对目标实例有意义。

### 4.2 发现（DNS 命名空间）

DNS 命名空间默认使用 well-known：

```
GET https://<domain>/.well-known/dsh-interconnect
Accept: application/dsh-interconnect-discovery+json
```

响应：

```json
{
  "version": 1,
  "mode": "single",
  "relay": "https://relay.example.com/v1",
  "keys": [
    {
      "kid": "2026-11-01",
      "alg": "ed25519",
      "publicKey": "base64url"
    }
  ],
  "policy": {
    "accept": "allowlist",
    "maxEnvelopeBytes": 1048576
  }
}
```

- `mode`：`single` 表示单租户域，公钥在域级发现记录里；`shared` 表示共享注册商，公钥按 instance 查询（见 4.4）。
- `relay` 是提交信封的 HTTPS 基址；没有 relay 的域可以填自己的主机。
- `keys` 在 `mode: "single"` 时至少一个；`mode: "shared"` 时省略，由注册商按 instance 返回。
- `registry` 在 `mode: "shared"` 时必填，是注册商的 API 基址。
- `policy` 只是提示，真正的接受策略由接收方执行；发送方不能据此跳过本地限制。
- 响应必须走 TLS；缓存不超过 `Cache-Control: max-age`，上限 1 小时；取不到新记录时可以使用未过期的缓存，否则该域不可发送。
- 可选 DNS TXT `_dsh-interconnect.<domain>` 作为备用发现通道：`v=1; relay=...; key=...`。v1 以 well-known 为主，TXT 只用于无法访问 HTTPS 的受控网络。

### 4.3 没有 DNS 域时

`domain` 首先是命名空间，不强制是一个可解析的 DNS 名。没有域名时，按信任锚选一种：

1. **使用 relay 提供的命名空间（推荐）**
   双方都注册到同一个 relay，地址变成 `alice@relay.example`、`bob@relay.example`。`relay.example` 是 relay 运营方的真实域，well-known 和密钥由它提供；用户不需要拥有域名。代价是信任集中到 relay 运营方。

2. **静态发现（小圈子/自建）**
   在 `federation.namespaces` 里直接配置命名空间到 relay 和公钥：

   ```yaml
   federation:
     namespaces:
       "team-a":
         relay: https://relay.example.com/v1
         keys:
           - kid: "2026-11-01"
             alg: ed25519
             publicKey: base64url
   ```

   地址 `alice@team-a` 里的 `team-a` 不是 DNS 名，不会发起 well-known 请求；配置就是权威。公钥是钉住的，换钥必须显式更新配置。这要求双方手工交换一次 relay 地址和公钥，适合固定小圈子。

3. **局域网 mDNS**
   同一广播域内用 `_dsh-interconnect._tcp.local` 发布 relay/端口，命名空间用 `.local` 或专用标签。跨网段、NAT、随机端口场景不可用；不作为默认。

4. **TOFU（不推荐作为默认）**
   首次连接时记录对方公钥，之后变更告警。没有域名或 relay 作为信任锚，最容易受中间人攻击；只能在低风险场景使用。

没有域名、也不接受以上任何一种信任锚时，不应启用跨域；继续用同域的 `peers` + 固定端口/隧道。

### 4.4 共享注册商（默认入口）

像 `dsh.hanasatominori.cn` 这样的共享注册商，让没有域名的用户直接得到 `alice@dsh.hanasatominori.cn`。它是可选的默认入口，不是协议必需；自建注册商使用同一套 API。

#### 4.4.1 域级发现

```json
{
  "version": 1,
  "mode": "shared",
  "registry": "https://dsh.hanasatominori.cn/v1",
  "relay": "https://relay.dsh.hanasatominori.cn/v1",
  "registryKeys": [
    { "kid": "registry-2026-11", "alg": "ed25519", "publicKey": "base64url" }
  ],
  "policy": { "accept": "allowlist" }
}
```

- 域级记录不含用户公钥；`registry` 是按 instance 查询的唯一权威。
- `registryKeys` 是注册商自己的 checkpoint/日志签名密钥，不是用户密钥；用户公钥只能从按实例查询获得。
- `relay` 是默认 relay；单个实例可以在注册记录里覆盖。
- `mode: "shared"` 的域不能把域级 `keys` 当作所有用户的公钥。

#### 4.4.2 按实例查询

```
GET {registry}/instances/{instance}
Accept: application/dsh-interconnect-registry+json
```

```json
{
  "version": 1,
  "instance": "alice",
  "keys": [
    { "kid": "2026-11-01", "alg": "ed25519", "publicKey": "base64url" }
  ],
  "relay": "https://relay.dsh.hanasatominori.cn/v1",
  "status": "active",
  "updatedAt": "2026-11-06T08:00:00Z",
  "logSeq": 1042,
  "movedTo": null
}
```

- `instance` 按 4.1 的字符集和大小写；路径段做 percent-encoding。
- 缓存不超过 1 小时；遇到未知 `kid` 时强制刷新一次。
- `logSeq` 是该记录对应的日志序号；客户端应校验这些 key 在透明日志的该序号处存在，防止注册商只改查询响应、不改日志。
- `status`：`active`、`suspended`、`disabled`。`suspended`/`disabled` 按 `policy/sender-blocked` 处理；作为收件人时返回 `recipient/gone`。
- `movedTo` 非空表示该地址已迁移；发送方应展示给用户，不自动跟随，避免被注册商或旧地址劫持。
- 查询响应由 TLS 认证；如果存在第三方镜像，注册商可以对响应加签名 checkpoint，客户端按 4.4.5 校验。

#### 4.4.3 注册

```
GET  {registry}/challenges?instance={instance}&action=register
POST {registry}/instances
Content-Type: application/dsh-interconnect-registry+json
```

注册请求：

```json
{
  "version": 1,
  "instance": "alice",
  "keys": [
    { "kid": "2026-11-01", "alg": "ed25519", "publicKey": "base64url" }
  ],
  "proof": {
    "challenge": "base64url",
    "signature": "base64url"
  },
  "contact": "alice@example.com",
  "relay": "https://relay.dsh.hanasatominori.cn/v1"
}
```

- `GET /challenges` 返回 `{challenge, expiresAt}`，一次性使用；challenge 必须绑定 `instance` 和 `action`（`register`/`rotate`/`delete`）。
- `proof.signature` 是对 JCS(`{instance, action, challenge, keys}`) 的签名，用请求里提交的私钥生成，证明持有私钥。
- `contact` 用于滥用联络和账号恢复，不进入公开发现记录；注册商必须说明保存时长。
- 注册商检查名字语法、保留名、唯一性、proof、联系方式、速率和 AUP；成功返回 `201 {instance, status, createdAt}`。
- 注册商**不得接收私钥**，也不得代替用户生成密钥。
- 默认注册商必须 opt-in：客户端第一次跨域发送时提示，不静默注册。

#### 4.4.4 换钥

```
GET  {registry}/challenges?instance={instance}&action=rotate
POST {registry}/instances/{instance}/keys
```

```json
{
  "add": [{ "kid": "2026-12-01", "alg": "ed25519", "publicKey": "base64url" }],
  "remove": ["2026-11-01"],
  "proof": {
    "challenge": "base64url",
    "signedBy": "2026-11-01",
    "signature": "base64url"
  }
}
```

- `proof` 由当前某个有效 key 对 JCS(`{instance, action: "rotate", challenge, add, remove}`) 签名；challenge 一次性使用，防止重放旧的换钥请求。
- 新 key 先加入，旧 key 至少保留一个最大 TTL 的宽限期；宽限期内两条 key 都能验签。
- 丢失全部私钥时没有自动恢复；注册商可以提供带延迟和审计的人工恢复，或者明确声明账号不可恢复。这个策略必须在注册时写清楚。

#### 4.4.5 透明日志

注册商维护 append-only 日志，至少记录：

```json
{
  "seq": 1042,
  "instance": "alice",
  "action": "add-key",
  "keys": ["2026-12-01"],
  "at": "2026-11-06T08:00:00Z",
  "previousHash": "base64url",
  "hash": "base64url"
}
```

- `action`：`register`、`add-key`、`remove-key`、`suspend`、`delete`、`move`。
- `GET {registry}/log?after={seq}` 返回条目；`GET {registry}/log/checkpoint` 返回 `{seq, hash, at, signature}`，由 `registryKeys` 之一签名；`GET {registry}/log/proof/{instance}` 返回该实例的包含证明。
- 客户端固定最近的 checkpoint，检测回滚；同一 `seq` 的 `hash` 变化视为 `registry/log-rollback`。
- 换钥必须出现在日志里；发现某实例的 key 变了但日志没有对应条目时，客户端应拒绝新 key 并告警。按实例查询返回的 `logSeq` 必须能对应到同一条日志记录。

#### 4.4.6 删除与迁出

- `DELETE {registry}/instances/{instance}` 必须由当前 key 签名；删除后保留 tombstone，至少一个最大 TTL，防止他人抢注同一地址。
- `GET {registry}/instances/{instance}/export` 返回公钥、relay、日志条目和注册时间；用户可导入自建注册商或另一家注册商。
- 迁移到新域时，旧记录写 `movedTo`；发送方只展示提示，不自动把消息改投新地址。
- 旧地址在宽限期内不能被第三方重新注册；宽限期结束后是否允许复用由注册商策略决定，必须公开。

#### 4.4.7 滥用与暂停

- `suspended` 停止新消息和新注册；已有 mailbox 冻结还是继续投递，由 AUP 说明。
- 保留名：`admin`、`support`、`postmaster`、`abuse`、`security` 等。
- 注册需要验证（邮箱/OAuth/GitHub）、限流、CAPTCHA 或等价手段；公开注册初期建议邀请制或灰度。
- 冒充、钓鱼、垃圾消息的举报入口、证据要求、暂停和申诉流程必须公开。
- 暂停和删除同样写入透明日志。

#### 4.4.8 默认部署与自建

- 初始社区默认注册商使用 `dsh.hanasatominori.cn`；该域名由项目维护者持有。它是**部署选择**，不写进协议常量，客户端通过 `federation.defaultRegistry` 配置。
- 域名控制：注册商锁定、双因素、DNSSEC、CAA、HSTS；TLS 证书自动续期；到期和联系人变更要有告警。
- 密钥托管：注册商的 checkpoint/日志签名密钥与用户密钥分离；根密钥离线保存或有明确的多签/恢复流程；透明日志的 checkpoint 定期备份。
- 运营披露：默认服务按社区服务提供，不承诺 SLA；提供状态页、事件联系人和故障公告。首次使用时披露谁能看到元数据、谁能看到正文、数据保存多久、受哪地法律管辖、如何迁出。
- 自建注册商实现 4.4.1–4.4.6 的同一套 API；单租户域可以完全跳过注册商，使用 4.2 的 `mode: "single"`。
- 默认注册商和默认 relay 应能分离部署；初期可以由同一运营方提供，但协议不要求绑定。
- 默认服务不应成为联邦的唯一入口；自建域、其它注册商和静态发现必须是一等公民。
- 域名或运营方变更时，旧注册商至少保留一个迁移宽限期，写 `movedTo`，并提供 `export`；不能静默把用户锁在旧域。

#### 4.4.9 注册错误码

| 代码 | 类别 | 含义 |
|---|---|---|
| `registry/name-invalid` | permanent | 名字不符合 4.1 的字符集或长度 |
| `registry/name-taken` | permanent | 名字已被注册，且不在可复用宽限期 |
| `registry/name-reserved` | permanent | 保留名或受保护品牌 |
| `registry/proof-failed` | permanent | challenge 签名验证失败 |
| `registry/challenge-expired` | permanent | challenge 已过期，需要重新获取 |
| `registry/key-conflict` | permanent | 同一 `kid` 对应不同公钥 |
| `registry/not-found` | permanent | 实例不存在 |
| `registry/suspended` | permanent | 实例或注册商被暂停 |
| `registry/quota` | temporary | 配额暂时耗尽，`retryAfter` 后重试 |
| `registry/rate-limited` | temporary | 注册/查询速率超限 |
| `registry/unavailable` | temporary | 注册商暂时不可用 |
| `registry/log-rollback` | permanent | 客户端检测到日志回滚，必须停止信任 |

## 5. 传输与角色

### 5.1 同域

继续使用现有直连 WebSocket：`peers` 里的固定 origin、`/interconnect/link`、共享 token。联邦协议不改变同域语义。

### 5.2 跨域

最小 HTTP 绑定：

- 提交：`POST {relay}/messages`，`Content-Type: application/dsh-interconnect+json`。
- 接收：接收实例向自己的 relay 维持一条 WSS 订阅，或轮询 `POST {relay}/mailbox/claim`；两者使用同一套信封与回执。订阅/领取必须用域密钥对 `address + nonce + timestamp` 签名，relay 用该域的发现记录验签，防止他人冒领 mailbox。
- relay 到 relay：同一 `POST /messages`，信封原样转发，只追加 `trace`。
- 回执：走反方向的 `POST /messages`，`kind: "receipt"`。

传输层只负责送达 acceptor；接受语义由第 8 节定义。

## 6. 信封

### 6.1 字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `version` | 是 | integer | 当前为 `1` |
| `kind` | 是 | string | `message` 或 `receipt` |
| `id` | 是 | string | 发送方生成的全局唯一 id：UUIDv7 或 ULID；同一发送方内不可复用 |
| `from` | 是 | string | `instance@domain` |
| `fromSession` | 否 | string | 发送方会话；回执和 reply 的目标 |
| `to` | 是 | string | `instance@domain` |
| `toSession` | 条件 | string | `kind: "message"` 时必填；回执省略 |
| `createdAt` | 是 | string | RFC 3339 UTC，秒级 |
| `expiresAt` | 是 | string | RFC 3339 UTC；必须晚于 `createdAt`，默认 24 小时，最大 7 天 |
| `contentType` | 是 | string | v1 只允许 `text/plain; charset=utf-8` 和 `text/markdown; charset=utf-8` |
| `body` | 是 | string | UTF-8 正文；最大 512 KiB |
| `replyTo` | 否 | string | 默认等于 `from`；回执和后续回复的目标 |
| `inReplyTo` | 条件 | string | `kind: "receipt"` 时必填，指向原消息 `id` |
| `wake` | 否 | boolean | 是否请求唤醒离线会话；默认 `false` |
| `headers` | 否 | object | 最多 16 项；键 `[a-z0-9-]{1,64}`，值最长 1 KiB，总大小 8 KiB；不进入模型上下文 |
| `trace` | 否 | array | 最多 8 项，每项 `{relay, at}`：`relay` 为域名，`at` 为 RFC 3339 UTC；relay 追加，不参与签名 |
| `signature` | 是 | object | `{alg: "ed25519", kid, value}`，`value` 为 base64url |

### 6.2 示例

```json
{
  "version": 1,
  "kind": "message",
  "id": "0198f3a2-7c41-7d3e-9b62-2f6f0a1c4d55",
  "from": "alice@a.example",
  "fromSession": "session-8f09b367",
  "to": "bob@b.example",
  "toSession": "session-264d37b0",
  "createdAt": "2026-11-06T08:00:00Z",
  "expiresAt": "2026-11-07T08:00:00Z",
  "contentType": "text/plain; charset=utf-8",
  "body": "请把 0.15.0 的产物 hash 发我。",
  "replyTo": "alice@a.example",
  "wake": false,
  "trace": [],
  "signature": {
    "alg": "ed25519",
    "kid": "2026-11-01",
    "value": "base64url"
  }
}
```

### 6.3 大小与 TTL

- 整个信封序列化后最大 1 MiB；`body` 最大 512 KiB。
- `expiresAt` 超过 7 天或早于 `createdAt` 的信封直接拒收。
- 收到时已过 `expiresAt` 的信封：`payload/expired`，永久拒收。
- `createdAt` 只用于展示和 TTL 校验；不用于排序或授权。
- 解析时忽略未知字段；未知 `version` 返回 `payload/unsupported-version`。`signature.alg` 只接受 `ed25519`，其它值按 `auth/invalid-signature` 处理。

## 7. 签名与认证

- 签名算法：Ed25519。
- 规范化：RFC 8785 JSON Canonicalization Scheme（JCS），对**去掉 `signature` 和 `trace` 后的整个信封**签名。
- `kid` 必须出现在发送方域的发现记录的 `keys` 中；找不到或已过期返回 `auth/unknown-key`。验签失败时先强制刷新一次发现记录，仍失败才拒绝，避免密钥轮换期的缓存误判。
- 发送方域名从 `from` 解析；接收方必须自己解析和缓存发现记录，不能信任 relay 转述的 key。
- 重放：接收方按 `(from, id)` 缓存至少 TTL + 5 分钟。同一个 `id`、完全相同的内容视为重复，返回 `accepted` 且 `duplicate: true`；同一个 `id`、不同内容返回 `auth/replay`。
- 时钟偏移超过 ±5 分钟返回 `auth/clock-skew`（临时，可重试）。
- 回执和普通消息使用同一套签名；`kind: "receipt"` 的签名者是接收域。
- 密钥轮换：新 `kid` 提前出现在发现记录中；旧 `kid` 至少保留一个最大 TTL 周期。

## 8. 三态响应

`POST /messages` 的同步响应只有三种：

### 8.1 accepted

```json
{
  "status": "accepted",
  "id": "0198f3a2-7c41-7d3e-9b62-2f6f0a1c4d55",
  "acceptedAt": "2026-11-06T08:00:01Z",
  "duplicate": false
}
```

含义：acceptor 已持久化并承担责任，之后可能投递失败并返回签名回执。HTTP 200。

### 8.2 deferred

```json
{
  "status": "deferred",
  "code": "rate/limited",
  "retryAfter": 30,
  "expiresAt": "2026-11-07T08:00:00Z"
}
```

含义：现在没有接受，也没有永久拒绝；发送方在 `retryAfter` 秒后重试，直到 `expiresAt`。HTTP 202。

### 8.3 rejected

```json
{
  "status": "rejected",
  "code": "policy/domain-blocked",
  "permanent": true,
  "detail": "this domain is not on the recipient allowlist"
}
```

含义：永久拒收，不要重试。HTTP 4xx。`detail` 只用于人读，不能用于程序判断。

同步 `rejected` 是 acceptor 的决定，由 TLS 认证；接收方层面的失败（会话不存在、唤醒被拒等）只通过签名回执报告，不由 relay 伪造。被永久拒收后，发送方不能用同一个 `id` 改字段重试；必须生成新的 `id`。

### 8.4 异步回执

接受之后的投递结果：

```json
{
  "version": 1,
  "kind": "receipt",
  "id": "0198f3a2-8d10-7a11-8f00-3c2a1b9e6e01",
  "from": "bob@b.example",
  "to": "alice@a.example",
  "inReplyTo": "0198f3a2-7c41-7d3e-9b62-2f6f0a1c4d55",
  "createdAt": "2026-11-06T08:00:05Z",
  "expiresAt": "2026-11-07T08:00:00Z",
  "contentType": "text/plain; charset=utf-8",
  "body": "",
  "status": "delivered",
  "code": "ok",
  "signature": { "alg": "ed25519", "kid": "2026-11-01", "value": "base64url" }
}
```

- `status`: `delivered` 或 `failed`。
- `failed` 的 `code` 使用 `delivery/*`。
- 回执不再生成回执；回执被拒收时静默丢弃并记录审计。
- 回执必须由接收域签名；relay 只能转发，不能伪造。

回执在信封字段之外增加：

| 字段 | 必填 | 说明 |
|---|---|---|
| `status` | 是 | `delivered` 或 `failed` |
| `code` | 是 | 成功为 `ok`；失败使用 `delivery/*` |
| `inReplyTo` | 是 | 原消息的 `id` |

回执的 `to` 是原消息的 `replyTo`（缺省为原 `from`），`from` 是原消息的接收地址。回执不需要 `toSession`。

### 8.5 一次完整流程

1. A 解析 `a.example` 自己的发送配置，解析 `b.example` 的 well-known，拿到 B 的 relay 与公钥。
2. A 生成 `id`、签名信封，`POST` 到 B 的 relay。
3. B 的 relay 用 `a.example` 的发现记录验签，执行域/实例策略、大小、速率和 TTL 检查；通过后落盘并返回 `accepted`，否则返回 `deferred` 或 `rejected`。
4. B 的 relay 把信封推给 `bob@b.example` 的 mailbox 订阅。
5. B 实例验签、检查目标会话，投递到 inbox；然后向 `alice@a.example` 发送签名回执。
6. A 的 relay 按回执的 `to` 转发，A 得到 `delivered` 或 `failed`。

`accepted` 只到第 3 步；第 5 步的失败不会把已接受的响应改写成拒收，而是走回执。

## 9. 错误码

`permanent` 表示发送方不要重试；`temporary` 表示按 `retryAfter` 重试；`async` 表示已接受、之后用回执报告。

| 代码 | 类别 | 阶段 | 含义 |
|---|---|---|---|
| `auth/invalid-signature` | permanent | 认证 | 签名校验失败 |
| `auth/unknown-key` | permanent | 认证 | `kid` 不在发现记录中 |
| `auth/key-expired` | permanent | 认证 | 密钥已过期 |
| `auth/replay` | permanent | 认证 | 相同 id 携带不同内容 |
| `auth/clock-skew` | temporary | 认证 | `createdAt` 超出 ±5 分钟 |
| `policy/domain-blocked` | permanent | 策略 | 发送域不在 allowlist |
| `policy/sender-blocked` | permanent | 策略 | 发送实例被拉黑 |
| `policy/recipient-opt-out` | permanent | 策略 | 接收实例关闭了跨域接收 |
| `policy/wake-denied` | permanent | 策略 | 发送方请求唤醒，但接收方不允许 |
| `policy/relay-forbidden` | permanent | 策略 | relay 不接受该域/该方向的转发 |
| `recipient/unknown-instance` | permanent | 策略 | 域内没有该实例；仅对已认证/已放行的发送方返回 |
| `recipient/unknown-session` | async | 投递 | 实例存在，但目标会话不存在 |
| `recipient/gone` | permanent | 策略 | 实例已删除、暂停或迁移，地址不再接收 |
| `payload/malformed` | permanent | 载荷 | JSON 或信封结构不合法 |
| `payload/too-large` | permanent | 载荷 | 超过信封或正文上限 |
| `payload/unsupported-version` | permanent | 载荷 | `version` 不支持 |
| `payload/unsupported-content-type` | permanent | 载荷 | v1 不支持的内容类型 |
| `payload/expired` | permanent | 载荷 | 已过 `expiresAt` |
| `payload/too-many-hops` | permanent | 载荷 | `trace` 超过 8 项 |
| `rate/limited` | temporary | 限流 | 超过速率或配额 |
| `queue/full` | temporary | 队列 | mailbox 满 |
| `queue/unavailable` | temporary | 队列 | relay 暂时不可用 |
| `relay/loop` | permanent | 转发 | 检测到环 |
| `relay/not-authorized` | permanent | 转发 | relay 与目标域没有转发授权 |
| `relay/upstream-timeout` | temporary | 转发 | 上游域超时 |
| `delivery/session-not-live` | async | 投递 | 目标会话没有 live agent，且未允许唤醒 |
| `delivery/resume-refused` | async | 投递 | 接收方拒绝唤醒 |
| `delivery/resume-failed` | async | 投递 | 尝试唤醒但失败 |
| `delivery/session-owned-by-subagent` | async | 投递 | 目标会话由 subagent 路由拥有 |
| `delivery/timeout` | async | 投递 | 投递阶段超时 |
| `delivery/expired` | async | 投递 | 接受后到 TTL 仍未投递成功 |
| `internal/unavailable` | temporary | 内部 | acceptor 内部故障 |

静默丢弃：未认证、明显滥用、或未放行域对未知收件人的探测。静默丢弃也记录审计，但不向发送方返回细节，避免地址枚举和退信滥用。HTTP 层可以返回通用 401/403，但响应体不得区分「收件人不存在」与「策略拒绝」。

`recipient/unknown-session` 通常是异步的：acceptor 先接受，接收实例在投递时发现会话不存在，再发 `failed` 回执。如果 acceptor 本身就是接收主机、能同步查询会话，也可以直接返回同步 `rejected`；两种路径对发送方都表示永久失败。

## 10. 默认策略

跨域默认 **deny**。同域保持现有 `peers` 行为不变。

接收实例的配置（草案字段）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `federation.enabled` | `false` | 总开关 |
| `federation.defaultRegistry` | `https://dsh.hanasatominori.cn/v1` | 首次跨域时建议的共享注册商；自建/其它注册商改这里，设为 `null` 时只允许静态命名空间 |
| `federation.namespaces` | `{}` | 静态命名空间：`{ 标签: { relay, keys } }`；非 DNS 命名空间必须在这里配置 |
| `federation.accept.domains` | `[]` | 允许的发送域/命名空间 |
| `federation.accept.instances` | `[]` | 允许的 `instance@domain` |
| `federation.reject.domains` | `[]` | 显式拒绝，优先于 accept |
| `federation.wake` | `false` | 跨域是否允许唤醒离线会话；默认不唤醒、不计费 |
| `federation.maxEnvelopeBytes` | `1048576` | 信封上限 |
| `federation.maxBodyBytes` | `524288` | 正文上限 |
| `federation.maxTtlSeconds` | `604800` | TTL 上限 |
| `federation.rate` | `60/min` | 每发送域/实例的速率；burst 20 |
| `federation.retention` | `604800` | mailbox 保留时间；不得短于 `maxTtlSeconds` |

规则：

1. 先认证，再解析策略；未认证的请求不返回收件人是否存在。
2. `reject.domains` 优先于 `accept.*`。
3. 所有永久拒收必须在触发计费 turn 之前完成。
4. `wake: true` 只有在 `federation.wake` 且该发送方被单独放行时才生效；否则 `policy/wake-denied`。
5. 同域的 `allowResume` 和 `peers` 语义不受影响。
6. 速率限制在 acceptor 和 relay 两处独立执行，取更严格的结果。

## 11. Relay 规则

1. **禁止开放中继**：只接受 `from` 域已通过签名认证、且 `to` 域属于本 relay 服务范围或已建立转发授权的信封。relay 通过 `to` 域的 well-known 发现记录确定下一跳；发现失败属于临时故障，返回 `queue/unavailable`。
2. **持久化后接受**：`accepted` 之前必须落盘；崩溃后能恢复。
3. **按接收实例分队列**：mailbox 以 `to` 为键；同一实例的多条消息按到达顺序排队，不承诺全局顺序。
4. **重试**：`1m, 5m, 30m, 2h, 6h`，到 `expiresAt` 停止；最终失败发 `delivery/expired` 回执。
5. **去重**：键 `(from, id)`；重复提交返回 `accepted` + `duplicate: true`，不重复入队；去重窗口不短于最大 TTL。
6. **环检测**：`trace` 最多 8 项；本 relay 域名已出现两次时 `relay/loop`。`trace` 不参与签名，发送方可以伪造；伪造只能让自己的消息被提前拒收，不能影响其他消息。relay 仍必须追加自己的 hop。
7. **回执路由**：`kind: "receipt"` 按 `to` 走反方向；不为回执再生成回执。
8. **内容可见性**：v1 的 relay 能看到正文。跨域 relay 必须是受信任的基础设施，且 hop 之间必须 TLS；面向不可信中继时，必须在 v1 之后增加端到端加密（见第 14 节）。
9. **审计**：记录 `id`、`from`、`to`、决定、时间、relay hop；保留时间由运维策略决定。
10. **配额**：按发送域、接收实例、来源 IP 分别限流；超出返回 `rate/limited` 或 `queue/full`。

## 12. 投递语义

- 至少一次（at-least-once）+ 幂等键 `(from, id)`；不承诺 exactly-once。
- `accepted` 表示 acceptor 负责；`delivered` 由签名回执确认。
- 顺序：同一 `(from, to)` 尽力保序，不承诺跨发送方或跨 relay 的顺序。
- TTL 默认 24 小时，最大 7 天；过期即失败，不做无限重试。
- 重复投递可能发生；接收实例必须按 `(from, id)` 去重至少一个 TTL。
- 重复提交返回 `accepted` + `duplicate: true`，不重新入队、不重新投递，也不重新生成回执；即使原消息后来失败，重复提交也不会把它复活。发送方要重试必须使用新的 `id`。
- 投递失败不得自动改投另一个会话；这是现有 addressing 规则的延续。
- 发送方收到 `failed` 回执后，需要新消息时必须使用新的 `id`，不能复用旧 id 重试。

## 13. 与现有实现的映射

| 现有概念 | 联邦协议 |
|---|---|
| `Config.instanceId` | 本地 id；跨域另配 `federatedId` |
| `peers` + origin | 同域直连；跨域改用 `instance@domain` + 发现 |
| `send` 的 `delivered` | 同域保持；跨域返回 `accepted`，之后用回执 |
| `peer-not-configured` | `policy/domain-blocked` 或 `recipient/unknown-instance`（取决于是否已认证/放行） |
| `unreachable` | `queue/unavailable`、`relay/upstream-timeout` |
| `session-not-live` | `delivery/session-not-live` |
| `resume-refused` | `delivery/resume-refused` |
| `session-owned-by-subagent` | `delivery/session-owned-by-subagent` |
| `message-too-large` | `payload/too-large` |
| `allowResume` | 同域保持；跨域由 `federation.wake` 控制 |

工具层需要新增一个明确的跨域地址形式，并区分「已接受」与「已投递」；不能把 `accepted` 渲染成 `delivered`。

## 14. 安全与隐私

- 传输全程 TLS 1.3；发现记录和 relay 端点必须使用受信任证书。
- 每域/每实例独立 Ed25519 密钥；不复用现有 `DSH_INTERCONNECT_TOKEN`。共享注册商只保存公钥，私钥永不离开客户端。
- 共享注册商是信任锚：它被攻破时可能替换公钥。透明日志、签名 checkpoint、客户端固定 checkpoint 和 key-change 告警是必需项，不是可选项。
- 首次跨域使用默认注册商必须 opt-in，并披露元数据、正文可见性、保留期和管辖地；用户可随时导出身份并迁到自建注册商。
- 重放窗口至少 TTL + 5 分钟；同一 id 不同内容永久拒绝。
- 不向未认证/未放行的发送方泄露实例或会话是否存在。
- 回执只发给已认证的发送方，并受速率限制，避免 backscatter。
- 正文默认对 relay 可见；如果 relay 不是发送方信任的基础设施，v1 不应承载敏感内容。端到端加密是后续版本的前置条件，不是可选项。
- 附件、链接预览、HTML 渲染都不在 v1 内；正文按纯文本处理。
- 审计与保留策略必须明确：谁在什么时间给谁发了什么，保存多久；注册商与 relay 分开审计。

## 15. 未决问题

1. `federatedId` 是否必须显式配置，还是允许把符合字符集的本地 `instanceId` 直接映射？
2. 发现只走 well-known，还是同时支持 DNS TXT/SRV？v1 建议只做 well-known；无 DNS 时用 4.3 的静态命名空间。
3. 默认注册商是否先以 `dsh.hanasatominori.cn` 上线，还是先只提供自建参考实现、由社区域名后续接入？
4. 跨域 `wake` 默认 `false` 是否足够，还是应该完全禁止跨域唤醒？
5. v1 默认最大 relay hop 数取多少：1（直接提交到接收方边缘）还是 2（发送方边缘 + 接收方边缘）？更多跳的转发留给后续版本。
6. 回执是否强制？发送方声明不接受回执时，失败如何告知？
7. 端到端加密是否必须在开放跨域之前完成？如果 relay 只由同一运维方控制，可以先不做。
8. 配额、滥用处理、域名信誉由谁负责：每个域自己，还是共享 relay 的运营方？
9. `accepted` / `delivered` 的语义变化是否能让现有工具调用方接受？
10. 默认注册商域名由项目维护者持有；是否需要独立法人/基金会或明确「社区服务、无 SLA」，个人持有域名和运营账号的单点风险如何在文档里披露？
11. 丢失全部私钥时：不可恢复，还是注册商提供带延迟和审计的人工恢复？两种策略的安全后果不同。
12. 注册商和 relay 是否强制分离部署，还是允许默认服务初期合并？合并时元数据和正文的信任边界如何说明？

## 16. 最小落地顺序

1. 定义信封 schema、JCS 规范化、Ed25519 签名/验签和错误码。
2. 单域内实现一个可持久化的 mailbox + 三态提交接口，不接跨域。
3. 加 well-known 发现和域密钥，跑通两个受控域之间的单跳投递。
4. 加共享注册商：challenge/注册、按 instance 查询、换钥、透明日志和迁出；默认服务可以从 invite-only 开始。
5. 加回执、去重、TTL、重试和审计。
6. 最后才考虑多跳 relay、配额和滥用策略；端到端加密在开放到不可信中继之前完成。
