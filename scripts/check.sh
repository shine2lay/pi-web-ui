#!/bin/bash
# Fork 自检：提交 / rebase 后一把过（与上游 CI 同口径，外加本 fork 的真 PTY 回归）。
#
#   scripts/check.sh            # 全量（含构建）
#   scripts/check.sh --fast     # 跳过构建与真 PTY 冒烟（改前端时够用）; Prettier only on the changed files
#                               # (docs/gate-prettier-changed.md)
#   scripts/check.sh --notes    # only the checks that read notes (docs/**/*.md, PATCHES.md): what wt land
#                               # runs for a change that touches nothing else (agent-tools docs/wt-notes-check.md)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Shared test CPU entry precedes sealing (which scrubs environment); no marker skips this check.
cpu_launch="$PWD/tests/lib/sealed-test-launch.mjs"
cpu_entry=0
env -u NODE_OPTIONS node "$cpu_launch" entry || cpu_entry=$?
case "$cpu_entry" in
0) ;;
3)
	payload_env=()
	[ "${NODE_OPTIONS+x}" = x ] && payload_env=(env "NODE_OPTIONS=$NODE_OPTIONS")
	exec env -u NODE_OPTIONS node "$cpu_launch" exec -- "${payload_env[@]}" bash "$PWD/scripts/check.sh" "$@"
	;;
*) exit "$cpu_entry" ;;
esac

# Always the same clock zone (some date tests, e.g. notes-plugin.test.ts, expect UTC), and always
# sealed: every step runs in a temp home with no model keys, so no test can touch real chats
# (scripts/sealed.sh; it just runs the command when we are already inside a sealed run).
export TZ=UTC
if [ -z "${PI_SEALED:-}" ]; then
	exec scripts/sealed.sh "$0" "$@"
fi

fast=false
[ "${1:-}" = "--fast" ] && fast=true

# --notes (Ops #235, PATCHES.md "notes-check"): wt land runs this instead of --fast when a change
# touches only notes (wt.yaml notes_paths: docs/**/*.md and PATCHES.md). It runs the PATCHES.md check
# and the unit test files that read a note, nothing else: no other step reads a note. A unit test that
# names a note in its code must be on this list or on the reviewed "names it but doesn't read it" list
# in tests/unit/notes-check-list.test.ts, which fails otherwise (it also reads this block).
notes_tests=(
	tests/unit/check-patches-md.test.ts
	tests/unit/patches-union.test.ts
	tests/unit/role-message-guard-contract.test.ts
)
if [ "${1:-}" = "--notes" ]; then
	echo "== notes only: the PATCHES.md check and the ${#notes_tests[@]} unit test files that read notes"
	node scripts/check-patches-md.mjs
	npm test -- "${notes_tests[@]}"
	echo "--notes: the checks that read notes passed (any other change runs the full check)"
	exit 0
fi

# The quick steps run beside the unit tests (gate-side-by-side, docs/gate-side-by-side.md). Each one
# starts in the background with its output in a file of its own, printed after the tests in this
# order under its usual heading. Then the check fails if any step failed (the tests too), naming each.
quick_dir="$(mktemp -d)"
quick_pids=()
quick_names=()
quick_titles=()
kill_tree() { # kill_tree <pid>: that process and everything it started
	local child
	for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
	kill -TERM "$1" 2>/dev/null || true
}
on_exit() {
	# Anything still running here means the script stopped early (an error or a signal): stop it.
	local child
	for child in $(pgrep -P $$ 2>/dev/null); do kill_tree "$child"; done
	rm -rf "$quick_dir"
}
trap on_exit EXIT
quick() { # quick <name> <heading> <command> [args…]: start one quick step in the background
	local i=${#quick_pids[@]}
	quick_names+=("$1")
	quick_titles+=("$2")
	shift 2
	(
		start=$SECONDS
		code=0
		"$@" || code=$?
		echo "$((SECONDS - start))" >"$quick_dir/$i.secs"
		exit "$code"
	) >"$quick_dir/$i.log" 2>&1 &
	quick_pids+=("$!")
}

echo "== protocol, PATCHES.md, typecheck, lint and prettier run beside the unit tests; their output follows the tests"
quick protocol "协议单源同步检查" npm run check:protocol
quick PATCHES.md "PATCHES.md: no heading twice, each after a blank line (it merges by union, docs/patches-union.md)" \
	node scripts/check-patches-md.mjs
quick typecheck "typecheck（双端 + tests + desktop + 扩展）" npm run typecheck
quick lint "lint" npm run lint
# gate-prettier-changed (docs/gate-prettier-changed.md): --fast, what wt land runs, gives Prettier only the files
# changed since mine (every file when its settings or version may have changed); the full check reads them all.
if $fast; then
	quick prettier "prettier" node scripts/prettier-scope.mjs --check
else
	quick prettier "prettier" npm run format:check
fi

echo "== 单测（vitest，含本 fork 的 terminal-view / global-history / 徽章用例）"
tests_start=$SECONDS
tests_code=0
npm test || tests_code=$?
tests_secs=$((SECONDS - tests_start))

failed=()
times=()
for i in "${!quick_pids[@]}"; do
	code=0
	wait "${quick_pids[$i]}" || code=$?
	echo "== ${quick_titles[$i]}"
	cat "$quick_dir/$i.log"
	if [ -n "$(tail -c1 "$quick_dir/$i.log")" ]; then echo; fi
	times+=("${quick_names[$i]} $(cat "$quick_dir/$i.secs" 2>/dev/null || echo "?") s")
	if [ "$code" -ne 0 ]; then failed+=("${quick_names[$i]} (exit $code)"); fi
done
times+=("unit tests $tests_secs s")
if [ "$tests_code" -ne 0 ]; then failed+=("unit tests (exit $tests_code)"); fi
printf -v line '%s, ' "${times[@]}"
echo "== times, side by side: ${line%, }"
if [ ${#failed[@]} -gt 0 ]; then
	printf -v line '%s, ' "${failed[@]}"
	echo "check.sh: FAILED: ${line%, }. Each step's output is above, under its == heading." >&2
	exit 1
fi

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
