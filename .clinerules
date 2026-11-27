# 上游同步规则（本仓库强制）

本仓库是 [atuizz/posewear](https://github.com/atuizz/posewear) 的 fork（`climbh/posewear`），本地叠了上游没有的功能（本地生图引擎 ComfyUI / sd.cpp、素材添加器、预览启动脚本、代理日志与重试）。

**用户说「同步上游 / 拉原作者更新 / 更新到最新版 / 看看上游有没有新功能」时，第一步固定是：**

```bash
scripts/sync-upstream.sh --agent-brief    # 打印完整执行契约，逐条照做，不要凭记忆编流程
```

三条不可协商的约定：

1. `origin` = 自己的 fork，唯一可推；`upstream` = 原作者，push 地址已 DISABLED，永久只读。
2. `main` 只做上游镜像（`git branch -f main upstream/main`），不提交、不改文件；本地功能全在 `local` 分支。
3. 同步用 rebase 不用 merge；冲突按「本地行为优先、上游实现方式吸收」解；脚本每次同步前已登记 `refs/upstream-backup/<名字>`，回滚用 `git reset --hard refs/upstream-backup/<名字>`。

标准动线：`--check`（只看冲突面）→ `--tag <最新tag>`（正式同步）→ 解冲突 → `node tests/run.mjs --offline` + `npm start` 手点本地功能 → `--push`。完整说明见 [docs/upstream-sync.md](docs/upstream-sync.md)。
