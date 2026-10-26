# Durable terminal replay order — Ops #597

Accountable lead: Ops. This is a renderer-only repair of #594, based on `c41a3bf975013bf2e4bd2f162815e8c4445353e2`. It is an unlanded handoff to #570, not independently releasable. Ops's explicit lead decision on the scope question permits a fifth file, `tests/unit/durable-command-admission.test.ts`, solely for a completion-aware mock and three obsolete timing cases; this is a technical decision, not deployment or owner consent. No host, wire, storage, dependencies, PTY, model, real chat or user profile is changed or used.

## Hypothesis written before production edits

**H-TERM-REPLAY-QUEUE-1.** The pinned TermXterm calls synchronous `term.reset()` before asynchronously queued `term.write(snapshot)`. xterm 6.0.0 documents in `CoreBrowserTerminal.reset` that pending input is not cleared. A same-turn pending `write("LIVE-A")`, reset and `write("HISTORY\r\nLIVE-A")` yields `['LIVE-AHISTORY', 'LIVE-A']` instead of `['HISTORY', 'LIVE-A']`. The old attach result also enables input on callback invocation, not actual renderer completion.

One change: put replacement into xterm's own ordered write stream, using parser cancellation plus RIS (hard reset) immediately before the retained snapshot and its optional exit decoration. Require the actual write callback AND the existing asynchronous literal-true host result before enabling attached status, input and resize. xterm owns all buffering and its existing overflow protections; no separate renderer backlog, guessed delay or timeout is introduced. Stale/duplicate replacements and disposed renderer completions remain fenced to the captured view lifetime.

Expected exactness: for a queued prefix `LIVE-A`, retained `HISTORY\r\nLIVE-A`, and post-snapshot `\r\nTAIL-1\r\nTAIL-2` queued before parsing finishes, the final buffer is exactly `['HISTORY', 'LIVE-A', 'TAIL-1', 'TAIL-2']`. Empty retained output is a real replacement, not permission to skip renderer completion. The host must still supply an authoritative snapshot with an exact live-output boundary; renderer ordering cannot deduplicate a host stream that sends overlapping bytes after the boundary.

Falsification: any surviving pre-snapshot prefix, lost/duplicated/reordered retained or post-snapshot bytes, inherited partial escape/parser state, premature attached/input/resize, duplicate exit decoration, mutation of a new renderer from an old completion, or renderer-originated create/run/restart/kill. The native suite must demonstrate the race against the **unaltered pinned old TermXterm**, not a handwritten bad adapter.

## Known-input checks (before implementation)

- Same-turn queued prefix and immediate replacement, including a truly empty snapshot; exact full buffer after native write completion.
- Several post-snapshot tails arriving before snapshot parse completion; Unicode, CRLF, output bursts and split escape sequences.
- Pre-snapshot incomplete CSI, OSC and DCS state, modes/attributes and alternate buffer; replacement starts from a clean parser/screen, subsequent split escape state still works.
- Host literal true before renderer callback, callback before host true, false/throw/reject, unsupported/synchronous/truthy result and true without replacement: only both genuine success conditions enable input/resize/status.
- Repeated/late replacement; unmount/remount, conversation/session/terminal switch and ABA switch; old registered writer/disposal/completion cannot affect a new view.
- Already-stopped and live-to-exited transitions while replay is pending: banner follows retained/live output in native order and appears once.
- Missing callback/target remains read-only; zero mount-originated command/create/restart/kill; existing explicit-shell behavior is checked by #594's native companion.

## Compatibility finding before production edits

The unchanged #594 unit fixture mocks `Terminal.write` with a bare `vi.fn()` that never calls a completion callback. Three existing attach/I/O tests also require synchronous `reset()` and immediate enablement after the host result. Those assertions encode the defect this task must remove; they cannot pass unchanged while genuinely checking renderer completion. Ops's actual lead answer authorized adapting that single legacy unit file, keeping every other assertion and its native companion unchanged. The three adapted test templates are `preserves attached shell live input/resize/output and non-killing unmount`; `freezes real original identity + fitted size; true needs output replacement before enabling input`; and `late replacement/result cannot touch another renderer (%s)` (conversation/session/terminal/remount). Their new mock exposes individual queued write callbacks: host true alone leaves the renderer pending/read-only until the required callback is explicitly acknowledged. Never add a production mock-detection path or pretend invocation proves parsing.

## Ordering and lifetime contract

`replaceOutput` queues one native write containing CAN (`0x18`), RIS (`ESC c`), the cleaned retained snapshot and, if already stopped, the exit banner. CAN returns incomplete CSI/OSC/DCS parsing to ground; RIS then resets buffers/modes/attributes at that exact position in the native queue. Earlier queued bytes are parsed before RIS and their screen/scrollback state is superseded. Later `write` calls remain after that single snapshot write. Later split escape sequences and Unicode chunks retain their normal parser state. An exit banner cancels any unfinished control sequence before decorating the final output; a renderer-local running edge prevents duplicates across replay and live exit transitions.

Only a still-current view with both an asynchronous literal-true host result and the native snapshot write's completion callback enables input, resize or attached status. Completion alone, invocation alone, no replay, false/truthy/throw/reject and unsupported callback remain read-only. An unacknowledged callback leaves the view pending; no fallback or timer fabricates success. No second backlog or promise barrier can hold a new view hostage. External writer disposal and effect cleanup fence before unregistering; all old replacement/write/result/completion paths are bound to the old renderer, never the new one. Callback order does not change the ABI.

## Exact receiving scope

- `web/src/components/TermXterm.tsx`
- `tests/unit/terminal-replay-order.test.tsx`
- `tests/terminal-replay-order-test.mjs`
- `tests/unit/durable-command-admission.test.ts` — completion-aware mock and the three timing cases above only
- `docs/durable-terminal-replay-order.md`

Tracking note: Ops HOME reported two simultaneous chats labelled #597 and instructed this terminal-repair chat not to mutate that native queue slot, now bound to a separate scheduler repair. This source work remains the admitted terminal repair; HOME will bind its committed handoff to a uniquely tracked receiving task. No queue completion or blocker mutation is made from this chat after that instruction.

## Remaining integration obligations

ABI remains `onAttachTerminal(intent, replaceOutput) => Promise<boolean>`, with genuine conversation/session/terminal/view binding and existing-only host ownership. The renderer completion is local; `replaceOutput` still returns void, and the host promise is not a renderer-completion or persistence receipt. #570 owns:

1. Actual retained-output capture with an exact snapshot/live cut. Prefix bytes superseded by the snapshot must already be retained there; bytes delivered after replacement must start strictly after that cut, in order. This renderer cannot infer or repair missing or overlapping host bytes.
2. Genuine existing-only ownership and target/view binding for the host result, including false/throw/lifetime refusal. No mount/attach command allocation, replay, spawn, restart or kill.
3. Retained output persistence, real reconnect/restore and service/process restart recovery, including actual registered live output and exit metadata. The fixture uses no PTY, service or real data and proves none of those host effects.
4. The unchanged integrated full gate and staged rollout, with real no-loss recovery/rollback proof and an accessible retained reader. Native xterm buffering/overflow protection remains unchanged; fixture burst sizes are known test inputs, not new limits.

Paired undo: disable/roll back the W2 host attach path and its caller together to the approved retained-reader mode if integrated proof fails; keep retained host data readable and do not re-enable mount-time execution. Do not independently revert just this renderer under an active W2 host or erase retained output to make a test pass. No independent land, install or deployment.

## Results

**HIT at the renderer boundary.** All implementation edits preceded the single focused verification run. At the worktree based exactly on #594:

- `scripts/sealed.sh node tests/terminal-replay-order-test.mjs --unit` — 7 files / 128 passed: 31 new ordering/lifetime cases, all 59 #594 cases with only the authorized mock/timing adaptations, and 38 existing SCM/touch regressions.
- `scripts/sealed.sh node tests/terminal-replay-order-test.mjs` — 318 native checks; actual component and native xterm; no write/reset/completion replacement.
- `scripts/sealed.sh node tests/durable-command-admission-test.mjs` — all 280 native #594 checks passed, file unchanged; explicit user-shell behavior preserved.
- `scripts/sealed.sh npm run build` — passed; worktree output only.
- `scripts/sealed.sh npm run typecheck` — all five existing projects passed.
- Explicit strict `tsc --noEmit` for new `.tsx` plus the existing build/CSS/fonts declarations — passed; the repository's test-project include covers only `.ts`, so this was checked separately.
- Targeted `oxlint` on all four source/test files — 0 errors / 0 warnings.
- Prettier check on all five files; `git diff --check` — passed before tests; doc-only evidence update checked again before commit.

The unaltered old control is loaded using `git show c41a3bf975013bf2e4bd2f162815e8c4445353e2:web/src/components/TermXterm.tsx`; SHA-256 `4357e605c8367ce7a768824b2eec662470da020b73df27835df2651803974720`. Same-turn old output was exactly `['LIVE-AHISTORY', 'LIVE-A', 'TAIL-1', 'TAIL-2']`, failing the fixed expectation `['HISTORY', 'LIVE-A', 'TAIL-1', 'TAIL-2']`. While a native async parser handler held snapshot completion, old state was already `attached` with `disableStdin=false` and buffer `['LIVE-AHISTORY']`. The corrected component stayed pending/read-only with no input/resize before release and then produced the exact fixed buffer. The hold is a native parser promise, not a timer, mock acknowledgement or modified write implementation.

Exact buffer assertions also passed for incomplete CSI/OSC/DCS, graphics charset and alternate buffer, incomplete Unicode prefix, split Unicode/CRLF/SGR/OSC tails, 128 prefix chunks and 180 live tail chunks, empty snapshots, both host/parser acknowledgement orders, nonliteral/false/reject and missing/throw/sync callbacks, true without replacement, late/duplicate replacement, native held-parser remount/session/conversation/terminal/ABA switches, disposal and old callbacks, stopped/live-to-exited banners and unfinished controls before exit. No renderer-originated create/run/kill, no real PTY or model calls, and no local/session output storage. The existing IIFE fixture build emits its known `import.meta` warning, and the normal build emits its large-chunk warning; neither is a failed check.

HOME independent acceptance and #570's integrated host/full-gate/retained-data proof are still pending. No integrated no-loss, landed, installed or deployed claim. No queue mutation after HOME's collision notice.
