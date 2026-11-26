# Ops #1103: Architecture's role-message hourly cap 40 -> 100 for 24 hours, reverting by itself

Owner Shine via COO (`rm-3b189c22`, 2026-11-26): "unblock architecture communication limit to 100 temporarily",
back to 40 an hour after 24 hours.

## Hypothesis (rule 14)

- **Problem and evidence:** `~/.pi-web-ui/role-messages.json` showed `architecture` with 40 sends in the last 60
  minutes, so every further `message_role` was refused with "(the limit is 40)". The cause is the rolling-hour rate
  cap (`ordinary.acceptedPerOrigin = 40`), not the 12-hop chain cap. The cap is one constant for every role; the
  only way to change it was a code change and deploy for all roles, with a second deploy to undo it.
- **One change:** one optional, time-boxed, per-role file `<dataDir>/role-message-hourly-overrides.json`
  (`{ "v": 1, "overrides": { "<role>": { "acceptedPerOrigin": 1..500, "expiresAt": <epoch ms>, "reason": "..." } } }`,
  mode `0600`), read by `roleMessagesHourlyLimitFor` in `server/role-message-limits.ts`. All three hourly checks
  (native store, approval host, approval core; the core's rollback mode keeps its own 20) take their number and their
  refusal text from it. The override applies while `now < expiresAt`; at or after `expiresAt`, or when the file is
  missing, malformed, out of range or readable/writable by others, the policy's 40 applies again. Ops and Temper stay
  exempt. Sealed runs resolve the file under their own temp data dir, never the live one.
- **Expected + measurement:** `tests/unit/role-message-hourly-override.test.ts`: with an active 100 override,
  `architecture` sends 100 in an hour and the 101st is refused naming "(the limit is 100)"; at `expiresAt` the next
  send is refused naming "(the limit is 40)" with no restart or edit; `backend`, `frontend` and `coo` stay at 40;
  `ops`/`temper` stay exempt; rollback mode stays 20; bad files fall back to 40. Red on the base, green after. Live:
  the file is written after the deploy with `expiresAt = live + 24 h`; a one-shot scheduled job checks the revert and
  removes the file after `expiresAt`.
- **Wrong if:** any other role's cap moves, the chain cap moves, the 101st Architecture send in an hour goes
  through, or a send after `expiresAt` is still allowed past 40.
- **Undo:** `rm ~/.pi-web-ui/role-message-hourly-overrides.json` (takes effect on the next send, no restart).
