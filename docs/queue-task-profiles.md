# Queue task launch profiles

The desktop and phone Queue panels have compact **Defaults** controls. All defaults begin at
**Inherit**. Expand an unstarted task to edit its **Task override** fields. Each field can independently
return to Inherit. Effective model, thinking and speed show `task`, `queue` or `app` as their source.

## Precedence and launch

Task override > explicit queue default > existing app selection, independently for each field.
Unset model retains pi-queue's `taskModel=default/same` compatibility. For the default route, the global
model wins, then the remembered folder model, then SDK selection. Unset thinking uses the selected
model's own saved thinking preference, then the global thinking preference. Unset speed is Standard,
never a parent chat's Fast/Ultrafast selection.

Defaults affect every **unstarted** task, not just newly added plans. Defaults/task patches are
session-fenced operations in the existing queue transcript; omission retains a field, `null` clears
it. Forks, other queues and assigned task chats cannot apply another queue's defaults.

Dispatch synchronously freezes an independently resolved profile in the `start` operation. A guarded,
one-use preparation callback records the actual initial model/thinking/requested speed (`prepared`)
before the child's first prompt. The assigned child's queue entry stores that same launch snapshot.
Concurrent edits cannot race that snapshot, and stale callbacks cannot attach to a new dispatch.
Failed, never-started launches can requeue; correcting defaults or overrides clears the visible error.

The actual SDK catalog, thinking-level helper and existing speed-capability helper validate configured
choices. An unavailable model or unsupported explicit thinking/speed blocks launch visibly; it does
not silently select another setting. Inherited app selection retains its existing fallback behavior.
Fast/Ultrafast are available only where the normal chat controls support them, not for Claude or an
arbitrary provider. The UI preserves incompatible saved choices so the owner can correct them.

## Started tasks and provider behavior

Already-started tasks are read-only in these editors, including paused/stuck/on-hold tasks. Their chat
link leads to the ordinary model/thinking/speed controls. Resumes, reloads and server restarts never
install a newer queue default in a task's existing session.

**Requested launch** remains distinct from **Current chat** settings in task details. Ordinary
account/model rotation and the speed implementation's real refusal/cooldown handling remain unchanged.
A requested tier is not evidence that the provider accepted it.

Profiles target tasks with their own pi-web-ui chats. Explicit settings on CLI/lanes-off/legacy in-chat
execution fail clearly instead of mutating the parent or ignoring the choices.

## Authority and compatibility

Only the authenticated owner panel can change queue defaults, using short-lived one-use capabilities
bound to conversation/session and, for task edits, an unstarted task. Public queue commands and tools
cannot mint them. `queue_add` accepts optional per-task `model`, `thinking`, `speed` proposals under
normal plan approval/Auto approve restrictions. Approval and update dialogs show effective choices
and changes. Async approval revalidates queue defaults, task state and session before writing.

Old queues/tasks remain readable. No default is installed by upgrading this feature, and installation
changes no global model, real queue flags/defaults or existing task sessions. Protocol version 38
mirrors the new optional profile/launch fields. `@earendil-works/pi-ai` matches bundled SDK 0.87.1 and
provides its public thinking capability helpers; no account-rotation code changes.

## Verification

`pi-queue` unit and RPC fixtures, app unit/gate/build checks and the sealed browser suite cover
inheritance/clear, default propagation, frozen launches/resumes, legacy/fork replay, owner capabilities,
async approval/dispatch races, unsupported combinations and simulated first-request ordering.
`tests/queue-profiles-test.mjs` uses isolated HOME/data, fake local provider keys, a fail-closed endpoint
and stub children, asserts zero provider requests, and exercises desktop/phone/320px layouts.
`PI_QUEUE_PKG` selects the matching add-on checkout; `PI_TEST_APP_REPO` selects an installed app artifact;
`QUEUE_PROFILES_SHOTS` keeps panel screenshot evidence. It never uses real queues/chats.
