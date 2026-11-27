# 跟上游同步（fork 模型，同时保住本地功能）

本地仓库是 [atuizz/posewear](https://github.com/atuizz/posewear) 的 fork（[climbh/posewear](https://github.com/climbh/posewear)），本地又叠了一批上游没有的功能：本地生图引擎（ComfyUI / sd.cpp）、添加器 `npm run add`、预览启动脚本 `local-preview.sh`、代理日志与重试等。目标：**上游发新版本时整段吸收，本地功能一行不丢**。

## 远端与分支分工（硬约定）

```
origin    → git@github.com:climbh/posewear.git     自己的 fork：只在这里提交、推送
upstream  → https://github.com/atuizz/posewear.git  原作者：只 fetch，push 地址已设为 DISABLED

main   → 纯上游镜像，指向 upstream/main，不提交、不改文件
local  → 本地功能分支，7 个提交叠在 upstream/main 上，rebase 维护；已推到 origin/local
```

- 日常开发、部署都在 `local` 上；`main` 只有 `git branch -f main upstream/main` 这一种写法。
- 部署命令 `npm run deploy` 已显式带 `--branch main`（wrangler 按本地分支猜部署目标，在 `local` 上必须靠这个参数才发到生产）。

## 每次同步由 AI 执行，等价于这一条

```bash
scripts/sync-upstream.sh                 # fetch upstream → 备份 HEAD → rebase local 到 upstream/main
scripts/sync-upstream.sh --tag v1.5.0    # 更稳：跟发布 tag，而不是跟 main 漂
scripts/sync-upstream.sh --push          # 同步成功并验收后推 origin/local
```

脚本另外几个开关：

| 命令 | 作用 |
|---|---|
| `--check` | 只读：上游进了哪些提交、`comm -12` 算出「上游改过、本地也改过」的撞车文件，不动本地 |
| `--status` | 领先/落后上游多少、本地提交列表、可用备份点 |
| `--tests` | rebase 成功后跑 `node tests/run.mjs --offline` |
| `--abort` | 放弃中途的 rebase，回到最近备份点 |
| `--bootstrap` | 一次性迁移：把未提交的工作区改动按主题切成提交（本仓库已跑过） |

每次 rebase 前，脚本把当前 HEAD 登记成 `refs/upstream-backup/local-<时间戳>`，出事一条命令回到同步前：

```bash
git reset --hard refs/upstream-backup/local-20261127-161127
```

## 冲突怎么解

只有一个原则：**本地行为优先，上游实现方式吸收**。本仓库 2026-11-27 那次 rebase（v1.4.0 → v1.4.0-4-g2dbaabc，含土耳其语与 Windows 兼容改动）只撞了 `scripts/preview.mjs` 一处：上游那版 `/api/proxy` 是朴素转发，本地那版带日志、图床重试和 body 断流保护，是超集 —— 直接保留本地整段实现，不要退回上游写法。

```bash
git add <文件> && git rebase --continue   # 继续
git rebase --skip                          # 这个提交不要了
git rebase --abort                         # 整次放弃（rebase 中途工作区是历史快照，脚本可能不在，用 git 内建命令）
```

## 同步后必做验收

```bash
node tests/run.mjs --offline    # 浏览器套件需要 Chromium；本机缓存版本对不上时直接借系统 Chrome：
                                # CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/run.mjs --offline
                                # 2026-11-27 实测：13/13 套件全绿（含本地代理单测 8 项）
npm start                       # 本地预览，手点本地引擎与添加器
```

本地功能才是真回归（上游测试覆盖不到）：

1. `npm start` 起本地预览，`local-preview.sh` 走代理/直连两条路径都能开；
2. 悬浮工作台里选「本地引擎」，能列出 ComfyUI / sd.cpp 状态；
3. `npm run add` 拖图写入 `assets-raw/` 并完成一次构建；
4. 生成记录、收藏、组合这些走 localStorage / IndexedDB 的没被上游改动打断（`wbCfg`、`wbSel`、`sel`、`fav` 键名别被覆盖）；
5. 本次上游新增的界面语言（如土耳其语）能切出来，说明 i18n 没被本地改动压掉。

想拿纯上游做对照，用 worktree 单开一份，不污染当前目录：

```bash
git worktree add ../posewear-upstream main
# 需要时 cd ../posewear-upstream && npm ci && npm start
git worktree remove ../posewear-upstream
```

## 网络注意

这台机器直连 github.com 会偶发 `HTTP2 framing layer` 报错，仓库已设 `git config http.version HTTP/1.1` 规避；上游 remote 用 https（只读），fork remote 用 ssh（已 `ssh -T git@github.com` 验过，账号 climbh）。

## 长期把冲突面压到最小

1. **本地逻辑新文件优先**：新增能力写成 `scripts/local-*.mjs`、`src/local-*.js`，上游文件只留 1~3 行 import/挂载。
2. **别整段重排上游代码**：本地格式化、改名、重排顺序会让之后每次 rebase 都撞车。`src/image-providers.js (+205)`、`src/studio.js (+107)` 属于高摩擦改动，后续再动它们优先「新增函数 + 少量调用点」。
3. **环境/工具类改动单独放提交**（`.gitignore`、`local-preview.sh`、`scripts/*.sh`），上游收了同类改动时可以直接 `git rebase --skip` 丢掉本地那份。
4. **每次同步后打 tag**：`git tag local-$(date +%Y%m%d) && git push origin --tags`，出问题能秒回。
