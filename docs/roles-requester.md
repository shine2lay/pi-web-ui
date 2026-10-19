# Roles: recorded task requester inputs

## H-ROLES-REQUESTER-1

**Wrong and evidence.** The Roles panel has a fixed “requester not recorded” label. Queue add operations keep plan consent and optional source-owned identity, but neither is evidence of who initiated the work. The host knows the accepted inputs of an active turn and discards that metadata at settlement. Architecture's source audit is `roles-data-steps-2026-10-17.md` (2026-10-17).

**One change and why.** Preserve a bounded, display-only snapshot of the turn's accepted input origins on each new ordinary queue add. Capture it from the optional trusted host before awaiting plan approval, not from tool arguments or plan text. Project the recorded inputs onto the existing task-source labels. Owner browser/Telegram admission and exact-target, hash-checked role deliveries are supported. Other automation, unsupported delivery kinds, missing records and restarts remain unknown. This supplies facts already known to the host without language inference or a model call.

**Meaning.** An input-origin record identifies the accepted inputs present when the task was proposed. It does not prove that each input requested that particular task, or that anybody approved its plan. The display says “From” and preserves every distinct input, including an unknown marker for an unclassified input. It is not an authority, routing, budget, source-ownership or own-work classifier. Old tasks are not backfilled. An existing task's original snapshot is not overwritten by a plan edit.

**Expected and measured.** Sealed fixed cases show owner browser/Telegram inputs, verified role requests and owner-relay attribution. Merged inputs remain a list. A missing host, pseudo client, unverified/misdirected role message, restart, malformed/oversized record or old task never becomes “you”. Queue replay and the UI mirror agree. Approval, launch, routing and permissions are unchanged.

**Falsifier.** Any guessed requester, model-supplied origin, incomplete list presented as complete, source id/path exposed as display text, rewritten old origin, or changed queue action/approval disproves the hypothesis.

## Scope and rollout

- Optional v1 record; older extensions/hosts and command-line Pi keep working without it.
- Metadata only: channel, opaque input id and role/message reference. No input text or chat body is copied into the new record.
- At most 32 distinct inputs; overflow removes attribution for that turn instead of silently truncating it.
- Keep `queue-origin.ts`, `roles-origin*` and their old policy/tracking gates inert.
- The owner requested minimal checks: a focused deterministic regression pass, build, required landing checks, then one read-only smoke. No new end-to-end model trial.
- Land queue and UI compatibility changes together before restarting the app. Notify Temper/Security before the UI restart while the requested helper window is active.
- Undo: revert these patches and deploy the preceding build; the optional historical metadata may remain but has no effect on queue behavior.

## Result

Sealed checks HIT (2026-10-18): pi-queue suite 367/367 including the new add/replay/consent fixture; pi-web-ui build plus `queue-requester`, `role-replies`, `queue-host` and `roles-task-next` tests 78/78. Admitted owner and role inputs are recorded, pseudo clients and unknown inputs show "Not recorded", overflow records nothing, edits keep the original, and display text carries no ids. Follow-up deliveries now derive the same admitted requester as prompt deliveries. Live result: only tasks added after install carry a requester; older tasks keep "Not recorded". No live task has been changed or used as a test.

Restarts (H-ROLES-TRACKER-2 in `docs/roles-tracker.md`, Ops #236): a turn a restart cuts off is carried on with its saved requester inputs, so a task queued in the carry-on turn names who asked (#214 and #215 showed "Not recorded"). The carry-on note itself still never becomes "you": without saved inputs it stays unknown.
