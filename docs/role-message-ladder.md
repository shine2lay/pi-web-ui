# Role-message approval ladder (Ops #122)

Roles message each other with `message_role`. A message started by another role's message is one
**hop** further down the same chain. Until #122 the server refused every message past hop 6
("Not sent: this would be message 7 …"), which stranded useful completion notices (FE32, H7).
#122 replaces that hard stop with an approval ladder. The Owner chose "Ship now, urgent later"
(native record dr-c512c42648d0): there is **no urgent exception** in this delivery.

## What a role sees

| Hop   | What happens                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------ |
| 1–6   | Sent as before.                                                                                  |
| 7–11  | Needs a grant from the responsible lead, or the COO by default. The tool says so and how to ask. |
| 12–16 | Needs a grant from the Owner (hop 12 included). A grant covers at most hops 12–16.               |
| 17+   | Fresh Owner consent for each further 12–16-sized step; nothing renews by itself.                 |

- Ask: `message_role` with `approval: { action: "request", recipients, context }`. The context is the
  Owner's dialog package (goal, progress, prior decisions, why needed, questions, options, cost/time/risk,
  exact authority, safety and holds).
- Decide (the approver only): `approval: { action: "decide", requestId, generation, choice, reason }` with
  `deny`, `one_send`, `requested_quantity` or `escalate_owner` (the lower approver may pass it to the
  Owner once). Status: `action: "status"`.
- A grant: at most **5 accepted business sends** in total across its named roles and branches, an upper
  hop (lower tier never above 11), **60 minutes**, bound to one chain line (its root and the record it was
  asked at), the named roles (requester included) and the requester's task. No automatic grants or
  renewal, no progress judge, no self-approval; a COO asking for itself without a distinct lead goes to
  the Owner.
- Owner-tier and escalated requests are **questions only**: they appear in the Owner's browser dialog
  ("Message continuation: Owner decision") and on Telegram through the authorised plugin, bound to
  the request generation. They send no agent message and charge nothing. Queue Auto approve is not
  Owner authority.
- Approval controls are typed: they skip only the business depth check and still count in the hourly
  ledger. The limit is **20 accepted per role per rolling hour**, except **temper and ops have no hourly
  limit**, across all their chats (Owner, 2026-10-20, dr-c6daedfa9fef; Ops #318). Their messages still
  count; the exemption skips only the hourly refusal, not chain approvals, grants, pauses, holds, scope,
  budgets or consents. No other role or the board's post cap changes.

## Hourly exemption: H-MSGCAP-EXEMPT-1 (Ops #318)

Lead: Ops. Owner source: dr-c6daedfa9fef, 2026-10-20 ("temper and ops have no limit";
"Let Ops choose"). Ops chose no hourly backstop; the chain's finite grants remain the loop boundary.

- Wrong now/evidence: the shared 20/hour cap stopped Temper #129's final review and land requests,
  and refused Ops sends at 16:56 and 17:49 on 2026-10-20, against the Owner's direction.
- One change: a fixed server-side `ROLE_MESSAGES_HOURLY_EXEMPT_ROLES = ["temper", "ops"]` and helper
  skip only the hourly refusal in native fallback send, approvals host and approvals core. Match the
  verified sender role, never tool input. Keep usage recording and the frozen v1 policy unchanged.
- Expected/measured: sealed cases accept the 21st and 40th sends for both roles, across home/task chats,
  with approvals ready and unavailable. QA's 21st keeps the exact refusal text and `ordinary_hourly`
  reason where supplied. Ops's seventh chain hop still needs a grant. A pre-change journal still loads
  and works. After installation, inspect logs and message metadata passively; send no real-role probes.
- Falsifier: an hourly refusal for either exempt role; a changed cap/text for another role; or a skipped
  chain/grant check. Keep `ROLE_MESSAGES_PER_HOUR = 20` and the board's cap unchanged.
- Result: stage HIT. Old-code controls refuse the exempt sends at 21; corrected sealed gate passes
  all 469 files (7,145 tests, six skipped), format, typecheck, protocol, build and 74 PTY checks.
  Exempt 21st/40th sends, QA refusal, unchanged chain gates and pre-change journal reload all pass.
  Installed-build/passive-log check follows the land; no real-role test messages.

### Retention clarification: H-MSGCAP-RETAIN-1 (Ops lead, 2026-10-20)

This is the Ops lead's technical clarification of #318, not new Owner consent.

- Wrong/evidence: review found that native `save()` trims delivered history at 1,000 records while
  `hourlyCount()` counts that history. QA's 20 deliveries followed by 981 unlimited Ops deliveries can
  remove QA's earliest charge and admit QA's 21st within the same hour. At 5,000 Ops deliveries the
  whole QA hour can disappear. Exemption alone therefore fails the unchanged-cap requirement.
- One change: protect capped roles' non-report records younger than `HOUR_MS` during existing history
  trimming, in addition to the normal newest 1,000. Exempt rows still rotate. The additional hourly
  proof is bounded by **number of capped sender roles × 20**; existing waiting/report protections
  remain separate. Keep `hourlyCount()`, the schema, the frozen v1 policy and refusal text/reasons.
  Isolate the exemption constant/helper in an import-free module, re-exported beside the native cap.
- Expected/measured: fixed-input cases (red before the retention fix) deliver QA's 20, then Ops's 981
  and 5,000; QA's 21st still fails before and after reload. At exactly `HOUR_MS`, aged QA proof no
  longer counts and may rotate. The history adds at most 20 rows per capped role and still rotates
  exempt rows past 1,000. Core's runtime import graph loads neither native messages nor the SDK.
  Inspect core/store usage retention and host rotation/carry-over for equivalent count eviction.
- Falsifier: recent capped-role usage disappears; expired proof remains charged; exempt rows stop
  rotating; extra hourly-proof rows exceed the bound; or standalone core loads native messages/SDK.
- History inspection: core usage pruning is time-only (`server/role-message-guard-core.ts:466`);
  `GuardFileStore.commit()` rejects removal of a still-recent charge (`server/role-message-guard-store.ts:1008–1011`).
  Its usage-count capacity fails closed (`server/role-message-guard-core.ts:549`); it never evicts
  charges to admit a send. Host `sendNow()` checks native `hourlyCount()` (`server/role-message-guard-host.ts:2110–2111`);
  `freshState()` carries all native records in the last hour into each new generation (`server/role-message-guard-host.ts:1053`),
  with no count trimming. No changes to these retention rules were needed. The old chain-pruning test now ages
  its chain exactly one hour before eviction, keeping every chain/restart assertion.
- Result: seven pre-fix cases red (six admit QA's 21st; one imports native messages into core).
  First sealed gate: 7,143 passed, six skipped, two failed. The 981-case boundary assertion wrongly
  required all expired proof to vanish, rather than allowing it in normal newest-1,000 history;
  corrected to assert the exact remaining count (18, or zero after 5,000). The unrelated CLI test
  needs `dist/server/plugin-updater.js`, so build the worktree before the corrected gate. No production
  change or check loosened for either failure. Corrected full sealed gate: HIT (7,145 passed,
  six skipped; 469 files), including every retention/import regression and existing safeguards.

## Chain identity

A message's root and parent are recorded with it. The chain survives an omitted `replyTo`, an FYI, a
control message, a restart and branching. A chat whose place cannot be proved (forged header, missing or
edited parent, or a parent dropped more than 30 days ago) is `unknown`: it is never reset to hop 1, and
it needs the Owner. Legacy records without root/parent are anchored explicitly (partial provenance),
never reset.

`role-messages.json` keeps its newest 1000 records plus waiting/report protections and capped roles'
non-report hourly proof (Ops #318; at most capped roles × 20 extra hourly-proof rows). A chain's place never depends on that rotating
copy: when a record is dropped, its chain facts (id, hash, target, root, parent, hop, guard tag and, since
Ops #379, how it ended) go to
`role-messages-chains.jsonl` beside it and are kept 30 days, so a reply to a pruned message keeps its hop
(before, it became `unknown`, and the native code even counted it as hop 0).

## How it is built

- `server/role-message-guard-host.ts` (new): the single admission authority. It wires component E
  (`role-message-guard-core.ts`, `role-message-guard-store.ts`) to the native ports: sender binding to the
  current home chat, approver selection (trusted lead binding, COO default, Owner), decision
  re-verification, transport through `RoleMessages.admit`, the browser/Telegram Owner question, startup,
  rotation and rollback detection. One re-entrant in-process lease covers E's store, rotation, decision
  records and every admit; a pid lock file guards the directory. Admission's deferred delivery and page
  notification timers are created through `GuardLease.detach` (`AsyncLocalStorage.exit`), so the callbacks
  and the chat turns they start cannot inherit lock ownership (#175, H-LEASE-1). Only scheduling is
  detached: synchronous `host.sent` and awaited nested guard work retain re-entry. The existing 0 ms kick,
  300 ms notification debounce, 3000 ms periodic tick and #156 after-turn boundary are unchanged.
- Component A (`role-message-guard-approvals.ts`) presents requests and decisions; #122 fixed its command
  fingerprint (it now uses E's `guardCommandFingerprint`) and added the question-only path.
- `server/role-messages.ts` keeps all native rules and gains `prepare` / `admit` / `causalityOf` /
  `hourlyCount` / `ancestorAt`; records carry `root`, `parent` and `guard`. With the host absent or
  degraded, the native depth-6 refusal applies unchanged.
- State: `~/.pi-web-ui/role-message-guard/` (E's store in `gen-N/`, decisions, Owner questions, lock,
  `history.jsonl`).

## Storage caps (Ops rm-efd6df89)

Measured live volume (metadata only): at most 365 role messages a day and 20 per role-hour. Proposed to
Ops (rm-1fe61704) and approved with changes (rm-efd6df89):

- Each guard file at most 16 MiB (`GUARD_FILE_MAX_BYTES`); E fails closed past a cap and the refusal
  names the store.
- Requests and grants: 600 each, counting only open requests and live grants. Settled ones never block a
  send; they leave 5 hours after they settle (a request after its 24 h expiry).
- Usage (the rolling hour) is pruned after 60 minutes. Transactions and audit receipts 3000 each, outbox
  2000, tombstones 6000.
- Retention (Ops rm-fc4b9788, option C): settled transactions, audit receipts and delivery entries leave
  5 hours after they settle, whatever is still open elsewhere; a send's delivery steps (each its own
  transaction) leave with it. Each tombstone (E's replay memory) ends 5 hours after it is made. Open
  requests, live grants and undelivered entries are never pruned. A decision or grant use that names a
  settled, pruned or unknown request or grant is refused and creates nothing.
- Settling from the message store (Ops #379, H-LADDER-PRUNE-2): a delivery E handed off but never saw
  confirmed (left `unknown` or `dispatching`), or accepted but never handed off (`committed`), settles
  from the role-message store's own record at E's next command: delivered or replied there -> `handled`
  (an FYI `dispatched`) at its delivery time; failed there -> `failed`; dropped from the store (it drops
  only finished records) -> as it ended, at the drop (a fact kept before #379 has no outcome: `handled`,
  labelled `dropped:unknown`); in neither the store nor its chain memory a day (a message's lifetime)
  after acceptance -> `failed` then. Still waiting, held, or still being handed off:
  left as it is. It then leaves 5 hours after that time like any settled entry. Nothing is sent or
  replayed: only E's record changes, and a `delivery_settled` line goes to `history.jsonl` (synced) before
  it does; if that line can't be written, nothing settles (a write that fails partway is cut back). If the
  change itself then fails to commit, the line stays and the next command settles it (a second line only
  if the app restarted in between). Before this, such entries never left, and from
  2026-10-20 they filled the store (3000 of 3000 audit receipts) so every send was refused. Each step's
  time is now read under the writer, and a hand-off's proof is checked against a reading taken after it
  returned, so a commit that lands meanwhile no longer leaves a send `dispatching` or `unknown`.
- An approval context over 16 KB (16384 bytes as JSON) is refused whole, with its size; never cut down.
- `history.jsonl`: one metadata line per request, escalation, decision, grant, grant use, grant end and
  delivery settled from the message store (ids, roles, kind, states and times; no context or message words); kept 30 days; past 16 MiB it becomes the one archive `history.1.jsonl`. A write
  failure is logged and never blocks a send or an approval.
- One log line `approval ladder WARNING: <store> at N%` when a store reaches 80%; armed again below 70%.

Measured footprint: a business send keeps about 4 transactions, as many audit receipts, 1 outbox entry
and 4.5 KB of journal for 5 hours. Worst case tested: the busiest real 5 hours (165 sends, 2026-10-09)
played twice plus 100 runaway sends, with an approval request open throughout: peak 1188 transactions and
audit receipts (40% of 3000), 256 outbox entries, 724 tombstones, a 5.1 MB guard file (31% of 16 MiB).
The guard store still starts a fresh generation only when nothing is open, on the older triggers (1 MiB or
300 accepted messages, 3000 tombstones).

Known limits:

- The accepted copy inside the guard file only shrinks at that rotation. If something stays open for days
  on end, it grows about 2 KB per send; at real volume the file would pass half after about a week, and
  the 80% warning fires before any refusal.
- Cost: every guard transaction rewrites and fsyncs the whole guard file. At the worst case above that
  is about 80 ms of server CPU per transaction (about 4 per send), plus disk waits that don't block.

## Rollback

The previous reader (git-pinned in `tests/role-message-guard-acceptance/previous-reader.mjs`) opens the
new `role-messages.json` unchanged: every id, word, state and hop is kept, its hard 6 applies, approval
controls count in its 20/hour, and its save keeps the ladder fields. Reinstalling the ladder continues
each chain where it was. Roll back with `pi-web-deploy rollback`; never restore an older backup over
live role-message state.

To turn approvals off without a rollback, set `PI_WEB_UI_MESSAGE_APPROVALS=off` (Ops #241); an unreadable
record gets a one-shot fresh start: `docs/role-message-fresh-start.md`.

## Not in this delivery (future work)

- Urgent notices: no protected types (`safety_action_notice`, `critical_risk_notice`,
  `safety_action_result`), producer adapters, incident state or depth exemption. Messages that claim
  urgency are ordinary. #125 found no qualified native urgent source; #130 found no safe small design:
  a C124 origin cannot be represented, because such notices are born resolved and written by same-UID
  writers. A future urgent path needs a trustworthy origin first.

## Proof

- Stage cases: `tests/unit/role-message-guard-host.test.ts` (real RoleMessages, E and A; fake chats and
  clock), including the FE32/H7 7th-hop counterfactual (old code refuses, the ladder asks).
- Lease races: `tests/unit/role-message-guard-lease.test.ts` uses real Node timers and the store's boundary
  hook with promise barriers. A send from an admit-created delivery waits across journal publication;
  both writers keep their messages, charges and outbox even if the old code could have passed ready
  twice. The page-notification callback is detached too; synchronous nested saves/rotation remain ordered.
  Run on the pre-patch source: all three race cases fail (including a lost accepted record), the two
  nesting/timing controls pass. No real chat, message send or model call is used.
- Acceptance: V's harness (`tests/role-message-guard-acceptance/`) through
  `tests/role-message-guard-binding-122.mjs` on the registered build; urgent cases are NOT RUN
  (not delivered, fail closed), never green.
- Rollback: `tests/role-message-guard-previous-reader-122.mjs`.
