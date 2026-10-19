# Message approvals: fresh start and off switch (Ops #241)

The approval ladder for chains between roles (`docs/role-message-ladder.md`; owner 2026-10-12: messages
1-6 free, 7-11 need the COO's grant, 12 and on the owner's) keeps its record in
`<data dir>/role-message-guard/gen-<N>/` (`journal.json` and its copy of the accepted messages,
`accepted.json`). When the two disagree, every start refuses to open the record and the ladder stays off:

    approval ladder UNAVAILABLE (recover: legacy writer divergence; refusing stale snapshot overwrite): sends use the native depth-6 rule; no approvals

This patch adds two things and nothing else:

- **A one-shot fresh start**, asked for with a request file that `scripts/role-guard-fresh-start.mjs` writes,
  and done by the next server start. It is bound to the exact bytes of the unreadable record; without such a
  request the server behaves as before. There is no automatic reset and no general reset command, and no
  pi-web-ui route or tool reads or writes the request. It isn't operator-only, though: any process of the
  same user can make it, a chat's shell included (see "Who can ask for it").
- **An off switch**, `PI_WEB_UI_MESSAGE_APPROVALS=off`: the undo, without going back to a build from before
  the ladder.

The owner picked "Fresh start + alarm" on 2026-10-18 (dialog "Message approvals off since Oct 14"). The
alarm is a separate task. This is simpler than Architecture's 2026-10-14 recovery design
(`/home/shinelay/architecture-dept/reviews/role-message-ladder-recovery-2026-10-14.md`), which wasn't picked.

## Hypothesis H-LADDER-FRESH-START-1

- **Wrong, and the evidence**: every start since 2026-10-14 06:43 logs the UNAVAILABLE line above (5 starts
  on 2026-10-18 alone). `~/.pi-web-ui/role-message-guard/gen-1/journal.json` (3,073,072 bytes) and
  `accepted.json` (412,984 bytes) haven't changed since 2026-10-14 02:59:46, when a race (fixed in 6689a5f4,
  live) left them disagreeing. Since then 6 sends were refused at message 7 (2026-10-14 to 10-16) and 1
  approval request was refused. `rotate(true)` can't help: it needs a store that opened.
- **The one change**: a request file bound to the exact old files lets `start()` keep a
  byte-identical copy of gen-N and begin gen-(N+1) with `freshState()`, which already carries the native
  record's last-hour sends. Then the request is marked done. Without a matching request nothing changes.
- **Expected, and how it's measured**: after the install, the start log says "approval ladder: fresh start
  from generation 1 (old record kept in archive-gen-1)" and "approval ladder: on (hops 1-6 free; 7-11 COO
  grant; 12+ owner grant)"; `current.json` is `{"gen":2}`; the archive's sha256 equals gen-1's; the request
  is renamed `fresh-start.done-<ms>.json`. A later restart stays on gen-2. Within an hour a real role
  message is committed in gen-2's journal.
- **Wrong if**: the ladder is still UNAVAILABLE with a matching request; any byte of gen-1 changes; a later
  start makes gen-3; a non-matching request (wrong digest, files touched within 2 h, request older than
  24 h, a record that opens) changes anything; a role message is lost or delivered twice.
- **Result: HIT** (2026-10-18, live). The request was written at 21:54:31 PDT (gen 1, sha256s `e3c99b7f…`
  journal and `d0842a80…` accepted). `pi-web-deploy` installed 033cd1d8 and restarted at 21:55:20. At 21:56:07
  the log said "approval ladder: fresh start from generation 1 (old record kept in archive-gen-1)" and then
  "approval ladder: on (hops 1-6 free; 7-11 COO grant; 12+ owner grant)". `current.json` became
  `{"gen":2}`. Both files in `archive-gen-1/` match gen-1 and the request byte for byte (sha256 and `cmp`),
  and gen-1 still dates from 2026-10-14 02:59:46. The request became `fresh-start.done-1792385767201.json`,
  and `history.jsonl` holds one `revoked_all`. gen-2 began empty (0 requests, grants, outbox entries,
  incidents and tombstones) with 11 sends carried over from the native last hour. The first real role
  messages were committed in gen-2 at 21:58:28, 2.5 minutes after the start. The next restart (22:01:12,
  564392e8, which contains this patch) logged "approval ladder: on" again and stayed on gen-2, with no
  gen-3. By 22:05, 8 role messages had gone through gen-2 (37 transactions, all committed). Each is once
  in `role-messages.json` (1,000 messages, no duplicate ids). None of the "wrong if" results happened live;
  the non-matching-request cases are covered by `tests/unit/role-message-guard-fresh-start.test.ts`.
  Seen but not changed here: most question/request/reply entries end in outbox state `unknown` (the wake-up
  wasn't confirmed), as in gen-1 (174 of 192 entries); each such message was delivered once in the native
  record.

## Hypothesis H-LADDER-SAFE-START-1 (Ops #248)

The follow-ups the reviews of Ops #241 left (Security
`/home/shinelay/security-lab/ladder-fresh-start-241/REVIEW-18466679.md` N1-N3, Architecture rm-55121021
S1-S2), so the record can't be wiped or misread at start-up.

- **Wrong, and the evidence**:
  - N3: `currentGeneration()` takes generation 1 when `current.json` is missing or not understood, and
    `start()` runs `cleanGenerations(1)` before `recover()`, which removes every gen-K but gen-1 and gen-0.
    Live has been on gen-2 since the fresh start, so a lost or garbled `current.json` would remove the live
    record (only the archive would survive). A `current.json` naming a folder that isn't there begins an
    empty generation there and cleans the others. `rotate()` has the same root: it takes
    `currentGeneration() + 1` and removes that folder first, so on gen-2 without `current.json` it would
    remove gen-2 itself.
  - N1: the request is read by path after `lstat` (check, then use) and has no size cap.
  - N2: the test's `script()` sets `PI_WEB_DATA_DIR` to "", so a call that forgets `--data-dir` would fall
    through to the live `~/.pi-web-ui`.
  - S1: the script writes a request, and the server acts on it, when the journal holds a prepared
    transaction or can't be parsed, so a fresh start could drop an unfinished send unseen.
  - S2: `freshStart()` repeats `rotate()`'s begin-a-generation steps; two copies can drift apart.
- **The changes, one per note, one commit each**:
  - N3: once any gen-N or archive-gen-N folder exists, a `current.json` that is missing, unreadable, not
    understood or names a folder that isn't there turns the ladder off at start
    (`approval ladder UNAVAILABLE (current.json <why>)`) before the lock or any guard file is written, and
    nothing is cleaned. A rotation refuses the same way. A first start (no generation folder yet) still
    begins gen 1. The script says so too, instead of "the server opens generation 1".
  - N1: the request is opened once without following a link (and without waiting on a pipe), checked on
    that open file (a plain file of this user, mode 0600, at most 4 KiB) and read from it, capped.
    Otherwise "fresh start refused (<why>)", and it stays where it is. The start that only settles a
    leftover request reads it the same way. The script won't write a request over 4 KiB.
  - N2: the tests run the script with `PI_WEB_DATA_DIR` set to the test's temporary data dir, and check that
    it is one.
  - S1: the fresh start acts only on a journal the store reads as committed. A prepared transaction (named
    by its operation id) or a journal the store can't parse: "fresh start refused (<why>)", the ladder off, and
    nothing cleaned or rewritten. The script refuses both too.
  - S2: one helper begins a generation for `rotate()` and the fresh start: remove a half-made folder, make
    it, write a fresh state, switch `current.json`. Same files, same order, same flushes.
- **Expected, and how it's measured**: in the focused sealed run, starts on a record that is on gen-2 with
  `current.json` missing, garbled or naming a missing generation end UNAVAILABLE with that reason, and every
  guard file (lock included) has the same sha256 and mtime before and after; a rotation with a garbled
  `current.json` throws and changes nothing; the N1 and S1 refusals change nothing; the existing rotation
  tests pass unchanged. Live, after the install: the start log says "approval ladder: on (...)",
  `current.json` stays `{"gen":2}`, there is no gen-3, and a real role message is committed in gen-2 after
  the restart.
- **Wrong if**: any of those tests sees a guard file change or disappear; a first start doesn't begin gen 1;
  an existing rotation test has to change to pass; the live start isn't "on" on gen-2.
- **Result: HIT** (2026-10-18, live). The N3 tests failed before the fix. The focused sealed run passed: 15
  files, 427 tests, 1 skipped (a screenshot check that is off by default). Every case where the ladder
  turns off left each guard file (lock included) with the same sha256 and mtime, and the rotation tests
  pass unchanged. Security gave GO on ec50fdcb (rm-de8874f8) and Architecture on 96c7160e (rm-223982b5),
  each after its own sealed run, with the same counts. `wt land` 74-202fbb landed the 7 commits as 03fb3da3
  at 23:35 with the full check. `pi-web-deploy` installed it at 23:37, and all five checks passed. At
  23:38:17 the log said "approval ladder: on (hops 1-6 free; 7-11 COO grant; 12+ owner grant)", with no
  UNAVAILABLE line since. `current.json` is still `{"gen":2}` (unchanged since 21:56:07), and the only folders
  are archive-gen-1, gen-1 and gen-2: no gen-3. The real role messages sent after the restart (rm-e4f57028
  at 23:39:17, rm-44b32fb1 and rm-c30e571c at 23:42:32) were each committed once in gen-2. Each appears once
  in `role-messages.json` (1,000 messages, no duplicate ids). None of the "wrong if" results happened.
- **Follow-ups the reviews left, not in this patch** (for one Ops task, A1 first):
  - A1 (Architecture), caused by this patch: on an install that has never started, a crash after gen-1 is
    made but before the first `current.json` is written now leaves the ladder off ("current.json is
    missing"), where it used to heal itself. It fails safe and the alarm shows it; the live folder can't hit
    it. Fix: write `current.json` first on that path, or make gen-1 under a temporary name and rename it.
  - O2 (Security, older path): if a rotation throws in `maybeRotate()` after a send was accepted, the chat
    gets an error for a message that went, so a retry could send it twice. Fix: catch and log it there.
  - A2: flush the folder after `writeCurrent()`'s rename. A3: one shared "prepared" test in the store.
    A4: an atomic lock (`openSync` "wx" or `flock`). All three predate this patch.
  - Known, no change asked (Security): a stale but valid `current.json` (for example `{"gen":1}`) still
    lets the start remove newer generations, the same as any same-user delete. Hence "never write a smaller
    N" below.

## Hypothesis H-LADDER-FOLLOWUPS-1 (Ops #253)

The five follow-ups the reviews of Ops #248 left (Architecture
`/home/shinelay/architecture-dept/reviews/ops248-ladder-safe-start.md` suggestions 1-4, Security
`/home/shinelay/security-lab/ladder-safe-start-248/REVIEW-ec50fdcb.md` O2), one commit each, in the order A1, O2,
A2, A3, A4.

- **Wrong, and the evidence**:
  - A1 (caused by #248): a first start makes gen-1 and writes `current.json` only once the new store is ready
    (host ~579-585). A crash in between leaves gen-1 without `current.json`, and since N3 every later start
    turns the ladder off ("current.json is missing"). Before #248 the next start healed it.
  - O2: `maybeRotate()` runs in `afterAccepted()` after a send was accepted and delivered, outside the send's
    `try`. When the rotation throws (a folder it can't write, a `current.json` garbled while the server runs, a
    new store that won't open), the chat gets an error for a message that went. A retry has a new tool-call id,
    so it would go twice. At start the same throw turns the ladder off.
  - A2: `writeCurrent()` renames `current.json` into place but doesn't flush the folder, so after a power loss
    the switch to N+1 may not be on disk; the next start would read N and remove gen-(N+1).
  - A3: the store tests "the journal holds a prepared transaction" (`bundle.stage === "prepared"`) in four
    places: `guardJournalRefusal()` (the fresh start's check), `recover()` and twice in the lookups. If one
    changes, the fresh start and `recover()` could disagree.
  - A4: the lock is read, then written (`readLock()`, later `writeDurable()`), so two servers starting on one
    folder at once can both pass the look and both hold the guard.
- **The changes, one per item, one commit each**:
  - A1: a first start (no gen-N or archive-gen-N folder) writes `current.json` (`{"gen":1}`) through
    `writeCurrent()` before it makes gen-1. A crash after that leaves `current.json` naming a generation that is
    there or not made yet, and the next start begins gen 1 as usual. N3 is unchanged: once a generation exists, a
    missing or odd `current.json` still turns approvals off.
  - O2: `maybeRotate()` never throws. When a rotation fails it reads `current.json` again. Still naming the
    store's own generation: approvals stay on, and the log says "approval ladder: rotation failed (<reason>);
    staying on generation N", once per reason while the server runs (the next send that finds the store due
    tries again). Otherwise, or when it can't be read: off, "rotation: <reason>" (never guess, as N3). A start
    whose rotation turns approvals off stops there and doesn't log "on". A send that was accepted always comes
    back to its chat as accepted.
  - A2: `writeCurrent()` flushes the guard folder after the rename (`fsyncDir`, which the fresh start's archive
    already uses).
  - A3: one store helper, `holdsPrepared()`, for all four; messages and behaviour stay byte for byte.
  - A4: the lock is made in one step that fails when it is there. The pid is written and flushed to
    `lock.tmp-<pid>`, then linked to `lock` (a link fails when `lock` exists, as `openSync` "wx" does). When a
    lock is there: a live other server's turns the ladder off, "another server (pid N) holds the guard", as
    today. A gone server's (dead pid), an unreadable one or this process's own is moved aside to
    `lock.stale-<pid>`, then removed, and the take is tried once more. If what was moved is a live server's lock
    after all (it took the lock just before), it is put back and this start turns off. A second failure turns it
    off (another server won). `stop()` is unchanged. Ops (the task's lead) chose two details beyond the plan's
    `openSync(lock, "wx")` and "remove the stale lock": a "wx" lock is empty until its pid is written, and an
    empty lock reads as unreadable, which the take-over removes; and removing by name could remove a lock
    another server made a moment after this one judged the old one gone. Either way two servers starting at
    once could still both hold it, the case A4 is for.
- **Expected, and how it's measured**: one focused sealed run of the guard test files. The A1, O2 and A4
  tests fail before their fix and pass after it. A2's test sees the guard folder flushed right after every
  `current.json` rename; A3's test sees `recover()` and the fresh start's check agree at every point where a send
  can stop. The existing guard tests (rotation, fresh start, N1-N3, S1, S2) pass unchanged, and every case that
  turns the ladder off leaves the guard files as they were. Live, after the install: the start log says
  "approval ladder: on (...)", `current.json` is still `{"gen":2}`, there is no gen-3, and the next real role
  message is committed once in gen-2.
- **Wrong if**: an existing guard test has to change to pass; a case that turns the ladder off leaves a guard
  file changed; the live start isn't "on" on gen-2; a real role message shows up twice in `role-messages.json`.
- **Reviews**: GO from both, no must-fix, each after its own sealed run of the guard tests (16 files, 448
  passed, 1 skipped). Security rm-706b8154 (`/home/shinelay/security-lab/ladder-followups-253/REVIEW-5039dc92.md`)
  covers host 0ab89fd0, store 41aaae5b and script ca463111: a change to those needs its delta look again, tests
  or docs alone an FYI. Architecture rm-8e4d9e40 (`/home/shinelay/architecture-dept/reviews/ops253-ladder-followups.md`)
  at 5039dc92 found A4's two details sound for two servers.
- **Result: HIT** (2026-10-19, live).
  - Tests: the A1, O2, A2 and A4 tests failed before their fix. A1: the next start was off, "current.json is
    missing". O2: the rotation's error was thrown into the send, and the start turned off. A2: no flush after the
    four renames of `current.json`. A4: two servers starting at once both came up holding the guard. A4's
    take-over test passes on the old code too, by its nature. The focused sealed run of the guard tests passed (16
    files, 448 tests, 1 skipped, the skip already in the view tests). No existing test changed, and no case that
    turns the ladder off wrote a guard file (after a send, only that send's own gen-2 files changed).
  - Land and install: `wt land` 78-3f986f landed the 8 commits on mine as 7a6bc2fb at 01:52 with the full check
    (444 files, 6370 tests, 6 skipped). It came after a clean rebase onto c83fdee3: the range-diff is identical,
    and the host, store and script are the ones both reviews covered. `pi-web-deploy` installed it at 01:55:
    result 0, all five checks passed.
  - Live: at 01:56:21 the log said "approval ladder: on (hops 1-6 free; 7-11 COO grant; 12+ owner grant)", with
    no other ladder line by 01:59. `current.json` is still `{"gen":2}` (unchanged since 2026-10-18 21:56:07), and
    the only folders are archive-gen-1, gen-1 and gen-2: no gen-3. `lock` names the new server (pid 738269) with
    mode 0600, so the new code took it, and no `lock.tmp-*` or `lock.stale-*` is left (Security's check). The
    first real role messages after the restart, rm-c6d11cae and rm-d149774a at 01:59:48, were each committed
    once in gen-2 (journal and accepted copy) and appear once in `role-messages.json` (1,000 messages, no
    duplicate ids; gen-2 has 82, no duplicates). None of the "wrong if" results happened.
  - Not seen live, by design: a failed rotation, a first start, a crash or two servers starting at once. The
    tests above cover those.
- **Follow-ups the reviews left, not in this patch** (none blocks the install):
  - B1 (Architecture), what A4 leaves open: between moving a stale lock aside and giving it back there is no
    `lock`. A third server starting in that moment, or a later start after the mover dies there, makes the
    give-back fail quietly, and the moved live lock is then removed: two servers end up holding the guard.
    Reproduced in `/home/shinelay/architecture-dept/work/ops253-review/repro/tests/unit/arch-ops253-three-servers.test.ts`;
    Security lists the same three-server case as a residual. Fix: keep the inode of the linked lock, check that
    `lock` still has it before "on" and before each guard write (else off), and let `stop()` remove only that
    inode. Also correct `takeLock()`'s docstring: the rename can take a lock made after the look (which is why
    the moved lock's pid is read again).
  - B2 (Architecture): a `beginGeneration()` that fails before the switch leaves a half-made gen-(N+1) until the
    next try or start. Remove it there, or make the steps under "If the log says UNAVAILABLE (current.json ...)"
    pick the folder that holds the record rather than the highest N.
  - B3 (Architecture): a directory at `lock` turns the start off but leaves `lock` naming this pid and the
    directory at `lock.stale-<pid>`. Fix: `lstat` `lock` first; anything but a plain file turns the start off
    and is left where it is; the `finally`'s removals best effort. The same `lstat` keeps a FIFO at `lock` from
    holding up the start (older).
  - B4 (Architecture, older): a `current.json` naming gen 2 or more when no `gen-` or `archive-gen-` folder is
    left starts an empty gen-N and turns on, where this doc says to stay off.
  - B5 (Architecture): sweep `lock.tmp-*` and `lock.stale-*` that a gone pid left (a crash inside `takeLock()`);
    when the clean-up after a switch fails, log "rotated to N+1; cleanup failed".
  - N1 (Security, hygiene): `takeLock()`'s `writeFileSync` with `flag: "wx"`, so it never follows a link
    planted at `lock.tmp-<pid>` or keeps an old file's mode. Same user only.
  - N2 (Security): O2 brings the first turn-off while the server runs. Approval decide and request read
    `this.adapters` again after their awaits (`presentOwnerQuestion`, the notice after the state change, the
    request), so a turn-off from another chat's send in between gives a raw "Cannot read properties of null",
    and a decision may be recorded while its notice isn't sent. It fails closed. Fix: after each await, check
    the status and adapters again and answer that the ladder is off.
  - Known, no change asked (Security): three servers starting at once against a stale lock can leave two
    holding it (B1); an execute in flight on the old store during the rare "switched but not flushed" turn-off
    may stay unreconciled.
  - Older, not caused by #253 (Architecture): a gone server's pid reused by another process keeps starts off
    (fix: keep the pid with its start time); `stop()` removes the lock by name (B1's inode check covers it).

## How to use it

Only when the start log says `approval ladder UNAVAILABLE (recover: ...)`. Run from the pi-web-ui checkout:

1. `node scripts/role-guard-fresh-start.mjs --dry-run`. It finds the data dir (`--data-dir <dir>`, else
   `PI_WEB_DATA_DIR`, else `~/.pi-web-ui`), reads `current.json`, hashes the generation's two files, and
   prints what it found: sizes, sha256s, last change, and the old record's open items (outbox entries by
   state, open requests, live grants), as counts and ids only, never a message's words. It says whether the
   record is unreadable and what the next start will do. It writes nothing.
2. `node scripts/role-guard-fresh-start.mjs` writes `role-message-guard/fresh-start.json` (mode 0600):
   `{v: 1, gen, journalSha256, acceptedSha256, at, expiresAt (at + 24 h), reason}` (`--reason <text>` to
   say why). It refuses, writing nothing, when the record is readable or a file changed less than 2 h ago.
3. Install or restart with `pi-web-deploy` (`pi-web-deploy <commit>`, or `pi-web-deploy restart`). The next
   start does the fresh start.
4. Check the server log for the two lines above, `current.json`, the archive's sha256s
   (`sha256sum ~/.pi-web-ui/role-message-guard/archive-gen-1/*`) against the request's, and that
   `fresh-start.json` became `fresh-start.done-<ms>.json`.

If the log says `approval ladder: fresh start refused (<why>)`, nothing was written and the request stays
where it is so the reason can be seen. Fix the cause, or make a new request, and restart again.

## If the log says rotation failed, or another server (Ops #253)

- `approval ladder: rotation failed (<why>); staying on generation N`: a size rotation couldn't make
  gen-(N+1). Approvals stay on in gen-N, and the next send that finds the record due tries again; the line
  comes once per reason while the server runs. Fix what it names (often a guard folder that can't be written
  or a full disk); nothing else is needed.
- `approval ladder UNAVAILABLE (rotation: <why>): ...`: a rotation failed and `current.json` no longer names
  the open generation, or can't be read, so approvals are off and sends go the native way. Restart with
  `pi-web-deploy restart`; if the start then says `UNAVAILABLE (current.json ...)`, follow the next section.
- `approval ladder UNAVAILABLE (another server (pid N) holds the guard): ...`, or
  `... took the guard as this one started`: another pi-web-ui server runs on the same data folder. Stop the
  extra one, then `pi-web-deploy restart`. A lock left by a server that is gone is taken over by itself.

## If the log says UNAVAILABLE (current.json ...)

Ops #248 (Security N3): once a generation folder exists, the start trusts `current.json` only when it can
read it, understands it, and the `gen-N` folder it names is there. Otherwise the log says
`approval ladder UNAVAILABLE (current.json <why>)` and the ladder stays off before the lock: no guard file is
written or removed. The fresh start doesn't apply here, and the script refuses. To bring the ladder back:

1. Look in `~/.pi-web-ui/role-message-guard/` for the newest `gen-N` folder that holds the record
   (`journal.json` and `accepted.json`): the highest N. An `archive-gen-N` folder is a copy, never the answer.
2. Write `{"gen":N}` and a newline to `role-message-guard/current.json`, then `pi-web-deploy restart`. The
   start logs `approval ladder: on (...)` on gen-N.

Never write a smaller N than the newest: each start keeps only gen-N and gen-(N-1) and removes every other
`gen-` folder, newer ones included. Never delete, move or rename a `gen-` folder by hand. If no `gen-N`
folder is left, leave the ladder off and ask Ops; don't rebuild one by hand.

## What the next start checks and does

It looks at a request only after `recover()` failed on the current generation N, under the guard's lease
and lock (N is the one `current.json` names; when that isn't understood the start stops earlier, see above).
It acts only when all of these hold; otherwise it stays off and logs why:

- the request, opened once without following a link, is a plain file of this user with mode 0600 and at
  most 4 KiB, in the format above (Ops #248, N1);
- `gen` is the current generation;
- it isn't dated in the future, is good for at most 24 h, and hasn't expired;
- both files of gen-N are untouched for at least 2 h and their sha256s are the request's;
- gen-N's journal holds a finished (committed) transaction the store can read. One holding a prepared send,
  or one it can't parse, is never started over (Ops #248, S1).

Then, in this order:

1. Copy gen-N's two files into `role-message-guard/archive-gen-N/` (flushed, then their sha256 checked
   again). That name is outside the generations clean-up, so the copy stays. gen-N itself stays in place
   too, as the one older generation kept; it goes with the next rotation.
2. Start gen-(N+1) with the helper a rotation uses (`beginGeneration()`, Ops #248 S2): remove a half-made
   gen-(N+1), write a fresh state (the native record's last-hour sends still count toward the 20 an hour; no
   open requests, grants or outbox), switch `current.json` to N+1.
3. Write `revoked_all` to `history.jsonl`, rename the request `fresh-start.done-<ms>.json`, log
   "approval ladder: fresh start from generation N (old record kept in archive-gen-N)".

A crash before `current.json` switches leaves the request, and the next start does it again. A crash after
it: the next start opens gen-(N+1) as usual and marks a leftover request for an older generation done; it is
never acted on again. A record that opens as usual ignores any other request and leaves it in place.

What doesn't carry over: open approval requests and grants (grants last 60 min anyway), and any send the old
record hadn't finished. The script lists those ids. The four sends stuck at 2026-10-14 02:59 were resent
the native way after the 06:42 restore.

## Who can ask for it

No pi-web-ui route or tool reads or writes `fresh-start.json`; only the server's own start reads it. But any
process running as the same user can write it, run the script and run `pi-web-deploy restart`, and every
chat's shell runs as that user. So the request is not operator-only: nothing keeps other same-user writers
out (Security's review of Ops #241, 2026-10-18).

What limits it is the binding: the current generation, the exact sha256 of both files, both untouched for at
least 2 h, good for at most 24 h, and used once. It acts only on a record that already fails to open.

Its only effect is what a same-user process can already do today by deleting `gen-N/journal.json` (the next
start then begins that generation empty): the open approval requests and grants end and the ladder starts
again with nothing open, plus a copy of the old record in `archive-gen-N`. It never grants, asks for or sends
anything, and it doesn't change the owner's pause on role messages (kept in `role-messages.json`).

So don't give the request more power later (carrying grants over, acting on a record that opens, choosing
what to keep) on the belief that only an operator can write it.

## The off switch

`PI_WEB_UI_MESSAGE_APPROVALS=off` in the server's environment turns the ladder off at start, before the
lock or any guard file: nothing is read or written. Sends use the native 6-message rule, approval actions
answer "Approvals are unavailable right now.", and the log says
`approval ladder UNAVAILABLE (turned off (PI_WEB_UI_MESSAGE_APPROVALS=off)): ...`. Any other value leaves
approvals on (the log names a value it doesn't understand). The record stays as it was, so removing the
switch brings the same record back.

To turn it on for the live service, create `~/.config/systemd/user/pi-web-ui.service.d/approvals-off.conf`
with these two lines:

    [Service]
    Environment=PI_WEB_UI_MESSAGE_APPROVALS=off

then `systemctl --user daemon-reload` and `pi-web-deploy restart`. To undo it: delete the file,
`systemctl --user daemon-reload`, `pi-web-deploy restart`.

## Undo

- The off switch above turns approvals off without touching the record.
- Reverting this patch (with `wt`, then `pi-web-deploy`) removes the script, the request check and the
  switch. A build without it opens gen-(N+1) as usual, so a fresh start that happened stays.
- The old record is never changed: gen-N stays until the next rotation and `archive-gen-N` stays.

## Tests

`tests/unit/role-message-guard-fresh-start.test.ts` (real host, store and native record; the record made
unreadable as the live one was):

- a matching request made by the script: gen-2, archive and gen-1 byte for byte, request done, the last
  hour's sends still counted, a real send committed through gen-2, a later start stays on gen-2;
- a crash after the archive copy, before `current.json` switched: the next start finishes it, once;
- no request, another journal or accepted.json, a file touched within 2 h, expired, good for over 24 h,
  dated in the future, another generation, writable by others, another format: off, and every guard file
  as it was;
- a record that opens: a request for its generation ignored and left; one for an older generation marked
  done;
- the off switch: off at once, no guard file read or written, sends the native way; another value leaves
  approvals on;
- the script refuses a readable record and files changed within 2 h;
- Ops #248, on gen-2: `current.json` missing, garbled or naming a missing generation: off with the reason,
  every guard file (lock included) the same sha256 and mtime, nothing cleaned; a rotation with a garbled
  `current.json` throws and removes nothing (N3);
- a request that is a link or a pipe (the start isn't held up), over 4 KiB, or not mode 0600: refused and
  left in place (N1);
- a journal holding a prepared send, or one that can't be parsed: refused, off, every guard file as it was
  (S1);
- the fresh start and a rotation begin their generation with one helper and leave the same files (S2);
- the script runs with `PI_WEB_DATA_DIR` on the test's temp folder (N2); it also refuses a request over
  4 KiB, a prepared or unparseable journal, and a missing `current.json` while a generation exists.
- Ops #253: a first start whose store fails once after gen-1 is made: the next start is on, in gen 1 (A1); a
  rotation after a send, in a folder it can't write: each send comes back as sent and is there once,
  approvals stay on, the log says why once; with `current.json` no longer naming the store: the send comes back
  as sent, approvals turn off, and only that send's own gen-2 files changed; at start, a rotation that fails
  stays on, and one that finds `current.json` changed turns off without saying "on" (O2).
- Ops #253, `tests/unit/role-message-guard-host-files.test.ts`: each rename of `current.json` is followed at
  once by a flush of the guard folder (A2); two servers starting at once on one folder: exactly one holds the
  guard and the other turns off, leaving nothing; a gone server's, an unreadable or empty, and this process's
  own lock are taken over; the give-back and second-try cases (A4).
- Ops #253, `tests/unit/role-message-guard-store.test.ts`: the fresh start's check and `recover()` agree on a
  prepared send at all 12 points where a send can stop (A3).
