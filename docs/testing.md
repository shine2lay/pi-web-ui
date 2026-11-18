---
test_check:
  kind: product
  staging: none
  release:
    files:
      - ~/projects/agent-tools/bin/pi-web-deploy
      - ~/projects/agent-tools/lib/deploy/release-smoke.mjs
    stop_proof: docs/release-stop-proof.json
  smoke:
    flows:
      F1: open the app
      F2: send a message and get a reply
      F3: open an existing big chat with pictures
      F4: a chat survives a restart
    before: node tests/release-smoke/before.mjs
    before_target: local-start
    live: node tests/release-smoke/live.mjs
    live_data: qa-account
    proof: tests/release-smoke/proof.json
  quarantine: docs/testing-quarantine.md
  below_par: found-below-par.md
  miss_log: docs/testing-misses.jsonl
  done_lists: .temper/features/*/done.md
---

# Testing pi-web-ui

pi-web-ui is the `product` kind. `test-check` reads the block above and scores the repo; the
format is /home/shinelay/projects/agent-tools/docs/test-check-page.md. The facts below come from files by script (make_page.py, QA #155).

## Tools

- node script: 265 test files, first seen at `tests/accent-contrast-test.mjs:1` (facts table, 2026-11-14).
- node:test: 1 test files, first seen at `tests/role-message-guard-acceptance/local.test.mjs:1` (facts table, 2026-11-14).
- vitest: 659 test files, first seen at `vitest.config.ts:1` (facts table, 2026-11-14).
- Browser test files: 141 (facts table).
- test-check counts 916 test files.

What the tests exercise:

- `tests/unit/**/*.test.ts` (Vitest, `npm test`): server modules, web logic and components, plugins
  and the fork's patches, against fakes and temp folders. The landing check runs these.
- `tests/*-test.mjs` (node scripts): each starts its own server with a temp data folder and drives
  it; [tests/run-smoke.mjs](../tests/run-smoke.mjs) runs those that need no model and no fixed local
  paths. Browser ones (playwright-core) are run by hand.
- Every run of `scripts/check.sh` is sealed ([scripts/sealed.sh](../scripts/sealed.sh)): a temp home
  with no model keys, so no test can reach a real chat or a model.

## What runs when

| When | What runs | How long | Source (date) |
| --- | --- | --- | --- |
| Before a change lands (`wt land`, also `wt check`) | `scripts/check.sh --fast` (wt entry `pi-web-ui`); test-check: wt entry pi-web-ui: check `scripts/check.sh --fast` runs vitest (scripts/select-tests.mjs:42). A failure refuses the land. | median 1.2 min over the last 10 succeeded lands (each land: check, wait for the land slot, push) | /home/shinelay/projects/agent-tools/wt.yaml:192; land records in /home/shinelay/projects/pi-web-ui/.git/wt-land-queue/ via test-check on 3723898 (2026-11-14) |
| Before a change that touches only notes lands | `scripts/check.sh --notes` instead of the check above, for files matching `docs/**/*.md, PATCHES.md` | not measured | /home/shinelay/projects/agent-tools/wt.yaml:202 (2026-11-14) |
| Each install (`pi-web-deploy`), before the swap | the before-run on the fresh build; not green = nothing installed | 57 s | /home/shinelay/projects/agent-tools/docs/pi-web-deploy-smoke.md (2026-11-14) |
| After every install, restart and rollback | server check, the live run, log check; red after an install rolls it back and names the last good build | 73 to 79 s | same |
| Every day at 04:00 | the whole unit suite and the build on the newest `mine`, in a throwaway checkout (`pi-web-ui-full-tests`, outside the repo); a failure messages the owner | 1.3 min on 2026-11-14 (644 files passed) | /home/shinelay/projects/agent-tools/docs/pi-web-ui-full-tests.md:37 (2026-11-14) |
| Never on `mine` | upstream's CI workflow, nightly at 16:00 and on upstream's `main` only | not measured | .github/workflows/ci.yml:3-10 (2026-11-14) |

The landing check ([scripts/check.sh](../scripts/check.sh) `--fast`) runs the protocol sync check,
the PATCHES.md check, the typechecks, oxlint and Prettier on changed files, plus only the unit test
files the change can reach (`scripts/select-tests.mjs`; all of them when unsure,
[docs/gate-selected-tests.md](gate-selected-tests.md)). The full check, plain `scripts/check.sh`,
adds every unit test, the build and the real-PTY terminal tests; no automatic run uses it. Upstream's
[.github/workflows/ci.yml](../.github/workflows/ci.yml) never runs on `mine`.

A release is an install on this machine with `pi-web-deploy` (agent-tools). It builds the commit in a throwaway
worktree (a failed build, or a changed `package-lock.json` without `--deps-updated`, refuses the
install), runs the before-run there, and installs only on green. After every restart it runs the
live run once, no second try: red after an install rolls back by itself and messages the owner;
unsure (exit 3) is neither rolled back nor recorded good. There is no staging copy.

## Smoke tests of the main user flows

[tests/release-smoke/](../tests/release-smoke/README.md) has one test file per flow, tagged
`@flow:<id>`. Each command prints one line per check and exits 0 (passed), 1 (failed) or 3 (unsure:
blocked outside pi-web-ui, such as the provider).

- Before the swap, `before.mjs` runs F1-F4 on its own copy of the folder's build, with temp data and
  the zero-token stand-in model (`local-start`, about 1 min).
- After the restart, `live.mjs` runs F1-F3 on the live app at both addresses, touching only a
  throwaway chat and a copy of QA's big chat (`qa-account`, about 1 min).

| Flow | Before | Live |
| --- | --- | --- |
| F1 open the app: page, socket ready, chat list, no version banner | yes | yes, both addresses |
| F2 send a message and get a reply: it streams, a tool call shows, the turn ends | yes | one tiny reply, no tool call |
| F3 open a big chat: it opens, scrolls back, its pictures load | yes | yes |
| F4 a chat survives a restart: the cut-off turn carries on | yes | no (needs a turn planted before the restart) |

Open flows: F5 a queued task runs, F6 a second window or phone on one chat, F7 the add-on pages
load. The before-run sees no real add-on, model, public route or swap; the live run skips F4 and
the tool-call display. Proof that each check goes red on a planted break:
[PROOF.md](../tests/release-smoke/PROOF.md).

## What is not covered

- Smoke flows F5-F7 have no test.
- The node-script tests in `tests/` run only by hand; the real-PTY terminal tests only in the full
  check. The build is not in the landing check; the daily run and `pi-web-deploy` build it.
- The landing check runs a subset of the unit tests; one it misses runs in the next daily run.
- Desktop shell and extension: typecheck only.

## How to run

```bash
scripts/check.sh --fast   # the landing check
npm test
npm run test:freeze
npm run test:smoke
npm run test:smoke:core
npm run test:unit
node tests/release-smoke/before.mjs   # needs a build
node tests/release-smoke/live.mjs
test-check /home/shinelay/projects/pi-web-ui
```

Rules every test here keeps:

- No automatic re-run. A test that fails and then passes on the same code is repaired, or pulled
  onto [the quarantine list](testing-quarantine.md) with a fix task (`tests/run-smoke.mjs`
  `--retry-once` is upstream CI's only).
- A skipped test says why and names the task that brings it back.
- Past failures and complaints are checks in [found-below-par.md](../found-below-par.md); bugs that
  got past the tests are in [the miss log](testing-misses.jsonl), each with the test that catches it now.
- Each feature's `done.md` is QA's done list (2026-11-17); ticked only with proof.

## Owner

- The builder of a change writes and keeps its tests; most patches are Ops's (PATCHES.md).
- Ops owns the landing check (`scripts/check.sh`, pi-web-ui's entry in agent-tools' wt.yaml) and the
  release (`pi-web-deploy` in agent-tools, which runs the smoke tests).
- QA owns this page, the testing standard, the smoke tests, the quarantine list, the miss log, the
  below-par list and the fixed big chat.
- Upstream owns `main`, its CI and its npm releases ([docs/release.md](release.md)).
