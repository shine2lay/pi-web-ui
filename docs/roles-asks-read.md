# Roles: "Asks unconfirmed" only when a chat really wasn't read

Ops #268 (owner, 2026-10-19 19:1x: "i see asks unconfirmed all the time"). Accountable lead: Ops.

## H-ASKS-READ-1

**Wrong, and the evidence.** The Roles page's status pill says "Asks unconfirmed: some roles not read" nearly all the time, so it can never say plainly whether anything waits on the owner. In a look-only check (2026-10-19 19:23) it showed 1.9 s after opening and kept showing. The cause:

- the server reads at most `ROLES_TASK_CHATS_MAX` = 8 started task chats per role (`server/roles-overview.ts:93`, used at `:896`); an open dialog in any later chat isn't matched to its role, so it isn't listed;
- the page knows this and marks asks unconfirmed whenever a role has more started chats than that (`web/src/roles-useful-model.ts:31` `TASK_CHATS_READ = 8`; `:546` `asksSeen: startedChats <= TASK_CHATS_READ`);
- Design had 9 started task chats (roles overview, 19:23), so the label never cleared. Ops had 11 the day #206 added the wording (`docs/roles-small-fixes.md`).

**One change, and why it should fix it.** Read every started task chat for open dialogs, up to 40 per role, and have the server tell the page, per role, whether every started chat was read (an explicit flag), instead of the page guessing from the count.

- With the dialogs of every started chat matched, an ask in the 9th to 40th chat is listed like any other, so the page may say what waits on the owner.
- Past 40 started chats, the flag is false and the label stays: the page stays honest.
- An older server sends no flag: the page keeps the old count rule.
- Cost rule, measured first (sealed timing below): if a warm overview build with 40 started chats in a role takes less than 200 ms longer (p90) than with 8, the server reads them all fully (TL;DR lines too). Otherwise it reads the chats past the 8th for open dialogs only, not their TL;DR lines.

**Expected result, and how it is measured.**

- Sealed: a role with 12 started chats and an open dialog in its 11th shows that ask as waiting on the owner, not as unconfirmed (sealed browser test `tests/roles-asks-read-test.mjs`; focused vitest for the server read and the page's tell state).
- Warm overview build p90 grows by less than 200 ms (sealed timing, 15 roles, one with 40 started chats of realistic size, 10 warm builds each at 8 and at 40).
- Live: in 10 opens of the Roles page, none shows "some roles not read" 10 s after opening, while every role has 40 or fewer started chats.

**What would prove it wrong.** The label still shows while every role has 40 or fewer started chats, or the warm build grows by more than 200 ms p90.

**Limits.** No change to which tasks or asks count, only to which started chats are looked at. "Nothing waits on you" is never said unless every started chat was read. The checks read no chat text.

## Timing (sealed), and the choice

`scripts/sealed.sh node --import tsx scripts/roles-asks-timing.mts --big 40 --runs 10`: the real reader over a synthetic fixture of 15 roles, Design with 40 started task chats and the others with 3 each (82 started chats; task chats 1 to 8 MB in turn, like the live p50 2.3 MB, p75 4.2 MB and p90 8 MB; Design's chats 142 MB, all files 366 MB). Per run: 3 cold builds (a new reader each), then 10 warm builds of one reader with nothing changed, and 10 after a line is appended to every started chat (all busy). `ROLES_TASK_CHATS_MAX` was set to 8 and to 40 in turn; at 8 the reader read 8 of Design's chats, at 40 all 40. Milliseconds, p50 / p90:

| Run | Cap | Machine | Cold | Warm, unchanged | Warm, after appends |
|---|---|---|---|---|---|
| A1 | 8 | busier (other chats' tests) | 1174 / 1325 | 12.3 / 33.0 | 54.5 / 105.9 |
| A2 | 8 | busier | 1489 / 1771 | 16.5 / 48.7 | 45.6 / 119.5 |
| C1 | 40 | just after the 20:00 pi-web-ui restart | 872 / 1003 | 9.3 / 10.8 | 34.2 / 67.7 |
| C2 | 40 | same | 752 / 969 | 6.9 / 8.2 | 10.3 / 11.6 |
| B8 | 8 | load 5.3, back to back with B40 | 483 / 521 | 3.3 / 4.7 | 11.2 / 11.9 |
| B40 | 40 | load 4.3 | 812 / 823 | 6.4 / 7.8 | 60.7 / 125.1 |

The machine's other work moves the numbers more than the cap does (cap 8: warm p90 4.7 to 48.7 ms). The largest warm p90 at 40 chats, 125.1 ms, is itself under 200 ms, so a warm build grows by less than 200 ms p90 against any run at 8 (back to back, B8 vs B40: +3.1 ms unchanged, +113.2 ms after appends). By the cost rule the server reads all 40 fully, TL;DR lines too; no dialogs-only split. Timing part of the hypothesis: hit.

A cold build, made once after the server starts, grew by about 300 ms p90 back to back (521 to 823 ms) for a role holding 142 MB of started chats. It isn't the rule's measure; live, Design had 9 started chats, one more than before.

## Before landing

- Focused vitest, `TZ=UTC scripts/sealed.sh npx vitest run tests/unit/roles-useful.test.ts tests/unit/roles-useful-asks.test.ts tests/unit/roles-overview.test.ts`: 84 of 84 passed. New: 12 started chats with an open dialog in the 11th (listed for its role and chat, `allChatsRead: true`, the page can tell, and after the answer can tell that nothing waits); 41 started chats (`allChatsRead: false`, the 41st chat's dialog isn't listed, the page says partial; the 40th's is listed); a started chat that can't be read (false, partial); the page takes the server's flag over the count (9 and 40 started chats with `true` can tell, `false` is partial) and keeps the old 8-chat rule when the flag is missing or not a boolean.
- Sealed browser test, `node tests/run-sealed.mjs roles-asks-read-test`: 12 of 12 checks passed. A role with 12 started chats; the fake model in the 11th asks a question and the dialog stays open. The overview lists it for Design and the 11th task's chat with `allChatsRead: true`; the page shows "1 waiting on you"; 10 s after opening, the status pill says "Live · updated …", not "Asks unconfirmed"; the You list shows the question with its Answer button; no page errors. On the old code the 11th chat isn't read, so the question isn't listed and the pill says "Asks unconfirmed: some roles not read".

## Landed and installed

- Landed as `bb432079` (wt land request 90-2bd27c, 20:16 to 20:19, run detached): the land gate passed, 447 test files, 6433 tests passed and 6 skipped; PATCHES.md 166 entries.
- Installed at 20:20 with `pi-web-deploy --landed 90-2bd27c`; `pi-web-deploy result bb432079` = 0 (live, and the checks all passed).

## Live look, and the result

Look only, 2026-10-19 20:28 to 20:33: `~/kept-from-tmp/2026-10-19/roles-asks-read-live/look.mjs`, one fixed pseudo client id (`carry-on:ops-live-look-asks`), a fresh browser context for each open, only `hello` and `roles_watch` sent (everything else held), GET and HEAD only. It read the status pill's words, the You count, and from the feed only role ids, counts and the `allChatsRead` flag: no chat text. 10 opens of `/?view=roles`, 30 s apart, on `bb432079` throughout (the server started 20:20:41 and didn't restart during the look).

| Opens | Status pill 10 s after opening | You | Most started chats in one role |
|---|---|---|---|
| 1 to 3 | Live (updated 20:28 to 20:29) | 0 waiting on you | 9 (Design) |
| 4 to 10 | Live (updated 20:29 to 20:32) | 0 waiting on you | 8 |

- In 10 of 10 opens the pill said Live 10 s after opening. None showed "some roles not read", not even during the first 10 s: the pill went from Updating to Live in 0.8 to 1.7 s.
- Every role sent `allChatsRead`, and every one was true. No role had more than 40 started chats. 0 page errors, 0 requests aborted.
- Design had 9 started chats in opens 1 to 3 (and in a test open at 20:27): the count the old page always marked "Asks unconfirmed: some roles not read" (19:23). From open 4 on, one of its tasks had ended and it had 8, a count the old page passed too. So the live before and after rests on opens 1 to 3 and the test open; the sealed test covers 12 chats.
- For #265: the Design card's budget bar was blue at 20:34 (Design then had 8 started chats). It was amber while the label showed.

**H-ASKS-READ-1: HIT.** Sealed: the 11th chat's ask is listed and the pill says Live (12 of 12 checks). Timing: a warm build at 40 chats grew by at most 113 ms p90, under 200 ms. Live: 10 of 10 opens without "some roles not read".

Undo: in a new worktree, `git revert bb432079`, `wt land`, then `pi-web-deploy`. The page then goes back to the 8-chat rule, and the label comes back whenever a role has 9 or more started chats.
