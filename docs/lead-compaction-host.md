# Lead compaction: native host boundary (H1156)

## Scope and hypothesis

Source-only H slice of Ops1154 / Architecture611. No scheduler activation, deployment,
model inference, or production history mutation. The hypothesis is that one native file
admission domain can reject stale/busy proofs and retain incoming input through native
commit/recovery. A same-manager append/refresh is synchronous and may still be expensive:
real-size responsiveness is integration's obligation, not established by isolated fixtures.

## Canonical APIs and integration

- `server/lead-compaction-contract.ts` is the H/E/T contract (original pin `5bd38b19`).
  Tickets are WeakMap identity capabilities, never serialized client authority. Only the
  private E bridge gets `issueTicket`; no route or tool exports it.
- `createWebLeadCompactionHost(ports)` in `server/lead-compaction-runtime.ts` joins the
  SAME process-wide `nativeLeadAdmission` already used by real host runtime creation,
  manager writes, input, scan/open and runtime lifecycle. Do not construct a separate
  `LeadCompactionHost` for the web app (the separate constructor is for isolated hosts).
- `ClientSession.leadCompactionPorts(acknowledge, coldApply, verifySource)` supplies real
  cached-conversation busy checks, cache invalidation and owned native reconstruction.
  The existing Conversation object, home, unread/work state and pending host inputs remain.
- `coldNativeApply(config)` and `nativeSourceVerifier(config)` in
  `server/lead-compaction-cold.ts` use a dedicated worker. Config comes only from trusted
  installed paths: SDK module, OpenViking package root, existing plan journal, session root,
  identity directory and rollout-state file. No model/client-supplied paths.
- E exports `createLeadExecutor(config, host, { observation, progress })` from
  `pi-openviking/src/v2/lead-executor.ts`. Configure ports with closures referencing E's
  `acknowledge`; preserve its private draft and `details.openviking` verbatim. H adds only
  `details.leadCompaction` for exact native replay identity.
- `enumerateCanonicalHomes()` / `resolveCanonicalLeadHome()` reuse the existing identity
  registry and transcript filename reader without opening sleeping journals. Unknown or
  duplicate bindings refuse. E independently checks durable principal/root/home authority.
- `readNativeLeadObservation(source)` returns only observed native assistant/tool-result
  entry IDs. Pass it as E's optional `observation(sessionId)` callback after resolving the
  canonical source. No usage estimate or startup turn is invented. An unobserved checkpoint
  remains unavailable; E reports the explicit protected floor rather than guessing.
- I wires T's inactive lifecycle/scheduler to these capabilities and removes old synchronous
  orchestration. Do not run two schedulers. No activation belongs to this patch.

## Lifecycle and recovery

The manager wrapper covers every public append, context edit, label, branch and source
replacement. Factory ownership covers asynchronous construction, and rejects cached or
opening collisions and managers read before a newer file mutation. Host input admission
advances revision before SDK work; nextTurn/custom notes are tracked until actual append
because SDK `pendingMessageCount` excludes them. Ordinary no-lock input retains the native
synchronous admission path; existing prompt-start/home-inbox wrappers still own their queues.
Runtime disposal, native switching/forking, reload, host force-reset/interrupt and scan/open
advance the same fences. No archive/network operation runs under the commit lock.

`tryApply` consumes one ticket, checks exact current generation/revision/binding/leaf, then
performs the SAME live manager's `appendCompaction` and that session's public `refreshContext`
without an await between final CAS and the native pair. It invalidates canonical stats/view
caches, fsyncs the native file, and awaits E's durable acknowledgement. Incoming input waits
outside SDK state and resolves against the current session only once admission releases.

A failure after native append (or an uncertain worker result) returns
`blocked / native-recovery-required`; that file stays held from provider admission.
Integration must call `host.recover(sessionId)` before retrying normal E checks for that home.
Recovery is awaited, never a detached task. Failure stays held; unrelated files continue.
Cached recovery first checks v3/truncation through E's canonical reader off-thread, then
reopens via public SessionManager/runtime factory APIs under host ownership and rebinds
existing viewers/hooks. It does not use cached `switchSessionNow`, `reload`, forced abort,
private SDK APIs or extension switch hooks as a substitute for disk reconstruction.
Cold recovery repeats the owned worker: canonical native plan identity skips an existing
append, fsync/reopen verifies it and E records the missing acknowledgement.

A process restart discards opaque tickets; native compaction details and the existing E
append-only journal remain authoritative. E reconciles a native append before threshold
checking. A new native runtime reads the durable journal rather than inheriting a stale
projection. Malformed/truncated cold source or journal refuses instead of migrating/repairing.
The safety domain is the host's owned writers; external history edits remain prohibited.

## Checks and limits

- `tests/unit/lead-compaction-host.test.ts`: actual SDK isolated native manager/session,
  stale append/branch/binding/capability, hidden nextTurn work, same-manager prefix retention,
  held incoming input, failed refresh/reopen and another file progressing in the same domain.
- `tests/helpers/lead-compaction-host-acceptance.ts`: H portion of frozen Ops1154 external
  adapter; supports actual input-handler admission and stale generation/branch/append cases.
  Other cases throw `H_ADAPTER_INTEGRATION_REQUIRED`, never a no-coverage pass.
- `tests/helpers/lead-compaction-cold-proof.mts`: actual canonical E/archive/readback plus
  native H worker; cold append/replay, opening collision, lost acknowledgement, selected-byte
  drift and a subprocess killed after native append before acknowledgement.
- The external cold harness uses `PI_OPENVIKING_ROOT` (default sibling `pi-openviking`) and
  E's external temporary fixture/fake archive transport. It never imports fixtures into prod.
- `nativePairMilliseconds(source)` is the measured cached synchronous span, including exact
  replay lookup, native append and refresh. It is not a full-source benchmark or HTTP proof.
- Initial RED was a missing-host-module failure (one failed suite, zero executed tests).
  Do not describe that baseline as behavioral coverage. Final receipts record actual results.

Use sealed typecheck/format and normal `wt check` / landing gates. Frozen Ops1154 assertions
and worker ACP code are untouched. Full A1–A6 combined proof, largest authorized real copies,
installed next-model-call and ONE blind QA final remain I/Q responsibilities.

## Rollback

No restart is performed by H. Before later activation I records the previously installed web
ref with `pi-web-deploy status`. Roll back orchestration/source by reverting this patch and
installing the chosen prior ref with `pi-web-deploy <ref> --reason 'lead compaction rollback'`
(or the deployment tool's rollback command). Never delete archives, native compaction entries,
immutable plans or append-only attempts, and never reset a source to pre-compaction bytes.
