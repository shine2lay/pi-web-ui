# Durable command admission — #594

Accountable lead: Ops. This is the caller-only command/terminal partition of #570, not an independently releasable change. No landing, deployment, storage switch, real PTY, shell command, model call or live-chat test is authorized here.

## Hypothesis written before edits

**H-COMMAND-OWNERSHIP-1.** At baseline `4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`, SCMPanel restarts an existing terminal before calling `appSend(run_command)` and clears/records commit text without checking its result. TerminalPanel has the same existing/new split. New command metadata is executed by TermXterm's mount effect; mounting a running command again dispatches it again. These are distinct owners of execution, and refusal can lose authored work or disturb terminal state.

Change: give every explicit command action one asynchronous original-target ownership callback **before** restart/create/select/view/editor/history side effects. The host owns checkpoint and the single command dispatch; command-terminal mounting is attach/render, never execution. Preserve the separate live PTY input/output/resize and lifecycle operations.

Expected: exact immutable command/source/target snapshots reach that one owner; false, rejected, unsupported or unresolved admission changes no terminal process or commit history/text; strict asynchronous true permits only current-target UI cleanup, never marks execution successful. Mount/remount/recovery dispatch no command. Newer edits, ABA edits and changed targets survive late completion.

Falsification: any command dispatch outside that owner, any pre-admission restart/create/select/view mutation, raw-source/options/target loss, duplicate dispatch on mount, or stale editor/history mutation. The native suite must also reproduce the actual old source's loss and duplicate-dispatch behavior; a reimplementation is not a control.

## Known-input matrix (before edits)

| Fixed synthetic input                                                        | Required observation                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Existing live or dead same-title terminal in original conversation/workspace | Callback first; no local restart or command send; exact original terminal ID/options            |
| New command; foreign-conversation or foreign-workspace same-title tab        | New original-target ID; no reuse of foreign tab; no create until host owns it                   |
| CommandDef name/command/absent or empty or explicit cwd                      | Preserve all three fields exactly; no trimming or resolving `${pwd}` against later active state |
| Raw SCM commit with spaces, quotes, slash, backtick and dollar               | Preserve raw source separately from existing escaped/trimmed shell rendering                    |
| Deferred/false/rejected/throwing/void/synchronous-true callback              | No terminal process, view, selection, text or history mutation; no fallback                     |
| Strict asynchronous true                                                     | Ownership, not execution/exit success; unchanged submitted editor revision can clear/record     |
| Same-tick repeated click/Enter                                               | One outstanding intent per action target; no second owner                                       |
| Newer text or text A→B→A; recall/generated edit                              | Revision changes; old completion cannot clear/record new revision                               |
| Conversation/workspace/session A→B or A→B→A; unmount/remount                 | Old completion cannot mutate new target/editor or dispatch again                                |
| Existing/new/dead command terminal mount, remount and metadata refresh       | Register/attach only; zero `run_command` independently                                          |
| Plain shell creation, input, output, resize, rename/close                    | Existing authorized live I/O/lifecycle preserved; no durable PTY-byte journal                   |
| Genuine pinned old SCMPanel + TerminalPanel + TermXterm                      | Refusal still loses commit text/history; mount/remount really dispatches again                  |

## Ownership ABI

### Explicit question and actual answer

Before production edits, #594 asked #570 (request `rm-7a8cee7b`, forwarded by Ops HOME) whether the caller may use one typed asynchronous original-target command owner and what mount/attach means. Ops returned **actual host decision `rm-ce1d26e5`**, in reply **`rm-2a76b917`**: the command callback below is accepted; mounting is never execution; a **separate existing-only attach callback is required**. This is #570/Ops's interface decision within the approved plan, not owner release approval or backend proof.

### Command E (SCMPanel and TerminalPanel)

`onCommandIntent?: (intent: CommandIntent) => Promise<boolean>` is exported as `OnCommandIntent` from `web/src/components/SCMPanel.tsx`. `CommandIntent` contains:

- `requestId`, `source: "scm" | "terminal"`, genuine original `conversationId`, `sessionId`, `workspaceCwd`.
- `command: { name, command, cwd? }`, preserving optional/empty cwd and all authored spacing. Only those fields are copied; no command-settings document is journaled.
- `terminal: { id, title, cwd, cols, rows, mode: "new" | "existing", running, exitCode }`. Existing reuse requires original conversation AND workspace AND title, excludes agent-bash terminals, and preserves original dimensions/liveness. A new terminal has a fresh requested ID, 80×24 initial size, `running: false`, `exitCode: null`; these are request metadata, not a claim that a process exists.
- Optional `commitSource: { text, revision }`, with **raw** editor text including spaces, separate from the prior shell-escaped/trimmed command rendering.

The outer intent and all nested records are frozen before invoking the callback. No guessed conversation/SID/cwd fallback is permitted. A per-caller pending guard precedes invoking the host, including same-tick click/Enter. Different deliberate actions remain different requests; the host must deduplicate a request by its identity, not by command text.

Only a genuine asynchronous **literal `true`** permits UI completion. Missing callback, missing/coherence-failed original target, synchronous/void/truthy result, throw, reject, false or pending result never triggers legacy dispatch. True means the host has checkpointed the **complete exact original intent** and owns its **one** create/restart/dispatch; it does not mean command success or exit 0. The caller never calls restart/create/run_command for command E. Unchanged raw editor revision is retired into commit history before switching views could unmount SCM. Newer/generated/recalled/ABA edits are not cleared/recorded. Original target generation and mount lifetime fence late result selection and editor mutation; switching away and back does not rehabilitate an old result.

The guard is caller-local, not durable storage or globally proven host deduplication. #570 must persist authored/current/edited state across real unmount/reload/restart, own exact ack/results and fresh recovered actions, and prevent duplicate command ownership across renderers.

### Renderer attach (TerminalPanel → TermXterm)

`onAttachTerminal?: (intent: TerminalAttachIntent, replaceOutput: (data: string) => void) => Promise<boolean>` is exported as `OnAttachTerminal` from `web/src/components/TermXterm.tsx`.

`TerminalAttachIntent` is frozen and contains genuine original `conversationId`, `sessionId`, `terminalId`, fitted `cols`/`rows`, and fresh `viewId`. `viewId` is a display occurrence, **not** authority. TerminalPanel only passes SID when the terminal and active snapshot conversation coherently match; it never invents one. Command/managed/recovered terminal mounts and remounts always take this path, including dead terminals. Stored `command`, cwd/title/agent-bash metadata never authorizes mount-time execution.

Input and resize remain disabled until asynchronous exact true **and one actual output replacement**. `replaceOutput("")` is valid for genuinely retained empty output; registration alone or true without replacement is not. The replacement resets this renderer once and applies the retained snapshot, with exit-sentinel handling preserved; later/duplicate replacement, old-target completion and callbacks after renderer cleanup cannot reset/write a newer view. Missing callback/identity, rejection, false, no replay or unresolved attach stays truthful pending/unavailable/read-only. There is no terminal_create/run_command fallback, no process mutation in render cleanup, and no fake new wire-message cast in this slice.

#570 owns `terminal_attach` protocol/bridge/TerminalManager implementation: **strictly existing-only**, no spawn/restart when absent; flush pre-snapshot pending output; replay the actual retained output to the requesting renderer only; return true only after actual replay/attach. If process/output disappeared after restart, unavailable is the honest result; never silently re-execute the stored command.

### Live M/X behavior (not a journal)

**H-COMMAND-SHELL-METADATA-1 (written at final source review, before correction).** Baseline TermXterm forwarded the UI locale and optional agent-bash flag when explicitly creating a plain shell. The required migration of creation out of mount initially omitted those two fields. Preserve both on TerminalPanel's explicit M send; expect the existing shell unit/native case to assert the same locale/flag without adding any command intent or mount send. Falsification: missing/mismatched metadata or a new mount-time create. This is preservation of the old live operation, not a new journal or recovery action.

All mounts are now renderer-only. The explicit **New terminal** user action in TerminalPanel sends a normal live `terminal_create` and adds its local shell metadata only if transport accepted it; fitting/resize follows successful attach. This small paired move preserves plain-shell lifecycle M without making a recovered shell mount a new spawn. Explicit rename, close and PTY input/resize remain live protocol operations; output is rendered/replaced, not journaled. Theme, keyboard copy/paste, touch scroll, visibility fitting and non-killing renderer disposal remain. Command settings editing is untouched.

### Required integration and undo

#570 must wire BOTH command callback props and pass `onAttachTerminal` through TerminalPanel; install the actual existing-only host attach boundary and correlated owned-command result before release. Do not deploy this slice alone: absent callbacks intentionally fail closed. No App/controller, use-chat, global types, protocol, backend, live settings or storage switch is included here.

#570 still owes real durable checkpoint/receipt/deduplication, output attach/results, crash/restart/recovery/backup/restore and no-data-loss rollback, preservation of current engine/JSONL storage, staged rollout and the integrated full release gate. These isolated caller tests do **not** prove those obligations. Undo this handoff and its paired host integration together; never revert just one side or re-enable mount-time command execution on restored records. No independent land/deploy is performed by #594.

## Result

Initial focused run: **59 new component tests / 97 focused tests passed**, build, all five typechecks, targeted lint (zero warnings/errors), six-file formatting and diff checks passed. Native tests passed the fixed-source admission, races, I/O and attach cases, then the old-source existing-terminal control reported **2 sends, expected 1**: the shared test helper deliberately clicked twice, whereas that control's oracle described one authored action. This was a fixture-count **MISS**, not permission to weaken ownership checks.

**H-COMMAND-CONTROL-1 (before fixture repair).** Parameterize action count: retain two-click fixed-source admission tests, explicitly single-click the old-source loss/remount controls, and separately assert the genuine old-source two-click duplicate. Expect one old explicit dispatch plus one remount dispatch, and two dispatches for two old same-tick clicks. Falsification: those counts fail against the pinned source, or any fixed-source ownership/mount assertion fails. Only the doubtful native stage is rerun; already-passing unit/build checks are not repeated without changed production code.

**Final result: H-COMMAND-OWNERSHIP-1 HIT (caller boundary only); H-COMMAND-CONTROL-1 HIT; H-COMMAND-SHELL-METADATA-1 HIT.** The final native suite passed **280 measured checks**, including actual-component/browser admission, new/existing/dead and foreign targets, duplicate click/Enter, deferred/strict-result cases, editor/target/lifetime races, immutable complete snapshots, real xterm live I/O, read-only/failed attach, and stale retained-output replacement. It reproduced genuine old-source loss for transport false **and true**, old same-tick duplicate clicks, and single-action new/existing command remount dispatches; no replacement implementation was used as a control. No browser runtime errors occurred.

Pinned old component SHA-256:

- SCMPanel: `15a6a65c1b94ab5974320fcb11501c9757f5d367519c1101a3e3cec0172a4c00`
- TerminalPanel: `710ffa6d895f2c23843e70ff53da939380836304fc75526a80613b682b742b1e`
- TermXterm: `a907246c56ea60acdd67c93fd77c792684dd96b56b17b0d85a2eb045af85e578`

Checks (sealed temporary HOME; no real chats/profiles/repos/PTYs/models involved in the fixtures):

```sh
scripts/sealed.sh env TZ=UTC VITEST_MAX_WORKERS=2 ./node_modules/.bin/vitest run tests/unit/durable-command-admission.test.ts tests/unit/scm-commit-history.test.ts tests/unit/scm-quote.test.ts tests/unit/scm-history-filter.test.ts tests/unit/scm-sidebar.test.ts tests/unit/term-touch.test.ts
scripts/sealed.sh node tests/durable-command-admission-test.mjs
scripts/sealed.sh npm run build
scripts/sealed.sh npm run typecheck
scripts/sealed.sh ./node_modules/.bin/oxlint web/src/components/SCMPanel.tsx web/src/components/TerminalPanel.tsx web/src/components/TermXterm.tsx tests/unit/durable-command-admission.test.ts tests/durable-command-admission-test.mjs
scripts/sealed.sh ./node_modules/.bin/prettier --check web/src/components/SCMPanel.tsx web/src/components/TerminalPanel.tsx web/src/components/TermXterm.tsx tests/unit/durable-command-admission.test.ts tests/durable-command-admission-test.mjs docs/durable-command-admission.md
git diff --check
```

Initial unit/build/typecheck/lint passed before the bounded native-fixture correction. Final review additionally found the explicit-shell locale/agent-bash preservation omission described above; after that correction all 59 touched unit tests, 280 native checks, build, five typechecks, targeted lint/format and diff checks passed. The other 38 already-passing focused regression tests were not needlessly repeated. Known non-fatal tool warnings: native IIFE fixture's imported base-url module uses `import.meta`; build reports existing large chunks. The native test supplies its own local fixture origin and has zero outbound app/model traffic. Both remain warnings, not claimed backend failures or claimed host-persistence proof. All changed files are exactly the six allowed paths. #570 receives this commit/ABI unlanded; genuine persistence/restart/rollback, real existing-only retained-output attach, full release gate and deployment remain outstanding there.
