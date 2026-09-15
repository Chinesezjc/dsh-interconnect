# 发布与同步流程

本包在 monorepo 合并落地期间与上游并存，因此每个上游 head 的改动都要核对并（按需）发布到 npm。这份文档记录这条流程，以及流程里两个会静默失败的环境坑。

## 一、跟随上游 head 核对

上游是私有仓 `deepseek-harness/deepseek-harness` 的 `feat/merge-dsh-interconnect` 分支（合并后为 master）。核对用本仓的脚本，它按**代码骨架**比较，而不是文本比较：

```sh
node scripts/check-upstream-alignment.mjs --ref <上游 head sha>
```

默认读取 `~/dsh-wt-ic-merge` 工作区。它检查六类不变量：

1. **四个源文件 + 三个 spec**：剥掉注释与 import 行后的骨架必须逐行一致（`ok … (skeleton identical)`）。
2. **同一批文件的原始文本（注释计入）**：除脚本里 `RAW_ADAPTATIONS` 记录在案的适配行以外，必须逐字一致（`ok … (raw text matches … outside N recorded adaptations)`）。注释与代码一样从上游逐字移植，所以「上游改了注释、本仓只移植了一部分」会在这里判红 —— 骨架那一遍剥掉注释，看不见这种漂移。该遍按**出现次数**比较（不是集合）并忽略空行；`index.ts` 里本仓独有的镜像块（子代理归属判定与 `assertNever`）由锚点整段排除，锚点找不到就判红而不是静默跳过。
3. **skill 正文** `assets/dsh-interconnect.md`：与上游**逐字节一致** —— 它是模型可见内容，一个字符的改动都算行为变化（永远字节复制，绝不用 patch）。
4. **`cordis.patch.yml` 的插入行**：行 id 与每行 `config` 的键必须与上游 `interconnect-profile` 层一致（部署 profile 按行 id 覆盖 `instanceId`/`peers`）。
5. **`peerDependenciesMeta`**：必须与上游`packages/experimental/interconnect/package.json` 的那张表完全一致（把某个 peer 标成可选是安装可见行为）。
6. **peer 子集**：上游声明的每个 peer 都必须出现在本仓 `package.json` 的 peers 里（只断言 `上游 ⊆ 本仓`；本仓 peer 更多是设计使然 —— 它镜像两个 util 包而不依赖它们，并把上游的 dependency 当 peer 声明）。

脚本判红的任何差异都是漂移，应当移植而不是调整脚本 —— 除非确实新增了一处适配点（见下节），那就把该行按上游/本仓两侧原文加进 `RAW_ADAPTATIONS`。汇总行会打印各集合的条数，例如
`no behavioural drift and no unrecorded text drift against <sha> across 7 ported files, 1 byte-exact asset, 1 patch row set, 1 optional-peer set, and 1 peer subset`。

新增检查时**必须构造负例**（删掉被守护的东西，确认脚本红并 exit 1，再还原）—— 没有负例的检查可能只是给失效机制盖绿章。

### 看上游 PR 的未解决线程

```sh
scripts/pr-threads.sh deepseek-harness/deepseek-harness 3243
```

**不要用 `reviewThreads(first: 100) { totalCount nodes { isResolved } }` 数线程**：`totalCount` 是全量，`nodes` 只有第一页，未解决线程若落在后续页就会被读成 0。实测 #3243 有 681→686 条线程、5 条未解决**全在第 7 页**，前 100 条里一条都看不到（据此曾误判"线程已归零"）。脚本用 `gh api graphql --paginate` 逐页累加并列出路径/作者/正文摘要。
另注：这个仓库里**未解决线程并不阻塞合并**——已合并的 #3926 至今仍有 7 条未 resolve 的 bot 线程；阻塞项是必需检查与审批分。

### 移植

本包是**移植**，不是拷贝。允许且仅允许这些差异：

- 模块标签与包名（`@deepseek-ai/dsh-experimental-interconnect` → `dsh-interconnect`）；
- 内部 import 说明符改为相对路径；
- **镜像**两个 Host 不对外导出的内部件：subagent 归属判定（上游的 `hasApiSessionSubagentOwner`）与 `assertNever`；
- `node:crypto` 的导入改写；
- 资源路径 `../assets/` → `../../assets/`。

上游的改动区域通常不含适配点，于是机械移植就是「按路径映射逐文件 `git diff | sed | patch`」：

```sh
node scripts/port-upstream-change.mjs --from <旧 head> --to <新 head>
```

该脚本按**显式映射表**处理四个源文件、三个 spec 与 skill 正文（正文**字节复制**、绝不 patch），自动删掉 `patch` 的 `.orig` 备份、列出所有 `.rej`、列出它不管的上游改动（docs/i18n 与本仓无关，`package.json` 的 `peerDependenciesMeta`/peer 集合要手工改），最后跑一次对齐门禁；**有任何 hunk 被拒就以非零退出**。

相比手工按门禁输出挑文件，它的优势是一次性把所有受管文件都过一遍：门禁的 raw 比对虽然也会对漏移植的注释判红，但那是**事后**判红（`RAW_ADAPTATIONS` 之外任何注释不一致都算漂移），而脚本按映射表直接打全部补丁，省掉「先漏掉、等门禁报出来再回头补」这一步；它也不会因映射写错而把 `tool-interconnect` 的补丁打到 `interconnect` 上。

需要单独打某一个文件时，手工管道仍然可用：

```sh
git -C ~/dsh-wt-ic-merge diff <旧 head> <新 head> -- <上游路径> \
  | sed -e "s#^--- a/<上游路径>#--- <本仓路径>#" -e "s#^+++ b/<上游路径>#+++ <本仓路径>#" \
  | patch -p0 --forward
```

改动落在 import 行附近时补丁会被拒（说明符不同），手工补那几行即可，然后**重跑对齐门禁**才算移植完成。

### 移植时的三个坑（都实际踩过）

1. **`patch` 会留下 `.orig`**：成功也会留（尤其是首个文件）。提交前用 `git status` 检查，删掉 `*.orig`；否则它们会被 `git add -A` 带进 commit。`.rej` 同理。
2. **补丁部分失败会留下不可编译的中间态**：同一文件里「改比较/改调用点」的 hunk 打上了、而「新增方法/改签名」的 hunk 被拒时，文件会引用一个尚不存在的参数或方法。处理顺序：`find . -name '*.rej'` → 读 reject 手工补 → **立刻 `pnpm run typecheck`**，不要等到最后才发现。
3. **hunk 被拒常常是因为本仓注释比上游旧**：注释停留在更早的措辞时，一旦上游在同一区域改动，补丁上下文就对不上（门禁的 raw 比对也会直接判红，见第一节第 2 条）。此时按上游原文**整段重写该处注释**（连同代码一起），让这个区域重新逐字一致，否则下一次改动会继续被拒。

配方用 `patch` 而不是 `git apply`：`git apply` 没有模糊匹配，上下文任何一行不匹配就整段拒绝。**但不要指望 fuzz 能救**——实测把 hunk 上下文里的一行注释改掉后，`git apply` 直接 `patch does not apply`，`patch -p1` 在同一处也照样 `1 out of 1 hunks failed`。上下文只差得**远**（在上下文窗口之外）时两种工具都能正常打上。非 ASCII 不是问题：中文注释在两种工具下都按字节匹配，不会因编码额外失败。

## 二、发布

发布是本地手工动作（CI 只做 typecheck + 测试 + 构建，**不发布**）：

1. 同步递增三处版本号：`package.json`、`dsh.plugin.json`、`CHANGELOG.md` 新条目。前两者的一致性由 `tests/release-consistency.spec.ts` 守着（漏 bump 会在 CI 红）。
2. `pnpm run check`（typecheck + 测试 + 构建）。构建产物与已发布版本比对可以确认改动是否真的只是文档级：
   `for f in $(find lib -name '*.js'); do shasum -a 256 "$f"; done`
3. 提交、打 tag、发布：
   ```sh
   git commit -m "sync with monorepo head <sha>: <一句话>"
   git push origin main
   git tag v<版本> && git push origin v<版本>
   npm publish
   ```
4. **等 registry 传播约 2–3 分钟**：处理期内连**精确版本端点**都返回 404（不只是 `dist-tags` 滞后），此时按版本安装会失败：
   ```sh
   curl -s https://registry.npmjs.org/dsh-interconnect | python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"
   ```

## 三、升级运行中的实例

每个实例的 profile 以 bundle 形式安装本包。升级即在 profile 里换版本、重启服务、回读验证：

```sh
# 直接在 profile 目录里换版本（见坑一：`dsh plugin add` 不会把 --registry 转给 pnpm）
cd $DSH_HOME/profiles/web
pnpm add dsh-interconnect@<版本> --registry=https://registry.npmjs.org --config.minimumReleaseAge=0
# 然后重启该实例的 DSH（systemd 或计划任务），并回读：
#   已装 package.json 与 dsh.plugin.json 的版本
#   `GET /interconnect/link` 的 WS 握手（无 token 返回 401 即路由已挂载）
#   用 scripts/probe-deployed-link.cjs 打 hello/ping/list/event/msg 五种帧
```

`dsh plugin --profile web add` 仍可用（它会顺带按安装态对账 `dsh.profile.bundles`），但**只换版本**时直接 `pnpm add` 更可靠，且不依赖 checkout 可运行。

**但只要这次改动会改变「哪些包是 profile layer」，就必须走 `dsh plugin`**：`dsh.profile.bundles` 的对账（`reconcilePlugins`）只在 `dsh plugin` 命令路径里跑。裸 `pnpm add/remove` 只动 `package.json`/`node_modules`，bundle 列表会保持原样——
- **加**新包用裸 `pnpm add`：列表里没有它，插件不会被挂载（静默不生效）；
- **删**包用裸 `pnpm remove`：列表里留下悬空名字，启动时 `dsh: cannot resolve profile bundle "<name>" from the dsh installation or <profile>` 直接失败。

换版本之所以能用裸 `pnpm add`，是因为 bundle 名早先已由 `dsh plugin add` 写进列表、且这一次名字没变。迁移到别的包时（例如换 `@deepseek-ai/dsh-experimental-interconnect-profile`）列表本身要改，必须用 `dsh plugin --profile web remove <旧包>` / `add <新包>`。

**`dsh plugin ... remove` 也要带 `--config.minimumReleaseAge=0`**（当要删的版本发布不足 24 小时；与「坑三」同一个门禁）。实测（本机 scratch profile，2026-09-15）：
1. `dsh plugin --profile web add dsh-interconnect@0.11.20 …` → `dependencies` 与 `dsh.profile.bundles` **同时**新增（对账生效）；
2. 不带该 flag 直接 `remove` → pnpm 报 *"The lockfile contains entries that the active policies reject"* 并失败，**但 `node_modules/dsh-interconnect` 已被删掉** → profile 处于「依赖还写着、bundle 还列着、包却不在」的悬空态，随后 `--dump-config` 直接 `Error: dsh: cannot resolve profile bundle "dsh-interconnect" from the dsh installation or <profile>`（这就是它能致启动失败的直接证据）；
3. 加上 `--config.minimumReleaseAge=0` 重跑 → pnpm 成功，**依赖与 bundle 列表项一并消失**，`--dump-config` 恢复正常。
   注：这个 scratch profile 的 `pnpm-workspace.yaml` 必须含 `autoInstallPeers: false`，否则 pnpm 会去 registry 拉 `@deepseek-ai/*` 那些未发布的 peer（报 `@deepseek-ai/dsh-type-meta is not in the npm registry`）；宿主上的 profile 自带该设置。
   若 `remove` 中途失败留下了悬空态，补救是 `dsh plugin --profile web install`（错误信息里给的也正是这条）或把包装回来。

**要改 profile layer 名单时，首选直接手改 `package.json`**（`dsh.profile.bundles` 换名 + 删旧依赖）→ profile 目录里 `pnpm install --config.minimumReleaseAge=0` → 重启前用 `dsh --profile web --dump-config` 验组合。理由：`reconcilePlugins` 只是把「依赖态」同步进 `bundles`，手改可以完全不依赖它，从而避开上面第 2 步那种「pnpm 失败但包已被删」的部分失败窗口；而手写 `bundles` 的 profile 从 R63 起就用 `--dump-config` 反复验过。
反过来，**`add` 一个未发布的包是安全失败**：实测 `dsh plugin --profile web add @deepseek-ai/dsh-experimental-interconnect-profile --registry=https://registry.npmjs.org` 报 *"is not in the npm registry, or you have no permission to fetch it"*，profile 完全不变（`dependencies` 仍为 null、`bundles` 仍是原样）——所以换到 monorepo 那个包时不要试图 `add` 它（它不在 npm 上，靠 installation 解析，必须写进 `bundles`）。`add` 失败无害、`remove` 失败有害，这一点决定了路线选择。

### 坑一：镜像滞后与重启的两处现实约束

- **`dsh plugin ... add` 不转发 `--registry`**：实测把 `--registry=https://registry.npmjs.org` 写在 `dsh plugin` 后面时 pnpm 仍查 `mirrors.tencentyun.com`，报「The latest release of dsh-interconnect is <上一个版本>」（发布后几分钟内镜像还没同步）。**可靠做法**是在 profile 目录直接 `pnpm add`，`--registry` 才会生效。
- **`curl /` 在重启后可能先返回 404**：应用在组合插件树期间 Web 服务会先应答 404，几秒后才回到 401。判活要**轮询到 401**（或非 000/404）再下结论，别把启动窗口里的 404 当成挂载失败。
- **重启命令**：MomoiAiri 上 `systemctl restart dsh-web` 直接可用；CI-Server 上同一条命令会报 `Interactive authentication required`（polkit），改用 `sudo -n systemctl restart dsh-web`。Windows 用 `Stop-ScheduledTask`/`Start-ScheduledTask DSH-Web`。
- **Windows 上跑探测脚本**：`ssh <host> "powershell -EncodedCommand <b64>"` 在脚本里**内嵌文件内容**时会超命令行长度（报「命令行太长」）；先用 `scp` 把 `scripts/probe-deployed-link.cjs` 传到 `C:/dsh/`，再用短的 EncodedCommand 设好 `IC_TOKEN`/`IC_PORT`/`IC_WS` 后 `node` 它。该机 sshd 还会偶发地在命令执行前关连接，重试即可。

`scripts/probe-deployed-link.cjs` 的用法：`IC_TOKEN` 必填（从该机 `$DSH_HOME/.credentials.yaml` 的 `DSH_INTERCONNECT_TOKEN` 取；它在 `refs:` 下**有两格缩进**，行首锚定的 sed 会取到空串）、`IC_PORT` 默认 3080。`IC_WS` 现在**可选**：不设时脚本解析本仓的 `ws` devDependency（在本仓 checkout 里直接可跑）；设了则用该路径。**把脚本经 stdin 喂给远端 `node -` 时必须显式给 `IC_WS`**：这种跑法没有本仓解析锚点，`require('ws')` 会失败并报 `probe: \`ws\` is not resolvable`（各机路径见上面的链路检查一节）。**不要打印 token 本身**。

### 部署后的互联链路检查

Linux 宿主用一条命令跑完下面全部检查（版本、profile 层、`/` 与 `/interconnect/link`、五帧、可选跨腿、产物 hash 链）：

```sh
scripts/verify-deployment.sh CI-Server 3080 /home/ubuntu/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules/ws 13081
# 参数：<ssh 别名> <本机端口> <该机 ws 包路径> [<跨腿端口>]
```

输出每项一条 `PASS/FAIL`，任一项失败退出码非零（实测：把端口写错 → `GET / -> 000`、`WS … -> 000`、探针 `ECONNREFUSED` 三条 FAIL、exit 1）。

Windows 宿主用同名的 PowerShell 版（Windows 没有 POSIX shell，所以脚本在宿主本机跑而不是从这边 ssh 进去跑）：

```sh
scp scripts/verify-deployment.ps1 scripts/probe-deployed-link.cjs CI-Server-Windows:'C:/dsh/'
ssh CI-Server-Windows 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\dsh\verify-deployment.ps1 -ExpectedVersion <版本> -CrossPort 19001'
```

它做同样的检查（凭据、版本、profile 层、`/` 与 `/interconnect/link` 的 401、五帧、跨腿五帧、`DSH-IC-Tunnels` 任务与出站 peer 端口），末尾把 **7 个产物 hash 打印出来供与本仓比对**（hash 每版都变，所以留在宿主机侧打印而不写死在脚本里）；任一项失败退出码非零。实测：正常时 8 项 PASS + `all checks passed`；`-Port 3999` 时 4 项 FAIL + exit 1。
写这类宿主侧 PowerShell 时注意两点（都实际踩过）：① 字符串里 `$Var:` 会被当成盘符限定变量引用报 `InvalidVariableReferenceWithDrive`，要用 `${Var}`；② `$ErrorActionPreference='Stop'` 下**原生命令的 stderr 会被当成终止性错误**——探针失败时脚本会在报告之前直接中断（正是最该报告的那条路径），所以调用 `node` 的地方要临时切回 `Continue` 并 try/catch。

下面是这些检查的逐条说明（两个脚本都按此实现）：

升级或改动隧道之后，除了逐台自检，还要确认**三向互联**：服务向某个 peer 发送需要一条**拨号（出站）链路**，只看到对端拨入并不代表本机具备发送能力。

1. **逐台自检**：`GET /` 得 401、`/interconnect/link` 无 token 得 401（注意重启后可能先返回 404，见坑一），再跑一次 `scripts/probe-deployed-link.cjs` 五帧。
2. **隧道单元**：两台 Linux 上 `systemctl is-active ic-tunnel-ci-windows.service`；Windows 侧 `Get-ScheduledTask -TaskName DSH-IC-Tunnels` 应为 `Running`、`@(Get-Process ssh).Count` ≥ 2、19001 与 13080 处于 LISTEN。
3. **`NRestarts` 是累计值，不代表"现在是否在重启"**：`systemctl show <unit> -p NRestarts --value` 可能是六位数（长期 flapping 的历史累计，实测 184245）。判据是**相隔约 20 秒取两次、数值不变且 `is-active=active`**。
4. **穿透验证**（比 TCP 转发更有说服力）：在任一台用本机凭证里的 token，对**下一跳的隧道端口**跑探测脚本——`IC_PORT=13081`（→ ci-windows）、`19001`（→ momoairi）、`13080`（→ ci-server），期望各自的 `hello from: <instanceId>`；六条有向腿都应通过。
5. **链路曾两端都断过时，要重启失去链路那一侧的实例**（`sudo -n systemctl restart dsh-web` / Windows 计划任务 Stop+Start），否则它只保留对端拨入，自己要等重连退避才会重新拨号。
6. **已装包的关键文件要与仓库逐字节一致**（`lib/` 是真正运行的代码，`assets/dsh-interconnect.md` 是 skill 正文、`cordis.patch.yml` 是挂载层；任一缺失或漂移都会**静默**生效，光看版本号发现不了）：
   ```sh
   d=$DSH_HOME/profiles/web/node_modules/dsh-interconnect
   sha256sum "$d"/lib/index.js "$d"/lib/{interconnect,tool-interconnect,skill-interconnect}/index.js \
             "$d/assets/dsh-interconnect.md" "$d/cordis.patch.yml" "$d/dsh.plugin.json"   # Linux
   shasum -a 256 …                                                                        # macOS
   # Windows: Get-FileHash <path> -Algorithm SHA256
   ```
   与本仓 `pnpm run check` 产物、`assets/`、`cordis.patch.yml`、`dsh.plugin.json` 的 hash 逐个比对。构建是确定性的，因此**同一版本下这几个 hash 应在仓库与三台部署上完全一致**；`dsh.plugin.json` 的 hash 同时证明已装版本就是当前仓库版本。这些值**每个版本都会变**（判定规则不变，数字只是当下基线），实测 0.11.23（三台全部逐字一致）：`lib/index.js 08ce274bb37a5e34`、`lib/interconnect/index.js 417d233de9787746`、`lib/tool-interconnect/index.js e32c539fed784db6`、`lib/skill-interconnect/index.js f3503a044b6791e9`、`lib/types/interconnect/types.d.ts 33956ef458ccb9a8`、`assets/dsh-interconnect.md 9ac2257814a68a23`、`cordis.patch.yml b324e2a6f00f7515`、`dsh.plugin.json f8ef85ec62159e06`（均为 sha256 前 16 位；0.11.22 的基线在 4 处不同：`lib/index.js 34dfba7d603e1787`、`lib/interconnect/index.js 976081ad8f7906b4`、`lib/tool-interconnect/index.js e3cf1a069d165b8c`、`dsh.plugin.json a0acf454ed126d65`；0.11.21 的基线在 4 处不同：`lib/index.js fa8f72b78e1d14b0`、`lib/interconnect/index.js 946fa483e8ed1b8c`、`lib/tool-interconnect/index.js 2353740801733d92`、`lib/types/interconnect/types.d.ts 4814ed410b65d7e0`，另加 `dsh.plugin.json 8ea672d207d1b9d1`；0.11.20 只在 skill 与 manifest 两处不同：`lib/skill-interconnect/index.js ac7f6b62698c99b2`、`dsh.plugin.json 7f6bb5c288125440`）。
   - **例外：发布之后又移植了注释时，`lib/types/**/*.d.ts` 会与已发布包不同**。注释在 JS 产物里被剥掉（`lib/**/index.js` 不变），但会**保留进 `.d.ts`**：0.11.18 发布后补的一处 `types.ts` JSDoc 曾让本仓 `.d.ts` 变成 `1d709beb309735d9` 而线上仍是 `ca4f433ff508fd09`；该注释已随 **0.11.19/0.11.20 发出**；0.11.22 的 `types.ts` 改动（`Config` 两个字段改可选 + `@default`）让两边一起更新到 `33956ef458ccb9a8` —— 这一次是**同版发出**，所以仓库与三台部署一致。比对时先确认「本仓是否在发布后改过源文件」，别把它当成安装损坏。
   - **更常见的一条例外：`.map` 里嵌了原始源码，所以任何注释改动都会让 `.map` 与已发布包不同**（`.js`/`.d.ts` 不受影响）。实测：head `fc1d297290` 把 `heartbeatTimer` 上方那段注释**移动**了位置，当时本仓 `lib/interconnect/index.js.map` 是 `87f27089008c8c3c` 而线上 0.11.20 是 `21996ddfb76beedf` —— 把两个 map 的 `sourcesContent[0]` 取出来看行号即可确认差异就是那次移动。**该注释已随 0.11.21 发出，两边重新逐字一致**；0.11.22 也保持一致（实测本仓与 CI-Server 上都是 `lib/interconnect/index.js.map 144462a0e88d47f8`、`lib/skill-interconnect/index.js.map 94ad5401ffa427c0`）。
     因此**上面的 hash 链刻意不含 `.map`**：判断「注释型 head 要不要发版」时，链内文件全同就说明**行为等价**（`.js`/`.d.ts`/正文/patch/manifest 都没变），发行与否是取舍而非正确性问题——注释改动会让已发布包的 `.map` 与仓库暂时不再逐字一致，但那只是调试元数据，下一次发版会自动收敛。

### 坑二：devDependency 不能写本机路径

本仓 CI 只检出 public mirror 到工作区的 `dsh/`，所以 devDependency 只有两种写法能在 CI 里解析：`link:../dsh/...`（sibling checkout 内的未发布包），或 registry 上的已发布版本。写任何本机路径（如 `link:../.dsh/source/current/...`）在本地能过、在 CI 的 typecheck 阶段必红（`TS2307`），且 `pnpm install` 不会提前报错。

为新增 devDependency 选 registry 版本时先看发布时间：pnpm 11 的 `minimumReleaseAge=1440` 会拒绝 24 小时内发布的版本（见坑三），所以别直接选当天的 alpha；用 `npm view <pkg> time --json` 确认，并核实该版本确实导出需要的符号。


### 坑三：pnpm 的供应链年龄门禁

pnpm 11 默认 `minimumReleaseAge=1440`（24 小时，`pnpm config get` 显示 `undefined` 但确实生效）。刚发布的版本会被锁文件校验拒绝：

```
ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
```

`minimumReleaseAgeExclude` 里写了**也不参与**锁文件校验，删 `pnpm-lock.yaml` 也不够（校验会按 `package.json` 的 spec 重判）。**有效做法**是安装时加 `--config.minimumReleaseAge=0`（单次生效，不改任何配置文件）。回退到已发布超过 24 小时的版本则不需要这个 flag。

### 坑四：代理与镜像

若该机 `~/.npmrc` 配了 `proxy`，而 registry 指向内网镜像，可能出现"代理对 npmjs 通、对镜像 ECONNRESET"。此时用 `--registry=https://registry.npmjs.org` 绕开镜像。

## 四、回滚

回滚就是升级换版本号（退到刚发布的版本才需要 `--config.minimumReleaseAge=0`）。升级前每台都留有 profile 备份（`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 与旧版插件目录），可直接还原。

## 五、已知的环境限制

- 本仓 CI 检出的是**公开镜像** `deepseek-ai/deepseek-harness` 的 master，它落后于活跃开发仓（合并工作发生在私有仓）。因此 **CI 绿不等于"对当前宿主可用"** —— 宿主兼容性由运行中的实例体现。
- 对齐门禁读的是私有仓工作区的真实 head，不受镜像滞后影响。

## 六、迁到 monorepo 的 profile 层（#3243 合入后执行）

三台部署最终要改成挂 monorepo 里的 `@deepseek-ai/dsh-experimental-interconnect-profile`（它只在合入后存在于主仓，**不在 npm 上**）。本节只记**与验收脚本相关**的差异；逐步操作清单在会话记忆 `~/.dsh/MEMORY.md` 的「合入日迁移清单」。以下每条都实测过。

**硬前提：宿主 checkout 必须先前进。** profile 层解析顺序是「先 dsh 安装、再 profile 目录」，而 `apps/cli/package.json` 把该 profile 包声明为 `workspace:^` —— 所以**宿主 checkout 里没有 `packages/experimental/interconnect-profile/` 时，bundle 名无法解析，启动直接失败**。实测三台 checkout 同为 `8d2ffaa3e9`，该 revision 下 interconnect 相关文件数 = 0。顺序必须是：ff checkout → `pnpm install --frozen-lockfile` → `pnpm run build` → 改 profile → 重启（**这中间不要重启**，见记忆里的顺序警告）。

**行 id 不变，所以宿主 `cordis.patch.yml` 一个字都不用改。** 实测 profile 包的 `cordis.patch.yml` 插入的三行 id 与本仓完全一致（`interconnect`/`tool-interconnect`/`skill-interconnect`），只有 `name` 不同（`dsh-interconnect/<subpath>` → `@deepseek-ai/dsh-experimental-*`）；`interconnect` 行的默认 config 也相同（`instanceId: dsh`、`requestTimeoutMs: 10000`）。宿主覆盖层按**行 id** 命中，`instanceId`/`peers` 照样落上去。

**验收脚本有两项检查在迁移后失去意义，不要当成故障：**

1. `verify-deployment.sh` / `verify-deployment.ps1` 里「已装版本 == 本仓 `package.json` 版本」与「产物 hash 链 == 本仓构建」这两项，只对**独立包**成立。迁移后 profile 挂的是 monorepo 包，包名与内部导入都不同，`lib/` 必然与本仓构建不同。
2. hash 判据降级为**同一包同一版本跨机一致**（三台互相逐字相同），而不是与本仓比。版本与层名单改为读 profile 的 `package.json`（`dsh.profile.bundles`）与装入的那个包的 manifest。

**回滚**：还原 profile 备份三件套 + 在 profile 目录 `pnpm add dsh-interconnect@<迁移前那版> --registry=https://registry.npmjs.org --config.minimumReleaseAge=0`（版本号在备份里读，别照抄本文）+ 把 checkout `git reset --hard <迁移前的 HEAD>`。独立包继续留在 npm 上正是为了这条路可用，所以**不要**撤下或 deprecate 它。

### 执行步骤（按序；每台做完再下一台：MomoiAiri → CI-Server → Windows）

宿主机名/端口/路径：**MomoiAiri** checkout `/root/dsh-web`、port **9001**、`systemctl restart dsh-web`、profile `~/.dsh/profiles/web`；**CI-Server** checkout `/home/ubuntu/deepseek-harness`、port **3080**、`sudo -n systemctl restart dsh-web`；**CI-Server-Windows** checkout `C:\dsh`、port **3080**、`Stop-ScheduledTask DSH-Web` + `Start-ScheduledTask DSH-Web`。

1. **备份 profile 三件套**（`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`）到 `$profile/.backup-<迁移前版本>-<UTC>/`。**必做**：既有备份只到 `0.11.13–0.11.19`（MomoiAiri）/`0.11.13–0.11.18`（另两台），近几次升级没留；备份不含插件目录（回滚时从 npm 重装）。0.11.23 的那份已在 2026-09-15 备好并逐字节校验，若 profile 之后又被改过则重备。
2. `git fetch origin`，**先确认 `origin/master` 已含目标包再 ff**：
   `git ls-tree -r --name-only origin/master | grep -q packages/experimental/interconnect-profile/ || echo "MIRROR NOT SYNCED — 先别 ff"`，通过后 `git merge --ff-only origin/master`。
   **注意取源不同**：MomoiAiri 直连私有仓；CI-Server / Windows 取**本机镜像**（`/data_local/ci/mirror/…`、`C:/ci/mirror/…`）—— 镜像滞后会造成「成功但不够」的 ff（拿到的 master 没有四包，症状要到第 4 步才报 resolve 失败）。
3. `pnpm install --frozen-lockfile` → `pnpm run build`。**为什么必须 build**：bundle 行按包名加载，这些包的 `main`/`exports["."]` 指向 `lib/index.js`；`tsconfig.host.json` 已引用四个包，build 会产出它们。
4. 写 profile 的 `package.json`（三台目标同一份）：`dsh.profile.bundles` 把 `dsh-interconnect` 换成 `@deepseek-ai/dsh-experimental-interconnect-profile`；`dependencies` 移除 `dsh-interconnect`（留 `{}`，**不加**新包——它从 dsh 安装解析）→ `pnpm install --config.minimumReleaseAge=0` → 用 `--dump-config` 验证组合出三行且 `interconnect` 行 `config` 带该机 `instanceId`/`peers`。**`dsh` 不在宿主 PATH**，正确形式：Linux `cd <checkout> && node --import <checkout>/node_modules/tsx/dist/esm/index.mjs apps/cli/src/bin.ts --profile web --dump-config`；Windows `cd /d C:\dsh && node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config`。**不要**用 `dsh plugin add`（该包不在 npm，会报 not in the npm registry；安全失败但白跑）。
5. **`cordis.patch.yml` 一个字都不改**（行 id 相同，覆盖层照样命中）。
6. 重启（命令见本节开头的三台表）。
7. 回读：unit active；**进程确实加载了新代码** —— `p=$(systemctl show dsh-web -p MainPID --value)`，要求 `stat -c %Y /proc/$p` **大于**插件文件 mtime（只看「磁盘版本 + 能响应」不够：重启没生效时旧进程照样响应）；`GET /` 轮询到 401（重启后可能先 404）；`/interconnect/link` 无 token 401；本机五帧。Windows 用 `Get-NetTCPConnection -LocalPort 3080 -State Listen` 取权威 pid。
8. 链路：本机到每个配置 peer 的**出站** ESTAB；再对下一跳隧道端口跑五帧（**六条有向腿**）。
9. 版本回读：读 `dsh.profile.bundles` + **`<checkout>/packages/experimental/interconnect-profile/package.json` 的 version** —— **路径在 dsh 安装里，不在 profile 的 `node_modules`**（第 4 步没把新包写进 profile 依赖）；三个插件包同理读 `<checkout>/packages/experimental/*/package.json`。该 bundle 包**没有 `dsh.plugin.json`**（靠 `dsh.bundle.patch`）。
10. 回滚：见上一段。

**顺序警告**：第 3 步做完到第 4/5 步改完 profile 之间**绝对不要重启** —— 此时磁盘上的 profile 仍指着独立包，而 checkout 已是合入后的 master。正确顺序是 2 → 3 → 4 → 5 → 6。

**合入后的收尾（先做完再动三台）**：① 撤掉会话记忆里属于本工作流的 watch（`ic-branch-head`、`ic-3243-ready`、`ic-3243-merged`）—— 不撤则分支每次 push 都会唤醒会话；② 停止同步（不再跟 head、不再发版）；③ **独立仓与 npm 包保持原样发布**：不 deprecate、不归档、不撤版本（既是上游 #3244 的验收条件，也是第 10 步回滚的前提）。
