# R0: task requester and explicit own-work policy (Ops #141)

Status: additive, inert; no production importer, route, instance, registration, writer or UI switch-on. This is unit R0 of the approved Roles build, not an installed Roles-page feature or native authentication implementation. The original page and all work controls are unchanged.

## H-ROLES-R0-1 (written before implementation)

Wrong / evidence: Q0 has exact task/queue keys but no admitted requester. Owner-channel text, self-proposed task approval and initiative membership cannot establish who requested a revision. O0/C0 deliberately lack native owner principal, atomic outbox and issuer registry (T03/T02/T05). Queue running/hold and budget stop are not owner own-work policy.

One change: a sealed native-source I-ORIGIN/1-to-C0 adapter, complete-open-index counts and a typed policy-only display projection, matching pi-queue's prospective origin history. No new owner declaration affordance or control.

Expected / measure: V07/V14/V15/S01/S02 fixed inputs reject wrong bindings and provenance, leave absent/legacy origins unclassified, exclude unknowns from both classes, keep future declarations from rewriting prior revisions/work, and separate policy, queue hold and budget stop. Original tests pass unchanged; cross-repo projections agree beyond 200 displayed rows.

Disproof: prose/approval becomes a request or policy; an unqualified/copy/foreign principal is accepted; a future declaration rewrites old work; running=false/hold/budget creates a policy; a caller overrides the native source; an import changes scheduling or existing behaviour.

## Origin admission and counts

`rolesNativeOriginRoot()` accepts **no arguments**. `roles-origin-native.ts` supplies the only input/capability and currently returns null. There is no options/flags/environment-injected admitter. Tests replace the module with Vitest mocks; fixture capabilities cannot mint native roots.

The future native host must authenticate the request source and any owner-forwarding chain with pi-queue's canonical checker at atomic plan commit. This adapter is not that host. Its input carries the exact I-ORIGIN/1 record, queue revision, admitted original owner principal, source envelope and C0 qualification. Record fields are closed, refs are whole, and the native commit timestamp must match the envelope. The C0 event binds request, actor, target, full Q0 tuple, source/issuer/lineage/incarnation/sequence/revision and plan operation. An owner-requested record additionally requires the exact admitted owner principal and C0 owner-principal seam. Approval/open/render receipts alone cannot supply a request.

Only the branded C0 result associated with its native key may count. Copied JSON, accepted roots from unrelated paths, wrong target/plan/time and conflicting origins are neutral. `rolesOriginCounts` uses the full complete B02/C08 canonical open index, not capped rows: ready/working/asking/stuck/waiting/blocked only. Own and requested exclude unclassified; requested splits owner/role. Missing/partial/stale/conflicting coverage yields unknown, not zero.

pi-queue `docs/queue-origin.md` specifies prospective immutable history: the same plan revision cannot be corrected in place, unknown is pinned, future corrections require a new revision, and work-time lookup cannot assign a future declaration to old costs. Neither module changes a ledger or persists/replays origins yet.

## C10: optional typed own-work policy

`rolesOwnWorkDisplay(target, {queueHold, budgetStop})` reads a native declaration or displays **Not recorded**. The closed declaration names the target role, authenticated owner, operation, effective time and paused/permitted state. Its policy ref binds those exact metadata fields to a branded, qualified C0 `policy-approved` owner action, not an ordinary plan approval or owner-opened event. No prose, Board text, instruction/body digest or new owner affordance is involved. A metadata hash is a binding, not authority.

Output has three independent facts: `ownPolicy`, `queueHold`, `budgetStop`. Running is deliberately not an input. A stopped queue does not mean own work is paused; a permitted policy does not release a hold, budget stop or dispatch permission. No requested or own work resumes.

## Native gap / no activation

T02 atomic outbox, T03 authenticated owner/request principal and T05 issuer registry are still absent. All production defaults remain unavailable / Not recorded. In accordance with Ops's existing D-MISSING decision (recorded for #139 in `roles-build-2026-10-13/SUPERSEDED.md`), these join T01–T05's single pre-switch-on package. They do not authorise an SDK change/upgrade, upstream request, body reading, source/hook/store mutation, install, restart or activation. See the shared R0 `NATIVE-SEAMS.md` proposal for primitive, isolation, consent, migration and test implications. No additional spec-only task or repeated owner question is created here.

## Checks and undo

New fixed tests cover classification/forwarding in the canonical add-on, native/fixture rejection in C0, all key fields, prospective revision/work time, independent policy/hold/stop, >200 full-index counts and static no-wiring boundaries. The old suites remain unchanged. Use `R0_QUEUE_MODULE` only in the cross-repo test before pi-queue lands; production modules read no environment override.

Normal sealed gate: `TZ=UTC scripts/check.sh`. Land pi-queue first, then pi-web-ui. There is no runtime import, so no PATCHES.md row or installation in this unit. Undo by normally reverting the additive R0 commit(s); there is no live state or migration to reverse.
