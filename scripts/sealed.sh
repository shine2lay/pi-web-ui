#!/bin/bash
# sealed.sh: run a command (a test, a test suite, check.sh) in a sealed temporary home.
#
#   scripts/sealed.sh <command> [args…]            # fence enforcing: touching real data fails the run
#   scripts/sealed.sh --report <command> [args…]   # fence only records (to take an inventory)
#   scripts/sealed.sh --keep <command> [args…]     # keep the temp home afterwards (for debugging)
#   scripts/sealed.sh env FOO=1 node tests/x.mjs   # pass a variable through: use `env`
#
# "Sealed" here (this machine can't use bwrap/unshare, so it is environment + a node fence):
#   - a fresh temp HOME, PI_CODING_AGENT_DIR, PI_WEB_DATA_DIR and TMPDIR, removed afterwards;
#   - a clean environment: only PATH, locale and terminal variables survive. No model keys or
#     tokens, and none of the live server's PI_WEB_PORT / PI_WEB_DATA_DIR (a chat's shell has them);
#   - the temp pi folder gets a stand-in model that can't be reached (provider "fastfail" at
#     127.0.0.1:1, a dummy key, automatic retry off): tests were written on machines where pi is set
#     up, and without any model the web app opens its first-run setup window over everything.
#     A prompt to it fails at once; nothing leaves the machine. PI_SEALED_MODEL=none skips it;
#   - every node process loads tests/lib/sealed-fence.cjs (NODE_OPTIONS). Touching the real ~/.pi,
#     ~/.pi-web-ui or ~/.pi-scheduler, or connecting to the live pi-web-ui port, is a fence hit.
#     Reading installed add-on code (~/.pi/agent/npm, ~/.pi/agent/git) is allowed.
#   - afterwards: fence hits are listed and fail the run (exit 97); processes the command left
#     running are stopped; new folders in the real sessions list are reported.
#
# Inside a sealed run already (PI_SEALED set)? Then the command just runs in that one.
# PI_SEALED_REPORT_FILE=<file> (outside the temp home) gets a JSON summary, for tests/run-smoke.mjs.
set -uo pipefail

if [ -n "${PI_SEALED:-}" ]; then
	exec "$@"
fi

mode=enforce
keep=false
while [ $# -gt 0 ]; do
	case "$1" in
	--report) mode=report; shift ;;
	--keep) keep=true; shift ;;
	--) shift; break ;;
	*) break ;;
	esac
done
if [ $# -eq 0 ]; then
	sed -n '2,6p' "$0" >&2
	exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
fence="$repo/tests/lib/sealed-fence.cjs"
real_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
real_home="${real_home:-$HOME}"
real_sessions="$real_home/.pi/agent/sessions"
live_ports="${PI_SEALED_LIVE_PORTS:-${PI_WEB_PORT:-8787}}"
report_file="${PI_SEALED_REPORT_FILE:-}"

root="$(mktemp -d "${TMPDIR:-/tmp}/pi-sealed-XXXXXX")" || exit 2
home="$root/home"
mkdir -p "$home/.pi/agent" "$home/.pi-web-ui" "$root/tmp"
printf '[user]\n\tname = Sealed Test\n\temail = sealed-test@localhost\n' >"$home/.gitconfig"
if [ "${PI_SEALED_MODEL:-fastfail}" != "none" ]; then
	printf '%s\n' '{"fastfail":{"type":"api_key","key":"sealed-test-dummy"}}' >"$home/.pi/agent/auth.json"
	printf '%s\n' '{"providers":{"fastfail":{"api":"openai-completions","baseUrl":"http://127.0.0.1:1","apiKey":"sealed-test-dummy","models":[{"id":"test-model"}]}}}' >"$home/.pi/agent/models.json"
	printf '%s\n' '{"retry":{"enabled":false}}' >"$home/.pi/agent/settings.json"
fi
log="$root/fence.log"
: >"$log"

sessions_before="$(ls -A "$real_sessions" 2>/dev/null)"

# The environment: a short list survives, everything else (keys, tokens, PI_WEB_*) is dropped.
envs=()
for v in PATH LANG LANGUAGE LC_ALL LC_CTYPE LC_MESSAGES TERM COLORTERM NO_COLOR FORCE_COLOR USER LOGNAME SHELL TZ CI PI_WEB_CHROME; do
	if [ -n "${!v+x}" ]; then envs+=("$v=${!v}"); fi
done
browsers="${PLAYWRIGHT_BROWSERS_PATH:-$real_home/.cache/ms-playwright}"
[ -d "$browsers" ] && envs+=("PLAYWRIGHT_BROWSERS_PATH=$browsers")
envs+=(
	"HOME=$home"
	"TMPDIR=$root/tmp"
	"PI_CODING_AGENT_DIR=$home/.pi/agent"
	"PI_WEB_DATA_DIR=$home/.pi-web-ui"
	"NODE_OPTIONS=--require $(if [[ "$fence" =~ [[:space:]] ]]; then printf '"%s"' "$fence"; else printf '%s' "$fence"; fi)"
	"PI_SEALED=1"
	"PI_SEALED_ROOT=$root"
	"PI_SEALED_FENCE=$mode"
	"PI_SEALED_FORBID=$real_home/.pi:$real_home/.pi-web-ui:$real_home/.pi-scheduler"
	"PI_SEALED_READONLY=$real_home/.pi/agent/npm:$real_home/.pi/agent/git"
	"PI_SEALED_LIVE_PORTS=$live_ports"
	"PI_SEALED_FENCE_LOG=$log"
	"PI_SEALED_REAL_AGENT_DIR=$real_home/.pi/agent"
	# npm: reuse the download cache, stay quiet
	"npm_config_cache=$real_home/.npm"
	"npm_config_update_notifier=false"
	"npm_config_fund=false"
	"npm_config_audit=false"
)

# Processes of this run carry PI_SEALED_ROOT=$root in their environment.
leftovers() {
	local e pid
	for e in /proc/[0-9]*/environ; do
		pid="${e#/proc/}"
		pid="${pid%/environ}"
		[ "$pid" = "$$" ] && continue
		grep -qzxF "PI_SEALED_ROOT=$root" "$e" 2>/dev/null && echo "$pid"
	done
}
leaked=""
stop_leftovers() {
	local pids pid
	pids="$(leftovers)"
	[ -z "$pids" ] && return 0
	for pid in $pids; do
		leaked+="$pid $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-160)"$'\n'
	done
	kill -TERM $pids 2>/dev/null
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 0.2
		pids="$(for pid in $pids; do kill -0 "$pid" 2>/dev/null && echo "$pid"; done)"
		[ -z "$pids" ] && return 0
	done
	kill -KILL $pids 2>/dev/null
	return 0
}
cleanup() {
	if $keep; then
		echo "[sealed] kept the temp home: $root" >&2
	else
		rm -rf "$root"
	fi
}
child=""
on_signal() {
	[ -n "$child" ] && kill -TERM "$child" 2>/dev/null
	stop_leftovers
	cleanup
	exit 130
}
trap on_signal INT TERM HUP

# Run it (in the background so a signal reaches the trap right away; stdin stays connected).
env -i "${envs[@]}" "$@" <&0 &
child=$!
wait "$child"
code=$?
child=""

stop_leftovers
sessions_after="$(ls -A "$real_sessions" 2>/dev/null)"
new_dirs="$(comm -13 <(printf '%s\n' "$sessions_before" | sort) <(printf '%s\n' "$sessions_after" | sort) | sed '/^$/d')"

final="$(env -i PATH="$PATH" node "$here/sealed-summary.mjs" "$log" "$mode" "$code" "$report_file" \
	"$leaked" "$new_dirs")"
final="${final:-$code}"
cleanup
exit "$final"
