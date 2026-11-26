# Ops #1097: department specialists in pi-web-ui, the seam and the failing-first cases

Owner Shine (`dr-74b275288405`), Architecture #591 (`rm-f42c9785`), Security (`rm-7d1d46c3`). Rule 18 Task 1 of 2 for
pi-web-ui (contract §4, §5.1-§5.4; pinned at
`~/architecture-dept/conventions/department-specialists.md` `5f3d1f73…`, `4-messages-ui.md` `8d20c2de…`,
`5-build-proof.md` `feac1fd9…`). Task 2 (Ops #1101) builds the seams, wires them in, moves the cases into the unit run
and deploys. Runs beside the Task 1s in pi-identity, pi-queue and pi-openviking.

## Hypothesis (rule 14)

- **Problem and evidence:** a department can't yet hand a queued task to one of its own specialists. pi-identity
  will write `specialist:"<slug>"` on the chat's `identity` entry; pi-web-ui today reads only `data.id`, so a bad
  specialist field (`"../x"`, a number, a home-chat entry) still gives the plain department (C-ENTRY-3..5 red), a
  later `/identity` silently rebinds a specialist chat (C-BIND-1), role messages carry no specialist and refuse an
  unknown `to` with a text naming the target and listing the roles (C-MSG-2/3: 4 different texts for 5 targets), and
  no queue row or header can show which specialist works a task (C-CHIP-1/2).
- **One change:** one small seam per concern, each in its own module so the oversized files keep their size:
  `server/specialist-entry.ts` (read the entry, sticky binding, `/identity` refusal `E_SPEC_BINDING_CONFLICT`),
  `server/specialist-messages.ts` (server-stamped `from.specialist`, who may see it, the fixed `E_NO_ROUTE: no such
role` refusal), `web/src/specialist-chip.ts` (the one chip on the queue row and the task chat's header).
- **Expected result + measurement:** `tests/department-specialists-acceptance.test.ts` (own config, outside the gate)
  red on `d52aaf1e` for every specialist behaviour and green for today's behaviour (no-specialist cases, roster of
  15, no specialist chrome); green after Task 2 with the file moved into `tests/unit/` and no assertion removed or
  weakened. `tests/unit/identity-config-parity.test.ts` (C-PARITY-1) green now, inside `scripts/check.sh`.
- **What proves it wrong:** any case still red after Task 2 or weakened to pass; a chat with a bad specialist field
  that still acts as its department (or falls back to the home chat's identity); `/identity` writing in a
  specialist-bound chat; another department seeing `from.specialist` or the chip; two `E_NO_ROUTE` texts that differ
  by target; any specialist row, picker, page, avatar or colour in the web app (§4.4); a growth in
  `server/role-messages.ts`, `server/identities.ts`, `server/agent-service.ts` or `server/protocol.ts`.

## Design (the seam)

- `server/specialist-entry.ts` (pi-web-ui's reader copy of the field only; pi-identity keeps the specialist file
  reader, the tool decision and `snapshotSha256`, §5.4):
  - `identityOfEntry(entry)`: `{id}`, `{id, specialist}` or `"unusable"` (bad slug against
    `SPECIALIST_SLUG_RE`, a non-string, `via` other than `"queue"`, a non-string `id`). Task 2 makes
    `identityIdOfEntry` / `identityIdOnBranch` call it, so an unusable entry reads as `null` (no usable identity) and
    never as the department or the home chat's identity.
  - `specialistBindingOnBranch(entries)`: the first specialist entry binds and stays; a later change is a conflict.
  - `identityCommandRefusal(entries)`: `{code: "E_SPEC_BINDING_CONFLICT", message}` on a bound branch; both
    `/identity` writers in `agent-service.ts` (the durable chat's handler and `setChatIdentity`) ask it before
    writing. Only the call lines are added there.
- `server/specialist-messages.ts`: `specialistStamp(sender)` from the server's binding (`SpecialistSender.specialist`
  on `RoleMessageSender`, never a tool argument), `specialistShownTo(record, viewer)` (owner and sending department
  only; the owner's list row gains `fromSpecialist`), `noRouteError(roleIds)` (starts `E_NO_ROUTE: no such role`,
  the same for every non-role `to`). The recipient's header stays `<dept> · Queue #N`.
- `web/src/specialist-chip.ts`: `specialistChip(task, viewer)` gives the launch snapshot's title, the slug before
  launch, or null (other department, no specialist). Task 2 renders it on `renderTaskQueueRow` and the header's
  `IdentityTag`, marked `data-specialist-chip`; no other specialist file may appear under `web/src` except a
  `SpecialistChip.tsx`.
- Shared cases: `tests/fixtures/department-specialists.cases.json`, byte-for-byte Architecture's file, pinned at
  `sha256 5c473f33…` in `tests/lib/department-specialists-cases.ts` (a drifted copy fails before any case runs).
  Architecture #593 has since published an additive update on disk (`c81741ee…`); Ops #1101 (Task 2) re-pins it.

## Falsifiers in the acceptance cases

| Group    | Cases                          | Red on d52aaf1e because                                      |
| -------- | ------------------------------ | ------------------------------------------------------------ |
| C-ENTRY  | 1-6, 1/3 twin                  | seam unbuilt; bad entries 3-5 read as `qa`, not `null`       |
| C-BIND   | 1, 4, 6, `/identity` sites     | seam unbuilt; neither `/identity` writer asks it             |
| C-MSG    | 1-4, 2/3 identical refusals    | no `from.specialist`; 4 different "no role" texts for 5 `to` |
| C-CHIP   | 1-4                            | chip unbuilt; no chip on the row or the header               |
| C-PARITY | 1                              | green (copy is byte-identical today)                         |
| C-NOSPEC | ENTRY-2, BIND-6, MSG-4, CHIP-4 | seam unbuilt; today's ids, records and rows already pass     |

Outside the six groups (listed in the suite so a new pi-web-ui case can't go unowned): C-PRIV-2, C-ASK-1/2
(pi-identity's tool answers) and C-MODEL-1/3 (pi-queue's launch composition).

## Result

Pending (Ops #1101). Red baseline: `~/ops-checks/department-specialists-1097/red.log` (33 failed, 10 passed of 43 on
`d52aaf1e` plus this seam).
