# Web test CPU entry

## Hypothesis (Ops #657, H-WEB-TEST-CPU-1)

The sealed fence scrubs the environment, while the detached runner currently asks the user manager
for a new unit. Neither is proof of membership in the shared system slice. Entering through the
canonical test launcher **before** sealing/building, and using its token-owned detached unit when
enabled, should cover both paths without changing test selection or isolation.

Measure with fixed fake-manager inputs and synthetic sealed commands: inactive/inside/outside,
refusal, failed detach, exact argv/environment/stdout/exit, token result/stop and cleanup. The
hypothesis misses if a scrubbed environment or forged marker bypasses entry, fallback runs uncapped,
following loses output/results, or a stop does not reach its own fixture. Real quota/unit lifecycle
qualification belongs to setup task G, not these fake transports.

H1: **MISS** in the first fixed checks: five existing caller-hook cases failed because the new Node
bootstrap read `NODE_OPTIONS` before the shell could scrub it. The two new shell-fixture failures
also showed that the enclosing fence correctly carried its marker/log into those fixtures; they
must explicitly request a fresh nested seal, as the existing fence tests do.

H2: scrub caller Node hooks only for the transport bootstrap, restoring them on the payload command
before any existing sealed fast path. Explicitly fresh synthetic seals should then keep the same
no-live-data fence, reports, environment filtering and cleanup. Wrong if invalid caller hooks still
break entry or a nested payload loses its fence. **HIT:** corrected fixed stage run: 110/110 tests
passed, including all 48 existing fence checks and the active bootstrap-hook control.

Independent review also found two dispatch failure windows and a legacy log-ownership transition.
H3: only documented refusals may fall back; preserve ambiguous dispatch records, let the detached
runner publish its canonical unit token, and recover the token from its final worker receipt after
an interrupted dispatch. Persist external log ownership independently of CPU placement and the
one-use environment file. Expected: no duplicate launch/log lines, with interrupted-start results
still followed exactly. Wrong if a signal/unknown status triggers fallback, recovery accepts an
invalid token, or a legacy child logs twice after placement re-exec. **Partial MISS:** five initial
review controls failed before the fix and passed after it; the second review exposed two additional
startup cases, both reproduced failing-first: delayed worker publication outlives the old grace,
and quota-dependent identity bookkeeping can abort startup during inactive rollback.

H4: keep tokenless dispatch explicitly unconfirmed while following its logs/receipts (never infer
"stopped" from a dead starter or elapsed looks); correlate the worker's canonical cgroup identity
without treating current quota readiness as a bookkeeping gate. Canonical entry alone still decides
whether commands may run. Expected: a delayed token eventually returns the exact result, and
inactive rollback does not abort a dispatched worker. Wrong if unconfirmed dispatch is called
success/stopped, or bookkeeping overrides the canonical entry verdict. **HIT:** all 563 unit files
passed (10,231 tests passed, 25 existing conditional skips), including the 56 new transport cases
and the unchanged 59 sealed-run/fence cases. Final independent source review: no unresolved P0/P1.

The full gate's unit/protocol/patch/lint/format checks passed, but TypeScript rejected the fixed
transport doubles: inference exposed all `spawnSync` overloads, although this adapter only uses its
UTF-8 command/argv/options shape. H5: describe that narrow injected transport in JSDoc, without
casts, suppression, changed runtime code or weakened assertions. Expected: the unchanged fixtures
and real `spawnSync` both satisfy the interface and typecheck passes. Wrong if runtime behavior or
existing type safety must change. **HIT:** typecheck passed with JSDoc-only transport types; no
runtime expression, assertion or compiler setting changed. The remaining full-gate phases then
passed sealed: build, PTY script regression and all 74 terminal checks. Normal detached landing
re-runs the gate on its rebased head. One preliminary gate invocation was interrupted by the tool's
short command timeout before a verdict; it is not counted as a pass.

At worktree verification, canonical policy status was `absent` with no faults; `land_slots` remained
1. Real CPU placement/aggregate quota/privileged lifecycle behavior is **UNPROVEN here** and remains
G/H's qualification, not something the fake transport tests claim.

## Entry inventory

| Entry                                                                    | Boundary                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/check.sh`, `--fast`, `--notes` (including `wt land`/`wt check`) | Check canonical status before the existing sealing decision; re-enter through `test-cpu exec` if outside. Original phases and conditions unchanged.                      |
| `scripts/sealed.sh [--report] [--keep] <command…>`                       | Check before the already-sealed fast path and before allocating/scrubbing the temporary HOME. Nested calls recheck real placement, not an environment marker.            |
| `node tests/run-sealed.mjs [names…]`                                     | Decide detachment while still in the originating service; enter before suite admission, builds and test children. Individual scripts retain their own sealed HOME/fence. |
| `run-sealed --here` or failed detach                                     | Same foreground entry; `--here` disables detachment only, never CPU placement.                                                                                           |
| `run-sealed --result [--out=…]`                                          | Read/follow only, not a new test; no CPU entry. Token jobs use `test-cpu result`, legacy user units keep their existing result path.                                     |
| `npm test`, `npm run test:unit`, direct Vitest                           | Use `scripts/sealed.sh npm test -- …` (or the gate); bare upstream commands are not automatically wrapped.                                                               |
| `npm run test:smoke`, `test:smoke:core`, `node tests/run-smoke.mjs`      | Use `scripts/sealed.sh <command…>`; selection, retries, workers and conditional skips stay upstream's.                                                                   |
| `npm run test:freeze`, direct `tests/*-test.mjs`, browser/manual scripts | Use `scripts/sealed.sh <command…>` or name scripts in `run-sealed`; no live attachment/model invocation is authorized by wrapping them.                                  |
| Build/type/lint/protocol/extension steps used for a test                 | Run inside the gate, `run-sealed`, or `scripts/sealed.sh <command…>`. Ordinary app builds/dev/start/deploy paths are not modified.                                       |
| Upstream GitHub CI                                                       | Keeps its upstream bare commands on remote hosts; this patch does not claim local-host coverage for unwrapped commands or external Actions.                              |

## Host contract and transport

One shared allowance, not a per-job quota: see agent-tools `docs/test-cpu-contract.md` (Ops #655).
The only command path is `/usr/local/libexec/test-cpu/bin/test-cpu`; the canonical policy is
`/etc/agent-tools/test-cpu.json`. No PATH search, environment override, local quota, second admission
pool or copied placement logic. This source lands inactive: G installs, H activates.

Without both installed launcher and policy, only **confirmed absent policy** permits old behavior.
A present/unreadable policy with a missing launcher refuses with 125; restore the canonical install.
With the launcher installed, its status is authoritative. Invalid status/transport fails visibly;
`PI_SEALED`, `WT_SLOT`, `CI`, and scrubbed HOME do not switch CPU entry off.

Detached active jobs use `start --log <out>/run.log --result <out>/cpu-result.json -- …`; `run.json`
retains repo/args/unit/time and adds the token/transport. Stop with the printed `test-cpu stop <token>`
command (add `--force` for that owned job only). `--result` follows the log and checks the token result;
a lost/unknown job is infrastructure failure, never success. The runner still writes `pid`, `exit`,
`summary.json`, individual logs and fence reports.

Only `start` exit 3 (inactive) permits the old `systemd-run --user` transport. That child also checks
canonical placement before work, so policy activation during startup cannot silently bypass it.
A documented refusal (125) falls back through foreground entry, never directly to an unplaced test.
A signaled/unknown start or invalid success receipt is ambiguous: retain its record and report it,
never start a possible duplicate. Workers also publish their canonical cgroup token; that identity
bookkeeping cannot veto canonical inactive entry during rollback. A final worker receipt can recover
an unpublished token, but only the canonical `result` command supplies its verdict.

After interrupted dispatch, a tokenless `--result` stays explicitly **unconfirmed** until identity
or the worker receipt appears. It reports that once; a dead starter or elapsed looks do not prove
that no worker exists. If no worker ever launched it may wait indefinitely: Ctrl-C leaves only the
follower, never cancels or retries the job. Malformed recovery files and canonical token errors still
fail explicitly. External log ownership is recorded independently of the one-use environment file,
so later policy activation/re-exec cannot double-append legacy output.

The sealed environment allowlist, temporary-home deletion, fence exit 97, descendant cleanup,
worker overrides, per-script timeout, fixed-port exclusion, known-fork skips and two-suite admission
remain unchanged. No server/cgroup-split, live app, Docker daemon, settings, slot count, privileged
setup, deploy or restart change.

Undo: revert this source patch. After later activation that would uncover these web routes; disclose
that before reverting. Operational non-killing undo is owned by G/H, not this adapter.
