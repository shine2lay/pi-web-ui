# Gate: the landing check's Prettier step checks only what the land changes

Ops #399, project faster-landing, criterion 6 (a pi-web-ui landing check in about 2 minutes instead of 6-7, with no test dropped or loosened; the owner asked for faster tests). Accountable lead: Ops.

## What it does

`scripts/check.sh --fast`, the check `wt land` runs for pi-web-ui, used to run `npm run format:check`: Prettier reading every file in its folders, one after another. Now it runs `node scripts/prettier-scope.mjs --check`, which gives Prettier only:

- the files changed since the merge-base of HEAD and `mine`: the land's commits, plus edits and new files not committed yet (a land's worktree has none, since `wt land` needs everything committed; a check run by hand before a commit may);
- of those, only the ones in format:check's own folders and globs (`server/`, `web/src/`, `extensions/`, `scripts/`, `bin/`, `desktop/`, `tests/*.mjs`, `tests/unit/`, `*.mjs` at the top), counted the way the shell and Prettier count them;
- never a deleted file, and never a symbolic link (Prettier skips one in a folder and refuses one named to it).

It runs the repo's own Prettier (`node_modules/prettier`, the one format:check runs) with `--check --ignore-unknown`, so `.prettierrc.json`, `.prettierignore` and `.gitignore` apply exactly as before. When no changed file is in those folders, it prints `prettier: no formatted files changed` and passes.

It checks every file, by running `npm run format:check` itself, when:

- HEAD has no merge-base with `mine` (an unrelated history, or no `mine` branch), or git can't list the changes;
- a change, a deletion included, may have changed Prettier's settings or version: `.prettierrc*`, `prettier.config.*`, `.editorconfig`, `package.json` or `package.yaml` in any folder, or `.prettierignore`, `.gitignore` or `package-lock.json` at the top.

`node scripts/prettier-scope.mjs` without `--check` only prints what it would check: `ALL: <why>`, or the files, one per line.

**A full check at any time:** `npm run format:check`, or `scripts/check.sh` without `--fast`. Neither changed: both still read every file.

## Why it doesn't loosen the check

Every changed file in those folders gets the same Prettier, with the same settings and ignore files, as before. A file the land didn't change is byte for byte the same as on `mine`, where it passed the whole check when it landed. When Prettier's settings, ignore files or version may have changed, the files that didn't change could judge differently, so then everything is checked. A file outside those folders was never checked, and still isn't.

## H-PRETTIER-CHANGED-1

**Wrong now, and the evidence.** Every land re-checks about 1,263 unchanged files to look at the handful it changed. Ops #392 counted the step's input on `mine` a2b3a255: 1,263 tracked files, 17,561,654 bytes, read by one Prettier process with no cache (report `~/kept-from-tmp/2026-10-22/faster-landing-format-input/REPORT.md`, sha256 c277eb82…). In Ops #368's measured landing check the step took 180.7 s (180.743 s), beside the unit tests and competing with them for the CPU.

**The one change, and why it should fix it.** `scripts/check.sh --fast` gives Prettier only the files the land changes, as above. Prettier's time grows with the files it reads, so a handful should take a second or two instead of three minutes.

**Expected, and how it's measured.** On a typical land the prettier time in check.sh's `== times, side by side` line drops from about 180 s to under 15 s, and the unit tests get that CPU back. Measured from this change's own sealed gate run, and from its land's check log.

**What would prove it wrong.** The prettier step still takes over 30 s on a small change, or any known case below misbehaves.

**Decided by this task's chat, as Ops' implementer, beyond the plan's wording.** Each makes the check look at more, never less, or matches what the full check already does:

- The diff is taken against the working tree, not only the commits (`base...HEAD`), and new files not committed yet count too, so a check run by hand before a commit doesn't pass an unformatted edit. A rename counts as a new file under its new name.
- `.gitignore`, `.editorconfig`, and Prettier's settings files and `package.json` in any folder also mean every file, since Prettier reads all of them.
- Symbolic links are left out, as the full check leaves them out.
- The repo's own Prettier is started directly with Node, not through `npx`, so a missing install fails with "run npm ci first" instead of downloading a Prettier.

## Known cases

`tests/unit/prettier-scope.test.ts` builds a scratch git repo for each case, with a base commit on `mine` and a work branch, the way a land's worktree has it:

- (a) a badly formatted changed file under `server/` is listed, and `--check` fails on it;
- (b) changed Markdown files outside the folders (`README.md` at the top, `plugins/p/notes.md`) are not listed. The plan named `docs/x.md`; a `docs/*.md` path in a unit test's code makes `notes-check-list.test.ts` want the test on its lists, and these are scratch files, not notes, so the case uses paths outside `docs/` instead of changing that test. The rule is the same for any folder outside format:check's (case (j) checks more);
- (c) a changed `.prettierrc.json` gives ALL, and `--check` runs the whole check; so do a deleted `.prettierignore`, a changed `.gitignore`, `package-lock.json`, `web/.prettierrc`, `server/prettier.config.mjs`, `desktop/.editorconfig` and `plugins/x/package.json`;
- (d) a changed `package.json` gives ALL, and a failing whole check fails `--check`;
- (e) no merge-base with `mine` gives ALL: an unrelated history, and a repo without `mine`;
- (f) a deleted file is not listed, and a renamed one is, under its new name;
- (g) a changed file named in `.prettierignore` is given to Prettier, which skips it;
- (h) well-formatted changed files pass;
- (i) nothing in the folders changed (only `README.md`): `--check` says so and exits 0;
- (j) the folders are format:check's own, word for word, and a path counts the way the shell and Prettier count it (`tests/e2e/deep.mjs` and `.hidden.mjs` are out, `server/.hidden.ts` is in);
- (k) edits not committed yet count, a new file too, but not one `.gitignore` leaves out;
- (l) a symbolic link is not listed;
- (m) `check.sh` uses it only with `--fast`; the full check still runs `npm run format:check`.

## Result

**Sealed gate runs on this change (Oct 22, `scripts/sealed.sh env TZ=UTC scripts/check.sh --fast` on `mine` a2b3a255 plus this change, built first).** Receipts in `~/kept-from-tmp/2026-10-22/faster-prettier-scope/` (`gate.log` is run 1, `run2-gate.log` run 2, each with its start and end times and load).

| Run | Prettier was given                                                                                 | `== times, side by side`                                                                   | Unit tests                                   |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1   | 3 files: `scripts/check.sh` (no parser: skipped), `scripts/prettier-scope.mjs`, its test; all pass | protocol 0 s, PATCHES.md 0 s, typecheck 15 s, lint 0 s, **prettier 1 s**, unit tests 184 s | 1 failed: `notes-check-list.test.ts` (below) |
| 2   | the same 3 files; all pass                                                                         | protocol 0 s, PATCHES.md 0 s, typecheck 17 s, lint 0 s, **prettier 0 s**, unit tests 151 s | 1 failed: the collector's time limit (below) |

Before: 180.7 s in Ops #368's measured land check (under heavy load), 100 s beside the tests on a quiet machine in #231's fair pair, for 1,263 files.

- Run 1 found one real problem, in this change's own test: its scratch repos used a Markdown path under the docs folder, and `notes-check-list.test.ts` took that for a test reading this repo's notes. Fixed in the test (case (b) above), without changing that guard.
- Run 2: every other test passed, this change's own 14 cases included. The one failure was `usage-accounting-collector.test.ts` "ingests/replays 100000 current-week attempts across 65 synthetic sources ..." stopping on its own time limit (`fixture:ingestion-committed:2:unavailable:time-limit:33`) under gate load (load up to 12). It passed in run 1; it is the collector's known load-sensitive limit (Ops #331, #311), and this change only takes CPU load away from the tests.
- The land's own check runs the same gate on the landed tree: its result is below.

**The land (Oct 22).** wt land 157-848b42 landed `0d949dc` on `mine` (08:41:11.5-08:44:04.0 UTC, 172.5 s from start to end, nothing ahead in the line, no rebase). Its own `scripts/check.sh --fast` gave Prettier the same 3 files (merge-base a2b3a255): "All matched files use Prettier code style!". `== times, side by side: protocol 0 s, PATCHES.md 0 s, typecheck 18 s, lint 0 s, prettier 1 s, unit tests 169 s`; 475 test files, 7,510 tests passed, 6 skipped. Land log: `~/kept-from-tmp/2026-10-22/faster-prettier-scope/land.log`.

**H-PRETTIER-CHANGED-1: HIT (Oct 22).**

- The prettier step took 1 s in the land's own check and 0-1 s in both sealed gate runs, against 180.7 s before (Ops #368) and 100 s on a quiet machine (#231). The bar was under 15 s; the miss line was over 30 s.
- Every known case passed, in the gate runs and in the land.
- Not shown here: how much the unit tests gain from the CPU Prettier no longer uses. They took 151-184 s in these three runs, against 334 s in #368's heavily loaded run; that isn't a fair comparison, and the unit tests are criterion 6's other half.

Undo: revert `0d949dc`. It changes only the check, so there is nothing to install or restart.
