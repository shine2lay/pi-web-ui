# Lead compaction: joined native lifecycle

## Scope and hypothesis

Ops1159 joins the H native admission owner, E off-thread canonical executor and T scheduler.
One host owns each native source. The add-on's replaced synchronous v2 turn-end orchestrator
is removed in the paired OpenViking release; the canonical handoff planner/archive implementation,
v1 paths and worker hooks remain. Never activate both orchestration paths.

Hypothesis: off-thread preparation/archive plus native same-manager commit allows eligible
lead homes to catch up without inference or starving HTTP. A timeout, unarchived cut, accepted
drift, duplicate input/cut or changed current work disproves it. Source gates are not installed proof.

## Runtime ownership

`server/lead-compaction-integration.ts` resolves the trusted staged add-on through the existing
bundle resolver and obtains configuration from its canonical path readers. No request supplies
a path, ticket, authority or executor module. The web host uses the existing admission singleton.
`server/lead-compaction-checks.ts` joins prepare, frozen-plan resume and native apply. The host
owns durable acknowledgement. Native recovery is awaited before another preparation; failures
retain the home hold. Successful reopen alone is never reported as an applied cut.

A recovery preflight is registered before clients are accepted; canonical homes with a durable
unfinished sparse application cannot open/admit input until that same application is reconciled.
Normal scheduling consumes native `agent_settled`, successful home-open and the existing quiesce-aware maintenance cadence.
No second timer or durable status store is introduced. Shutdown detaches and closes the worker
before disposing native sessions. The scheduler launches homes independently and coalesces
same-home checks; retries occur on later lifecycle events, not an internal spin loop.

`GET /api/busy` includes `leadCompaction` for the native engine: enabled, optional machine-only
startup error and sanitized per-home snapshots. This existing authenticated diagnostic surface
is not public health and contains no transcript or model request. Same-attempt E measurements
survive H's final native receipt; a new attempt clears previous measurements. Errors remain
visible without a model turn. A startup failure does not claim activation.

## Preservation and limits

Routine protected entries, prior fold notes, latest user/work/checkpoint and complete tool groups
remain protected. No emergency or worker archive authority is added. Cold checkpoints are derived
from the newest retained real native assistant and all following real tool-result IDs, then frozen
in the canonical plan; hints never override native facts. No real/unique checkpoint still refuses.
Sparse application reuses §4g selection, not the rolled-back synchronous raw-run coordinator.

The first completed large-copy component used authorized historical 92,684,261-byte Frontend
and 50,516,119-byte Backend captures concurrently, plus three growth/reopen cycles. Original
hashes/stats remained unchanged. Both reported unavailable-checkpoint floors, with zero archives,
native cuts or model calls. Initial estimates were 1,029,662 and 1,222,724 respectively;
these are projection estimates, not provider-token measurements or recovered contexts.

The external component recorded zero 10-second health/15-second page timeouts, maximum health
gap 2,999.113187 ms and event-loop maximum 552.075263 ms. It did not exercise a native pair,
application-serving-during-compaction, browser/socket behavior, or installed trigger wiring.
These measurements are NOT full A6 or installed reliability. The first import-stage attempt
failed missing dependencies; its receipt remains alongside the subsequent component evidence.

## Sparse archive and native application

A typed sparse plan shares the canonical append-only handoff journal with prefix plans. Every selected
ordinary run gets its canonical frozen fold fingerprint and durable archive/readback before native
omission. Protected notices stay at their original native IDs/types/content/order; current tail and
all raw history remain. No old prefix plan is reinterpreted as sparse under its old identity.

H issues an unforgeable ticket for the full application hash. Under same-file ownership it syncs an
owned start marker, appends only exact planned context edits/archive references, syncs native progress,
and yields between operations. Ownership across awaits uses AsyncLocalStorage, never the global
internal flag. Final durable validation precedes one owning refresh and acknowledgement. Native markers
without durable acknowledgement remain startup recovery obligations, not ready state. Unknown effects
refuse. Current input waits outside native state and resumes against the recovered owner.

Fixed private E/archive/native and H cached-yield/crash/cold-open tests exercise this path. Large-case
attempt4 reached the real sparse plan but an external archive fixture lacked mkdir; zero native cuts
occurred, original captures stayed unchanged and the failure is retained. The fixture was corrected,
checked separately, and the next attempt resumes the SAME frozen private plans rather than refreezing.
No largest-real or installed success is claimed until that evidence is complete.

## Checks and rollout

Preserve frozen Ops1154 A1–A6 assertions. The external actual-host adapter must fail unsupported
cases, never fabricate observed scalars. Native SDK startup patches precede first SDK loading;
plain production-Node worker loading is separately checked from development-loader tests.
Use unit tests, sealed typecheck/format, normal worktree gates, actual joined acceptance and
real concurrent copies before installation. One QA installed blind final checks the brief,
checklist, diff and source pins independently, including the authorized next normal model call.
No production reliability claim follows from this document or isolated native tests.

## Paired release and rollback

Install the web orchestration and paired OpenViking executor/configuration/removal together
through `pi-web-deploy` with its normal canary. Do not install the add-on removal alone while
an old host is running, or activate a new host against an old add-on. Record installed bundle
hashes and the pre-install reference; a repository HEAD alone is not a loaded release.

Rollback through the canonical deployment path to the previously recorded paired release.
Stop new orchestration admissions, but preserve every archive, native append, immutable plan
and append-only attempt. Never restore a live transcript to pre-cut bytes, reset a journal,
or delete an error to make a retry pass. Pending work must remain reconcilable.
