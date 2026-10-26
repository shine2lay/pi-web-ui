# Snapshot exclusions repair — Ops #572

Accountable lead: Ops. Scope: `server/workspace-snapshot.ts`, its dedicated cache tests, this evidence note and a PATCHES entry. No deployment.

## H-SNAPSHOT-EXCLUDES-1 (written before changes)

- Evidence: W1-B `454dea8a` seeds a temporary Git index from the kept snapshot index when the real index, common `info/exclude`, top-level `.gitignore` and cwd `.gitignore` stamps match. `git add -A` treats previously untracked paths in that kept index as tracked. Nested ignore files, `core.excludesFile` contents and the setting selecting that file are absent from the stamp. Thus newly ignored cache-only paths can remain in later snapshots.
- Change: when reusing a snapshot index, ask Git to re-evaluate its current standard exclusions; remove only ignored paths not genuinely tracked by the real index, then stage normally. Leave real-index seeding, copied-index mtime, racy-Git checks, unsupported/skip flags, same-tree commit reuse and fallback behavior intact.
- Expected result: independent synthetic nested/global exclusion cases fail on the unchanged W1-B source and pass after the correction. Exclusion deletion admits the paths again; tracked-but-ignored controls keep their current W1-B contents; the real index's bytes/inode/size/mtime and HEAD do not change. Existing snapshot tests, normal build and full landing gate pass.
- Falsifier: the unchanged `454dea8a` implementation already excludes the independently specified cache-only paths; or the correction drops a genuinely tracked control, misses edits, changes the real index, or fails the normal gates. Record counterevidence instead of weakening expectations.

## Contract and verification design

All fixtures are disposable synthetic Git repositories under the sealed test HOME/TMPDIR. No user repository, chat, session, model or service is involved. Expected path sets are literal fixture specifications, not inferred from implementation. The former empty-index `git add -A` tree is a separate control for cache-only exclusions, not the oracle for genuinely tracked-but-ignored files: pre-W1-B omitted those, whereas W1-B deliberately retains them so restore does not delete them. This repair preserves that W1-B protection.

Controls: new and edited nested `.gitignore`; new, edited and reselected `core.excludesFile`; exclusion removal; tracked and untracked files matched by the same rule; same-tree reuse after an excluded file edit; whole-repository staging from a nested cwd; NUL-delimited unusual filenames; existing racy-Git, flags, corrupt-cache and real-index protections.

## Results

H-SNAPSHOT-EXCLUDES-1: **HIT** in the planned red/green checks.

- **Original control:** `git rev-parse 454dea8a:server/workspace-snapshot.ts` and `git hash-object server/workspace-snapshot.ts` both returned blob `288aa1b68d20fc53ddae1b6d9f1b1d4683874e76` before the correction. The new expectations were tested against that unchanged source, not a simulated implementation.
- **Red:** `PI_SEALED_MODEL=none scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/workspace-snapshot-cache.test.ts -t 'rechecks a|rechecks exclusions'` — all six new cases failed, 18 existing cases deselected. Both nested-ignore cases and all three global-exclude cases retained `sub/scratch.txt` in the snapshot. The nested-cwd case additionally retained leading-space, wildcard and newline cache-only names. The real-index/ignore stamp remained unchanged as specified. This confirms the review finding rather than merely a missing test.
- **Correction:** on cache reuse only, `ls-files --cached --ignored --exclude-standard -z -- :/` reads Git's current exclusions using the temporary index. If there are matches, the same read against the real index identifies genuinely tracked ignored paths. Only the difference is sent over NUL-delimited stdin to `update-index --force-remove` with `GIT_INDEX_FILE` still pointing to the temporary index. The ordinary `add -A`/`write-tree` path then proceeds unchanged. Read output is not trimmed, and both commands use cwd-relative filenames for whole-repository coverage from nested cwd.
- **Green:** `PI_SEALED_MODEL=none scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/workspace-snapshot-cache.test.ts tests/unit/workspace-snapshot.test.ts` — **26/26 tests pass**, including the six regressions and all 18 existing cache cases. The same literal expected sets now exclude cache-only files, retain edited genuine tracked controls and negated/visible paths, re-admit files after the exclusion source is deleted, and reuse the snapshot commit after an excluded-file-only edit. The synthetic real index's bytes/inode/size/mtime and HEAD remain unchanged. Existing mtime copy, both racy-Git seeds, flag/layout fallback, corrupt cache, linked worktree, restore and concurrent snapshot cases pass.
- **Build and format:** sealed `npm run build` passes (web, server, DSH runtime and vendor bundles; existing large-chunk warnings only). Sealed Prettier check passes for the two changed TypeScript files; `git diff --check` passes.
- **Landing authority:** the normal detached `wt land` runs the repository's full sealed `scripts/check.sh --fast` gate: all unit tests, protocol, PATCHES, five-target typecheck, lint and changed-file formatting. The task's final landing receipt supplies the checked merged commit and gate result; it is not guessed in this pre-gate evidence commit. No separate shortened gate or deployment is used.

The seeded index remains in use: no unconditional empty-index reset, recursive ignore inventory or rehash of unchanged contents is introduced. A reuse with no ignored entries adds one Git exclusion query; genuine ignored entries add a real-index query, and cache-only ignored entries add one removal command. No new timing claim is inferred from the correctness run; historical W1-B real-repository benchmarks were not repeated because this task uses synthetic fixtures only.

## Undo and limitations

Revert this repair commit to recover W1-B behavior (including its exclusion defect); no data migration or install is part of this task. Snapshot creation still has Git's existing command timeout/buffer constraints and is not an atomic filesystem snapshot against concurrent edits. This task does not change restore's existing real-index reset behavior. Performance is secondary to correct exclusions; keep the seeded fast path and avoid hashing unchanged file contents unnecessarily.
