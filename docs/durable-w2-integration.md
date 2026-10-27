# Wave 2: immediate relief integration (Ops #570)

Accountable lead: Ops. Project: pi-durable-cutover.

## Scope and recorded answers

The original #570 plan combined integration with switching every chat to the durable engine.
Preparing the integration exposed a missing engine host, incomplete tool bridges and a lossy
JSONL rollback. Ops home then relayed the owner's answer (home message m73851):
“ok its your job to check the work and put them together and do wave 2, check and then wave 3”.

The owner subsequently selected **Staged rollout** in native answer `dr-2827476c6b11`,
question `task_570_rollout_sequence` (title “Task #570 rollout”): deploy the checked
current-engine fixes first, then complete SQLite as Wave 3. Ops home's native `queue_reply`
receipt confirms that answer was relayed verbatim to #570. This actual owner answer supersedes
sequencing question `k9bee77f3`; it is not inferred from a department's decision or a notebook.
Wave 2 may be verified, landed and deployed under that staged plan. It does not authorize a
premature engine/storage switch or waive any preservation, test, backup or release requirement.

The approved split is:

- **Wave 2 (#570):** integrate #563–#567, keep the pi engine and existing JSONL sessions, verify,
  land and deploy immediate freeze/reconnect fixes and the selected UI features.
- **Wave 3 (separately queued by Ops home):** DurableAgentService with the full host tool set,
  lossless rollback/dual-write, then #569's verified SQLite migration and cutover.

The settings package entry already points to `/home/shinelay/projects/billion-context-pi`.
An isolated BCP worktree builds its public durable entry successfully; the live link is unchanged.
The pi-web-ui package/lock link now resolves successfully with the unchanged host SDK, and its
isolated classic-extension check passes (31 browser assertions); controlled live artifact installation
and final integrated verification remain pending.
Neither linking nor this deploy authorizes changing any chat to the durable engine.

## Owner acceptance requirement: no data loss

Owner in Ops home, m74290: “Make sure we dont lose any data”. This is an acceptance requirement,
not evidence of success and not new migration or source-read permission.

For Wave 2, keep the current pi engine, JSONL authority and every persisted record. Verification
must cover restart/reconnect, positioned paging, draft/send-once, and cache eviction without losing
persisted history or queued/in-flight work. Reuse relevant existing test evidence, name missing
coverage explicitly, and never infer losslessness from counts, module acceptance or a build.
No real chat has been used for an experiment, and this preparation has not changed live settings,
links, storage or engines. The earlier isolated draft/browser fixture now passes its 29/31 checks;
that prior result is not proof of the new preservation lifecycle or integrated global losslessness.

Wave 3 handoff obligations, before any storage switch:

- Inventory all persisted session, branch, ACP and related state/files in the admitted scope.
- Preserve untouched originals; use a consistent offline snapshot or a proven equivalent and a
  verified restorable backup, following existing backup/security policy. Do not delete originals
  as cleanup. No live-chat experiment or broad source read is authorized by this requirement.
- Verify complete contents and relationships plus active-context meaning, not only record counts.
- Verify rollback preserves messages and state written **after** cutover as well. Reverting binaries
  or restoring only the old snapshot is insufficient; the lossless bridge/dual-write plan must
  cover those later writes and queued/in-flight work.
- If a preservation check is missing or fails, do not deploy the affected storage change. Keep the
  original store authoritative and report the exact gap and proposed in-scope repair to Ops.

The final handoff must separate measured W2 preservation results, unproved conditions, and these
remaining W3 obligations. None of the obligations above is marked met by this preparation.

## Hypothesis H-W2-RELIEF-1 (before integration)

**Evidence/problem:** billion-context-pi and marker replay repeatedly scan old entries; server
session/workspace caches and the client's late-pong handling add avoidable work and banners.
The 7-day connection-log baseline (through October 26 00:28 Pacific) records 103.1 stalls of
at least one second per hour, 206.1 stalled seconds per hour, and 4.65 banner records per hour.
The preceding 24 hours are worse (204.6 stalls/hour, 416.2 stalled seconds/hour, 5.79 banners/hour),
with high build load a confounder. A banner record alone does not prove a false reconnect.

**Change:** deploy incremental block/marker sync, bounded caches, a non-destructive WebSocket
probe, a compatible socket history tap and a ready-frame flush before SDK initialization. Mount
Tool Inspector and the selected client features without replacing the chat engine.

**Expected result/measurement:** known-input stage and integration tests pass; old pagination,
question rail, switch cache, send callbacks and host tools remain working. Compare stall count,
stalled seconds and banner reasons in equal-length windows, recording CPU load as a confounder.
Aim for at least 50% fewer >=1-second stalls at similar load, and no probe-induced reconnects
while the socket is still open. Real socket closes are counted separately.

**Falsifier:** stall rate remains within 20% of the baseline at comparable load, or open sockets
still cause reconnect banners. Do not claim SQLite's <50 ms turn-sync hypothesis was proved:
Wave 2 does not switch storage or eliminate the pi SDK's whole-context work.

## Hypothesis H-W2-PAGING-COMPAT-1 (before compatibility changes)

**Evidence/problem:** static integration review after rebasing the accepted repairs found three
cross-module gaps. The draft transport compares a conversation slot with `activeSessionId()`
(a host UUID), so a valid request is rejected. An engine fallback emits `older_messages`, bypassing
the new client's one-outstanding-request tracker; the next request can remain blocked. Finally,
applying a second character-budget cut after the pi engine computes digests/`quietLead` changes
the window start without recomputing that metadata. Same-slot session replacement also needs
fresh cached data and an echoed session UUID, not merely a conversation name.

**One compatibility change:** select the pi engine's character-budget boundary before building its
window metadata; correlate the socket transport with both slot and session, translate requested
engine fallback replies into positioned `earlier_messages`, and preserve digest/quiet metadata in
the existing client merge. Keep ordinary `load_older`, switch-cache reuse, callback ordering and
reconnect policy unchanged.

**Expected result/measurement:** fixed-input round trips through the actual server transport and
client request tracker allow two or more contiguous pages, consume each request once, reject old
session data, and keep quiet-turn/digest boundaries correct. The planned isolated browser fixture
must additionally prove ordering, scroll anchoring and typed/quoted first-binding drafts/send-once.

**Falsifier:** any valid host UUID request is refused, a second valid page cannot be requested,
old-session data is relabelled as current, metadata refers to the pre-budget window, or the browser
needs a reconnect to make paging work. No live or performance result is inferred from these checks.

## Integration boundaries

- `createHistoryTransport` wraps the raw socket sender **before** serialization/backpressure.
  It preserves the existing onSent callback, absolute `messagesStart`, delta revisions and
  switch-cache reuse. Requests beyond the tap's cached engine window fall back to `load_older`;
  the client normalizes both `earlier_messages` and `older_messages` into its existing reducer.
- `attachAfterReady` waits for the ready frame's send completion and yields one I/O turn before
  starting SDK scans. A socket closed in that gap creates no session. Existing queued-command
  replay, startup notices and attach failure handling remain in place.
- Tool Inspector policy attaches in the common session factory, before any request (not only
  on drawer opening). A single store per data directory is shared with the authenticated HTTP
  routes. Reads/updates resolve the exact open client + conversation and never create or switch
  a chat. The drawer closes on a conversation switch.
- `PI_WEB_ENGINE` stays as it was. Original session JSONL files are not migrated or rewritten.

## Open readiness requirement

W1-B (#565, landed `454dea8a`) did not initially include the session-list cache fix.
The proposed `session-parser.ts` does not exist; the actual `server/agent-service.ts`
`sessionInfosCache` retained expired full text. Repair #576 (`f17e6262`) now releases it.
The integration worktree is rebased onto that checked repair rather than duplicating it.

Ops home's final independent review accepted all five repairs: #572 `516a2266` (snapshot
ignore-path recheck), #574 `93da6aeb` (request-bound paging, provisional drafts and code-safe
chips), #575 `db0e22f1` (import-only manifests, callable loadout and fork identity), #576
`f17e6262` (expired text release), and #573 `5be6d044` (offline migration projection and identity).
This worktree now consumes those landed versions. Module acceptance is not cross-module or
browser proof; the integration checks remain separate. Their acceptance did not answer the
original sequencing question. The later actual owner answer recorded above supplies that decision;
neither module acceptance nor staged sequencing authorizes a premature storage cutover.

Wave 3 migration facts retained for handoff (not permission to migrate): the target must be
offline; the migrator lock excludes other migrators, not a running Harness. Inventory source
headers first; only v3 is supported, and older versions must fail explicitly rather than be
skipped. `--target-dir` is the durable directory itself (`<dataDir>/durable`). Preserve host
UUID separately from DB-global numeric ID. The migration manifest distinguishes archival
`entryIds` from active `contextEntryIds` / `contextOrder` / `headId`; active tags must never
use archival IDs. Original metadata is `legacy.custom` with the full original entry as `data`;
new runtime metadata is `app.pi.custom`. Both source snapshots and target Harness must be offline.
An optional module-only `parentSessionMap` maps exact original parent strings only to already
enumerated offline files; no basename guessing or live-parent reads. Missing necessary state
refuses migration. Publication is atomic per session, not workspace-wide; `activeBlocks` counts
materialized observations after branch/native-compaction filtering, not raw flags.

## Isolated fixture setup check: H-W2-FIXTURE-SDK-1

The first browser attempt stopped before creating a fixture or running assertions: Node reported
`ERR_MODULE_NOT_FOUND` for the fixture's old `@mariozechner/pi-coding-agent` import. This is a
fixture setup miss, not a product or browser result. The fork uses `@earendil-works/pi-coding-agent`.
Change the fixture to that same installed SDK. Expect native fixture creation to succeed and the
browser assertions to run; another import or API mismatch falsifies this setup hypothesis.
Only rerun this isolated fixture after the correction, not the entire integration suite.
Result: HIT for setup; the corrected SDK import created the fixture and ran its initial assertions.
The next first-binding assertion failed separately and is not covered by this setup result.

## Fixture correction hypotheses (before changes)

**H-W2-FIXTURE-BUDGET-1:** the real preview test expected a single 1,500,001-character assistant
text block to exceed the window budget, but `serialize.ts` truncates each assistant text block
to 200,000 characters. The observed start of zero is therefore a bad fixed input, not proof that
budgeting failed. Replace only that fixture message's content with eight 200,000-character blocks,
which remain above the 1,500,000-character budget after serialization. Expect start four, the same
partial digest and correct quiet lead; a different start or incorrect metadata falsifies this.
Do not change the serializer's existing limits or the product boundary to make the test pass.

**H-W2-FIXTURE-BIND-1:** the browser expected automatic sending after first UUID binding. The
actual composer explicitly warns and retains an unbound draft; it does not enqueue that rejected
submission. Keep the assertions that pre-bind text/quote survive and nothing is sent, wait for the
bound input, verify the entire draft is unchanged, then submit once explicitly. Expect exactly one
accepted, persisted message even after duplicate binding delivery. Any lost draft or duplicate
message falsifies this. This corrects the fixture to the existing contract; it does not claim that
unaccepted submissions are durable queues or that restart/in-flight preservation is proved.

Result for H-W2-FIXTURE-BUDGET-1: HIT. The corrected real preview fixture and all other integration
unit cases pass (15/15, sealed focused run). H-W2-FIXTURE-BIND-1's four draft assertions pass in the
isolated browser. The acknowledgment correction below subsequently verifies its accepted-message
and exact-text persistence stage too; later paging/restart conditions remain separate.

**H-W2-FIXTURE-ACK-1 (before correction):** the browser waits for `prompt_received`, which does
not exist in this fork. `protocol.ts` and `prompt-ack.ts` specify `prompt_ack` with the outgoing
send's `id`, `conversationId` and `ok`. Listen for that exact send's actual acknowledgment, fail
explicitly on refusal, then verify the complete accepted text in the fixture's native transcript.
Expect the wait to resolve without inventing an acknowledgment or accepting another send's result.
A missing/mismatched/refused acknowledgment or absent/duplicate persisted text falsifies this.
This repairs a fixture contract error, not product persistence or model behavior.
Result: HIT. The sealed corrected run passes seven assertions, including the matching accepted ack,
exactly one send after duplicate binding, and the complete accepted text appearing exactly once in
the temporary native transcript. It stops at the next independent initial-history boundary assertion.
Evidence: `/tmp/ops570/browser-e2e-ack-corrected/` and
`/tmp/durable-w2-browser-1793030365282/result.json`; no fence hits or real chats/models.

**H-W2-FIXTURE-SEED-1 (before correction):** the history fixture is created in the initial
workspace before attachment. `agent-service.ts` resumes that project's latest session, so the draft
send stage can append to the very 122-message file that the later history test assumes untouched.
Create that independent history fixture only after the initial draft send has completed, and assert
its file/session identity differs from the draft's native transcript. Expect the known 122-message
history to open at start 116 with six messages, then four contiguous pages. A non-independent file
or a different native boundary falsifies this; do not adjust expected counts to hide added records.
Result: HIT. After isolating creation, the known history opens at 116/six, with suggestion chips,
Select-to-quote and flow-light verified (13 browser assertions). The next page metadata check fails.

**H-W2-PAGE-DIAG-1 (before diagnostic change):** both the actual button callback and protocol
builder specify a 30-message page, so a request at 116 should return start 86. The failed artifact
does not record the request boundary or reply metadata, so it cannot distinguish an integration
fault from a stale fixture/client scope. Record only the isolated UI request's numeric boundary,
limit and reply start/count/session-match before the unchanged assertion. If request 116/30 receives
anything other than start 86/count 30/the same session, the server integration needs repair; if the
request differs, trace its actual client state. No expected value, timeout or assertion is relaxed.
Result: the diagnostic captured request 86/30 and reply 56/30 with the correct session. That reply
is correct. The fixture had already allowed the first page through before arming its delayed reply.

**H-W2-FIXTURE-AUTOPAGE-1 (before correction):** `MessageList` also calls `loadEarlier()` when
scrolling upward near the top. The fixture scrolls/quotes before arming its hold, so an automatic
116-to-86 page can arrive before its first explicit click. Hold every earlier-page reply from the
start; explicitly release exactly one positioned reply per loop and arm the next wait before release.
Keep the known boundaries 86/56/26/0, one request per page, duplicate-click and two-pixel anchor
checks unchanged. Verify the reconstructed complete known message contents/order and unchanged
original JSONL prefix as well, not merely 122 messages. Unexpected boundaries, duplicate requests,
any changed/missing original content, or anchor movement falsifies this. No product scrolling or
paging behavior is changed to accommodate the fixture.

Result: HIT. The sealed `browser-e2e-held-autopages` fixture passes all 29 assertions in five
seconds with zero fence hits and no live chats or models. Pages are exactly 86/56/26/0, the complete
122-message content/order is reconstructed, and every original JSONL byte remains an unchanged
prefix. The actual quote/chips/theme/Inspector, exact accepted draft and one-handshake checks pass.
Evidence: `/tmp/durable-w2-browser-1793031389821/result.json` and its two screenshots. This is an
isolated integration result, not live latency, restart or global losslessness proof.

## Hypothesis H-W2-BCP-LINK-1 (before package integration)

The global settings already name `/home/shinelay/projects/billion-context-pi`, but pi-web-ui does
not declare that local dependency and the production classic distribution predates reviewed commit
`f069b19def16475297a86d89b0d5e43d44c71ba5`. Add the local file dependency without changing the
current SDK/pi-ai 1.0.1 or the engine/store, and exercise the independently built same-commit classic
extension in the temporary native browser runtime. Check dependency resolution and the actual
compress/decompress Inspector controls. Before installation, the controlled production artifact build
must match the reviewed source; it is not a source edit or a durable cutover. Peer conflict, changed
host SDK, extension-load failure or unavailable tools falsifies this. Keep any incompatible link out
of live settings/install until repaired within the admitted plan.

Dependency-resolution result: the local file dependency and lockfile install cleanly; the lockfile
adds 39 lines without changing host SDK/pi-ai 1.0.1 or private durable 1.4.0. The installed BCP link
resolves to the existing source directory. No global settings edit or production distribution build
has occurred. The optional isolated browser extension check uses `PI_WEB_BCP_FIXTURE` pointed at
the separately built same-commit worktree. The named runner intentionally seals away unrelated
parent environment, so its first run still covered only the original 29 checks. Passing the optional
extension path explicitly **after** `scripts/sealed.sh env` exercises all 31 checks: reviewed classic
compress and decompress both register enabled in the native SDK 1.0.1 Inspector. Result:
`/tmp/durable-w2-browser-1793032730360/result.json`. No live extension artifact changed.

Preservation foundation #577 is consumed at `429ec0ff6560fc60c1cb2ffc86df52e23429dcb6` (normal
receipt `210-8fa90e`), not copied. Its accepted module API does not prove the remaining host/client
hooks. Foundation #578 is now also consumed by clean rebase at
`f70eb359f9a9d14d9ee0e9baed5d896de2fd8acc` (normal receipt `211-abff5b`); Ops independently
accepted its module/API only. Its complete contract is `docs/durable-pending-attachment-recovery.md`.
No parent rerun is substituted for integrated recovery proof. The earlier unchanged soak timeout was
isolated under quiet CPU: the focused sealed soak passes unchanged in 55.63 seconds. The final
whole gate still must pass after integration changes.

## Recovery repair admission and producer hypothesis

Ops' technical answer to #570's task-split question (not new owner consent): run **#579**
(browser coordinator) and **#580** (server lifecycle adapter) in parallel, with new-module-only
ownership. #570 keeps common host/protocol/hook/App/composer/package wiring and actual combined
browser/build/gate/rollback proof. Both accepted foundations are consumed. Earlier #577/#578
admission returned again by the queue is historical, not another open dependency or new task.
Interfaces are exchanged before callers; final consumption uses checked landed pins, not copied
module implementations. No deployment or W3 storage/source authority changes.

#580 is now consumed by clean rebase at `3c7411e90281746d07c4358a85501d8fe610476f`
(normal receipt `212-f0c1a8`). Common wiring replaces both legacy admission paths, handles both
explicit capture/refusal errors, consumes each terminal/suffix outcome independently of socket-send
failure, fences late attach, and drains the sealed FIFO without later commands overtaking it.
Optional ready capability/generation and `session_initialized` separate transport readiness from
completed startup. These edits are **prepared, not yet checked**. The helper's read-only spot review
caught a throwing-report cleanup hazard; the per-item no-throw consumer addresses it, with actual
socket regression proof still owed. Handler return never becomes a persisted ack.

#579 pin `48cec10e20ecc3870f0e2422fb990160c00e215d` remains **unsafe for release**: Ops found
that legacy literal user text `{"format":"pi-web-pending-work-v1"}` collides with its internal carrier
parser. Ops #581 repaired it at `1752cef513498a0993d365f5d208209656517211`, normal receipt
`217-eb1649`; HOME independently accepted the exact six-file repair. This worktree has cleanly
rebased onto that repaired pin and the accepted inert #584 pin
`9d8c66c30dcf2d375ae4959f4ab310a988600afd` (receipt `216-27c44d`), preserving all caller handoffs
and uncommitted integration work. Only validated outer v2 provenance decodes a carrier; ambiguous
old untagged source remains incomplete/raw-exportable. No caller codec workaround or old reader.
Build/pin/retain the repaired reader before real producers. #584 also needs real host serialization,
post-await target/readiness checks and actual downloaded-artifact-byte restoration; its DOM-export
assertion is not that proof. Neither accepted module activates itself.

Requirements clarification answered by Ops in this task's lead dialog (m01418): preserve
`appSend(ClientMessage): boolean` as synchronous transport and add
`appAdmit(ClientMessage): Promise<boolean>` for explicitly classified authored work. Exact true
requires the full checkpoint followed by owned admission; it never means executed or server
persisted. Any false/rejection retains editable originals, including a committed-payload envelope
failure. Credentials, OAuth/capability secrets, PTY streams and transient probes/watches are
excluded from a new generic journal; unknown classification grants no persistence permission.
Recovery never reauthorizes an action or automatically replays uncertain work.

Ops admitted read-only patch/test audits #582 (components), #583 (stores), and compatibility module
#584. The legacy public `startChat(...): boolean` remains boolean: #584 must checkpoint its complete
immutable original intent synchronously before true/effects, with owned initialization and exact
write/readback. Later async failure retains it for editable recovery. Trimming is only empty-input
validation; never reread caller-mutated options after await. `compose(...): boolean` and other
public producer paths remain separately included in #570's host audit; #584 alone does not cover
all plugins. Native `chat.create`/open-session remain async. No caller-side parser workaround or
unreviewed checkpoint substitute is authorized by this technical decision.

**H-W2-ASYNC-PRODUCERS-1 (before producer edits):** the composer tests `appSend(...)` as a boolean,
so an async persistence result would be truthy even when it later resolves false. Suggest chips hide
before send, and plugin sequences do not await the final prompt. Await actual send admission before
clearing native composer/chips or completing a sequence; fence double-submit while preparing, and
never clear edits/attachments/session selected after preparation began. Expect delayed/rejected
persistence to leave the complete current draft and attachments, one submission during a pending
commit, and successful completion to clear only the unchanged captured draft. Early clear, a duplicate
wire send or deletion of newer edits falsifies this. These producer edits alone do not implement the
coordinator/host or establish durable acknowledgement; combined checks still follow both helpers.

## Hypothesis H-W2-RECOVERY-HOST-1 (before host/client preservation wiring)

The accepted #577 queue API explicitly requires correlated recovery for non-prompt operations;
the current browser gives only prompts a correlation/recovery copy. `send()` returns synchronously
and forms may clear immediately after socket send. The accepted #578 storage interface is async,
requires unique reload-stable tab ownership (including cloned tabs), and must commit the complete
payload before transmission. Merely changing `pending.push` or the legacy persistence effect leaves
these gaps. Also, the existing positive prompt ack can refer to a **volatile waiting queue**, not
persisted native history, so it alone cannot authorize releasing the durable recovery copy.

Proposed change: a bounded, separately owned client recovery-coordination module around #578,
with checked tab ownership, commit-before-transmit, stable command correlation, complete recovery
of unacknowledged commands and explicit unknown/non-processed outcomes. #570 owns the common
hook, composer, socket/protocol and visible recovery wiring. Never automatically replay an
uncertain non-idempotent command, and retain recovery bytes through negative/unknown outcomes,
visual reconciliation and volatile queue acknowledgments; release only after proven persisted
operation-specific confirmation or explicit user discard. This does not switch the native store.

Expected proof: exact text/attachment/command content survives close/reload and cloned-tab cases;
failed/quota/unavailable storage sends nothing and leaves the full draft recoverable; duplicate or
stale outcomes cannot execute/delete work; both pending-admission branches and every abandonment/
drained suffix are accounted for. Missing content, guessed success, premature release or a wire send
before a durable recovery commit falsifies the change. Additional module-task admission/ownership
is for the Ops lead; no new owner-only storage/source permission is sought or implied. The recovery
owner and new origin-local database must remain reachable through rollback, with a tested usable
restoration path while unresolved work exists. Restoring only the old JSONL/build is insufficient;
the origin-local recovery database is not a server backup. The current × action returns work to the
composer and is **not** permission to discard its recovery copy.

## Preservation coverage and concrete gaps (not a losslessness claim)

- The new fixed-input integration unit tests pass 15/15: positioned paging, stale-session rejection,
  cache replacement, callback ordering and close-before-attach. Their synthetic history is not
  restart, backup, pending-command durability or complete-state proof.
- The isolated browser passes 29 assertions: pre-binding draft/quote preservation, matching accepted
  ack and one exact persisted send, contiguous four-page native history, complete content/order and
  unchanged original JSONL prefix, stable scroll anchors, quote/chips/theme and mounted Inspector.
  Restart and complete queued/in-flight recovery are not proved by that fixture.
- Existing `pending-sends.test.ts` covers retained text, refusal/retry, reconnect/reload and session-ID
  remapping. Its oversized-attachment case deliberately omits large inline image/file bytes from
  recovery storage. An interruption before server persistence can therefore leave the recovery copy
  without those bytes. This is a concrete existing gap, not evidence that normal accepted sends lose
  their attachments; no live experiment was made.
- Existing `ws-pending-queue.test.ts` expects the pre-initialization queue to drop its oldest command
  at its 256-command boundary. Socket-close and attach-failure paths clear that volatile queue.
  These existing behaviors do not establish preservation of queued/in-flight work. A bounded repair
  must preserve/recover accepted work or explicitly refuse it while retaining a retryable client copy;
  changing the limit alone is not proof.
- Ops has admitted both bounded repairs in parallel: #577 supplies recoverable pre-initialization
  commands; #578 supplies complete pending-attachment recovery. #570 owns the host/client wiring and
  end-to-end acceptance of their landed contracts. Neither module-only acceptance establishes that
  integration. Keep native JSONL authoritative, no storage cutover, and do not treat a passing build,
  matching counts, or legacy tests of lossy behavior as meeting the owner's acceptance requirement.
  W3 obligations above remain entirely separate.

## Hypothesis H-W2-RETAINED-READER-1 (before artifact builder)

**Evidence/problem:** reverting the application bundle does not remove new IDB/localStorage work,
but the old bundle cannot interpret it. #579 and #584 standalone readers must stay reachable on the
same original origin even with the new app unavailable. A file:// export reader has the wrong origin.

**One change:** build the reviewed, content-pinned reader modules into self-contained HTML; retain
immutable hash-named versions plus a checked navigation index in the data directory, served by the
existing authenticated `/plugins/pi-web-pending-recovery/client/` static route. This is a first-party
recovery asset, not a third-party plugin activation or DOM grant. Do not replace another plugin,
change a consent setting, add a service, or delete older reader assets/source work. Publish the
index only after every versioned asset is verified; an interrupted install leaves the old index.

**Expected measurement:** the isolated native fixture opens those actual same-origin authenticated
URLs, verifies inline/Blob module execution and exact original-work export/restore, removes/reverts
the app bundle while retaining work written afterward, and still uses both readers. Unauthorized
requests fail. Record artifact hashes/pins and complete-content results, not just counts.

**Falsifier:** a reader needs the replaced app bundle, origin/auth/CSP blocks access, interrupted
publication strands an earlier version, a newer record is inaccessible, or an external reference is
reported complete without its actual resolver/bytes. No build or module pass alone proves this.

## Hypothesis H-W2-IDENTITY-CORRELATION-1 (before echo wiring)

**Evidence/problem:** the accepted #583 audit and current routes show identity-file, note and draft
results identify a resource/action, but not the originating operation. A late same-resource ACK or
read after reopen can be mistaken for a newer save/read. A client-only counter cannot identify it.

**One change:** optional opaque `reqId` on those existing read/mutation requests and their six
existing response types; echo the exact own string property on every existing success/refusal
branch. Missing/invalid correlation leaves legacy replies unchanged. Consumers match request,
resource and captured editor/open revision; missing/mismatched IDs are not cleanup authority.
This changes no authorization, original file location, deduplication, replay or persistence proof.

**Expected measurement:** fixed-input echo/no-echo/prototype/parallel-request cases and actual
isolated socket success/refusal/read/error results preserve the exact operation ID. Paired editor
fixtures retain newer text through ACK/reopen; those remain the assigned helpers' responsibility.
**Falsifier:** any route omits/mixes IDs, legacy requests change, or a matching token alone is treated
as a persisted receipt or used to erase a later editor revision. Prepared edits are not proof.

## Hypothesis H-W2-OWNED-HANDOFF-1 (before native host-admission wait)

**Evidence/problem:** a successful `ws.send` alone can race an explicit host startup/target refusal.
Returning true before that known refusal can leave a save form waiting for a domain result that will
never arrive. The pending lifecycle distinguishes untouched work from dispatch-started uncertainty.

**One change:** the native port waits for the exact current-socket/generation/attempt host outcome.
After all target/readiness guards, the host may report metadata-only `dispatch-started` uncertainty;
that means entered dispatch, NOT successful execution or persistence. A matched pre-dispatch refusal
or socket failure resolves false and retains the full editable original/checkpoint. Local never-sent
holds remain owned admission only after their full checkpoint; their first wire handoff is checked
again. No timeout/automatic replay is introduced. Reporting failure must never prevent dispatch or
terminal cleanup. Optional port support keeps the pure facade independent of a transport.

**Expected measurement:** deferred owned handoff does not clear a draft early; matched refusal,
throw/close/target change and stale outcome retain it; a true dispatch-started outcome still cannot
release any recovery record or claim Saved. Actual socket/consumer fixtures remain required.
**Falsifier:** any uncorrelated/old outcome completes admission, reporting throws out of dispatch,
uncertainty becomes retryable/cleanup permission, or normal transient traffic waits on this path.

## Explicit native payload policy (Ops m01418, applied field by field)

The first native admission policy positively classifies exact prompt/edit payloads, typed
`run_command` definitions, about/prompt/notebook identity-file saves, identity-note saves and composed
board posts/close notes. Exact keys/types and original resource/reqId are retained. Unknown extra
fields are not silently dropped to manufacture an eligible record. Terminal input is not a typed
command definition. A stored order/close command is not permission to execute it again.

Config/composite draft commands, approval-bearing role answers, credentials/OAuth, arbitrary plugin
payloads, PTY streams and unknown schemas remain outside the new journal; existing authorized live
paths are not revoked. An unsupported `appAdmit` returns false without dispatch, never falls back to
`appSend`. Synchronous calls to a known authored-admission family cannot bypass the checkpoint.
Intentional reference-only attachments still require the coordinator's actual source verification;
missing verification fails visibly before send/clear. Do not claim reference bytes recovered from
metadata alone. This policy is not a content-scanning promise about arbitrary authored prose.

## Prepared-stage check, 2026-10-26 12:33 PDT

One sealed fixed-input run passes **107/107 across four files**:
`recovery-admission.test.ts`, `recovery-policy.test.ts`, `pending-recovery-reader.test.ts`, and
`durable-cutover-integration.test.ts`. It covers the new pure admission/owned-handoff ports,
field-sensitive policy, additive filesystem reader publication and optional identity echoes, plus
the earlier window/startup primitives. H-W2-ASYNC-PRODUCERS/OWNED-HANDOFF/RETAINED-READER and
IDENTITY-CORRELATION are supported **only at these tested module boundaries**. No native handler,
real socket/caller/reload/reference/rollback claim follows. The prior browser 29/31 assertions are
not rerun/new-lifecycle proof. Full type/build/gate, corrected #581 codec, checked #584 checkpoint,
all applicable caller slices, native integrated preservation and independent frozen review remain.

## Hypothesis H-W2-BINDING-ONLY-1 (before native runtime binding)

**Evidence/problem:** the admission attempt currently retains its entire originating `UiState` even
after `newPendingSend` has captured the required baselines. Long-lived recovery copies would thereby
retain old message windows/models/config snapshots and defeat view-cache eviction.
**One change:** retain only transport/generation/lifetime and stable target binding after constructing
the immutable work; never put the full `UiState` in the attempt/held port. Fresh explicit retry
recaptures the current binding and checks the original session before its fresh status probe.
**Expected:** fixed cases show no state/history property on retained/published bindings, while full
input bytes, wrong-target refusal, held ownership and known-unprocessed retry remain correct.
**Falsifier:** an old full view remains reachable through an attempt, or removing it causes a retarget,
replay, missing payload, or loss of baseline/proof semantics. No automatic recovery cleanup is added.

## Hypothesis H-W2-RESOURCE-SCOPE-1 (before target-scope wiring)

**Evidence/problem:** Ops admission of #589/#590 explicitly distinguishes GoalBar's original real
conversation from Scheduler's global task resource. Treating every recovery record's source session
as the action target would falsely reject a global save after an unrelated chat switch; inventing a
conversation identity for a global task would be wrong. Conversely, GoalBar's real original
conversation prop must not silently follow a newer active chat.

**One change:** share an explicit deterministic resource-scope predicate between host and client.
Known global authored resources retain their exact resource IDs/body and original recovery source
namespace; that namespace is not a task target or authority. Unknown types default to session scope,
and the predicate grants no journal/read/action permission. Goal packets may carry the original
conversationId; validate it before effects using constant-time live metadata. Never fetch history
or add a snapshot call for a target check.

**Expected measurement:** fixed cases preserve global task A while the visible chat changes to B,
reject goal A when only B is actually bound, and reject scope spoofing/unknown types. Native tests
must still prove real binding and no wrong-resource effects; these edits are not that proof.

**Falsifier:** a global source namespace becomes fabricated conversation authority, a stale goal
changes the current chat, any permission is widened, or the check materializes history.

## Hypothesis H-W2-EXISTING-TERMINAL-1 (before backend attach)

**Evidence/problem:** `terminal_create` calls `TerminalManager.openView`, which safely preserves an
existing PTY/history but creates a shell for an unknown ordinary id. It does not itself replay output.
A command/recovered render mount must therefore not use it as proof of a harmless attach.

**One change:** add a distinct existing-only terminal attach/snapshot, original-conversation/session
checks and a targeted requesting-view replay result. Flush pending output before the retained snapshot
so subsequent live output cannot duplicate its pending suffix. Never create/restart/kill on this path;
missing or stale target is unavailable. Keep plain-shell and explicit command execution paths intact.

**Expected/falsifier:** real TerminalManager fixed cases must retain exact output/history and sizes,
perform zero spawns/kills for live/exited/missing/invalid views, and flush pending output before the
snapshot. Actual socket/view tests must replace only the requesting live view and reject stale targets.
A missing view creating a process, duplicate output, cross-target response or local-registration-only
success falsifies it. This is retained output, not a guarantee of unlimited historical PTY output.

## Stage checkpoint and hypothesis H-W2-SCOPE-BUILD-1

Sealed prepared-stage run: **149/149 across six files pass** (admission, document owner/ports,
explicit payload policy, reader filesystem integrity, history/identity metadata, existing-only real
TerminalManager). This is pure/port/FS/backend evidence, not a real socket/current-draft/rollback or
full-gate pass. The pinned v2/P readers also build and verify in a TEMP data root, version
`e93ae4b764a1b926466fa50c6161af283eb4c1f660f1689e0527420c0dc8eaf3`, committed source revision
`552cba2e5cd4ccb2e39f0711c0cbb7cb455b8160`; no live installation.

The first full compile **missed**: TS6059, `shared/recovery-scope.ts` is outside the server compiler's
`rootDir: server`. Web build passed; server compile stopped, so do not start/claim an updated server.
**One repair:** move the identical dependency-free classifier under `server/`, update the two imports;
frontend has no rootDir and can bundle that pure source. Keep one table, do not widen compiler roots
or duplicate policy. After relocation **both web/server build pass**; no Node-only browser input.
The five-target check then found five type errors, not runtime losses: the new open interface
`CommandDispositionMsg` lacks the implicit closed-object index compatibility expected by two old
attachment fixtures; a fake SID getter was inferred as two string literals; a coordinator fake widened
its discriminants and returned null where the real API throws.

**H-W2-METADATA-TYPES-1, before repair:** make the identical wire object a closed type alias (no
wildcard/extra fields), explicitly type the fake SID getter as string, and make the fake coordinator
return the real discriminated result/throw on a missing original. Expect all five compiler targets;
no production fallback, changed field or weakened behavioral assertion. These measured compiler
repairs do not qualify native socket or full no-loss behavior. **Result: all five typecheck targets
pass** after correcting the fake's result annotation to the exported `PrepareRecoveryResult`.
Only the affected recovery-client suite was repeated after its fake contract change: **15/15 pass**;
`git diff --check` passes. The six-file 149-pass stage remains prior backend/port evidence, not full gate.

### Remaining integration boundary (not completed by accepted slices)

The actual use-chat sender/owner/async registration, removal of the legacy lossy persistence effect,
all producer/result/source adapters, current-editor draft flush and recovery UI are still being wired.
Do not land/deploy the half-paired callers. Native queue-answer occurrence/applied proof is still
missing from the old void/wake-based path; a send, refresh or closed-chat wake must not become true.
FileService/App still need captured real target/result metadata, not a fabricated file authority.

Latest HOME direct queue/busy reconciliation: current native **#597 is scheduler key-presence**,
chat **c1199**, repairing `18c0844b…`. An OLDER live terminal repair chat **c1177** has the same
old displayed #597 but is not the current row: it finishes only its approved real-xterm ordering work
for `c41a3bf9…`, hands over directly, and must not mutate queue597. HOME will track that committed
terminal result unambiguously. **#598 remains dropped** to prevent a third terminal implementation.
Do not add after597 expecting terminal work. Both fixes are now HOME-reviewed and consumed as
unlanded pairs: terminal `c41a3bf9` + `e82c6ed9418d0f08bcf8b74138aa14f2b1025fc6`, scheduler
`18c0844b` + `801c4cf8e46296a3f8754f9c64644710fa7f5a64`. Board `53ff91cb` and composer
`eab7897e` also have complete HOME boundary acceptance and are consumed. No duplicate work or
repeat review is needed. These are module/caller boundary acceptances, not integrated qualification. #593 `53ff91cb…` and #595 `eab7897e…` now have HOME source acceptance,
but these new handoffs/store modules have not yet been combined into this worktree. #596 must wait
for its corrected reviewed pin. Only repaired command+terminal code may be combined eventually.

## Native bridge preparation checkpoint (not yet qualified)

`recovery-chat.ts` now connects the document owner to actual socket objects, server generations,
explicit `session_initialized`, original metadata/lifetime and cross-workspace held targets. `use-chat`
registers the ONE `appAdmit`, delays startup probes until attach, binds native snapshots before React
catch-up, and removes its legacy parse/serialize writer and direct optimistic/Retry send path.
The full original is captured before async source checkpoints; false/throw/committed-but-failed never
clears the caller. A fresh prompt-status nonce is echoed only with the actual session scope; a negative
lookup alone still cannot authorize replay. Unknown delivery is labelled unknown, not Not sent.

Focused port-stage verification: **7 files / 181 assertions PASS** in 22.67 s. This includes actual
recovery-client/admission/transport composition over fixed fake storage/socket ports, original bytes,
source-before-clone, committed failures, held first-wire, target/workspace ABA, exact metadata and
fresh lookup fences. It is NOT native browser storage, real `use-chat`/App or server-socket proof.
All five TypeScript targets now PASS. Static checking caught an undefined status-context variable
and an actor-vs-guard-proxy comparison; the handler now captures `clientId` and checks the actual
underlying session before/after lookup, with fail-closed getter handling. Actual host-socket coverage
for that callback is still owed. Fake socket `readyState` types were corrected without widening the
production WebSocket contract; assertions/gates were not removed or rerun just for that annotation.

Source-rich Board/command hooks, actual reference resolver, atomic composer-return/compose,
current-source persistence, FileService/AskHub glue, retained extra readers and full restore/rollback
remain explicit incomplete integration work. The temporary missing-source handler refuses without
publication; it must not ship as a disabled feature. The existing two-sink recall path is not counted as
an atomic recovery restore. App edit admission now captures the displayed target before image fetch
and awaits the actual bound checkpoint/handoff; its real filesystem/browser proof remains owed.

## Hypothesis H-W2-AUTHORED-SOURCE-1 (before source adapters)

**Evidence/problem:** C retains the exact outbound command, but Scheduler/Board packets omit inactive
or pre-normalized editor fields. Their approved accessors expose full original sources on the exact
original object; page-memory `current`/`attempts` is not reload or rollback preservation. Scheduler
has an accepted typed CAS store; Board currently has no durable source store. Do not manufacture a
prompt, attachment or outbound command to hide a UI source in C's payload.

**Change:** field-specific source adapters capture and validate the original source before cloning,
retain both submitted originals and evolving current edits in their own non-executable typed records,
and await the source transaction/readback before the existing full-wire C checkpoint/publication.
Serialize per genuine source identity and preserve a newer current revision when an older submitted
original completes. Failed/unknown/conflicting reads are not absence; no physical deletion or replay.
Board's raw `kind`/recipients/words remain a draft only, not an order/owner receipt or publish authority.
Use genuine origin-session metadata only as C's archive namespace, never as global action ownership.

**Measure/falsifier:** fixed delayed/CAS/commit-but-readback-failed tests, actual IDB complete-content
reload/standalone-reader/rollback proof, newer B plus submitted A retained, source-before-clone WeakMap
proof, and no save/publish/run on restoration. A missing inactive field, overwritten current edit,
corrupt-as-empty row, fabricated target, unknown-payload journal or action on restore falsifies it.

**Scheduler stage result:** the new source controller first passed 16 atomic/CAS/failure cases. Its
actual original-object source/wire pairing, document-lifetime current-edit observer and native handler
are now wired. The touched-stage run passes **4 files / 160 assertions** (19 source-controller,
4 actual-panel/observer, 49 field-policy and 88 existing caller cases), with full source A plus newer B,
commit/readback failure, source-before-clone, workspace binding, inactive options and zero actions on
look/restore. Storage in those integration cases is synthetic, not a claim of real IDB/rollback proof.
A submitted original and initial current are in ONE atomic record replacement: do not create an empty
submitted list and add A in a second transaction, which could strand A after readback failure/current B.
All five TypeScript targets pass after the wiring.

A fresh build plus the existing isolated actual-app/Chromium/core feature fixture also pass
**31 assertions**, evidence `/tmp/durable-w2-browser-1793060537082`, including the simple accepted
prompt path, exact history/order/native-prefix checks, UI features and reviewed classic compress/
decompress registration. This is after the real `use-chat` sender replacement, not the earlier
pre-integration fixture. It does NOT yet prove owner reload/clone recovery, complete source/attachment
restore, server-status callback scope, all caller families, retained readers or lossless rollback.
No live browser/profile/session/installer was used and no real model call was made.

Board's typed durable source boundary remains a concrete gap. Interface FYI `rm-613ca33d` supplies a
minimal independent new-module partition and exact non-executable form schema; Scheduler work did
not wait for an answer. Do not manufacture UI-source packets/attachments or call C's wire copy a full
Board form backup. No new storage/source permission or publication is inferred from this stage.

## Hypothesis H-W2-RECOVERY-REACHABILITY-1 (before native recovery fixture)

**Evidence/problem:** native C restores complete IDB records, but `use-chat` deliberately does not
reinsert `restored` into the old optimistic rail (a visual/text/volatile ACK is not deletion authority).
Without a real recovery surface, stored orphan bytes are not a usable owner-reload recovery path.
The requested implementation worker did not start: shared pool refused at 16 retained agents; no
worker/reviewer result exists. Continue inline, without stopping unrelated agents.

**One change:** mount a read-only retained-original surface driven by C's event-driven view, with
explicit complete-artifact export and no send/delete/release. Extend an isolated actual-app fixture
for the real ChatInput/C/IndexedDB owner, known full attachment content, reload/opener clones,
transaction/quota/committed-envelope failures and no replay. Use only ownServer/fresh temporary
browser data; inspect no model-bound request, tool or result.

**Expected check/falsifier:** exact synthetic originals, identities, order and byte hashes must survive
and be exportable through the actual app after reload, including an unpublished committed orphan;
clone may not steal/publish/clear; every persistence refusal retains the full editable draft before
wire. Any missing owner/original, hidden unusable source, stripped bytes or automatic replay is a
failure. This is not yet same-origin independent-reader/rollback or global no-loss proof. Separate
source-supported zero-byte upload truthiness remains an explicit follow-up codec case, not a pass
claimed from the large-file test.

**Outcome:** H-W2-RECOVERY-REACHABILITY-1 **HIT** for the actual-app core recovery scope. Focused
`tests/unit/pending-recovery-panel.test.ts` passed **4/4**, and isolated Chromium actual-app
`tests/durable-core-recovery-test.mjs` passed **57/57 assertions** across `reload-clone`, `quota`,
`abort` and `envelope` (`/tmp/durable-core-recovery-1793063050438/result.json`, zero live models or
chats; details and two fixture-only hypotheses in `docs/durable-core-recovery-fixture.md`). This
still does NOT prove retained same-origin standalone reader/app-bundle-unavailable rollback,
source-rich Board/composer/command/FileService/AskHub glue, or global losslessness.

## Hypothesis H-W2-LEGACY-IDENTITY-TESTS-1 (before legacy fixture adaptation)

**Evidence/problem:** `#586` (`ccf51248`) and `#587` (`99faad82`) changed `saveNotebook`,
`saveOpenNote`, `saveOpenIdentityFile`, and `sendIdentityDraftAction` to return `Promise<boolean>`
and require echoed string `reqId` correlation on replies, while `tests/unit/identity-notebook.test.ts`,
`tests/unit/identities.test.ts`, and `tests/unit/identity-config.test.ts` (outside helper-owned paths)
still assert synchronous boolean return values, exact no-`reqId` payloads, and un-echoed replies.

**One change:** update only those legacy test expectations in `tests/unit/identity-notebook.test.ts`,
`tests/unit/identities.test.ts`, and `tests/unit/identity-config.test.ts` to register `setAppAdmit`,
await the async save/draft APIs, assert `reqId: expect.any(String)` on outgoing requests, and pass
the captured `reqId` on simulated server replies—without dropping any existing assertion or adding
a production fallback.

**Expected measurement / falsifier:** all five identity/notebook unit suites (`identity-notebook`,
`identities`, `identity-config`, `durable-notebook-admission`, `durable-identity-admission`) pass in
one sealed run with zero dropped tests. Any failure or weakened production check falsifies this step.

## Hypothesis H-W2-FILE-HOST-1 (before paired host change)

**Evidence/problem:** accepted #591 fences replies but the actual host still drops all correlation.
`FilesService.readFile` reads cwd after an import await; `writeFile` truncates the destination then
re-reads it as an unrelated read. App passes no original binding. This both leaves the new editor
read-only and can retarget/acknowledge the wrong operation; a partial write can damage the original.

**Change:** capture the existing authorized path, real target, workspace and genuine session before
any await; echo the exact request/lifetime/revision and method-derived purpose on every result.
Bind the real resource on the first complete read, require it on correlated writes, and replace a
file only after a same-directory temporary file is written, read back and synced. Preserve the
existing limits/access policy and file mode/owner. A failed post-rename durability step is unknown,
not a claim that nothing happened. No arbitrary-file or config journal is introduced.
App holds one immutable original open binding/transport; a later context cannot reuse it, including
ABA. Refused sends retain the editor rather than remounting away its draft.

**Expected measurement:** fixed temporary-file cases cover wrong/absent/mutated metadata, original
cwd during an awaited read, symlink retarget, full writes beyond the preview prefix, binary/truncated
preview, write failure before publication, and legacy requests. A real isolated App/WS/filesystem
fixture must then prove usable edit/save plus newer draft retention. No live files or chats.
**Falsifier:** any mismatched read confirms a write, a stale target is written, failed preparation
truncates the original, or App can no longer edit a valid current file.

**Outcome:** H-W2-FILE-HOST-1 **HIT** at the actual App/socket/temp-filesystem boundary. The three
file suites passed **78 assertions / 5 existing skips**; all five typecheck targets and the build
passed. `tests/durable-file-host-test.mjs` passed **15 actual-app assertions** with zero fence hits,
model prompts or page errors (`/tmp/durable-file-host-1793063821468/result.json`). Real exact A/B
file writes, withheld write acknowledgement, stale same-path read, reopened lifetime and changed
workspace rejection were checked. A pending response cannot replace newer text, and neither the
original nor other workspace file is modified by a stale-open attempt. This is not arbitrary-file
reload durability or global rollback proof; no new generic file/config journal was added.

## Hypothesis H-W2-TYPED-READERS-1 (before retained asset expansion)

**Evidence/problem:** the retained asset builder currently includes only core and legacy plugin-start
readers. Scheduler/composer stores have their own reviewed look-only readers, but their development
HTML points into `/src/` and will not work after the application bundle is absent or rolled back.

**One change:** extend the same immutable checked-source asset version with the reviewed typed reader
HTML and self-contained sibling modules. Preserve Composer's restrictive same-origin script CSP;
do not add inline permission, imports from the app, a new origin/service, or storage write capability.
Old two-reader versions remain valid/reachable. Board receives the same treatment only after its
actual accepted module arrives. Never fabricate a placeholder reader as completed recovery.

**Expected measurement:** deterministic publication cases verify paired assets, hashes, retained old
versions and interrupted publication. A real isolated authenticated same-origin server/browser reads
exact synthetic post-install core and typed work after app bundles are blocked and the server is
restarted. Confirm unauthenticated refusal, no automatic action and no altered source rows.

**Falsifier:** missing dependency, weakened CSP, inaccessible newer work, lost earlier navigation,
unauthorized read, automatic action or changed/deleted original data. An asset build alone is not
restoration or post-change rollback proof.

**Outcome:** **HIT for the retained reader boundary**. All **17 deterministic artifact tests** pass.
`tests/durable-retained-readers-test.mjs` passes **26 native assertions** via the actual authenticated
static route, zero fence hits/page errors, and no model or socket calls. Evidence:
`/tmp/durable-retained-readers-1793064012781/result.json`. Synthetic work is written through the real
core/plugin/composer/scheduler stores _after_ both asset versions are installed. The server restarts,
all app/source/bundle routes remain blocked, and the readers recover full core bytes (above the
legacy 1.5M boundary), exact plugin options, composer source/incoming/effective attachments, and
scheduler current/submitted inactive form fields. Every original native IDB/localStorage row stays
byte-for-byte unchanged by inspection/export. A separate fresh browser context on the **same origin**
explicitly restores and re-exports the complete checksum-checked core artifact. All six reader/module
URLs refuse unauthenticated access; Composer's original restrictive CSP is unchanged; old versions
remain reachable and verified.

This fixture builds explicitly marked **non-production** artifacts from current test source; it does
not relax `buildPinnedReaders` or count as a frozen release pin. It uses the current server with app
routes blocked, **not an actually reverted old server binary**. Board reader integration and actual
old-binary rollback compatibility, final pinned artifacts, real caller restoration and the full W2
release check still remain; no global losslessness claim follows.

## Hypothesis H-W2-COMMAND-HOST-1 (before host/caller pairing)

**Evidence/problem:** reviewed SCM/Terminal callers now require one `onCommandIntent` and an
existing-only `onAttachTerminal`, but App supplies neither. A plain `run_command` stores only the
rendered command, omitting the raw commit text and original terminal/source intent. Mounting must
never become an execution fallback. The prepared server attach reply is not yet consumed.

**One change:** pair both callbacks with the existing document recovery owner. Include the complete
positively typed original command intent in its checkpointed wire record (not a generic command or
PTY journal), retaining whitespace, raw commit revision, original real CID/SID/workspace and
terminal metadata. Require exact source/wire coherence, current original binding and one host claim
per request identity before create/restart. Duplicate/conflicting/unknown outcomes never replay or
release the copy. Wire existing-only attach responses to the original renderer exactly once; no
missing-output fallback, no invented execution/persistence receipt. Legacy uncorrelated live controls
remain unchanged.

**Expected measurement:** fixed-input controller/host tests prove complete bytes before send,
stale/ABA/duplicate/failure preservation, source exclusions and exactly-once ownership; an isolated
actual-app/native PTY fixture proves initial action once, mount/remount/reload attaches only, and
missing output stays unavailable. Existing backend limits and permission checks remain intact.

**Falsifier:** any uncheckpointed side effect, lost raw source, changed target, duplicate spawn on
replay/remount, fake successful output attach or status treated as persistence. Keep this as prepared,
not qualified, until those specific checks pass. New Board #598 is separately accepted for typed
source/storage only; #599 repairs its raw-view export and is not duplicated here.

### Command host verification in progress

The prepared terminal host/controller stage passes **5 files / 133 assertions**, all five TypeScript
targets and sealed build. Its first actual-app fixture failed before reporting assertions, and the
fixture's nonexistent `server.close()` teardown masked the original failure. **H-TERMINAL-FIXTURE-1:**
use the actual `ownServer.stop()` API, preserve the original failure in a bounded diagnostic, then
clean only that fixture's temporary source root. Expect the real failure (or success) to become
observable without changing production behavior or acceptance assertions; another masked error
would falsify this setup repair. **HIT:** the real error was a fixture selector looking for the
command name _inside_ the icon-only Run button. **H-TERMINAL-SELECTOR-1:** select the actual named
command row first, then its Run button; source confirms the name is in its sibling `.cmd-main`.
Expect the real native action to execute or expose the next actual boundary, without a product
change or reduced assertions. **HIT:** actual one-command dispatch is observed, with no browser
errors and `dispatch-started`/unknown persistence. The next fixture failure incorrectly waited for
an interactive shell to exit after its inner Node process finished. **H-TERMINAL-EXIT-INPUT-1:** the
fixed exited-terminal case now explicitly includes `; exit`, matching its intended known outcome;
`runCommand()` intentionally leaves a normal shell interactive otherwise. No product change or
removed ownership/reload assertions. **HIT:** exactly one native effect and complete output are
observed. **H-TERMINAL-RESOURCE-FIXTURE-1:** the fixture took the first _arbitrary_ view reply while
more than one view was attaching (a missing view, then a complete successful view). Correlate the
wait with the actual submitted terminal ID; do not filter out a negative reply for that ID. Expect
the correct existing-only result without hiding a real original-target failure. **HIT:** with that
resource binding, `tests/durable-terminal-host-test.mjs` passes **12 actual-app/native assertions**
(no fence hits or page errors): one full-original command, one native temporary-file effect, duplicate
wire refusal without replay/release, reload attaching complete existing output without rerun, and
explicit missing-output refusal without creating a process. Evidence:
`/tmp/durable-terminal-host-1793064717450/result.json`.

**H-W2-COMMAND-HOST-1 HIT for the paired native command and existing-view boundary.** The legacy
opaque `pi-web-ui:plugin-run-command` event remains a separately identified policy/host audit gap:
it is not silently relabeled as a user SCM/terminal intent, journalled, or counted by this proof.
Command-list configuration save/delete and unrelated PTY controls remain outside this authored-run
checkpoint. Original command records remain recoverable; a successful run/exit does not delete them.
This is not an old-binary rollback, arbitrary live command, or global data-loss claim.

## Hypothesis H-W2-COMPOSER-HOST-1 (before host edits)

**Evidence:** `composeToComposer` invokes independent attachment/text setters then returns true;
`#595` is still inert. Complete accepted injected work can therefore remain memory-only, and a
second setter failure can expose half a draft. Existing text-only L1/server draft persistence does
not cover attachments. The module/retained-reader passes do not prove this host boundary.

**One change:** route boolean compose through the reviewed complete checkpoint and one owned
full-draft sink. The actual ChatInput/App refs supply a genuine current owner/session/composer and
monotonic revision, updated synchronously before React scheduling. Capture and validate all original
source/incoming/effective fields, perform the full synchronous write/readback, recheck the original
port/revision, then publish one full snapshot. Do not use the older two-sink path as fallback. Failures
leave source work and any committed checkpoint recoverable, with a visible notice. Existing page,
path and conversation references remain opaque; this does not fetch them or acquire access.

**Measure:** fixed full-payload, rich-dedupe, source mutation/ABA, reentrant setter, missing/stale owner,
quota and committed-then-refused cases; then actual App/plugin boolean injection, reload and explicit
look-only/restore on the same origin. No prompt is sent by compose or restore; no implicit retirement.
**Falsifier:** true before verified full storage plus owned sink, dropped metadata, partial accepted
UI, wrong-session placement, hidden failure, or inaccessible complete recovery after reload.
Ordinary unsaved-edit persistence and plugin start/new-session sequencing remain separate outstanding
requirements; this boundary is not a declaration that those already pass.

**Fixture correction:** the first four-suite pass had 88 pass / 4 failures because the historical
bridge fixture called truncated `AAA` a base64 image and the new large-file input put raw Unicode
in `fileData`. The strict checked module correctly refused both. **H-COMPOSER-FIXTURE-BYTES-1:** use
complete canonical base64 of the same known bytes for positive cases, and keep `AAA` as an explicit
negative control. Expect positive full-content checks to pass without changing production validation
or reducing payload size; accepting the negative or losing exact decoded bytes would falsify it.
**HIT:** four suites/93 assertions pass, and sealed build passes.

**H-COMPOSER-BINDING-1:** the actual App fixture saved the full checkpoint then correctly retained
it on a false placement result. Source shows the hook compared binding JSON strings, but the checked
codec emits the same five binding fields in a different insertion order. Compare all five fields
by value instead; keep every owner/session/composer/revision fence. Expect the same real native case
to place once, while changed-field controls remain refused. Missing/ignored fields or stale placement
would falsify this repair. No serialized payload or storage comparison is loosened.
**HIT:** 39 affected unit cases and sealed build pass; actual native compose now accepts one complete
placement. The native reload case exposed a second integration gap: the existing text-only L1 mirror
still held the earlier keyboard draft because programmatic placement did not call `noteComposerEdit`.
**H-COMPOSER-L1-MIRROR-1:** after the full checkpoint and owned placement, notify that existing draft
path with the complete placed text. Expect reload to show the same text and explicit recovery to add
its saved attachments without duplicating old source text. The full checkpoint remains authoritative;
L1 failure cannot delete it. No guessed replacement of different/newer drafts is introduced.

**H-W2-COMPOSER-HOST-1 and H-COMPOSER-L1-MIRROR-1 HIT at the paired composer boundary.**
The actual-app fixture passes **28 native assertions**, zero fence hits/page errors, no prompts sent:
`/tmp/durable-composer-host-1793065360780/result.json`. Full source/incoming/effective data and real
image/file bytes are checkpointed before exact boolean true; reload preserves the raw original;
explicit same-session restore rehydrates all chips without duplicating L1 words; export retains raw
records; a known original composer works offline without sending. Native quota, committed-then-throw
and a synchronous newer edit all refuse without partial placement, retaining original/newer editable
work and any complete checkpoint. The prior affected unit stage is 39/39, all five typechecks and
sealed full build passed before the final one-line L1 notification fix; its web build and actual
native fixture passed afterward. No fake owner or direct test-only compose path is used.

Legacy `composer-bridge.test.ts` still covers its nine original behavioral categories, but now mounts
the actual complete checkpoint/sink contract, never legacy half-sink fallback. Truncated base64 is
kept as a rejection control. Full W2 gate, actual old-binary rollback, startChat sequencing and generic
unsaved-edit lifetime protection remain outstanding; this result does not claim those passed.

## Hypothesis H-W2-PLUGIN-START-HOST-1 (before legacy plugin startChat host integration)

**Evidence/problem:** `createPluginHostApi().startChat(opts)` in `web/src/plugin-host.ts` trims
`opts.prompt`, reads mutable `opts` across asynchronous `set_cwd` / `new_chat` / `set_model` waits,
sends the prompt with `deps.send` even if an intermediate transition timed out or the source session
drifted, and returns synchronous `true` without saving the full original intent first. Moreover,
`triggerPluginUiAction` sets `pluginApiCaller` only synchronously during the plugin callback and
clears it in `finally`, so deferring `#584`'s `owner.begin` to a microtask when `getSource()`
includes `pluginId` would fail `sameSource(intent.source)` on every plugin UI invocation. Meanwhile,
`#584`'s landed tests (`tests/unit/plugin-start-checkpoint.test.ts` and
`tests/plugin-start-checkpoint-test.mjs`) invoke `createPluginHostApi` without a checkpoint owner as
their behavioral red control (`storage.values.size === 0`).

**One change:**

1. Extend `PluginHostDeps` in `web/src/plugin-host.ts` with optional `getStartChatOwner`,
   `getSessionId`, `admitPrompt`, and `onStartChatChange` (plus `getPluginApiCaller()` export and
   read-only `lastStartChatResult()` / `startChatIssues()` accessors on `PluginHostApi`). When
   `getStartChatOwner` is supplied (which `web/src/App.tsx` always supplies in production), validate
   host readiness and configured model synchronously, then run `owner.checkpoint(opts)` and
   `owner.begin(cp.identity)` synchronously in the accepting tick before returning `true` or
   sending any effect.
2. In the serialized `runCheckpointed(intent, permit)` continuation, read only the deeply frozen
   `intent` (`intent.original.prompt`, `intent.promptId`, `intent.effective.*`, `intent.source.*`),
   check `permit.valid()` and target readiness before and after each transition (`set_cwd`,
   `new_chat`, `set_model`), enforce original `conversationId`/`sessionId` when `newChat === false`,
   and dispatch the final prompt via `admitPrompt` (`chat.admitBound`) with exact untrimmed
   `intent.original.prompt`, `id: intent.promptId`, and `forSession: targetSessionId`. Any step
   failure or `admitPrompt !== true` aborts continuation and records `continuation-failed` without
   sending into the wrong target or retiring the checkpoint.
3. Add `web/src/use-plugin-start-recovery.ts` (page-lifetime singleton `openPluginStartCheckpoint`
   bound to `getPendingRecoveryOwnerId()`) and `web/src/components/PluginStartRecoveryPanel.tsx`
   (read-only display of `recovery-required` entries, option presence tags, runtime issues, and
   corrupt/unknown records, with explicit non-destructive **Restore prompt to composer** and
   **Export raw JSON** actions, wired in `web/src/App.tsx`).

**Expected measurement:** focused unit suite `tests/unit/durable-plugin-start-host.test.ts`,
existing `tests/unit/plugin-host.test.ts` and `tests/unit/plugin-start-checkpoint.test.ts`, and
isolated actual-app Chromium fixture `tests/durable-plugin-start-host-test.mjs` verify:

- Exact untrimmed `original.prompt` (Unicode, CRLF, leading/trailing whitespace), option presence
  (`absent` / `undefined` / `value`), `promptId`, and `pluginId` are written and read back in
  `localStorage` before `startChat` returns `true` and before any `set_cwd`/`new_chat`/`set_model`/`prompt` effect.
- Mutating `opts` immediately after `startChat(opts)` returns `true` cannot alter the executed
  transitions, prompt text, or saved record.
- `newChat: false` refuses continuation if the active conversation/session drifts before prompt
  admission; transition timeouts or `admitPrompt` failure record `continuation-failed` and leave the
  checkpoint in `recovery-required` (`possibleEffects: true`).
- Quota, corrupt/unknown namespace keys (`catalogue-incomplete`), uninitialized/conflicting owner,
  or invalid model/readiness return `false` synchronously with zero effects and caller input intact.
- Reload keeps the record in `recovery-required` with no auto-replay; explicit user restore places
  the exact untrimmed `original.prompt` into the composer without deleting/retiring the record.

**Falsifier:** `startChat` returns `true` when storage/owner/validation fails, any effect precedes
the synchronous checkpoint+begin readback, `opts` mutation leaks into execution, `pluginApiCaller`
causes `source-mismatch` on `begin`, failed transitions still send the prompt into the wrong chat/cwd,
or reload auto-replays `startChat`.

**HIT (unit stage):** `tests/unit/durable-plugin-start-host.test.ts` (11/11),
`tests/unit/plugin-host.test.ts` (104/104), and `tests/unit/plugin-start-checkpoint.test.ts` (89/89)
pass **204/204 assertions** in a single sealed run. Isolated actual-app Chromium proof
`tests/durable-plugin-start-host-test.mjs` follows next.

## Hypothesis H-W2-BOARD-HOST-1 (before Board host/observer/reader integration)

**Evidence/problem:** `#593` (`web/src/roles-state.ts`, `web/src/components/RolesView.tsx`) holds
authored `BoardDraftSource` (`board_post` with inactive `picked` roles and untrimmed `title`/`text`,
and `board_close` with untrimmed `note`) in page memory only (`boardDrafts` / `boardSources`), while
`#598`/`#599` (`web/src/board-draft-store.ts`, `web/src/board-draft-reader.ts`,
`web/board-draft-recovery.html`) provide the typed IndexedDB store and standalone reader. Without a
host adapter (`web/src/recovery-board.ts`), current-source observer in `web/src/roles-state.ts`,
and 5th retained reader entry (`board.html`) in `scripts/pending-recovery-reader.mjs`, Board drafts
do not survive page reload or binary rollback, and `observeSchedulerSources` / `observeBoardSources`
in `web/src/use-chat.ts` must iterate `inspection.records` (`BoardDraftInspection` /
`SchedulerDraftInspection`).

**One change:**

1. Export `getBoardCurrentSources()` and `subscribeBoardCurrentSources(listener)` from
   `web/src/roles-state.ts`, notifying listeners when an authored `BoardDraftSource` is created or
   revised, and notify `roles-state` subscribers when `restoreBoardDraft` adds a recovered source.
2. Add `web/src/recovery-board.ts` (`createBoardSourceCheckpoints`), mirroring
   `web/src/recovery-scheduler.ts`: serialize per-`editorId` CAS/readback writes so initial
   `current` + `submitted` sources commit atomically in one transaction before `appAdmit` returns
   `true`, verify wire/source coherence (`board_post` trimmed `title`/`text`, `kind`, `"all"` vs
   sorted `picked`; `board_close` `id` and trimmed `note`), preserve newer current revisions when
   retiring a completed `reqId` via marker-only `retired: true` (never deleting rows), and expose
   `inspect()` (`inspectBoardDrafts`).
3. Update `observeSchedulerSources()` and `observeBoardSources()` in `web/src/use-chat.ts` to
   iterate `inspection.records` (`!record.retired` -> restore `record.submitted` and
   `record.current`, and report `inspection.status === "corrupt"`), and include `board.html` /
   `board.mjs` in `scripts/pending-recovery-reader.mjs`.

**Expected measurement:** `tests/unit/recovery-board.test.ts`, `tests/unit/board-draft-store.test.ts`,
`tests/unit/durable-board-admission.test.ts`, `tests/unit/pending-recovery-reader.test.ts`, and
`tests/durable-retained-readers-test.mjs` verify atomic initial `current`+`submitted` retention,
inactive `picked` role preservation when `toAll: true`, newer-edit preservation across retirement,
reload look-only restoration into `RolesView`, and standalone `board.html` reader verification when
`/assets/*` is blocked.

**Falsifier:** any wire admission before committed readback of `BoardDraftSource`, loss of inactive
`picked` roles or untrimmed whitespace across reload, retirement deleting a row or hiding a newer
unsubmitted revision, or `board.html` failing standalone/unauthenticated checks.

**Result:** **HIT** — `tests/unit/recovery-board.test.ts`, `tests/unit/board-draft-store.test.ts`,
`tests/unit/durable-board-admission.test.ts`, and `tests/unit/pending-recovery-reader.test.ts` pass
140/140; `tests/durable-retained-readers-test.mjs` passes 19/19
(`/tmp/durable-retained-readers-1793070907447/result.json`) including the 5th retained reader
`board-draft-recovery.html` with `web/dist` removed; `tests/durable-board-host-test.mjs` passes
16/16 (`/tmp/durable-board-host-1793071956733/result.json`).

## Hypothesis H-W2-QUEUE-ANSWER-HOST-1 (before AskHub #592 occurrence and applied-result host wiring)

**Evidence/problem:** `TaskQueuePanel.tsx` (`#592`) requires `answerBindings`
(`TaskQueueAnswerBinding[]`) and `onAnswerResult` (`TaskQueueAnswerResult`), refusing to enable or
clear a stuck-task answer without an occurrence-bound `questionId` and explicit `{ applied, reason }`
confirmation. Without host/client wiring on `UiTaskQueue`, `task_queue_answer`,
`task_queue_answer_result`, `use-chat.ts`, and `App.tsx`, the Queue panel lacks `answerBindings`
and `onTaskQueueAnswerResult`.

**One change:**

1. Extend `UiTaskQueue` in `server/protocol.ts` with `answerBindings?: UiTaskQueueAnswerBinding[]`,
   extend `task_queue_answer` with optional `{ reqId, queueId, questionId, question, choices, detail }`,
   and add `task_queue_answer_result` to `ServerMessage`.
2. In `server/agent-service.ts`, populate `answerBindings` in `taskQueueOf(conv)` from reconciled
   `ClientSession.stuckAsks` occurrences (`questionId: have.askId`), and in `taskQueueAnswer`
   validate exact `queueId`, `taskId`, `questionId` (`have.askId`), `question`, `choices`, and
   `detail` before calling `askHub.answer`, emitting `task_queue_answer_result` with `{ applied: r.ok }`
   while keeping legacy unbound `task_queue_answer` callers working.
3. In `web/src/use-chat.ts` and `web/src/App.tsx`, expose `answerQueueTask(request)` correlated by
   `reqId` + exact binding + active WebSocket (resolving `{ applied: false }` on disconnect/mismatch)
   and pass `taskQueueAnswerBindings` + `onTaskQueueAnswerResult` to `RightPanel`.

**Expected measurement:** deterministic unit/service tests in
`tests/unit/durable-cutover-integration.test.ts` verify `answerBindings` population, exact
occurrence acceptance, stale `queueId`/`questionId`/question refusal before `askHub.answer`,
disconnect/mismatch preservation (`applied: false`), and legacy `task_queue_answer` compatibility.

**Falsifier:** a stale `questionId` or `queueId` answers a newer occurrence, a disconnect resolves
`applied: true`, or `TaskQueuePanel` clears the user's answer without a matching `applied: true`
result.

**Result:** **HIT** — `tests/unit/durable-cutover-integration.test.ts` and
`tests/unit/recovery-client.test.ts` pass (42/42 and 18/18), proving `queueAnswerBindings`
populates occurrence-bound `questionId`s, `taskQueueAnswer` refuses stale `questionId`/mismatched
choices before `stuckAnswerSender`, `answerQueueTask` correlates `reqId` and resolves `applied: false`
on disconnect/mismatch, and `selectDraftToRestore` protects unsaved composer drafts across
reload/restart.

## Hypothesis H-W2-REFERENCE-VERIFY-1 (before default reference availability/bytes verifier)

**Evidence/problem:** `web/src/pending-send-storage.ts` requires `options.verifyReference` for any
non-inline `PromptAttachment` (`imageData === undefined && fileData === undefined`). `use-chat.ts`
did not pass a default `verifyReference` to `createRecoveryChatTransport`, causing reference
attachments (`@file` workspace references, `lines` slices, `uploadPath`, same-origin `imageUrl`,
and `conversation` references) to fail recovery admission.

**One change:** implement `createReferenceVerifier` in `web/src/recovery-chat.ts` and wire
it as `verifyReference` in `createRecoveryChatTransport` (with client-ID and view
context from `use-chat.ts`), verifying same-origin `imageUrl` bytes, workspace `path` / `uploadPath`
availability, size, and `lines` bounds via `/api/file?...&download=1`, and `conversation`
references against known conversations or readable session files, while rejecting `blob:`,
missing/changed files, out-of-range lines, and uncaptured live `page` references unless explicitly
granted for the active session.

**Expected measurement:** deterministic unit tests in `tests/unit/recovery-client.test.ts`
verify readable workspace/upload/image/conversation/granted-page references pass, while `blob:`,
missing/404 files, mismatched byte sizes, out-of-range line spans, and ungranted `mode: "page"`
references return `false` and preserve the original draft.

**Falsifier:** any unreadable, `blob:`, size-mismatched, or ungranted `page` reference is accepted
as complete without inline bytes, or a valid workspace/upload/image/conversation reference is rejected.

**Result:** **HIT** — `tests/unit/recovery-client.test.ts` passes 18/18, and
`tests/durable-retained-readers-test.mjs` passes 31/31
(`/tmp/durable-retained-readers-1793073850310/result.json`), including the 5th retained reader
`board.html`, simulated pre-W2 rollback UI boot on the same origin without touching W2 stores,
JSONL canary preservation, and byte-identical recovery across all 5 stores.

## Hypothesis H-W2-NO-DIRECT-PROMPT-BYPASS-1 (removing pre-init/DSH direct prompt bypass in use-chat.ts)

**Evidence/problem:** Ops HOME review of candidate `1d440ce5f603e70e819a2dc26ab3a61aa66e8537`
found a P0 production bypass in `web/src/use-chat.ts`: when `commandRecoveryReadyRef.current` was
`false` (before `session_initialized` or after socket close/reconnect) or in DSH no-session mode,
`admit()` bypassed `recovery.admit(message)` and called `sendDirectPrompt`, skipping durable
IndexedDB checkpointing and dispatching volatile RAM-only `pending_add` entries.

**One change:** remove `sendDirectPrompt` and `commandRecoveryReadyRef` from `web/src/use-chat.ts`
so `admit()` unconditionally delegates to `recovery.admit(message)` (with DSH no-session mode bound
to `dsh:${conversationId}` via `effectiveSessionId` and `recoveryViewRef.current.engine` synced on
`ready`), and update the synthetic unit-test socket harnesses in `tests/unit/ws-probe-and-ui.test.ts`
and `tests/unit/durable-client-review-regression.test.ts` to emit `commandRecovery: 1`,
`recoveryGeneration`, `session_initialized`, and `command_disposition` with an in-memory
`setNativeRecoveryCoordinatorFactory` backend.

**Expected measurement:** `tests/unit/locales.test.ts`, `tests/unit/chatinput-send-notice.test.ts`,
`tests/unit/ws-probe-and-ui.test.ts`, `tests/unit/durable-client-review-regression.test.ts`, and
`tests/unit/recovery-chat.test.ts` pass 128/128; `tests/durable-cutover-browser-test.mjs` passes
32/32 (`/tmp/durable-w2-browser-1793079326130/result.json`); and full `TZ=UTC scripts/check.sh --fast`
passes with zero uncheckpointed prompt paths.

**Falsifier:** any prompt submission bypasses `recovery.admit(message)` before `session_initialized`,
during reconnect, or in DSH mode, or any unit/browser test fails.

**Result:** **HIT** — 128/128 unit assertions and 32/32 composed browser assertions pass with
unconditional `recovery.admit(message)` enforcement.

## Verification and undo

Require #563–#567 landing **and #571's corrected Tool
Inspector result** before readiness acceptance. The two legacy-module defects (partial-adapter
validation and expansion-by-index) were corrected by #571, landed
`7c7d5185c711c3c5cbb3fe81ef40aa842aae529d` via `203-f91997`, per Ops home's checked report.
That report covers function-hook validation, stable escaped tool-name expansion state, four
partial-hook controls and insertion/reordering while preserving draft/focus; its worker gate
reported 505 files, 8268 passed, 16 skipped. This closes those module defects only, not full host
mounting/live proof or the durable public adapter. That module acceptance did not itself authorize
a deployment; the later recorded owner staged-rollout answer supplies the sequencing decision.
Then rebase,
complete the local package link, verify the new modules and all integration tests, build, and run
`TZ=UTC scripts/check.sh --fast`. Land detached with
`wt land`, then `pi-web-deploy --dry-run` and the landed-request deploy. Its single throwaway-chat
model health check is allowed by the owner-approved #570 plan.

Use the live-look procedure with an isolated browser and no actions on real chats. Record
measured UI/connection results separately from unit tests; no short observation can establish a
24-hour rate. Roll back an unsuccessful Wave 2 install with `pi-web-deploy rollback`; sessions
stay on the pi engine throughout.
