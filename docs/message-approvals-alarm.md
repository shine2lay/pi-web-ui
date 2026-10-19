# Message approvals: an alarm when they're off (H-LADDER-ALARM-1)

Ops #242, project message-approvals (owner 2026-10-18, picked "Fresh start + alarm"; this is the alarm part:
"it shows in the log and on the Roles page instead of staying silent"). It runs beside #241, the fresh start.
Accountable lead: Ops. Patch `ladder-alarm` (PATCHES.md); agent-tools carries the deploy-output part.

## Hypothesis

**Wrong, and the evidence.** The approval step for long chains between roles (messages 1-6 free, 7-11 need
the COO's grant, 12+ the owner's) has been off since 2026-10-14 06:43. Every server start logs
`approval ladder UNAVAILABLE (recover: legacy writer divergence; refusing stale snapshot overwrite): sends use
the native depth-6 rule; no approvals`, and nobody noticed until #233 read the log on 10-18, 4.5 days later.
Dozens of installs passed pi-web-deploy's log check, because agent-tools `lib/pi-web-check.mjs` `checkLog`
flags only errors. The Roles overview (`UiRolesOverview`, `server/protocol.ts`) has no field for it, so the
page showed nothing.

**One change, and why it should fix it.** Show the step's own state (`RoleMessageGuardHost.state`, only read)
in the two places people look:

- the Roles page's floating header: an amber chip "Message approvals off" right before the status pill
  (the stale pill's colours: #1D1A12 / #4D3F1F / #F0B95A), its tooltip "Chains between roles stop at 6
  messages and nobody can approve more. Reason: <reason>. Off since this server started at <time>.";
- pi-web-deploy: the log check keeps its status and adds a note "message approvals are off (<reason>)" when
  the new server's log has the UNAVAILABLE line; the deploy output and `pi-web-deploy status` print it as
  `note: ...`.

Shown only when the step is "degraded". No banner and no new row (the owner removed both earlier); the
pill's behaviour is unchanged; the note never fails a check, rolls back, posts to Slack or changes an
exit code.

**Expected result, and how it is measured.** In sealed tests the chip and the note appear for "degraded"
and not for "ready", "starting" or absent, and the log check's status and pi-web-deploy's exit code are
unchanged. Live, after the install, both match the live start log's "approval ladder" line: shown while
it says UNAVAILABLE, hidden once it says "on".

**What would prove it wrong.** The chip or the note shows while approvals are on; either is missing while
they're off; or any deploy fails, rolls back or changes its exit code because of it.

## Result

**HIT** (2026-10-18), for the "off" side live and both sides in tests.

- **Tests.** Sealed focused tests pass: pi-web-ui 191/191 (`roles-overview`, `roles-exact`, `roles-u0`,
  `roles-overview-tool`, `roles-view`: the overview's `approvals` for degraded, ready and absent; the chip
  shown or hidden, its tooltip), agent-tools 63/63 (`test/pi-web-check.test.mjs`: logs with and without the
  line; the check still passes, no rollback, same exit code, Slack text unchanged). Both land gates passed:
  pi-web-ui `e2b26783` (land 57-d86e1d), agent-tools `3e1412a` (land 17-a63714).
- **Deploy.** `pi-web-deploy e2b26783 --reason "message approvals alarm"` went in at 21:18; all five checks
  passed, no rollback, `pi-web-deploy result e2b26783` = 0. Approvals were still off at that start (#241
  wasn't in yet): the start log at 21:19:18 says `approval ladder UNAVAILABLE (recover: legacy writer
  divergence; refusing stale snapshot overwrite)`. The deploy output prints, right after `✓ log: no new
  errors`, `note: message approvals are off (recover: legacy writer divergence; refusing stale snapshot
  overwrite)`, and `pi-web-deploy status` prints the same note under the last result. The Slack message
  is the usual install message, without the note.
- **Roles header** (look only, own clients that send nothing but `hello` and `roles_watch`; desktop dark
  and light at 1400x1000, phone dark at 390x844): one chip "Message approvals off" right before the pill,
  amber rgb(29, 26, 18) / rgb(77, 63, 31) / rgb(240, 185, 90), contrast 9.76. Its tooltip is the agreed
  sentence with the log's reason and "21:18", and it appeared under the real pointer in a headful browser.
  The overview carried `approvals: {on: false, reason: <the log's reason>, since: <the service's start>}`.
  The pill is unchanged (one button in one `role=status`, its tooltip as before); no banner; nothing
  scrolls sideways; axe finds nothing serious on the chip; no page errors. The server and its ladder line
  were the same before and after the look.
- **Not yet seen live:** the "on" side (no chip, no note). Approvals are still off, so it gets its live
  proof when #241 turns them on; until then the sealed tests cover it.
- **Side effect on phones:** at 390 px the pill already fills the header's width, so the chip wraps onto a
  line of its own above it, and the header is about 42 px taller while approvals are off. On desktop the
  chip shares the pill's line (both 32 px tall), so the header keeps its height.

Evidence: `/home/shinelay/kept-from-tmp/2026-10-18/ladder-alarm-live/look-1` (`result.json`, header shots,
`chip-tooltip.png`), made by `look.mjs` and `run.sh` in the folder above it.
