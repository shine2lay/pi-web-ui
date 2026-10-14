# Roles message receipts: M0 / Ops #139

## H-ROLES-M0-1 (written before implementation, 2026-10-13 ~19:45 PDT)

**What is wrong, with evidence.** The Roles page's only native message facts are guesses:

- `RoleMessageRecord.state` (`server/role-messages.ts`) is `waiting | delivered | replied | failed`. `delivered` means the header was found in the target transcript (`transcriptHasRoleMessage`), and `replied` means a reply record linked back. Neither says the message reached a model's final input, or that the turn it was in finished well.
- `RoleTurnRecord` (`server/role-replies.ts`) keeps the send ids a run was _admitted_ with (`collectRoleInput`) and a last-message error, but no session epoch, turn, run or attempt identity. `settleTurnRecord` hands it only to the home-only `roleReplyOf`; task chats and FYIs never reach it.
- pi SDK 1.0.1 has no metadata-only final-input hook (T01). `context`, `context_with_system` and `before_provider_request` carry the whole message list or provider payload (reading them is model-input inspection, forbidden). `turn_start` has only `turnIndex` and a time; `auto_retry_start/end` only a per-sequence counter. There is no issued run or attempt identity.
- The protocol list is the newest 100 records (`ROLE_MESSAGES_LIST`) out of 1000 kept (`ROLE_MESSAGES_KEEP`): a count made from it is not a full index.

**The one change.** Add one inert module, `server/roles-messages.ts`, that is the only place "processed" can come from: three capability adapters (admission + reply-link, delivery, input-settlement) that turn typed native metadata into C0 `rtpi/event/1` records, and one pure directed-arrow projection that joins them by the exact message ref. Processed comes only from `rtpiProcessed` on an inclusion record of _that_ message and a settlement record of the _same_ whole-ref witness (session, epoch, turn, run, attempt). The input-settlement adapter refuses to emit known facts while the T01 seam is missing (`input-hook-unsupported`), so on today's native seams every badge is unknown and its ready claim is blocked. No producer, hook, importer or store change.

**Why it should fix it.** The arrow can then only say "Processed in a settled turn" on the exact evidence C02 names, while admission, delivery, a header, idleness, a reply, pruning, compaction, an abort, an empty error or another attempt's success cannot produce it; and what cannot be proved shows as unknown instead of a guess.

**Expected, and how it is measured** (fixed synthetic metadata, `tests/unit/roles-messages.test.ts`, no model input, no chat file):

- F13/V03 positive: inclusion (S,E,T,R,A1) + successful settlement of the same A1 → processed, for home, task and FYI separately.
- V03/S04 negatives, each pending or unknown, never processed: admission only; header/delivered only; idle; empty-error same attempt; reply arrived; settlement pruned; compaction (inclusion lost); abort; A2 success for an A1 inclusion; failed A1; FYI without its own inclusion; home-only producer (task and FYI stay unknown).
- Native seams as they are (T01 missing): every message `processed: unknown`, badge `ready: false`, `blocked: input-hook-unsupported`, even with inclusion-looking input.
- Index: totals come only from a native index marked complete; a 100-row tail or a truncated store gives null totals and `complete: false`; the pending window shows at most 200 with the full total.
- S02: a message bound to an older home revision stays in its old domain, never counted for the new home.
- V04: the same receipt rebuilt gives the same canonical bytes and dedup key; changed bytes under the same key is a conflict.
- V15: extra body, text, path or hash fields on the input never reach the record.
- Old-code counterfactuals: mapping `state` `delivered`/`replied` to processed, or `roleReplyOf`-style home settlement, or counting the 100-row list, each fails at least one fixed case the new code passes.

**What would prove it wrong.** Any negative case coming out processed; any processed without T01 declared; a truncated index reported complete or with a total; a task or FYI message processed from a home-only settlement; body, path or hash bytes in a record; or any change to an existing file's behaviour.

Result: **HIT** (32/32 on the first run; landed inert as `afdf36af`).

## H-ROLES-M0-2 (review of the landed M0, written before the fix, 2026-10-13 ~20:45 PDT)

A read-through of `rolesMessageArrows` after landing found four places where it still guesses. Each gets one change and one fixed case that fails on `afdf36af`.

- **(a) Pending after a redelivery.** Wrong: `pending` is `!failed`, and `failed` is true when _any_ delivery failed. A message whose first delivery failed and whose redelivery got in (or the other way round) shows `delivered: "yes"` but drops out of the pending list and the pending total. Change: `failed` only when no delivery succeeded, so pending follows the final delivery state. Expect: both orders give `delivered: "yes"`, `pending: true`, pending total 1. Wrong if: either order leaves it out of pending, or a failure-only message becomes pending.
- **(b) Settlements of one attempt that disagree.** Wrong: a same-key conflict is only marked through `context.action`, and a settlement has none, so the first settlement seen wins silently. Two settlements of one attempt under different keys (success and error) make the result depend on record order. Change: a witness whose settlements conflict (same key with other bytes, or different outcomes) is a conflict; every message included in that attempt shows `unknown` (`receipt-conflict`) and is listed in `conflicts`. Expect: success-then-error and error-then-success both give unknown; an exact duplicate (same bytes) still gives processed; a conflict on another attempt leaves this message processed. Wrong if: either order still gives a processed or not-processed answer, or a byte-identical duplicate is called a conflict.
- **(c) Stale without a known current home.** Wrong: `stale` is `currentHome[role] !== homeRevision`, so a role missing from the registry, or a role id such as `constructor` or `__proto__` read through the object prototype, is called stale without evidence. Change: `stale` is `null` unless the registry has its own positive current home for that role. Expect: missing, zero and prototype-named roles give `null`; a matching home gives `false`; an older one still gives `true`. Wrong if: any of them gives `true` or `false` without a registry entry.
- **(d) One id listed twice in the index.** Wrong: a repeated id is counted twice in `shown`, the class counts and the pending total, and an index whose total counts the repeat is still called complete; two entries that disagree put one message in two arrows. Change: one entry per id; a repeated id makes the index not complete; entries that disagree make that message `unknown` (`index-conflict`, listed in `conflicts`). Expect: `[home, home]` with total 2 gives `complete: false`, `total: null`, `shown: 1`, one arrow, and the message still processed on its exact receipts; disagreeing entries give one arrow and unknown. Wrong if: a repeat is counted twice or the index is still complete.

Measured by the stage test (fixed synthetic metadata only) before and after the change; then the land gate.

## What this module is

`server/roles-messages.ts` (unit M0, I-MESSAGE/1). **Inert (D-INERT)**: no production file imports it; no instance, timer, registration, journal or I/O; nothing is appended. Every adapter is off unless called with `enabled: true`, and an explicit disable writes nothing. PATCHES.md gets no row until a consumer imports it (as with C0 and Q0).

### Native metadata in (I-MESSAGE/1)

`RolesMessageMeta`: the exact message id, kind (`question | request | fyi | reply | report`), route (`home | task`), sender and recipient role ids with their registry home revisions, the target binding (`sessionId`, `sessionEpoch`, `branchId`, `homeRevision`), and for a task route the queue tuple `{queueId, taskId, planRevision}` from Q0's I-QUEUE key. `replyTo` names the original for a reply. There is no text, header, hash, path, title or chat label: the binding must come from native state (the session header id, as Q0 does), never a file name or a "Queue #N" label.

Receipt classes are separate: `home` (a turn-starting message to a role's home chat), `task` (to a queue task chat, bound by queueId+taskId), `fyi` (no turn of its own; read with that chat's next message). An FYI needs its own inclusion receipt; the turn it is read in must include it.

### Three capability adapters (C0 seams)

| Adapter                       | Facts                                 | Native source it stands for                                                                               | Without its seam                                                                             |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `rolesMessageAdmission`       | `message-admitted`, `message-replied` | role-message admission (the persisted record; a reply's own new id, linked to `replyTo`)                  | C0 refuses: T02 `canonical-source-not-committed`, T05 `native-issuer-registry-missing`       |
| `rolesMessageDelivery`        | `message-delivered`                   | the persisted delivery revision (`sends`, `deliveredAt`)                                                  | same                                                                                         |
| `rolesMessageInputSettlement` | `message-included`, `message-settled` | the generic final-input / successful-settlement producer (every chat, before the home-only `roleReplyOf`) | **T01 missing**: known facts are refused `input-hook-unsupported` before any record is built |

Each record carries the message as `context.action` (kind `operation`, id = message id), the recipient role, the target session, and for a task the queue and task id. `message-settled` is a turn's settlement: it carries the witness only, and is joined to a message through that message's own inclusion record.

### Directed arrows (pure projection)

`rolesMessageArrows(index, records, capability)` groups messages by direction (`from → to`) and receipt class, and for each message reports `admitted`, `delivered`, `inputBound`, `replied` (the reply's id, a separate message and arrow) and `processed` (`processed | not-processed | unknown` with the reason from `rtpiProcessed`). A reply never processes its original; hovering is a client action and has no function here.

- `processed` only for an inclusion record of this exact message whose witness has a successful settlement of the same witness. Another attempt's settlement is `unknown` (`settled-different-attempt`); a same-attempt error or abort is `not-processed` and the message stays pending.
- `badge.ready` is true only when the capability declares the T01 seam; otherwise `blocked: "input-hook-unsupported"`.
- Totals come from the native index only when it says `complete`; otherwise totals are null and `complete: false`. Pending shows at most 200 (`rtpiPendingWindow`) with the full total.
- Pending follows the final delivery state: a message counts as failed only when no delivery of it got in.
- Conflicts are never resolved by order: a message whose receipts conflict, or that was included in an attempt whose settlements conflict, shows `unknown` (`receipt-conflict`). One index entry per id; a repeated id makes the index not complete, and entries that disagree show `unknown` (`index-conflict`).
- `stale` is `null` unless the registry has its own current home for the recipient role.
- Legacy records with no receipts stay unknown; nothing is cleared, upgraded or rewritten.

## Missing native seam (D-MISSING) and the proposal

T01 (exact final-input hook with native run/attempt identity) does not exist in pi SDK 1.0.1, so the input-settlement adapter stays off and the badge's ready claim is blocked. No SDK instrumentation, payload reading or helper was added. The bounded proposal went to Ops with queue_stuck (`T01-PROPOSAL.md` in the #139 receipts folder).

Ops decided (rule 21, 2026-10-13 ~20:30 PDT; Ops's technical decision, not an owner approval): keep processed unknown and record T01 as a missing seam. T01 joins T02-T05 in one bundled package that goes to the owner before any switch-on, alongside J0 (#145). There is no spec-only T01 task and no contract revision now. This authorises no SDK change or upgrade, upstream request, payload reading, producer, hook or store change, install, restart or switch-on.

## Stages and undo

- Stage: `scripts/sealed.sh node_modules/.bin/vitest run tests/unit/roles-messages.test.ts` (fixed metadata only; no SDK, chat, model or network).
- Normal gates: `npm run build && TZ=UTC scripts/check.sh`, then `wt land`.
- Undo: revert the one commit (three new files). Nothing imports them, no store or record is written, so old readers, `role-messages.json`, the guard store and the Roles page are unchanged. The adapter-disable undo is the default: `enabled` absent → `off`, no record.
