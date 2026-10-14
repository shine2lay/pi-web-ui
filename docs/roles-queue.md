# Roles canonical queue projection — Q0 / Ops #137

## Hypothesis and scope

H-ROLES-Q0-1 was written before implementation in pi-queue's `docs/roles-queue.md`.

Evidence: #110 S1/S2 remain in the pinned pi-queue 40cbf3d and pi-web-ui 370f92e5. Native `queue.ts` replays queue operations with the session ID. `roles-overview.ts` omitted it. An add → pause(finished) → run(queueId) branch consequently showed stopped in the Roles badge and `roles_overview`, although the native queue was running.

One change: build the read-only I-QUEUE projection on the existing canonical `applyOp`, with complete binding/index/runtime inputs, then adapt it to C0. A separate labelled patch corrects the existing caller by passing the **native session-header ID**, not the home filename or label. No second scheduler/replay, store repair, dispatch, hold/capacity change, or new live reader.

Prediction: exact replay parity and full native totals on fixed branch/fork/rebind/restart/legacy cases; exact tuple and plan revisions survive display caps; complete capacity4 + one current worker → 1 working/3 free; missing/partial/stale/unbound remains unknown; old caller fails the regression while new caller and real tool pass it. Removing/disabling the new modules changes neither old readers nor queue entries. Any contrary case disproves the hypothesis.

First results (2026-10-13 18:51–18:53 PDT): S3 PASS 10/10, S4 23/25 (two bound-running assertions fail), old exact reader counterfactual fails as expected. S1/S2 initially 23/24; H-ROLES-Q0-1b corrected a fixed-case misuse of in-home starts, and the changed case passes in isolation. Gates not yet run.

### H-ROLES-Q0-1c — caller parameter position (before correction)

Wrong: the new scanner retains the header ID (both header/reset tests pass), but its caller initially passed that ID as argument four. The exact `taskQueueFromEntries` signature is `(entries, available, maxDone, shareable, queueId)`: argument four is shareable patterns, not the queue ID. This leaves the same original rejection and explains both failing bound-running assertions.

One change: pass `undefined` for the unchanged shareable default and the native header ID as **argument five**. Expected: both fixed running assertions and the actual tool caller pass, while foreign/headerless cases remain unchanged. Disproof: either assertion still false or foreign IDs accepted. Test S4 alone before the full gates; result HIT, all four new caller assertions passed after the correction (2026-10-13 18:59 PDT).

### H-ROLES-Q0-1d — C0 absent capability (before correction)

Wrong: the full web gate stops at server TypeScript with `roles-queue.ts(131,37): error TS2345`: this adapter's optional capability can be undefined, while the C0 validator requires a capability or explicit null. The stage tests cover absent proof correctly at runtime, but the TypeScript contract is stricter.

One change: normalize an omitted capability to null at the validator boundary. Expected: server typecheck passes with identical fail-closed handling of absent native proof; default-off and fixture results stay unchanged. Disproof: typecheck still fails or absent proof is accepted. Run server typecheck and S3 alone, then finish the full gate. Result HIT (2026-10-13 19:00 PDT): all five typecheck targets PASS; S3 PASS 9 adapter cases plus the isolated cross-repo case. The sealed command must set `Q0_QUEUE_MODULE` after `scripts/sealed.sh` (its parent environment is intentionally discarded).

Full gate (2026-10-13 19:10 PDT, rebased on mine aa3c26e3): protocol, typecheck, lint and prettier PASS; unit tests 5267 PASS, 1 FAIL. The one failure, `systemd-install`, was only this fresh worktree's missing `dist/` (check.sh runs the tests before it builds). After `npm run build`: that file PASS 30/30, build PASS, real-PTY suites PASS 74/74.

### H-ROLES-Q0-1e — session-line match anchored (before correction)

Wrong: found in review before landing. `lineKind` matched `"type":"session"` anywhere in a line's first 512 bytes, and checked it before the old kinds. A tldr, queue, user or reply line holding a real nested `{"type":"session"}` object in that window would become a session line and be dropped. Not seen in real data, but it breaks the promise that every other line keeps its old classification.

One change: only a line that starts with the native header's own bytes, `{"type":"session"`, is a session line. Every other line goes through the old checks unchanged, so the patch only adds a kind for lines that were ignored before.

Expected: new fixed `lineKind` cases pass (the header is a session line; a nested session object leaves a queue, tldr, user or reply line its old kind), and they fail on the unanchored code; the Q0 regression block and the whole Roles reader file still pass. Disproof: the nested case is still misclassified, the header is no longer found (the Q0 running assertions fail), or any old test changes. Result HIT (2026-10-13 19:15 PDT): the new fixed case fails before anchoring (`expected 'session' to be 'queue'`); after anchoring the entire reader file passes 26/26, including the real tool and reset cases. Final landing and gate receipts: `/home/shinelay/company-lab/shared/roles-queue-q0-2026-10-13/RESULT.md`.

## Consumer interface

### Canonical add-on projection (pi-queue)

`queue-projection.ts` exports `projectQueue(source, expectedBinding, runtime?, period?)`. It is not imported by the add-on's entry point, `queue.ts`, or `source.ts`.

- `source.entries`: the complete current **root-to-leaf branch** supplied by the canonical session manager, not a chronological JSONL scan. Its own `applyOp` produces the queue state.
- `source.binding` and `expectedBinding`: exact `{queueId, sessionId, sessionEpoch, branchId, homeRevision}`. Queue ID is the native session ID; epoch/branch/home revision must come from native binding, never a path, timestamp, task label or caller/model assertion. An absent/mismatched binding returns unknown, not a default capacity.
- `source.children`: the native assigned-child binding index, each exact task tuple plus opaque chat reference, child session ID and child epoch. Absence/ambiguity stays unknown, even when a runtime says idle. It cannot be reconstructed from old task labels. A lane started without a canonical chat reference stays unknown.
- `runtime`: an exhaustive, uncapped current inventory at the exact projection revision and binding, no older than the queue source observation. It must enumerate every started/terminal chat, including idle/closed. A eight-chat Roles tail is not this inventory. Any stale key, wrong child epoch/chat, missing/extra/duplicate worker or coverage gap gives null working/free. Runtime idle is not a working record. Home busy is a separate field and never occupies a task lane unless the canonical in-home task is actually working.
- Task key: the queue binding plus `{taskId, planRevision}`. Revision 1 is the canonical add; each accepted plan update increments the branch-local ordinal. Source-guarded updates remain immutable. This read-only projection metadata is **not** a receipt, approval, origin or new queue operation.
- Complete `index` and all eight per-status `counts` are uncapped. Display alone caps pending at 200 and recent done at 20; done rows older than 30 days are excluded from that display. Totals and every native key/status survive both caps. Optional explicit period counts refer to retained native done entries, never a lifetime total or installed/live feature.
- Requested, launch and current selected profiles are separate; selected is native runtime metadata, never proof a model executed. Existing times, holds, initiative, touches and dependencies are preserved as display metadata. Outside queue references are opaque native file-reference hashes, not guessed queue IDs or feature-live gates.

### C0 adapter (pi-web-ui)

`server/roles-queue.ts` exports `rolesQueueSnapshot(input, nativeEnvelope, options?)`, default **off**. No production file imports it, no instance/producer is registered, and even an explicit call does not append or mutate anything.

It consumes the I-QUEUE metadata subset structurally, without a build/deployment-path dependency on another repository. Full totals go into C0's bounded `queue-snapshot`; task rows remain in I-QUEUE. The event exports no plan/question/prompt body or chat path. Partial coverage uses explicit unknown/null counts rather than zero or a capped total. Bad counts/free-slot arithmetic are rejected. The C0 validator enforces envelope, issuer, lineage, version and namespace.

The prospective integrator must supply admitted native source/issuer/outbox qualification. **T02 (atomic outbox) and T05 (native issuer registry) remain absent here**, as in #136. No native capability is minted. Fixture capability is synthetic only and cannot certify `rtpi-native`. This deliverable does not claim native capture or UI activation.

## Sole existing-reader correction

Label `roles-queue-id`: the incremental transcript scanner retains the first native session header's ID, resets it with a rewritten/replaced file, and passes it to `taskQueueFromEntries`. It ignores a second session-like line. Headerless legacy keeps unbound replay behaviour and does not guess an ID. Bound foreign runs/autonomy remain rejected by the existing mirror.

Existing chronological scanner behaviour, old DTO/protocol, active/queued caps, scheduling and page layout are otherwise unchanged. The correction can reach the tool/page only through a later separately approved pi-web-ui install. None is done by #137.

## Stages and undo

- S1/S2: pi-queue `node --test tests/projection.test.ts`, with canonical replay as the oracle and unchanged legacy queue suites.
- S3: sealed pi-web-ui `tests/unit/roles-queue.test.ts`; the cross-repo fixed case uses `scripts/sealed.sh env Q0_QUEUE_MODULE=/absolute/queue-projection.ts node_modules/.bin/vitest run tests/unit/roles-queue.test.ts` before queue landing (after landing it defaults to the sibling pi-queue repository). No live chat, SDK or model is loaded.
- S4: sealed `tests/unit/roles-overview.test.ts` block **Q0 bound queue caller regression**, including the actual `makeRolesOverviewTool` caller on synthetic files. Restore the exact old `server/roles-overview.ts` bytes in the owned worktree for the single counterfactual; its bool assertion must fail. Restore the new bytes and run the fixed stages. No live replay repair.
- Normal gates: pi-queue `npm test`; pi-web-ui `TZ=UTC scripts/check.sh`; normal `wt land` checks, queue first then web.

Undo the additive projection commits to remove the future seams: no existing queue records, settings or stores change. The adapter defaults off and its explicit disable writes nothing. Separately revert `roles-queue-id` to restore the old incorrect output only; it cannot resume, cancel or resend work. Old readers ignore these unregistered modules. No migration or inverse-record rewrite is needed.

C0's source pins describe its accepted baseline, not these new bytes. The later integrator must explicitly repin/qualify the corrected reader and new modules; a source-hash drift is not silently turned into acceptance. `#136`'s schemas and core remain unchanged.
