#!/usr/bin/env bash
# 上游同步器（本地辅助脚本，非上游文件）
#
# 模型：origin/main 是纯上游镜像（只 fetch 不提交），本地功能全部放在 local 分支上，
#      每次同步把 local 分支 rebase 到上游最新，冲突只发生在自己的提交里。
#
# 用法：
#   scripts/sync-upstream.sh --bootstrap      首次：把当前未提交的本地改动按主题落到 local 分支
#   scripts/sync-upstream.sh --check          只看上游新提交 + 冲突面预估，不动任何东西
#   scripts/sync-upstream.sh                  同步到 origin/main
#   scripts/sync-upstream.sh --tag v1.5.0     同步到指定发布 tag（更稳，推荐跟 tag）
#   scripts/sync-upstream.sh --tests          同步成功后跑离线回归（node tests/run.mjs --offline）
#   scripts/sync-upstream.sh --abort          放弃正在进行的 rebase，回到最近的备份点
#   scripts/sync-upstream.sh --status         看当前分支领先/落后上游多少、本地提交列表、备份点
#
# 任何一次同步前都会把当前 HEAD 登记到 refs/upstream-backup/<branch>-<时间戳>，
# 出问题一条命令回滚：git reset --hard refs/upstream-backup/<名字>
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${REMOTE:-origin}"
LOCAL_BRANCH="${LOCAL_BRANCH:-local}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
TAG=""
MODE="sync"
RUN_TESTS=0

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m• %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --bootstrap) MODE="bootstrap" ;;
    --check) MODE="check" ;;
    --tests) RUN_TESTS=1 ;;
    --tag) TAG="${2:?--tag 需要版本号，例如 --tag v1.5.0}"; shift ;;
    --remote) REMOTE="${2:?--remote 需要名字}"; shift ;;
    --branch) LOCAL_BRANCH="${2:?--branch 需要分支名}"; shift ;;
    --abort) MODE="abort" ;;
    --status) MODE="status" ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

in_rebase() { [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; }

latest_backup_ref() {
  git for-each-ref --sort=-creatordate --format='%(refname)' 'refs/upstream-backup/*' | head -1
}

case "$MODE" in
  abort)
    in_rebase && { git rebase --abort; ok "已放弃 rebase"; }
    REF="$(latest_backup_ref)"
    [ -n "$REF" ] || die "没有找到备份点"
    info "回到备份点 $REF ($(git log -1 --format='%h %s' "$REF"))"
    git reset --hard "$REF"
    exit 0
    ;;
esac

# ── 0. --status：随时查看与上游的差距（手工 rebase 之后也用它复核） ────────────
if [ "$MODE" = "status" ]; then
  CUR="$(git rev-parse --abbrev-ref HEAD)"
  in_rebase && printf '\033[33m• rebase 进行中：git rebase --continue / --abort\033[0m\n'
  TARGET="$REMOTE/$UPSTREAM_BRANCH"
  if git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null; then
    printf '分支 %s\n上游 %s（%s）\n' "$CUR" "$TARGET" "$(git describe --tags --always "$TARGET")"
    printf '领先 %s 个本地提交，落后 %s 个上游提交\n' \
      "$(git rev-list --count "$TARGET..HEAD")" "$(git rev-list --count "HEAD..$TARGET")"
    git log --oneline --no-decorate "$TARGET..HEAD" | sed 's/^/  /'
  else
    printf '分支 %s（还没有 %s，先跑一次同步）\n' "$CUR" "$TARGET"
  fi
  echo '备份点：'
  git for-each-ref --sort=-creatordate \
    --format='  %(refname:lstrip=2) → %(objectname:short) %(contents:subject)' \
    'refs/upstream-backup/*' | head -5
  exit 0
fi

# ── 1. 首次：把未提交的本地改动整理成分主题的提交 ─────────────────────────────
if [ "$MODE" = "bootstrap" ]; then
  CUR="$(git rev-parse --abbrev-ref HEAD)"
  [ "$CUR" = "$UPSTREAM_BRANCH" ] || info "当前在 $CUR，bootstrap 会新建 $LOCAL_BRANCH 分支承载本地改动"
  git rev-parse --verify --quiet "refs/heads/$LOCAL_BRANCH" >/dev/null && die "分支 $LOCAL_BRANCH 已存在，bootstrap 只跑一次"

  TS="$(date +%Y%m%d-%H%M%S)"
  BK="$(git rev-parse --git-path upstream-backup)/$TS"
  mkdir -p "$BK"
  git diff > "$BK/worktree-tracked.patch"
  git ls-files --others --exclude-standard > "$BK/untracked.list"
  tar -czf "$BK/untracked.tar.gz" -T "$BK/untracked.list" 2>/dev/null || true
  git rev-parse HEAD > "$BK/head.txt"
  info "改动的原始快照：$BK"
  ok "快照就绪，生成提交"

  git switch -c "$LOCAL_BRANCH"

  commit_group() { # $1=提交信息  $2...=路径
    local msg="$1"; shift
    local staged=0 p
    for p in "$@"; do
      if [ -e "$p" ] && ! git diff --quiet HEAD -- "$p" 2>/dev/null; then
        git add -- "$p"; staged=1
      elif [ -e "$p" ] && git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
        : # 已跟踪且无改动
      elif [ -e "$p" ]; then
        git add -- "$p"; staged=1
      fi
    done
    [ "$staged" = 1 ] && git commit -q -m "$msg" && ok "提交：$msg"
    return 0
  }

  # 同步脚本本身放在第一个提交里：rebase 到中途时工作区处于某个历史提交状态，
  # 脚本若在后面的提交里就会「消失」，--abort 反而用不了
  commit_group "chore: 本地忽略、开发环境与上游同步脚本" .gitignore scripts/sync-upstream.sh
  commit_group "docs: 补充本地引擎与素材添加文档" docs/local-engines.md docs/adding-assets.md docs/upstream-sync.md AGENTS.md
  commit_group "feat: 本地预览与本地生图引擎（ComfyUI / sd.cpp）" \
    scripts/local-engine.mjs scripts/preview.mjs src/image-providers.js src/studio.js \
    src/app.js src/index.html src/style.css src/history.js build.py \
    functions/api/proxy.js package.json \
    tests/local-engine-regressions.mjs tests/local-workspace-regressions.mjs
  commit_group "feat: 本地添加器与预览启动脚本" \
    scripts/add-asset.py scripts/add-asset.html scripts/favicon.svg local-preview.sh

  # 兜底：任何还没进提交的改动（例如新增但没在上面列出的文件）
  if [ -n "$(git status --porcelain)" ]; then
    git add -u
    git ls-files --others --exclude-standard -z | xargs -0 -r git add --
    git commit -q -m "chore: 其余本地改动"
    ok "提交：其余本地改动"
  fi

  ok "bootstrap 完成，本地分支 $LOCAL_BRANCH 上共 $(git rev-list --count "$UPSTREAM_BRANCH..$LOCAL_BRANCH") 个提交"
  git log --oneline "$UPSTREAM_BRANCH..$LOCAL_BRANCH"
  cat <<EOF

下一步：
  scripts/sync-upstream.sh --check     # 看上游有哪些新提交会撞车
  scripts/sync-upstream.sh --tag <tag> # 跟发布 tag 同步（首次会补浅克隆历史）
  node tests/run.mjs --offline         # 迁移后先跑一遍离线回归
EOF
  exit 0
fi

# ── 2. 前置检查 ───────────────────────────────────────────────────────────────
in_rebase && die "有未完成的 rebase：先解决冲突并 git rebase --continue，或 scripts/sync-upstream.sh --abort"
CUR="$(git rev-parse --abbrev-ref HEAD)"
[ "$CUR" = "$LOCAL_BRANCH" ] || die "请在 $LOCAL_BRANCH 分支上执行（当前 $CUR）：git switch $LOCAL_BRANCH"


# 浅克隆先补历史：rebase 需要共同祖先，depth=1 会让整段历史当 root 重放
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  info "浅克隆仓库，先补历史（--deepen=200）"
  git fetch "$REMOTE" --deepen=200 --tags --prune || git fetch "$REMOTE" --unshallow --tags
else
  info "拉取 $REMOTE"
  git fetch "$REMOTE" --tags --prune
fi

if [ -n "$TAG" ]; then
  TARGET="refs/tags/$TAG"
  git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || die "上游没有 tag $TAG"
else
  TARGET="$REMOTE/$UPSTREAM_BRANCH"
  git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || die "没有 $TARGET"
fi
TARGET_DESC="$(git describe --tags --always "$TARGET" 2>/dev/null || echo "$TARGET")"

BASE="$(git merge-base HEAD "$TARGET" || true)"
[ -n "$BASE" ] || die "找不到与上游的共同祖先，先 git fetch --unshallow"

NEW_COMMITS="$(git rev-list --count "$BASE..$TARGET")"
LOCAL_COMMITS="$(git rev-list --count "$BASE..HEAD")"

# ── 3. --check：只报告冲突面 ─────────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  info "上游 $TARGET_DESC 相对 $BASE 新增 $NEW_COMMITS 个提交"
  [ "$NEW_COMMITS" -gt 0 ] && git log --oneline --no-decorate "$BASE..$TARGET" | head -30
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git diff --name-only "$BASE" "$TARGET" | sort -u > "$TMP/up"
  git log --name-only --pretty=format: "$BASE..HEAD" | sed '/^$/d' | sort -u > "$TMP/local"
  echo
  info "本地分支有 $LOCAL_COMMITS 个提交，改动 $(wc -l < "$TMP/local" | tr -d ' ') 个文件"
  HITS="$(comm -12 "$TMP/up" "$TMP/local")"
  if [ -n "$HITS" ]; then
    printf '\033[33m冲突高风险文件（上游改过、本地也改过）：\033[0m\n'
    echo "$HITS" | sed 's/^/  - /'
  else
    ok "上下游改动无交集，rebase 预计零冲突"
  fi
  exit 0
fi

# ── 4. 备份 + rebase ─────────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "工作区不干净：先把改动提交到 $LOCAL_BRANCH（或 git stash），否则 rebase 会丢改动"
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="refs/upstream-backup/$LOCAL_BRANCH-$TS"
git update-ref "$BACKUP" HEAD
info "当前 HEAD 已登记为 $BACKUP"

if [ "$NEW_COMMITS" -eq 0 ]; then
  ok "上游没有新提交（$TARGET_DESC），无需同步"
  exit 0
fi

info "rebase $LOCAL_COMMITS 个本地提交到 $TARGET_DESC"
if ! git rebase "$TARGET"; then
  echo
  printf '\033[31m✗ rebase 停在中途，冲突文件：\033[0m\n'
  git diff --name-only --diff-filter=U | sed 's/^/  - /'
  cat <<EOF

处理方式（三选一）：
  1) 手工解决冲突 → git add <文件> && git rebase --continue
  2) 这个提交不需要了    → git rebase --skip
  3) 整次放弃            → git rebase --abort
                           （rebase 处于中途时工作区是历史快照，本脚本可能不在，直接用 git 内建命令）
     回到同步前状态：git rebase --abort && git reset --hard $BACKUP

提示：冲突通常只落在「上游也改过的那几行」上。本地新增的独立文件（scripts/local-engine.mjs、
src/app.js 的挂载点等）很少冲突；如果反复冲突，把本地逻辑往独立文件里挪，见 docs/upstream-sync.md。
EOF
  exit 1
fi

AFTER="$(git rev-list --count "$TARGET..HEAD")"
ok "rebase 完成，$LOCAL_BRANCH 现在基于 $TARGET_DESC（本地提交 $LOCAL_COMMITS → $AFTER）"
[ "$AFTER" -lt "$LOCAL_COMMITS" ] && info "有 $((LOCAL_COMMITS-AFTER)) 个提交被上游吸收/内容已存在而自动丢弃，属正常"
git log --oneline --no-decorate "$TARGET..HEAD"

if [ "$RUN_TESTS" = 1 ]; then
  info "跑离线回归"
  node tests/run.mjs --offline || die "回归失败，先用 --abort 回到 $BACKUP 再逐项排查"
  ok "回归通过"
fi

cat <<EOF

下一步：
  npm start                      # 本地预览确认功能还在
  git push <你的远端> $LOCAL_BRANCH   # 需要备份到远端时才推
回滚：
  git reset --hard $BACKUP
EOF
