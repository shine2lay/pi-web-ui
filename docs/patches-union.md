# PATCHES.md: stop changes conflicting on new entries

Ops #219, the second half of the owner's Oct 18 pick "Early warning + fewer conflicts" (the first half, wt's early conflict warning, is Ops #218 in agent-tools). Accountable lead: Ops.

## H-PATCHES-UNION-1

**Wrong, and the evidence.** Two changes landed at about the same time both add an entry right under PATCHES.md's title (line 13 of 6,766), so the second one's rebase stops on a conflict there. 11 of the 26 commits landed on `mine` on Oct 18 touched PATCHES.md, and #213 had to move its entry off the busy top to land.

**One change, and why it should fix it.** `.gitattributes`: `PATCHES.md merge=union`, Git's built-in union merge for that one file: where both sides changed the same place, Git keeps both sides' lines instead of writing conflict markers. It applies to rebase, merge and cherry-pick, in every worktree, because `.gitattributes` is in the tree. Guard: `scripts/check-patches-md.mjs`, run by `scripts/check.sh` in both modes, fails when a "## " heading appears twice and names it.

**Expected result, and how it is measured.** Such rebases go through with both entries. Measured by a scratch-repo test (two branches each add an entry under the title; without the attribute the rebase conflicts, with it it is clean and both entries are there), then no wt land failing on a PATCHES.md conflict over the following day.

**What would prove it wrong.** A rebase still stops on PATCHES.md, or the union garbles an entry in a way the duplicate-heading check misses.

**Result: MISS, at the scratch test, before anything landed.** The union rebase is clean, but it garbles the entries, and the duplicate-heading check misses it.

- Scratch repo, two entries that both end with the usual "- Undo: `pi-web-deploy rollback`, or revert this commit and deploy." line: without the attribute the rebase conflicts; with it, it is clean, but the first entry loses its Undo line and the blank line after it, and the second entry's heading follows straight on from the first entry's last bullet.
- Replay of real entries: the 18 entries landed on `mine` on Oct 17-18 as single insertions, each pair (306 ordered pairs) added under the title of the same base, one rebased onto the other. Built-in union: 306 clean rebases, 0 whole results. All 306 lose the blank line between the two entries; 20 also move real lines out of the first entry (for example left-task-status then roles-sent: left-task-status's Undo line ends up only in roles-sent's entry). 0 duplicate headings, so the guard passes all 306.
- Why: Git's union is its normal three-way merge with "take both sides" instead of conflict markers. Before taking both sides, the merge matches lines the two sides have in common (the blank line that ends every entry, a shared Undo line) and writes them once, after both sides. With `merge.conflictStyle=diff3` Git skips that matching: the same 306 pairs all came out whole (306 of 306), and so did a merge driver running `git merge-file --union --diff3` (306 of 306). Git's own early-conflict check (`git merge-tree --write-tree`, used by wt since #218) honours both the attribute and such a driver (clean); where a driver named in `.gitattributes` isn't defined, Git falls back to its normal merge and the rebase conflicts as today.
- What the garbling always leaves: in all 306, a "## " heading with no blank line before it. Today every "## " heading in PATCHES.md has a blank line before it.

## H-PATCHES-UNION-2

Ops decided this switch (lead, technical, rule 21) after H-PATCHES-UNION-1's measured MISS, within the plan's goal and limits; it is not the owner's consent. It replaces the plan's first done-when item, `.gitattributes` with `PATCHES.md merge=union`, with `PATCHES.md merge=patches-union` and the driver below.

**Wrong, and the evidence.** Git's built-in union merge garbled all 306 replayed pairs of real entries (each lost the blank line between the two entries, 20 also moved real lines out of the first entry), and the duplicate-heading guard passed all 306 (H-PATCHES-UNION-1 above).

**One change, and why it should fix it.** A merge driver for PATCHES.md only, `patches-union`, that runs Git's own union merge in diff3 mode: `git merge-file --union --diff3 -q %A %O %B`. In diff3 mode Git doesn't match the lines the two sides share, so each side's new lines are kept as one whole block, the base's entry first, then the rebased one. `.gitattributes` names the driver; the driver itself is one setting in the repo's git config (below), which every worktree of the repo shares. Where it isn't set, Git falls back to its normal merge: a conflict, as before, never a garbled merge. The guard gains a second rule: a "## " heading with no blank line before it fails, naming it. That is what every garbled union in the replay left, and no heading in PATCHES.md has it today.

**Expected result, and how it is measured.** All 306 replayed pairs come through whole (306 of 306), and the guard passes all 306 driver merges and fails all 306 built-in union merges. `tests/unit/patches-union.test.ts` checks the three cases in a scratch repo: no attribute, a conflict; attribute and driver, clean, both entries whole, Undo lines included (and wt's early check, `git merge-tree`, agrees); attribute without the driver, a normal conflict. Then, over the following day, no wt land failing on a PATCHES.md conflict (land logs, at the next touch).

**What would prove it wrong.** Any replayed pair losing or moving a line, or the guard missing a garbled merge.

**Result: HIT, at the replay and the scratch test (Oct 18, before landing).**

- Replay, the same 18 real entries and 306 ordered pairs as H-PATCHES-UNION-1 (base `ea0f4a18`). With the driver: 306 clean rebases, 306 whole (every line of both entries, the base's entry first, then the rebased one), 0 lost or moved lines, and the guard passes all 306. Git's plain union on the same pairs: 306 garbled, and the guard fails all 306 (0 missed).
- `tests/unit/patches-union.test.ts`: all three cases as expected (no attribute, a conflict; attribute and driver, both entries whole and `git merge-tree` clean; attribute without the driver, a normal conflict). `tests/unit/check-patches-md.test.ts`: passes this PATCHES.md, fails a twice-used and a glued heading, naming each.
- Still to check, at the next touch: no wt land failing on a PATCHES.md conflict over the day after landing (land logs).

## Switching it on, and the undo

`.gitattributes` is in the tree, so every checkout of `mine` has the attribute. The driver is one setting in the repo's git config (`.git/config` of the main folder, shared by all its worktrees), set once on Oct 18 from a worktree:

```sh
git config merge.patches-union.name "PATCHES.md whole-entry union"
git config merge.patches-union.driver "git merge-file --union --diff3 -q %A %O %B"
```

A new clone needs the same two commands, run once inside it. Until then, PATCHES.md conflicts as it did before; it is never merged garbled.

Undo: revert this change's commit, then `git config --remove-section merge.patches-union`. Either half alone is harmless: without the attribute the driver is never used, and without the driver Git merges normally.

Don't use `merge.conflictStyle` for this, and don't use Git's plain `merge=union` (H-PATCHES-UNION-1). No other file merges by union.
