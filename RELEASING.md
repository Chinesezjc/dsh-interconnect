# 发布与同步流程

本包在 monorepo 合并落地期间与上游并存，因此每个上游 head 的改动都要核对并（按需）发布到 npm。这份文档记录这条流程，以及流程里两个会静默失败的环境坑。

## 一、跟随上游 head 核对

上游是私有仓 `deepseek-harness/deepseek-harness` 的 `feat/merge-dsh-interconnect` 分支（合并后为 master）。核对用本仓的脚本，它按**代码骨架**比较，而不是文本比较：

```sh
node scripts/check-upstream-alignment.mjs --ref <上游 head sha>
```

默认读取 `~/dsh-wt-ic-merge` 工作区。它检查三类不变量：

1. **四个源文件 + 三个 spec**：剥掉注释与 import 行后的骨架必须逐行一致（`ok … (skeleton identical)`）。
2. **skill 正文** `assets/dsh-interconnect.md`：与上游**逐字节一致** —— 它是模型可见内容，一个字符的改动都算行为变化。
3. **`cordis.patch.yml` 的插入行**：行 id 与每行 `config` 的键必须与上游 `interconnect-profile` 层一致（部署 profile 按行 id 覆盖 `instanceId`/`peers`）。

脚本对注释措辞差异**不判红**（本包自己写文档），任何它判红的差异都是行为漂移，应当移植而不是调整脚本 —— 除非确实新增了一处适配点（见下节）。

### 移植

本包是**移植**，不是拷贝。允许且仅允许这些差异：

- 模块标签与包名（`@deepseek-ai/dsh-experimental-interconnect` → `dsh-interconnect`）；
- 内部 import 说明符改为相对路径；
- **镜像**两个 Host 不对外导出的内部件：subagent 归属判定（上游的 `hasApiSessionSubagentOwner`）与 `assertNever`；
- `node:crypto` 的导入改写；
- 资源路径 `../assets/` → `../../assets/`。

上游的改动区域通常不含适配点，于是可以直接打补丁：

```sh
git -C ~/dsh-wt-ic-merge diff <旧 head> <新 head> -- <上游路径> \
  | sed -e "s#^--- a/<上游路径>#--- <本仓路径>#" -e "s#^+++ b/<上游路径>#+++ <本仓路径>#" \
  | patch -p0 --forward
```

改动落在 import 行附近时补丁会被拒（说明符不同），手工补那几行即可，然后**重跑对齐门禁**才算移植完成。

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
# 直接在 profile 目录里换版本（见坑四：`dsh plugin add` 不会把 --registry 转给 pnpm）
cd $DSH_HOME/profiles/web
pnpm add dsh-interconnect@<版本> --registry=https://registry.npmjs.org --config.minimumReleaseAge=0
# 然后重启该实例的 DSH（systemd 或计划任务），并回读：
#   已装 package.json 与 dsh.plugin.json 的版本
#   `GET /interconnect/link` 的 WS 握手（无 token 返回 401 即路由已挂载）
#   用 scripts/probe-deployed-link.cjs 打 hello/ping/list/event/msg 五种帧
```

`dsh plugin --profile web add` 仍可用（它会顺带按安装态对账 `dsh.profile.bundles`），但只换版本时直接 `pnpm add` 更可靠，且不依赖 checkout 可运行。

### 坑四：镜像滞后与重启的两处现实约束

- **`dsh plugin ... add` 不转发 `--registry`**：实测把 `--registry=https://registry.npmjs.org` 写在 `dsh plugin` 后面时 pnpm 仍查 `mirrors.tencentyun.com`，报「The latest release of dsh-interconnect is <上一个版本>」（发布后几分钟内镜像还没同步）。**可靠做法**是在 profile 目录直接 `pnpm add`，`--registry` 才会生效。
- **`curl /` 在重启后可能先返回 404**：应用在组合插件树期间 Web 服务会先应答 404，几秒后才回到 401。判活要**轮询到 401**（或非 000/404）再下结论，别把启动窗口里的 404 当成挂载失败。
- **重启命令**：MomoiAiri 上 `systemctl restart dsh-web` 直接可用；CI-Server 上同一条命令会报 `Interactive authentication required`（polkit），改用 `sudo -n systemctl restart dsh-web`。Windows 用 `Stop-ScheduledTask`/`Start-ScheduledTask DSH-Web`。
- **Windows 上跑探测脚本**：`ssh <host> "powershell -EncodedCommand <b64>"` 在脚本里**内嵌文件内容**时会超命令行长度（报「命令行太长」）；先用 `scp` 把 `scripts/probe-deployed-link.cjs` 传到 `C:/dsh/`，再用短的 EncodedCommand 设好 `IC_TOKEN`/`IC_PORT`/`IC_WS` 后 `node` 它。该机 sshd 还会偶发地在命令执行前关连接，重试即可。

`scripts/probe-deployed-link.cjs` 的用法：`IC_TOKEN` 必填（从该机 `$DSH_HOME/.credentials.yaml` 的 `DSH_INTERCONNECT_TOKEN` 取；它在 `refs:` 下**有两格缩进**，行首锚定的 sed 会取到空串）、`IC_PORT` 默认 3080。`IC_WS` 现在**可选**：不设时脚本解析本仓的 `ws` devDependency（在本仓 checkout 里直接可跑）；设了则用该路径（例如在某台宿主上跑时指向该机的 `ws` 包）。**不要打印 token 本身**。

### 坑三：devDependency 不能写本机路径

本仓 CI 只检出 public mirror 到工作区的 `dsh/`，所以 devDependency 只有两种写法能在 CI 里解析：`link:../dsh/...`（sibling checkout 内的未发布包），或 registry 上的已发布版本。写任何本机路径（如 `link:../.dsh/source/current/...`）在本地能过、在 CI 的 typecheck 阶段必红（`TS2307`），且 `pnpm install` 不会提前报错。

为新增 devDependency 选 registry 版本时先看发布时间：pnpm 11 的 `minimumReleaseAge=1440` 会拒绝 24 小时内发布的版本（见坑一），所以别直接选当天的 alpha；用 `npm view <pkg> time --json` 确认，并核实该版本确实导出需要的符号。


### 坑一：pnpm 的供应链年龄门禁

pnpm 11 默认 `minimumReleaseAge=1440`（24 小时，`pnpm config get` 显示 `undefined` 但确实生效）。刚发布的版本会被锁文件校验拒绝：

```
ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
```

`minimumReleaseAgeExclude` 里写了**也不参与**锁文件校验，删 `pnpm-lock.yaml` 也不够（校验会按 `package.json` 的 spec 重判）。**有效做法**是安装时加 `--config.minimumReleaseAge=0`（单次生效，不改任何配置文件）。回退到已发布超过 24 小时的版本则不需要这个 flag。

### 坑二：代理与镜像

若该机 `~/.npmrc` 配了 `proxy`，而 registry 指向内网镜像，可能出现"代理对 npmjs 通、对镜像 ECONNRESET"。此时用 `--registry=https://registry.npmjs.org` 绕开镜像。

## 四、回滚

回滚就是升级换版本号（退到刚发布的版本才需要 `--config.minimumReleaseAge=0`）。升级前每台都留有 profile 备份（`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 与旧版插件目录），可直接还原。

## 五、已知的环境限制

- 本仓 CI 检出的是**公开镜像** `deepseek-ai/deepseek-harness` 的 master，它落后于活跃开发仓（合并工作发生在私有仓）。因此 **CI 绿不等于"对当前宿主可用"** —— 宿主兼容性由运行中的实例体现。
- 对齐门禁读的是私有仓工作区的真实 head，不受镜像滞后影响。
