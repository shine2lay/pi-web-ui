# Durable client review repair (#574)

Accountable lead: Ops. Requested Wave-1 correction before #570 mounts Wave 2.
No deployment, live chats, server protocol or reconnect-policy changes.

## Hypothesis (before implementation)

H-CLIENT-STATE-PARITY-1: review at 992a2716 found that `readEarlierPage`
inferred an unpositioned reply from the _current_ cursor, allowing a duplicate
reply after a render to prepend the same messages at invented positions.
Manual clicks also bypass the list's pending-request guard. Track one actual
request boundary, consume it once, reject overlapping/ambiguous replies and
apply the same deduplication to manual and automatic paging. Expect exact,
contiguous message IDs and cursors with one request per outstanding boundary,
including bursts and replies separated by renders. Any duplication, gap,
cross-conversation merge or lost scroll anchor falsifies the repair.

The draft scope currently changes from null to conversation+session at first
Pi initialization, which clears text typed or quoted while initialization was
pending. Distinguish binding a provisional draft to the _same_ conversation
from changing conversations or replacing a bound session. Keep the former's
text and edit guards, but clear/restore only the destination's draft on a real
switch. DSH still sends without Pi session IDs and isolates conversations.
Expect editable but unsendable Pi provisional text, preserved at binding and
sent once on explicit submission; text carried to a different conversation,
overwritten by a late saved draft, lost at binding or sent twice is a miss.

The suggestion parser recognizes only simple triple fences. Use the existing
Markdown parser's source positions to exclude actual fenced/indented/inline
code, including matching fence lengths, rather than guessing with a regex.
Ordinary prose suggestions must keep their existing extraction/deduplication
and deliberate-click behavior. A code example becoming a chip or a code
example disappearing from displayed text falsifies this repair. The existing
locked `mdast-util-from-markdown` 2.0.3 is declared directly, not upgraded or
newly installed, so the client does not depend on accidental package hoisting.

## Review follow-up hypotheses (before verification)

H-CLIENT-RETIRED-SCOPE-1: independent source review found that only abandoned
pending pages were retired. A completed session-S1 page could therefore be
replayed after the same conversation slot binds S2, relabelled as S2. Retire
completed request provenance as well; expect a matching S2 session identity
before accepting that slot's next positioned page. Any S1 replay merged into
S2 disproves the fix.

H-CLIENT-LIST-SCOPE-1: the list's pending anchor tracks conversation and cursor
but not session. A replacement session with the same cursor can remain locked
by S1's anchor. Include session identity in request deduplication and anchor
reset dependencies; expect one new manual request after replacement while
rapid clicks within one session still coalesce. A stale anchor or duplicate
manual request disproves the fix.

H-CLIENT-CODE-ORIGIN-1: an any-overlap exclusion also hides a prose marker whose
prompt contains inline code, while an incomplete code example can consume a
later prose marker in the global regex. Classify the marker's origin, skip
past code ranges without consuming later prose, and retain the complete prose
prompt. Expect code-origin examples preserved literally and ordinary prose
chips, including inline-code prompts, extracted unchanged. Losing either
falsifies the fix. All three are client-only corrections within #574's scope.

H-CLIENT-PAGING-LIFECYCLE-1: a second source review found that a same-session
socket replacement cancels the hook's request but leaves the list's anchor
guarded. Share a client-only monotonic cancellation generation between the
request tracker and list; reset anchors only when that generation or identity
changes, not on ordinary renders. Expect a fresh request after a disconnect/
reconnect, including batched lifecycle changes with the same final identity;
another stale lock or duplicate request while genuinely pending disproves it.
This tracks cancellation; it does not alter reconnect timing or policy.
Source-review miss before execution: generation-first anchor invalidation also
skipped compensation when a valid prepend and reconnect were batched. Restore
an accepted same-identity prepend before dropping an unanswered old-generation
anchor. Measure the combined ordering with an exact scroll offset as well as
cursor/IDs; generation-only cancellation must still unlock a new request.

## Verification and integration

A separate test author specifies fixed-input DOM/hook regressions in
`tests/unit/durable-client-review-regression.test.ts`, without implementing
production fixes. Existing tests remain unchanged. After all edits: sealed
focused tests and an old-code negative control, sealed build, then detached
normal `wt land` gate. The landing receipt and queue completion identify the
exact checked landed pin; no deployment follows this task.
These are synthetic UI/unit checks, not live-browser reliability evidence.

Result: H-CLIENT-STATE-PARITY-1 and its review follow-ups HIT on fixed inputs.
The 69 dedicated regressions pass; together with existing probe/UI, message
window, draft, pending-send and switch suites, 8 files / 238 tests pass sealed.
Loading the five original production modules from
`992a27161346b4fd7bcc9db6fca45875114a4b00` without changing the fixtures gives
46 expected failures / 23 passes. The two isolated original P1 controls fail
specifically with cursor 0 instead of 30 after a duplicate reply and an empty
textarea instead of the typed-plus-quoted draft after initialization. The
fixed code passes both, preserving exactly-once send and DSH no-session use.
Sealed build, both-side/test/extension typechecking, lint (0 errors), PATCHES
validation and changed-file formatting pass. Independent source review found
no remaining scoped issues after the lifecycle and anchoring corrections.
The detached normal landing gate remains mandatory, not inferred from these
focused results.

#570 must check actual async initialization snapshots, paging request/reply
ordering and scroll anchoring in an isolated browser fixture at integration.
Positioned paging replies must include `historyWindow.earliestIndex`,
`historyStart` or `start`; an unpositioned reply is usable only when it can be
bound unambiguously to the sole outstanding request on this connection.
After abandoning a page during a switch, replies for that conversation must
carry an explicit position. If the same conversation slot now has a different
session, a position alone is ambiguous too: it needs an echoed matching
`sessionId` or a fresh socket. The client rejects ambiguity; it does not force
a reconnect or alter the server protocol. #570 must keep/prove that identity
correlation when wiring the host, not treat a rejected ambiguous reply as a
success. The current server paging tap already supplies explicit positions.
No change to the >30 s socket-recovery policy, optimistic-send ledger,
explicit chip-send behavior or server protocol is authorized here.

## Undo

Revert this patch, rebuild, and use the separately approved release path.
No stored-data migration or engine switch is involved. Nothing is deployed
by this task; #570's rollout consent and unrelated owner pauses remain.
