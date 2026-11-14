---
test_check:
  kind: product
  staging: none
  release:
    files:
      - ~/projects/agent-tools/bin/pi-web-deploy
      - ~/projects/agent-tools/lib/pi-web-deploy.mjs
      - ~/projects/agent-tools/lib/pi-web-check.mjs
  quarantine: docs/testing-quarantine.md
  below_par: found-below-par.md
  miss_log: docs/testing-misses.jsonl
---

# Testing pi-web-ui

pi-web-ui is the `product` kind. `test-check` reads the block above and scores the repo; the
format is /home/shinelay/projects/agent-tools/docs/test-check-page.md. The facts below come from files by script (make_page.py, QA #155).

## Tools

- node script: 265 test files, first seen at `tests/accent-contrast-test.mjs:1` (facts table, 2026-11-14).
- node:test: 1 test files, first seen at `tests/role-message-guard-acceptance/local.test.mjs:1` (facts table, 2026-11-14).
- vitest: 659 test files, first seen at `vitest.config.ts:1` (facts table, 2026-11-14).
- Browser test files: 141 (facts table).
- test-check counts 916 test files: server/openviking-dashboard.test.ts, tests/accent-contrast-test.mjs, tests/adaptive-math-test.mjs, ....

What the tests exercise:

- `tests/unit/**/*.test.ts` (Vitest, `npm test`): server modules, web logic and components, plugins
  and the fork's patches, against fakes and temp folders. The landing check runs these.
- `tests/*-test.mjs` (node scripts): each starts its own server with a temp data folder and drives
  it; [tests/run-smoke.mjs](../tests/run-smoke.mjs) runs those that need no model and no fixed local
  paths. Browser ones (playwright-core) are run by hand.
- `tests/terminal-bash-test.mjs` and `tests/terminal-bash-script-test.mjs`: the terminal on a real
  PTY, in the full check only.
- Every run of `scripts/check.sh` is sealed ([scripts/sealed.sh](../scripts/sealed.sh)): a temp home
  with no model keys, so no test can reach a real chat or a model.

## What runs when

| When | What runs | How long | Source (date) |
| --- | --- | --- | --- |
| Before a change lands (`wt land`, also `wt check`) | `scripts/check.sh --fast` (wt entry `pi-web-ui`); test-check: wt entry pi-web-ui: check `scripts/check.sh --fast` runs vitest (scripts/select-tests.mjs:42). A failure refuses the land. | median 1.2 min over the last 10 succeeded lands (each land: check, wait for the land slot, push) | /home/shinelay/projects/agent-tools/wt.yaml:192; land records in /home/shinelay/projects/pi-web-ui/.git/wt-land-queue/ via test-check on 3723898 (2026-11-14) |
| Before a change that touches only notes lands | `scripts/check.sh --notes` instead of the check above, for files matching `docs/**/*.md, PATCHES.md` | not measured | /home/shinelay/projects/agent-tools/wt.yaml:202 (2026-11-14) |
| After every install, restart and rollback (`pi-web-deploy`) | pi-web-check, outside the repo: checks server, page, reply, bigchat and log; a failure of server, page or reply rolls the install back | not measured | /home/shinelay/projects/agent-tools/lib/pi-web-check.mjs:81 and :83 (2026-11-14) |
| Every day at 04:00 | the whole unit suite and the build on the newest `mine`, in a throwaway checkout (`pi-web-ui-full-tests`, outside the repo); a failure messages the owner | 1.3 min on 2026-11-14 (644 files passed) | /home/shinelay/projects/agent-tools/docs/pi-web-ui-full-tests.md:37 (2026-11-14) |
| Never on `mine` | upstream's CI workflow, nightly at 16:00 and on upstream's `main` only | not measured | .github/workflows/ci.yml:3-10 (2026-11-14) |

The landing check, `scripts/check.sh --fast` ([scripts/check.sh](../scripts/check.sh)), runs beside
each other: the protocol sync check (server and web types), the PATCHES.md check, the typecheck of
server, web, tests, desktop shell and browser extension, oxlint, and Prettier on the changed files.
With them it runs only the unit test files the change can reach, picked by
`scripts/select-tests.mjs` from the import graph and a daily read map, and all of them when it can't
be sure ([docs/gate-selected-tests.md](gate-selected-tests.md)), which keeps a land to minutes. A
change to notes only runs the PATCHES.md check and three unit test files. The full check, plain `scripts/check.sh`, adds every unit test, the build and the
real-PTY terminal tests; no automatic run uses it. A daily job outside the repo runs every unit test
file and the build on the newest `mine`, so a test the landing check left out runs within a day.

The nightly schedule in [.github/workflows/ci.yml](../.github/workflows/ci.yml) is upstream's: it
runs on upstream's `main` only, never on this fork's `mine` (lines 3 to 10).

A release is an install on this machine with `pi-web-deploy` (agent-tools; every patch's Undo line in
[PATCHES.md](../PATCHES.md) names it). Before the install it only builds the commit in a throwaway
worktree: a failed or incomplete build, or a changed `package-lock.json` without `--deps-updated`,
refuses the install. No test runs then; the unit tests last ran when the change landed. After every
install, restart and rollback, pi-web-check looks at the live app: the server answers, the page loads
at both addresses, a throwaway chat replies, a copy of QA's fixed big chat (Ops #885) opens with all
its pictures, and the log has no new errors. When the server, the page or the throwaway chat still
fails on a second try, pi-web-deploy rolls the install back by itself and checks again, then sends the
owner one message. They touch no real chat (a throwaway chat and a copy). They are not declared as
smoke tests here: they are not tests of the main user flows kept in this repo with a flow tag. There is no staging copy: an install goes straight live.

## What is not covered

- The main user flows have no smoke tests: no test carries a flow tag, so nothing proves before or
  right after a release that sending a message, answering a question, a queue task or the roles
  pages still work. pi-web-check covers only a new chat's reply, opening a big chat and the page load.
- The node-script tests in `tests/` are not in the landing check or the daily run; they run only by
  hand. The browser scripts among them use fixed local paths, and the live ones need a real model.
- The real-PTY terminal tests run only in the full check, which no automatic run uses. The build is
  not in the landing check; the daily run and `pi-web-deploy` build it.
- The landing check runs a subset of the unit tests. A test the import graph and the read map both
  miss runs only in the next daily run, after the change has landed.
- The desktop shell and browser extension are only typechecked.

## How to run

```bash
scripts/check.sh --fast   # the landing check
npm test
npm run test:freeze
npm run test:smoke
npm run test:smoke:core
npm run test:unit
test-check /home/shinelay/projects/pi-web-ui   # this page's score
```

Rules every test here keeps:

- No automatic re-run. A test that fails and then passes on the same code is repaired, or pulled
  onto [the quarantine list](testing-quarantine.md) with a fix task. (`tests/run-smoke.mjs` has a
  `--retry-once` option; only upstream's CI passes it.) The last flake that refused lands was
  repaired, not pulled ([docs/gate-plugin-dom-flake.md](gate-plugin-dom-flake.md)).
- A skipped test says why and names the task that brings it back.
- Past failures and complaints are checks in [found-below-par.md](../found-below-par.md); bugs that
  got past the tests are in [the miss log](testing-misses.jsonl), each with the test that catches it now.

## Owner

- The builder of a change writes and keeps its tests; most patches are Ops's (PATCHES.md).
- Ops owns the landing check (`scripts/check.sh`, pi-web-ui's entry in agent-tools' wt.yaml) and the
  release (`pi-web-deploy` and pi-web-check in agent-tools).
- QA owns this page, the testing standard, the quarantine list, the miss log, the below-par list and
  the fixed big chat that pi-web-check opens.
- Upstream owns `main`, its CI and its npm releases ([docs/release.md](release.md)), none on `mine`.
