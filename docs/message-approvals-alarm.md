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

Not measured yet.
