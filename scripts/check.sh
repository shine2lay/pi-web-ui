#!/bin/bash
# Fork 自检：提交 / rebase 后一把过（与上游 CI 同口径，外加本 fork 的真 PTY 回归）。
#
#   scripts/check.sh            # 全量（含构建）
#   scripts/check.sh --fast     # 跳过构建与真 PTY 冒烟（改前端时够用）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fast=false
[ "${1:-}" = "--fast" ] && fast=true

echo "== 协议单源同步检查"
npm run check:protocol
echo "== typecheck（双端 + tests + desktop + 扩展）"
npm run typecheck
echo "== lint"
npm run lint
echo "== prettier"
npm run format:check
echo "== 单测（vitest，含本 fork 的 terminal-view / global-history / 徽章用例）"
npm test

if $fast; then
	echo "--fast：跳过构建与真 PTY 冒烟"
	exit 0
fi

echo "== 构建（server + web + vendor）"
npm run build
echo "== 真 PTY 回归（本 fork 的脚本文件执行 + 上游的 bash 套件）"
node tests/terminal-bash-script-test.mjs
node tests/terminal-bash-test.mjs

echo
echo "全部通过。改了 server/ 的话记得重启 pi-web-ui 才会生效。"
