# Roles answers: restrict extension dialogs after the first release

## Scope and sequence

Ops is the accountable lead. The owner first asked for the existing answer feature to be released and then for its permission-filter issue to be fixed (2026-10-17: “release it first then fix the issue”). The first release, `ecf28ad4`, went live at 21:21 PDT; all deployment checks passed. A look-only check saw an enabled Answer button without opening or answering a real ask. Two other snapshots showed the existing incomplete-status fallback, correctly offering only Open chat.

This is the separate follow-up. It does not change the supplied Roles layout, answer dialog, owner authority, receipt path, or the original-chat answer surface. No real prompt is answered by an agent.

## H-ROLES-ANSWER-FILTER-1

**Wrong / evidence.** Security's `REVIEW-f04ec33b.md` B1 found that extension permission, trust, sampling, budget and deletion prompts all arrive as generic `dialog` asks. The first release intentionally allowed them, by the owner's explicit release-first choice. Merely excluding built-in `approval` asks does not exclude those extension prompts.

**One change / reason.** Apply one shared kind/title policy both when exposing an Answer target and when opening or submitting the actual form. Ordinary `question` asks and eligible owner-`stuck` asks retain the existing checks. Generic dialogs are permitted only with the exact native queue-plan titles `Add to the queue?` or `Change task #N?` (positive decimal task number, no padding or extra characters). Other generic dialogs remain listed with Open chat only. A complete-string comparison rejects a trailing newline rather than relying on JavaScript `$` alone.

This is the bounded title allow-list recommended in Security B1, not producer authentication. A same-user extension that deliberately uses a queue-plan title is not distinguished by this filter; there is no producer tag in the current Ask type. The existing same-user trust boundary and all shape, context, membership, revision and explicit-owner-submit checks remain.

**Expected / measurement.** Known permission, trust, sampling, budget and deletion dialog cases, unknown titles and near-matches get no Answer target and cannot be opened or submitted through a forged/stale target. Native add/change plan dialogs and ordinary questions still work. Test fixed cases at the shared policy, actual overview reader and real service boundary; run the existing sealed native question/task/plan browser test, full normal gate and a read-only live check. Security reviews only this delta.

**Falsifier.** Any rejected dialog still has an Answer target or reaches its handler through the Roles route, a native queue plan or ordinary question is rejected, Open chat disappears, or an answer guard is weakened.

**Result.** HIT in the fixed cases. `TZ=UTC scripts/check.sh` passed: 411 test files, 5,977 tests passed, 6 skipped, build and 74 PTY checks passed. The policy/service suite passed 56 cases and the real-overview suite passed 32. The existing sealed native-answer proof passed 17/17: question, owner-stuck task and queue-plan answers, complete context, exactly-once browser receipt, native queue acceptance, no automatic start, desktop/phone checks and no page errors. No real ask was opened or answered. Logs: `/home/shinelay/kept-from-tmp/2026-10-17/roles-answer-filter/checks/{full-check,browser}.log`. Security delta review and post-install look-only check remain pending.

## Undo

Revert this one follow-up and install through `pi-web-deploy`. That restores the explicitly authorised first-release dialog scope, not an automatic approval capability. A safer emergency fallback is the existing original-chat route; no chat or decision file needs editing.
