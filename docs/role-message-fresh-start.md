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
- **Result**: pending (filled in after the live check).

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

## What the next start checks and does

It looks at a request only after `recover()` failed on the current generation N, under the guard's lease
and lock. It acts only when all of these hold; otherwise it stays off and logs why:

- the request is a plain file of this user, not writable by group or others, in the format above;
- `gen` is the current generation;
- it isn't dated in the future, is good for at most 24 h, and hasn't expired;
- both files of gen-N are untouched for at least 2 h and their sha256s are the request's.

Then, in this order:

1. Copy gen-N's two files into `role-message-guard/archive-gen-N/` (flushed, then their sha256 checked
   again). That name is outside the generations clean-up, so the copy stays. gen-N itself stays in place
   too, as the one older generation kept; it goes with the next rotation.
2. Start gen-(N+1) the way a rotation does: remove a half-made gen-(N+1), write a fresh state (the native
   record's last-hour sends still count toward the 20 an hour; no open requests, grants or outbox), switch
   `current.json` to N+1.
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
- the script refuses a readable record and files changed within 2 h.
