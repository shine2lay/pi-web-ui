#!/bin/bash
# Fork 同步：把 mine 上的补丁 rebase 到上游的某个 tag（默认最新 tag）。
#
#   scripts/sync-upstream.sh            # 最新上游 tag
#   scripts/sync-upstream.sh v0.86.0    # 指定 tag（或任何 upstream 的 commit-ish）
#
# 冲突时停在 rebase 中间：改完 `git add -A && git rebase --continue`；
# 如果冲突是因为上游自己修了同一个问题 —— 用 `git rebase --skip` 丢掉这个补丁，
# 然后在 PATCHES.md 里把它标成 merged 并删掉对应小节（见文件顶部的生命周期）。
# rerere 已开：同一个冲突第二次会自动套用上次的解法。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
[ -n "$(git status --porcelain)" ] && {
	echo "工作区不干净，先提交/暂存再同步。"
	exit 1
}

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/xing-shuyin/pi-web-ui.git
git config rerere.enabled true
git fetch upstream --tags --prune

target="${1:-$(git tag -l 'v*' --sort=-v:refname --merged upstream/main | head -1)}"
[ -n "$target" ] || {
	echo "找不到上游 tag。"
	exit 1
}
git rev-parse -q --verify "$target^{commit}" >/dev/null || {
	echo "未知的目标：$target"
	exit 1
}

echo "== 同步 main（纯镜像，ff-only）"
git checkout main
git merge --ff-only upstream/main

echo "== 把 mine 的补丁 rebase 到 $target"
git checkout mine
base="$(git merge-base mine "$target" || true)"
echo "   当前基线：$(git describe --tags --abbrev=0 "$base" 2>/dev/null || echo "$base")"
git log --oneline "$target..mine" | sed 's/^/   补丁: /'
git rebase --onto "$target" "$base" mine

cat <<EOF

rebase 完成 → $(git describe --tags --always)
接着：
  npm ci && scripts/check.sh      # typecheck + lint + format + 单测 + 构建
  # 上游若已自带某个补丁：git rebase --skip 掉它，并更新 PATCHES.md 的状态
  git push --force-with-lease origin mine
EOF
