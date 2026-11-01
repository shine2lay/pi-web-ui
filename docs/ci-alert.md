# CI alerts to a role's home chat

A script on spark can report a failed CI run or a scheduled run that never appeared through the app's control socket. The server checks the fields, writes the message, and delivers it as **the CI watch**. This is not `role_report`; the automatic 6 am report job stays off.

## Contract

Send one JSON line to the control socket. Its path is given by `controlPath(dataDir, port)` in `server/control-socket.ts`; on spark the data directory is `~/.pi-web-ui`. Read `app-token` in that directory without printing it. Do not put the token in command arguments, logs or saved examples.

```json
{
  "cmd": "ci_alert",
  "token": "<app token>",
  "role": "ops",
  "alert": {
    "kind": "failed",
    "repo": "shine2lay/rollcall",
    "workflow": "ci",
    "runId": "41277155657",
    "url": "https://github.com/shine2lay/rollcall/actions/runs/41277155657",
    "sha": "0123456789abcdef0123456789abcdef01234567",
    "jobs": ["backend"],
    "conclusion": "cancelled",
    "cancelReason": "time-limit",
    "limitMinutes": 40,
    "event": "workflow_dispatch"
  }
}
```

A missed scheduled run instead has:

```json
{
  "kind": "missing",
  "repo": "shine2lay/rollcall",
  "workflow": "ci",
  "slot": "2026-11-01T06:00:00Z"
}
```

The answer is one JSON line:

```json
{"ok":true,"id":"rm-12345678","duplicate":false}
```

The same key again returns the **first** record's id with `duplicate: true`, without sending again. A refusal is `{"ok":false,"error":"<reason>"}`. Success acknowledges a durable queued record, not that the receiving chat has already finished its work.

## Checked fields

Only `cmd`, `token`, `role` and `alert` are command fields. No free-text field, logs, test output, branch, or arbitrary extra keys are accepted.

- `role`: an existing role with a home chat. Role lookup trims and lowercases the id, as the existing app-report senders do.
- `kind`: `failed` or `missing`.
- `repo`: `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
- `workflow`: 1–100 characters from `[A-Za-z0-9 _./()-]`.
- `runId`: required for `failed`; 1–64 characters from `[A-Za-z0-9._:-]`. A local full-suite run may use a nonnumeric id.
- `url`: optional for `failed`; exactly `https://github.com/<repo>/actions/runs/<digits>` for the checked repo, with no query, fragment or trailing path.
- `sha`: optional for `failed`; exactly 40 hex characters, stored lowercase and shown as seven characters.
- `jobs`: optional for `failed`; at most 15 names. A name is 1–80 characters from `[A-Za-z0-9 _.:/()\[\],-]`. Unsafe names are replaced by `(name not shown)`, not interpreted as headers or instructions.
- `slot`: required for `missing`; a real ISO timestamp with a timezone. It is normalised to UTC for the message and dedupe key.
- `conclusion`: optional, only with `failed`; `failure`, `timed_out`, `startup_failure` or `cancelled`. Absent means `failure`, not `null`.
- `cancelReason`: optional, only with conclusion `cancelled`; `time-limit`, `by-hand` or `unknown`. Absent means `unknown`.
- `limitMinutes`: optional, only with `cancelReason: "time-limit"`; an integer from 1 to 1440.
- `event`: optional; `schedule` or `workflow_dispatch`.

Unknown enum values, wrong types, extra fields and bad combinations are refused. There are no new rate caps or quotas. The existing control socket's framing and transport limits are unchanged.

## What reaches the chat

The example's body is:

> CI watch: shine2lay/rollcall ci, manual run 41277155657 on commit 0123456 was cut off by its 40-min time limit. Jobs not finished: backend. https://github.com/shine2lay/rollcall/actions/runs/41277155657

`event: "schedule"` says **nightly run**, `workflow_dispatch` says **manual run**, and an absent event says **run**. No branch is inferred: the schema has no branch field. Other endings are **failed**, **timed out**, **failed to start**, **was cancelled by hand**, and **was cancelled (no reason given)**. A time-limit cancellation without minutes says **was cut off by its time limit**.

A missing alert says which scheduled UTC slot got no run. The header names the CI watch, what happened, the repo and the workflow. The hint asks the receiving chat to use its tools to open the run, find the failing tests and fix or queue the fix; for a missing run, check the schedule and whether the workflow is turned on. It asks for no reply and reuses the work check's `statusHint("poke")`: one status line, no narration or summary.

The record is `kind: "report"`, from `{role:"app", title:"the CI watch", chat:"CI watch", file:""}`, with chain 1. It bypasses the role-message caps and guards, just like the other app reports, and never goes to Telegram. It waits until any running turn settles, starts a turn in the home chat, and uses the existing delivery retries. Existing pauses still apply. A reply to an alert is refused; act with tools instead.

## Dedupe and persistence

Keys are global across roles:

- Failed: `repo:workflow:runId`.
- Missing: `repo:workflow:missing:slot`, using the normalised UTC timestamp.

Changing jobs, SHA, conclusion or the recipient does not create a new alert for the same key. Validation and role/home lookup still run before duplicate lookup. The `ci` record field stores the key and the checked kind/repo/workflow/runId/sha/slot/conclusion/cancelReason/limitMinutes/event fields that were supplied or defaulted. Text is built by the server, not taken from the caller.

Dedupe survives restarts and applies while the record exists. The existing record rotation keeps reports for at least nine days, and waiting messages are not rotated out; it is not a permanent run-id archive. A watcher should also keep its own delivery state. Never edit `role-messages.json` by hand.

## Implementation and checks

- `server/ci-alert.ts`: pure validation, key, body, header words and hint.
- `server/role-messages.ts`: `requestCiAlert`, shared `appReportRole`/`addAppReport` with `requestPoke` and `requestStall`, persistent key lookup, stamps and refusal of replies.
- `server/control-socket.ts`: `ci_alert` and the shared app-token check; thin methods in `server/agent-service.ts` and `server/index.ts`'s engine interface.
- `server/protocol.ts`, `web/src/role-message-text.ts`, the existing message card/row and i18n: label a CI alert as the CI watch, not a 6 am report.
- `tests/unit/ci-alert.test.ts`: allowed fields, refusal cases, safe job names, all conclusions/reasons, text and key.
- `tests/unit/ci-alert-route.test.ts`: temporary store and fake host; socket token refusals, delivery, dedupe/restart, no-reply and app-report regression checks. No real chat or model.

## H-CI-ALERT-ROUTE

**Problem and evidence:** scripts have no supported way to reach a role's home chat about failed or missing CI. The only existing control-socket report command is `role_report`, for the 6 am job which is off.

**Change:** a token-checked, fixed-field, deduplicated `ci_alert` command on the existing app-report path, not another sender.

**Expected and measured by:** one record per key; it starts a turn in the role's home chat; repeating it returns the first id; bad fields and missing/wrong token are refused. Unit and sealed landing checks, then one permitted live alert to Ops and an identical duplicate request.

**Wrong if:** a second record appears for the same key, unchecked caller text reaches the chat, or no turn starts.

**Pre-land review hypothesis H-CI-ALERT-CHECKS:** the initial 32-case suite missed malformed role objects, long allowed fields, impossible calendar dates and shared delivery/display edges. The review found that string-coercing a role can throw, a header can lose checked fields, and validation differs from the agreed schema. Correct the CI variant's checks and use the existing report/quiet-turn paths consistently, with regression cases for each finding. Expected: all agreed fields survive unchanged except documented normalisation, bad values refuse without throwing, and CI turns stay quiet and off Telegram even after a busy turn. Wrong if any new case reproduces the defect. **HIT:** the corrected focused run passed all 147 tests in nine files (including the 35 CI checks), sealed on 2026-11-01. Build, all five TypeScript projects, scoped Prettier and the PATCHES check passed. A separate sealed A/B of the same token-checked command against base `286bc3db` and the changed handler returned `unknown cmd: ci_alert` with zero service calls before, and one successful receipt after; no real chat or model was used. Its first assertion expected the wrong spelling of the existing refusal (`unknown command`); corrected to the observed exact `unknown cmd: ci_alert`, then passed. Full landing and live checks remain below.

**Landing 314-b1a233: MISS (not deployed).** On rebased commit `b03bee21`, the full selected gate reported 1 failed / 177 passed files, 2 failed / 3488 passed / 3 skipped tests. The complete failure inventory was `tests/unit/locales.test.ts`: `key 与 zh 一一对应（顺序一致）` (five new CI keys absent from the German pack, also absent from all other seven packs) and `无空 value，占位符与中文一致` (`de.roleMessageFoldCiWatch` was undefined). Protocol, PATCHES, typecheck, lint and Prettier all passed. The five later wait-check errors observed this one failed landing, not five test runs. Receipt retained in `wt land-status 314-b1a233` and journal unit `ops-720-ci-alert-land`.

**Corrective hypothesis H-CI-ALERT-LOCALES:** adding the five CI labels only to the English table left the eight downloadable language packs out of sync. Add those same keys with translated wording and unchanged `{title}`/`{id}` placeholders to the existing packs; do not alter delivery, validation or tests. Expected: all eight packs match the English key set and placeholders, and the normal landing gate passes. Wrong if either locale test still fails or another gate failure remains. Corrected focused checks: 4/4 locale and 3/3 notes-list tests passed sealed; build, typecheck, scoped Prettier and PATCHES passed. **HIT:** landing `315-b5cd8a` succeeded at 2026-11-01T16:48:32Z with `3fc4165d` on `mine`.

**Deploy:** `pi-web-deploy` installed `3fc4165d` at 2026-11-01 08:50 PST; `pi-web-deploy result 3fc4165d…` exit 0, "live, and the checks all passed" (server, page, reply, bigchat, log).

**Live receipt (the one permitted send):** role `ops`, kind `failed`, repo `shine2lay/pi-web-ui`, workflow `ci-alert live check`, runId `live-check-2026-11-01`, sent with node over the control socket at 2026-11-01T16:56:40Z (token read from `app-token`, never printed).

- First request: `{"ok":true,"id":"rm-595e6554","duplicate":false}`. Identical second request 0.2 s later: `{"ok":true,"id":"rm-595e6554","duplicate":true}`.
- Records with key `shine2lay/pi-web-ui:ci-alert live check:live-check-2026-11-01`: exactly 1 (`rm-595e6554`, kind report, from CI watch, to ops), state delivered, 1 send, delivered 3 s after acceptance.
- Journal: `rm-595e6554 CI watch -> ops · failed · shine2lay/pi-web-ui · ci-alert live check (…key…)`, then `the same alert again (…), not sent`, then `delivered to ops (home chat)`. The three lines carry no token.
- Turn: the alert entry landed in Ops' home chat at 16:56:42Z and an assistant turn followed at 16:57:44Z with no other user entry in between. Ops' home chat confirmed it received the fixture and treated it as the delivery check.
- Look only (`~/kept-from-tmp/2026-11-01/ops-720-live/look.mjs`, own pseudo client, sends held): the row reads "From the CI watch", the repo and the workflow, not a 6 am report; axe found nothing serious or critical in desktop dark, desktop light and phone dark; no page errors.

**Result: H-CI-ALERT-ROUTE HIT.** One record for the key, a turn started in the role's home chat, the repeat returned the first id with `duplicate: true`, and only the server's fixed text reached the chat.

**Found by the look: H-CI-ROW-PHONE.**

- *Problem and evidence:* on a 390 px phone the folded CI row overflows its button (scrollWidth > clientWidth): its kind chip "failed · shine2lay/pi-web-ui · ci-alert live c…" is cut mid-word at the row edge with no ellipsis, and the first words of the message don't show. Cause: `.rolemsg-row-kind` is `flex: none` with `white-space: nowrap`, and a CI alert's kind words (what happened, repo and workflow, up to about 200 characters) are far longer than any other row's kind.
- *Change:* let the kind chip give way with an ellipsis and take at most half the row (`flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis`), so the preview keeps room. The full words stay in the DOM and in the open card's header. Rows whose chip fits in half the row are laid out as before. (The preview keeps room on the desktop, not on the phone: see the result.)
- *Expected and measured by:* the sealed `tests/role-message-fold-test.mjs` gains a CI row and checks that no row's button overflows, in desktop dark and white and phone dark and white; it fails on the old stylesheet at phone width and passes with the change. After deploy the look-only check of `rm-595e6554` reports no overflow on the phone.
- *Wrong if:* the CI row still overflows at 390 px, or another row's kind chip is cut on the 1280 px desktop.

**Result: H-CI-ROW-PHONE HIT** on its bar, with one limit found.

- Sealed A/B of `tests/role-message-fold-test.mjs` with its new CI row: on the old stylesheet phone dark and phone white failed (row overflow 35 px, page overflow 20 px; every desktop check passed); with the change all checks passed in all four views. Landed as `aa4a6bca` (land `316-da4687`, 2026-11-01 09:49 PST).
- Deploy: `pi-web-deploy` installed `aa4a6bca` at 09:50 PST; `pi-web-deploy result aa4a6bca…` exit 0, "live, and the checks all passed".
- Live look only at `rm-595e6554` (same kit, no sends): on the 390 px phone the CI row's button overflows 0 px (35 px before) and its kind chip ends in an ellipsis at 138 px (the old row ran off the edge with no closing border). On the desktop view (1400 px window, 1196 px row) the chip is 238 px and not cut, and the preview is 652 px. Across the three folded rows in Ops' home chat: none overflows and no chip is cut on the desktop. On the phone the only cut chip is the CI row's own. axe found nothing serious or critical in desktop dark, desktop light and phone dark; no page errors.
- Limit: on the phone the CI row's preview gets 0 px, because the sender name, the chip and the turn chip fill the row; the rationale "so the preview keeps room" holds on the desktop only. Not changed further: for a CI alert the preview repeats the chip's words (what happened, repo, workflow), and the open card shows all of it. A later change that wants a preview on phone rows with long kinds needs its own hypothesis.

## Undo

Before any real records exist, revert this patch and deploy through `pi-web-deploy`. After records exist, stop the caller and forward-disable acceptance of `ci_alert` in the control handler, keeping the record types, display and existing delivery path so stored alerts retain their meaning. Existing queued alerts may still finish. Do not delete records or turn on `role_report`. Land and deploy the undo normally; it does not change role traffic, Telegram routing, caps or the 6 am job.
