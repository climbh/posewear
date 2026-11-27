# 跟上游同步（同时保住本地功能）

本地仓库是 [atuizz/posewear](https://github.com/atuizz/posewear) 的 clone，但本地已经叠了一批上游没有的功能（本地生图引擎 ComfyUI / sd.cpp、添加器 `npm run add`、预览启动脚本、本地代理与工作台改动等）。目标：**上游发新版本时能整段吸收，本地功能一行不丢**。

## 先看现状（2026-11-27 诊断）

```
origin           → https://github.com/atuizz/posewear.git  （就是上游，不是自己的 fork）
分支             → main，跟踪 origin/main，HEAD = f9f55db (v1.4.0)
仓库形态         → 浅克隆（.git/shallow，depth=1，只有 1 个提交）
本地改动          → 全部在**工作区**，未提交：16 个改动文件 (+764/−99) + 5 个未跟踪文件
```

这意味着：现在任何一次 `git pull`、`git checkout`、`git reset --hard` 都会让本地功能消失，而且没有历史可以找回。**第一件事是把本地改动变成提交**，然后才谈同步。

## 三条路线怎么选

| 路线 | 做法 | 适合 | 代价 |
|---|---|---|---|
| **A. 本地特性分支 + rebase（推荐）** | 上游只读，本地功能在 `local` 分支上一串提交，每次 `git rebase origin/main`（或跟 tag） | 本地功能会长期存在、想持续吃上游新功能 | 上游改到同一段代码时要解冲突，但冲突只在自己的提交里 |
| B. 补丁队列（patch） | `git diff > patches/local.patch`，上游更新后 `reset --hard` + `git apply` | 本地改动零星、随时可以全丢 | 一次性大 patch，上游一动就 `apply --reject` 手工捡，越往后越难 |
| C. fork + PR | 把本地功能拆成 PR 回上游，之后直接吃官方实现 | 本地功能有普适价值、愿意维护 PR | 需要上游 review，功能落不落地不由你定 |

这次选 A，并**顺手把 A 的成本压低**：本地逻辑尽量放独立文件（`scripts/local-engine.mjs`、`scripts/add-asset.*`、`scripts/preview.mjs` 已经是这样），上游文件（`build.py`、`src/studio.js`、`src/image-providers.js`）里只留薄薄的挂载点。这样 rebase 的冲突面就等于「上游恰好改到你挂载的那几行」。

## 一次性迁移：把工作区改动落到 local 分支

仓库里已备好 `scripts/sync-upstream.sh`，其中 `--bootstrap` 就是这一步。它会先做快照（`.git/upstream-backup/<时间戳>/` 里存 `git diff` 全量 patch、未跟踪文件 tar 包、原 HEAD），再按主题把你的改动切成 4~5 个提交：

1. `chore:` `.gitignore` + 同步脚本本身（脚本放第一个提交，rebase 中途也在）
2. `docs:` `AGENTS.md`、`docs/local-engines.md`、`docs/adding-assets.md`
3. `feat:` 本地生图引擎（`scripts/local-engine.mjs`、`scripts/preview.mjs`、`src/image-providers.js`、`src/studio.js`、`src/app.js`、`build.py`、`functions/api/proxy.js`、`package.json`、相关测试）
4. `feat:` 添加器与预览启动脚本（`scripts/add-asset.*`、`scripts/favicon.svg`、`local-preview.sh`）
5. 兜底：任何没归类的改动

```bash
cd ~/posewear

# 0) 先确认当前工作区的确是你想要的状态（这会成为 local 分支的历史）
git status
git diff --stat

# 1) 迁移（只跑一次；它会自己留快照，出问题 git reset --hard HEAD 回不去就用快照 patch）
scripts/sync-upstream.sh --bootstrap

# 2) 看一眼结果：main 脏不到上游，local 上是你自己的提交
git log --oneline -6
git diff main..local --stat
```

迁移后约定：

- **`main` 永远只跟上游**，不提交、不改文件。它只用来当同步基准。
- **`local` 是你的工作分支**，日常开发都在这里。
- 本地部署照旧，`npm run deploy` 里已显式带 `--branch main`（wrangler 按本地分支猜部署目标，不带会静默发到分支预览）。

## 日常同步

```bash
git switch local

scripts/sync-upstream.sh --check     # 只看：上游进了哪些提交、哪些文件会撞车（不动本地）
scripts/sync-upstream.sh              # 同步到 origin/main
scripts/sync-upstream.sh --tag v1.5.0 # 更稳：跟发布 tag，而不是跟 main 漂
scripts/sync-upstream.sh --tests      # 同步成功后跑离线回归
scripts/sync-upstream.sh --status     # 随时看领先/落后多少、本地提交列表、备份点
```

推荐跟 tag：上游按 `v1.x.0` 发版（`CHANGELOG.md` 里有），跟 tag 同步等于一次拿一个完整版本，比跟 `main` 的半成品稳定得多。第一次同步前仓库是浅克隆，脚本会自动 `--deepen=200` 补历史（rebase 需要共同祖先，depth=1 会把整段历史当 root 重放）。

撞车时的处理顺序，只有一个原则：**本地行为优先，上游实现方式吸收**。例如上游把 `build.py` 的成人标记判定抽成了 `_is_adult_item()`，本地在同一个 `if` 上加了 `adult` 字段覆盖逻辑，正确解法是两者合体：

```python
flag = p.pop('adult', None)
if flag is not None:
    if flag:
        p['a'] = 1
elif _is_adult_item(p, ADULT_LINES, ADULT_CATS):   # 用上游的新辅助函数，别退回旧写法
    p['a'] = 1
```

冲突解决完 `git add <文件> && git rebase --continue`；想整次放弃就 `git rebase --abort`（脚本此时可能不在工作区，因为 rebase 中途工作区是历史快照，直接走 git 内建命令；`git rebase --abort && git reset --hard refs/upstream-backup/<备份点>` 回到同步前）。

## 同步后必做

```bash
node tests/run.mjs --offline    # 离线回归，不联网也能跑
npm start                       # 本地预览，手点一遍本地引擎与添加器
```

本地功能的真回归是这些（上游测试覆盖不到）：

1. `npm start` 起本地预览，`local-preview.sh` 走代理/直连两条路径都能开；
2. 悬浮工作台里选「本地引擎」，能列出 ComfyUI / sd.cpp 状态；
3. `npm run add` 拖图写入 `assets-raw/` 并完成一次构建；
4. 生成记录、收藏、组合这些走 localStorage / IndexedDB 的没被上游改动打断（`wbCfg`、`wbSel`、`sel`、`fav` 键名别被覆盖）。

想拿纯上游做对照，用 worktree 单开一份，不污染当前目录：

```bash
git worktree add ../posewear-upstream main
# 需要时：cd ../posewear-upstream && npm ci && npm start
git worktree remove ../posewear-upstream
```

## 长期把冲突面压到最小

1. **本地逻辑新文件优先**：新增能力写成 `scripts/local-*.mjs`、`src/local-*.js`，上游文件只留 1~3 行 import/挂载。
2. **别整段重排上游代码**：本地格式化、改名、重排顺序会让之后每次 rebase 都撞车。当前 `src/image-providers.js (+205)`、`src/studio.js (+107)` 属于这类高摩擦改动，后续再动这两个文件时优先「新增函数 + 少量调用点」而不是原地重写。
3. **环境/工具类改动单独放一个提交**（`.gitignore`、`local-preview.sh`、脚本），方便上游收了同类改动时直接 `git rebase --skip` 丢掉本地那份。
4. **每次同步后打 tag**：`git tag local-$(date +%Y%m%d)`，出问题能秒回。
