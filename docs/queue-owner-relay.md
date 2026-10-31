# Relaying an owner's dialog answer to another department's queue (host half)

Task 676 host half. pi-queue owns the tool (`queue_reply` with `target_role`), the target home's checks, the
source chat's dialog check, delivery, records and texts: its `docs/owner-answer-relay.md` is the whole route. This
side only authenticates the two home chats and carries one single-use ticket between them. No model-facing tool,
no state journal and no answer of its own is added.

## Hypothesis and status

**H-CROSS-QUEUE-OWNER-2 (host part).** #671's host actor requires the question's source session to be the queue's
own department, so a genuine owner answer in COO's home dialog can never reach a RollCall task without a false
source. A separate coordinator that authenticates the calling home and the target role's one home through the
same registry facts, and hands the target home a one-use ticket bound to both, should let pi-queue deliver it once
without widening anyone's authority. Falsified if a non-home, a task chat, the same department or a caller-chosen
path can start a relay; if a ticket works twice, for another session, after either home changed, or after its
command returned; or if a success is reported without the target home's own reply. **Result:** HIT: the unit and
coupled native tests below pass; see pi-queue's docs/owner-answer-relay.md for the end-to-end result.

**Status:** landed and live. pi-queue's half is cd99eef (land 35-9a7e02, its full check passed). This half,
8f16a650, failed land 257-7330d8 only on Prettier (10,296 unit tests, typecheck and lint passed). Ops then landed it
unchanged with a format-only commit, 7c8bc74f, and #674's host half (d8de9fa4) through land 259-ec55e5 without the
land checks, on the owner's order relayed by COO (rm-550021c2: "land without checks, just take the risk, the checks
take too long"). Live as 7c8bc74f since 2026-10-31 11:45; pi-web-deploy's checks passed (server, page, reply, big
chat, log). Afterwards, on the exact live pair (pi-queue cd99eef, pi-web-ui 7c8bc74f): typecheck clean, the five
question and relay unit test files 63/63, coupled native tests 14/14, the first run of #676 together with #674's
host half. This build never used the route on a real record or task; applying the owner's saved answers is the
source home's own later step.

## Modules and reuse

- `server/queue-owner-relay.ts`: `ownerRelayRequest` (exact shape: `role`, `id`, `record`, `note?`; role
  `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` up to 40, never trimmed or case-folded; record `dr-` + 12 hex; note up to
  8,000) and `OwnerRelayCoordinator` (`relayOwnerAnswer`, `consumeOwnerRelay`), a mirror of pi-queue's
  `owner-relay-port.ts` version 1. Same lane/ticket pattern as `queue-question-commit.ts`, separate lanes so a
  relay's nested native owner commit can't wait on itself.
- `server/queue-question-native.ts`: one `roleHome(sessionId)` fact (registered native endpoint, open session
  with the same id and file, identity on the branch, that role's single home chat by `samePath`, not a task chat)
  now shared by the question cards' source check and the relay coordinator; `homeOf(role)` takes the registry
  role with exactly this id and one home chat; `sessionIdOf(file)` the open session's id. Prepare and dispatch are
  the existing `openChatForQueue` / `queueRunCommand` paths.
- `server/queue-host.ts`: `relayOwnerAnswer` and `consumeOwnerRelay` exposed only together; `agent-service.ts`
  wires them from `nativeQuestionHost(...).relays`.

## Contract

1. `relayOwnerAnswer(sourceSessionId, request)` (pi-queue's source chat):
   - invalid shape → refused `invalid owner-relay request`; no single home chat for the role → refused;
   - one relay at a time per target home (`resolve(homeChat)` lane);
   - the source must be `roleHome` → else `the calling chat isn't its department's registered home chat`; the same
     role or the same file → `the source and the target are the same department: relay without target_role`;
   - the target home is prepared (opened without a prompt) and must then be `roleHome` of exactly that role and
     file → else `the <role> home chat isn't open with its queue`; the source is checked again;
   - a frozen grant `{ role, id, record, note?, source: { role, sessionId, file }, target: { … } }` and a fresh
     `randomBytes(32)` token; `/queue owner-relay <token>` is dispatched to the target home only.
2. `consumeOwnerRelay(token, targetSessionId)` (pi-queue's target home, inside that command): single use (the
   token is deleted on any presentation); the presenting session must be the grant's target, and both homes must
   still be what the grant says, else the ticket dies refused; returns `{ request, finish }` frozen.
3. Results: the target home's `finish` is the only success path (`relayed`, `kept`, `already`, each with a task);
   its other replies are checked (`refused`, `failed`, `uncertain`); an unknown shape is `uncertain`. When the
   command returns: not consumed → refused, and the ticket dies (`the target home didn't take the relay`, or `the
   target home has no queue command` without pi-queue); consumed without a reply → `uncertain`. A throw before
   consumption is refused, after it uncertain. A late second `finish` changes nothing.

pi-queue's `deliverRelay` in the target home may call the existing `commitQuestion` (#671) for a Rule 21
question; the target home is then the native actor of its own queue, so `nativeQuestionHost`'s actor rule is
unchanged.

## Limits

- The host proves who asked and which homes; it never reads a dialog, a record or a queue. Those are pi-queue's
  checks, in the chats that own them.
- An SDK prompt deferred while the target home is settling an agent turn returns before the command runs: the
  ticket then dies and the source is told it wasn't taken (nothing changed); calling again later works.
- #671's generic-acceptance recall guard checks the bound queue and the actor's home, not the source home (see
  pi-queue's doc).

## Undo

Revert this patch (8f16a650 and its format-only follow-up 7c8bc74f, keeping #674's d8de9fa4 between them) and
pi-queue's half (cd99eef) through the normal land, then `pi-web-deploy`. Without these functions, pi-queue's
source chat says this pi-web-ui can't relay yet; nothing is saved by the host, so nothing needs migrating. A relay
kept in a target queue is pi-queue's record and stays readable. `pi-web-deploy rollback` (to 231f5e09) is quicker
but also takes #674's host half out: pi-queue's Rule 24 restore is then refused, as by any older host.

## Checks

- `tests/unit/queue-owner-relay.test.ts`: the request shape; a relay through one frozen one-use ticket; refusals
  that send no command (task chat, unknown session, same department, no home, bad role, extra fields, empty
  source, a closed or foreign home); dead, foreign and late tickets; a home that changed before delivery; consumed
  but unanswered, thrown or unknown replies as uncertain; lanes per target home.
- `tests/coupled/queue-owner-relay-native.test.ts` (opt-in, `vitest.question-coupled.config.ts` with
  `PI_QUEUE_NATIVE_SOURCE` set to a pi-queue worktree): real pi-queue, real SDK sessions and the real
  `queueRunCommand` dispatcher; a COO home dialog relayed to RollCall's stopped #36 once with the source named and
  after a restart `already`; refusals (lead chat that isn't home, same department, no home, `RollCall`, `action`,
  `Frontend #1`, `RollCall #10`, `RollCall or Frontend`, cancelled dialog, missing record, dialog in the target
  home, forged ticket); an answer to an older stop; a paused target kept and delivered once; two relays at once
  and the owner's own answer racing; a Rule 21 ordinary choice getting his exact words; a relay behind a delayed
  commit and a recall racing a relay, each with one outcome. `tests/fixtures/question-commit-host.ts` and
  `tests/coupled/native-queue-world.ts` (generalized for several role homes) are reused, not copied.
