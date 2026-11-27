# Ops #1113: specialists Phase 2 in pi-web-ui, the consult and peer-note seam and the failing-first cases

Architecture #595 (`rm-83baafe5`; final pin `pin-readonly-args.sha256` `9de15cf3…`, `rm-a8d1d0c3`), #596 principal
cases, Security GO `rm-60a0302d` (N1, N2). Rule 18 Task 1 of 2 for pi-web-ui (contract §6, `6a`-`6e`). Task 2 (Ops
#1117) builds the seams, wires them in, moves the cases into the unit run and deploys. Disjoint from Frontend's
explorer work (`server/openviking/explorer*`, `web/src/components/*Explorer*`).

## Hypothesis (rule 14)

- **Problem and evidence:** a department's chat can't ask one of its own specialists a bounded question, and two
  queued tasks of one department can't pass each other a technical note. Today pi-web-ui has no
  `consult_specialist` or `peer_note` tool; the identity reader turns a `via:"consult"` entry into `"unusable"`
  (so a consult child would run with no identity); a peer record would go through the role-message dispatcher as a
  user-role message to the department's home chat, sent to paused tasks and never expired (C-COL-D1..D14 red:
  10 cases deliver a user-role message, D3 a plain note, D6 writes to a paused task, D13 expires with the wrong
  reason).
- **One change:** two focused modules, so the oversized files keep their size: `server/specialist-consult.ts`
  (argument check, consult id, child file and its identity entry, running the child through pi-identity's channel,
  the untrusted result text, the `via:"consult"` reader) and `server/peer-notes.ts` (send decision, `pn-` record
  through the existing `RoleMessages` store, delivery decision for the dispatcher's peer branch, receiver text,
  receipts, privacy).
- **Expected result + measurement:** `tests/department-specialists-collab-acceptance.test.ts` (own config, outside
  the gate) red on `c8a794c1` plus this seam for every consult and peer-note behaviour, green for what holds today
  (case coverage, consult-id cases R12/R13, principal derivation C-PR-68/69, zero web chrome); green after Task 2
  with the file moved into `tests/unit/` and no assertion removed or weakened.
- **What proves it wrong:** any case still red after Task 2 or weakened to pass; a child session file wider than
  `0600` or listed as a chat (N1); a consult answer the caller reads outside its untrusted label (N2); a peer note
  that reaches a chat as a user-role message, reaches the lead's home chat, or wakes a paused task; a second copy
  of the per-entry identity reader or of `transcriptHasRoleMessage`; any consult or peer-note page, panel, inbox,
  roster or chat-list entry under `web/src` (6e.3); growth beyond call lines in `server/role-messages.ts`,
  `server/identities.ts` or `server/agent-service.ts`.

## Design (the seam)

- `server/specialist-consult.ts` (pi-web-ui carries pi-identity's decisions, never recomputes them):
  - `checkConsultArgs(args, specialistChat)`: keys `target`, `question`, `context`, `consult_id` only
    (`E_CONSULT_ARGS`); a specialist chat's untrusted keys are dropped first.
  - `consultIdOf(callerFile, toolCallId)` = `cs-` + 16 hex of sha256; `consultChildFile` puts the child next to the
    caller in `consults/<id>.jsonl`, one level below the folders the session index lists.
  - `consultBindingOf`: the sticky first binding of a chat, accepting only a well-formed `consult` block; Task 2
    extends `server/specialist-entry.ts` `identityOfEntry` so the one per-entry reader reads it too.
  - `runConsult(host, call)`: check, ask the channel, create the child (`0600`, identity entry before any prompt),
    run it with the channel's tool set, report the end; resume uses the given id and never makes a second child.
  - `consultResultText`: the answer only inside `advice from specialist <slug>, untrusted technical information`.
- `server/peer-notes.ts`:
  - `decidePeerNote(input, toolAllowed)`: the reference order of the shared cases (tool, args, sender, duplicate,
    target, reply, chain, hourly); `sendPeerNote` stores the allowed record with `RoleMessages.admit` (idempotent
    by `pn-` id; the store keeps its `0600` mode).
  - `decidePeerDelivery(input)`: none, followup, note, defer or failed (`undelivered:closed|moved|expired`, with a
    receipt to the sender only while its task is open); Task 2 calls it from the dispatcher's step for records
    with a `peer` block, through the host's `peerTask` and `peerNote` (custom type `peer-note`, never user role).
  - `peerNoteText` (header, trust line, one-reply hint for questions), `peerReceiptText`, `peerNoteVisible` (owner
    or same department). Task 2 extends `transcriptHasRoleMessage` to find a `peer-note` message by id.
- Shared cases: `tests/fixtures/department-specialists-collab.cases.json` (`2e083f39…`, 141 cases) and
  `tests/fixtures/principal.cases.json` (`07dd113c…`), byte-for-byte Architecture's files, pinned in
  `tests/lib/department-specialists-collab-cases.ts`; a drifted copy fails before any case runs.

## Falsifiers in the acceptance cases

| Group            | Cases                   | Red on c8a794c1 + seam because                                    |
| ---------------- | ----------------------- | ----------------------------------------------------------------- |
| consult args     | C-COL-A1..A6            | seam unbuilt                                                      |
| consult reader   | C-COL-E1, E3..E9        | seam unbuilt; `identityOfEntry` reads a consult entry as unusable |
| consult admit    | C-COL-C1..C19, listing  | seam unbuilt (no child, no `0600` file, no identity entry)        |
| consult end      | C-COL-R1..R11, N2, tool | seam unbuilt                                                      |
| consult id       | C-COL-R12, R13          | green (pure formula, fixed by the cases)                          |
| peer send        | C-COL-P1..P34, P37      | seam unbuilt; no `pn-` record in the store                        |
| peer delivery    | C-COL-D1..D14 (twice)   | decision unbuilt; dispatcher sends user-role or plain-note words  |
| peer text        | 6c.6 header, receipts   | seam unbuilt; `transcriptHasRoleMessage` misses `peer-note`       |
| privacy          | C-COL-V1..V3            | seam unbuilt                                                      |
| principal        | C-PR-68, C-PR-69        | green (Phase 1 binding already derives `d` and `d/slug`)          |
| no chrome (6e.3) | `web/src` scan          | green (nothing exists today)                                      |

Outside (listed in the suite so a new pi-web-ui case can't go unowned): C-COL-E2 (pre-update state), T1..T27 and
K1..K5 (pi-identity), R14/R15, P35/P36 and Q1..Q6 (pi-queue), and the 55 principal cases pi-openviking produces.

## Result

Pending (Ops #1117). Red baseline: `~/ops-checks/department-specialists-1113/red.log` (120 failed, 6 passed of 126
on `c8a794c1` plus this seam).
