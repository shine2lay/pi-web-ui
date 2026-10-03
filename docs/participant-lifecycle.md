# Passive participant lifecycle

A saved conversation and a loaded worker are different things. A plugin must not
call a saved participant “connected” merely because a history row exists. It also
must not require the owner to keep every assigned role selected in a browser.

`host.retainParticipantRoutes(source)` is an optional additive host capability,
requiring the explicit `participants` manifest permission. `source()` returns the
current owner-controlled `{sessionId, role}` bindings. The returned lease exposes
`refresh(): Promise<void>` and `dispose(): void`. Registration does not send work.

The host retains those exact loaded participants when the owner navigates away.
Refresh serially recovers missing participants from the canonical session index.
It requires a unique existing session file, a valid transcript and a matching
host-derived branch identity (or existing identity home metadata for that same
file). It never substitutes another session for the role, repairs a transcript,
rebinds a role, creates an assigned chat, prompts a model or approves execution.
Missing, ambiguous, changed-identity, corrupt and capacity-limited targets remain
disconnected. A plugin must still read `participantRoutes()` for actual readiness.

The ordinary twenty-four-open-chat limit applies per project. Concurrent browser,
project and participant session opens share an admission gate. Current bindings
and shutdown state are rechecked after loading, and a newly loaded runtime is
rolled back on failure. Recovery uses a detached internal client, does not mark
messages seen, and does not move any browser's active conversation. No new model
turn is requested. Session extensions load normally, as for a history open.

Closing an assigned worker is refused with an explanation: change its Team
assignment first. Unbinding, revoking the permission or unloading the plugin
releases retention; it does not abort an active chat or delete its saved history.
Conflicting roles for one session fail closed. Repeated refreshes coalesce and do
not endlessly prolong a slow recovery.

The Company plugin calls refresh when activated, during its existing maintenance
cycle and after authorized owner-panel actions. This host activates installed
plugins on the first UI connection, including after a restart; opening individual
role conversations is never required. These calls do not enable
collaboration, unpause the team, select a product, change resources or dispatch
work. The DSH adapter currently exposes a no-op lease rather than claiming Pi
session recovery support.

## Regression checks

- `tests/unit/participant-lifecycle.test.ts`: current bindings, concurrent refresh,
  disposal, conflicts, malformed targets, failures, permission/effect lifetime.
- `tests/participant-lifecycle-test.mjs`: real isolated Pi host, exact startup and
  restart recovery, navigation, dismissal, two-browser/cold-open races, corrupt
  and mismatched targets, capacity and disposal. A sentinel rejects attempted
  turns; fixtures contain no credentials or real conversation data.
- Existing conversation-capacity, server-owned-chats, switching and carry-on tests
  remain required because their lifecycle paths share the session-open gate.
