# Role-message guard contract v1

> **Delivered by #122 (ladder only).** L1–L5, L7 and L8 are wired live through
> `server/role-message-guard-host.ts` (see `docs/role-message-ladder.md`). L6 (protected scope) and the
> urgent option B are **not** delivered: the Owner chose "Ship now, urgent later" (dr-c512c42648d0)
> after #125 found no qualified native urgent source and #130 found no safe small design (C124 origin
> unrepresentable). Urgent-looking messages are ordinary; protected cases stay NOT DELIVERED.

Component C of Ops #122's approved split. **Type-only, inactive, not a released guard.**
`server/role-message-guard-contract.ts` emits an empty module. It exports no factory,
policy value, native verifier, store, dispatcher, registration or default instance.
The existing hard depth-6 behavior remains unchanged until #122 separately integrates
and qualifies the feature. Components must use this one contract, not a private fork.

## Binding policy and provenance

These are document SHA256 pins, not authentication or runtime approval:

| Document | SHA256 |
| --- | --- |
| PLAN-v3-SPLIT.md | 5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9 |
| PLAN.md | c8b8d6c109dcc7ed32187796b9785676dadea749085ce9819ba086194354e259 |
| PLAN-v2.md | ae4b1bbae8006f30085d006f40130b3aa445ba15b921021c7276349fcd8c3c0c |
| URGENT-PROPOSAL.md | 47689efd821d201b46d6ba22d158b6e5adfac4e8d015cc6956371045ce98a86c |

Private originals: `/home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12/`.
PLAN-v2 controls policy conflicts. Only urgent option **B, depth-only**, is selected;
the original proposal's urgency-based hourly exemption is NOT policy. Separately, the Owner's
2026-10-20 direction (dr-c6daedfa9fef, Ops #318) exempts the server-derived sender roles
**temper and ops only** from the ordinary hourly refusal, across all their chats. There is no
hourly backstop for those two roles; usage is still recorded. PLAN-v3 changes staging only.
The frozen v1 policy fields, contract/policy pins and durable state format stay unchanged;
the role-specific exemption is applied beside that policy, not stored in it.
Version literal: `role-message-guard/v1`. A version/policy/contract digest mismatch is
unavailable, not permission to fall back to an unguarded path. Landed commit, tree,
source SHA256 and consumer handoff are recorded in private `split/contract/HANDOFF.md`.

## Ownership and API boundary

| Owner | Responsibility | Contract surfaces |
| --- | --- | --- |
| C / #124 | This single erased contract and law examples | all exported types; no implementation |
| P / #125 | Read-only qualification of native producers | evidence manifest; no runtime API supplied |
| E / #126 | SINGLE admission/state/transaction authority | `GuardCoordinator`, `GuardStorePort`, all state/receipt/result types |
| A / #127 | Explicit role decisions, native Owner adapter, isolated views | request/context/question/decision types; calls E for every mutation |
| U / #128 | Qualified producer lookup and fixed native templates | incident/evidence/notice types; calls E for every admission |
| V / #129 | Independently derived acceptance cases | implements injected harness against these interfaces, never copies E's oracle |
| I / existing #122 | Sole central wiring, combined review and installation | authentic invocation lookup, real verifier/transport binding, readiness gates |

All functions are **interface methods for future injected implementations**, not SDK
methods. No factory name or undocumented native API is implied. A/U never maintain
parallel counters, grant stores, decision stores or outboxes. All reads and mutations
use E. I alone registers runtime consumers. Needed changes return to Ops before any
consumer changes the frozen interface; all consumers pin the same commit and digest.

- `GuardUntrustedInput`: discriminated agent input. Existing ordinary callers map to
  `send` in I without changing their existing wire schema. Decode unknown fields with
  actual runtime validation. Unknown operations/extra authority fields cannot grant.
- `GuardInvocationReference`: host-resolved invocation key, not an agent-selected role,
  session file or tool-call string. I binds its resolution to the real tool closure.
- `GuardHostVerifier`: verifies invocation/causality, selects approver, verifies role
  decision/Owner answer/native incident, and revalidates inside admission and dispatch.
- `GuardCommand`: internal E entry. `request_record` is a proposal; E reconstructs
  initial state/times/notification keys and rejects caller-selected approvals. E also
  revalidates decision authority and first-answer binding under its writer lock.
  `control_send` contains NO arbitrary body: E renders the bounded stored request or
  decision. U cannot select a protected recipient through `protected_send`.
- `GuardStorePort.transact(identity, update)`: one writer; callback sees canonical
  state under the same lock. Next state, canonical accepted legacy record, all quota
  and grant uses, outbox/wake identity and result form ONE recoverable durable commit.
  The callback MUST NOT dispatch, wake or acknowledge a speculative write.
- `GuardTransportPort`: dispatch/wake/query only already committed entries after
  fresh revalidation. A confirmed receipt must identify this exact dispatch/wake key;
  `unknown` is not success, denial, handled status or safe retry permission.
- `GuardCoordinator.status`: authorised read only, with found/authoritatively absent/
  unavailable/unknown distinctions. It is not an outgoing communication. A status
  query cannot create a grant, notification, request generation or new business root.
- `GuardConsumerBinding`: evidence pins and explicit readiness blockers, not a feature
  flag, authority token or proof that any blocker has been resolved.

`GuardHostVerified<T>` prevents accidental compile-time mixing only. **Branding is not
authentication.** It has no exported minting function or runtime symbol. A type cast,
serialized brand, copied proof, caller-held signature or fake verification adapter
cannot establish trust. Persist only proof references; revalidate restored records
against the real native authority before using them. Matching structural fields does
not prove the semantic truth of a declared goal or progress claim.

## Behavioral laws

Each law is binding on E/A/U/I. Component C's tests are static/type checks and fixed
synthetic law examples, NOT tests of future runtime implementations.

### L1 — exact depth ladder and finite uses

Causal NEXT business hop 1–6 needs no new continuation grant. Hop 7–11 needs an
explicit selected responsible-lead/COO or genuine Owner grant. Hop **12 inclusive and
above** needs actual Owner authority; 12 is escalation, not an absolute hard stop.
No automatic progress credits, standing delegation, timeout approval, root-24 cap,
16+4 hourly reservation, generic Auto approve or model-selected Owner decision.

For requested quantity n in **1–5**, next blocked depth d has upper hop d+n−1;
lower-tier upper hop is capped at 11. Offer only quantities fitting that cap, rather
than silently converting an over-broad request. At d=7,n=5: 7–11. At d=11 lower tier
allows n=1 only. At d=12,n=5 Owner: 12–16. Grant expiry is issuance+**3,600,000 ms**,
not sliding. Both maximum accepted uses and upper hop must permit every send.
Repeated sends at one depth and all participants/branches share the same use budget.
Rejected attempts, control messages, protected notices and confirmed same-record
transport retries consume no business-grant use. Ambiguous reservations stay held.

### L2 — origin, legacy and control identity

The native verified incoming record determines root/parent/next hop. `replyTo` is
routing only. FYI, rewording, recipient/kind change, omission of replyTo, reconnect,
restart, branch copy or an approval round-trip never lowers depth or creates a new
root. Multiple sends from the same input share next hop but consume separate uses.

`rooted` may mark a genuine host-verified non-role origin. `legacy_boundary` is an
explicit anchor for the exact authenticated legacy incoming id/hash, preserving its
stored depth+1. Its historical root is **unknown**: do not reconstruct nonexistent
parent links or imply historical root scope. Unknown/missing/ambiguous/pruned/stale
causality is blocked; it never becomes hop 1. No transcript scan, historical approval
migration or replay/backfill of old refused notices. A decision notification restores
the original request's causal binding, not the control record's depth.

Identity/fingerprint binds policy, original causal binding, authenticated origin
role/session/task/incarnation, request/decision generation, participants/recipients,
operation and exact structured scope. Grants additionally bind quantity, upper hop,
issue/expiry, approver/event and audit identity. Same operation key+same fingerprint
returns the original result. Changed fingerprint with that key is an identity conflict,
not a new message. No caller-selected root, task or source metadata is authoritative.

### L3 — actual approver and actual Owner

No trusted lead registry was found in the inspected identity definition. Default to
COO. A lead is usable only through an already supported Owner-authorised native
binding. Titles/task text/initiative tags and proposed tracking records are not one.
Lower-tier answers come from the selected role's **current authenticated home**;
task/subagent/other-role sessions, stale homes and self-approval fail. If requester is
COO and there is no distinct authorised lead, require Owner rather than self-grant.
Revalidate authority at decision and use; changed assignments invalidate the binding.

Owner answer must originate in the actual authenticated browser or existing
specifically authorised Owner Telegram route and match this exact question,
generation and finite choices. `from: browser`, `ownerChannel`, `forOwner`, plugin
asks permission, copied ids, COO statements, generic queue Auto approve or transcript
prose are NOT sufficient. No agent-callable Owner answer operation. First actual
answer wins across transports/reconnect; custom prose cannot expand the allowed
quantity/scope. Durable first-answer arbitration is an integration requirement.

### L4 — bounded approvals without a depth-recursion loophole

One open request per root/tier/scope generation; at most **20 outstanding/requester**;
request expires after **86,400,000 ms**. States are context_needed, awaiting_approver,
awaiting_owner, rate_limited, held, approved, denied, expired, exhausted, revoked,
unknown. A lower-tier pending state is not falsely an Owner question.

Require complete `GuardApprovalContext`: goal, progress/change, prior decisions,
reason, exact next step/outcome, all outstanding questions, options/tradeoffs,
time/cost/risk, exact bounded communication authority, native facts versus declared
claims, relevant safety/scope/holds. At hop 12+ this full context belongs INSIDE native
dialog detail, with deny/one_send/requested_quantity choices, never always-allow.
Empty or clipped essential context is context_needed/unavailable, not accepted.

One initial and one decision notification, with same-record transport retries; one
explicit upward escalation, never a timer, lead→COO loop or automatic generation.
Control envelopes bypass ONLY recursive business-depth approval. They consume the
sender's ordinary hourly allowance and retain the original business binding. Read-only
status and the human Owner answer itself are not agent outbound communications.
A durable decision without notification may be visible as rate-limited/held. Approval
never automatically sends business payload: a fresh explicit send rechecks all guards.

### L5 — one ordinary hourly ledger

**20 accepted communications per origin ROLE per rolling 3,600,000 ms**, shared by
home/task chats, branches, recipients, business/control/protected traffic, **except temper
and ops have no hourly limit** (Owner, 2026-10-20, dr-c6daedfa9fef; Ops #318). For every
other role the twentieth is the last; the twenty-first is blocked **even if urgent**, with
the existing refusal text/reason. Only the server-derived sender role selects the exemption,
never agent input. All roles' accepted communications remain recorded in the same hourly
ledger. Accepted waiting, failed and indeterminate deliveries keep their charge. Reports
already excluded by the old reader remain reports; new controls/protected notices MUST NOT
be disguised as report. The exemption skips only the ordinary hourly refusal: chain limits,
grants, approvals, scope, causality, pauses/holds and the board's post cap are unchanged.

Trusted finite safe-integer time/counter validation is required. Event age must be
0≤age<window; exact window expiry frees capacity. Future timestamps, clock rollback,
unknown clock, corrupted/reordered state or incomplete recovery never refill counters.
Use a durable conservative time watermark; uncertainty blocks or holds, not reset.
Human Owner answers, rejected admissions and proven idempotent retries add no charge.
Ordinary/protected numbers cap communications, NOT providers, model tokens or dollars.

### L6 — selected protected scope, never action authority

Only safety_action_notice, critical_risk_notice, safety_action_result qualify. U must
bind actual qualified native producer/version/incarnation/event/episode/generation,
resource/owner/origin/causality, active deterministic predicate, native action/intent/
terminal receipt where needed, permission and assigned destination. Generic cancellation,
shell success, model/tool prose, caller urgency, stale/dead/contradictory source or a
fresh ticket for the same incident is ineligible. P's negative readiness result blocks
U/full I delivery; fixtures cannot replace it. No new classifier/monitor/meter.

Types 1/2 share **one initial** slot per native episode; at most **one terminal result**
(succeeded/failed/indeterminate) of the same evidenced authorised action. No result
requires inventing an initial delivery, but all episode/storage/quota bounds still
apply. Initial action-required information can have null action authority and grants
NONE. Accepted/underway actions and results require their real separate authorisation.
Unknown outcome is not success, action/retry authority or another result slot.

Exactly **one verified assigned destination**, no caller broadcast or alternate route;
changed ownership parks the notice. **2 new incidents/origin/hour; 4 protected accepted
notices/origin/hour AND destination/hour; 12/system/hour; 12 live incidents** including
pending/unknown reservations; incident expires after **86,400,000 ms**. Complete fixed
rendered template at most **2,048 UTF-8 bytes**, including required scope/unknown/receipt
facts, never clipped. No attachment, prompt, transcript or executable instruction.

All smaller bounds apply SIMULTANEOUSLY with ordinary 20/hour for non-exempt origins;
the Owner's ops/temper ordinary-hourly exemption does not relax any protected bound. Protection bypasses
DEPTH ONLY, preserves original depth and consumes no continuation grant. It does not
propagate to ordinary replies. Reserved result storage is NOT future delivery capacity;
a late result faces current limits. Failed/unknown accepted deliveries keep every charge.

### L7 — durable admission, outbox and no speculative retry

E is the sole mutation writer. One recoverable transaction binds grants/requests,
ordinary/protected quotas, incident slots, exact canonical accepted legacy record,
receipt, audit, outboxId/dispatchKey/wakeKey and operation fingerprint. No accepted or
recorded acknowledgment before durable commit. Rejected attempts have no accepted
communication; separately recorded request/decision status is not a sent message.

States prepared/committed/unknown are distinct. Persist enough `GuardReservation`
metadata to hold every uncertain quota/grant/incident/control slot during recovery.
Audit-only or prepared state is NOT a grant or accepted delivery. A definitely failed
commit dispatches nothing; ambiguous write/rename/flush/crash returns unknown, keeps
reservations and permits only querying the SAME identity. No speculative refunds,
fresh-key blind resends or cross-channel fallback. Concurrent final-use/first-answer
attempts serialize; duplicates return the original outcome. A pruned id is not
`absent: authoritative`; source/store uncertainty must stay unknown/unavailable.

Accepted, dispatched, handled and wake acknowledged are different facts. Transport
must prove actual same-key dedupe before retry; this contract does not claim existing
native exactly-once delivery. Idle wake promptly; busy wait ONLY for current turn.
No artificial batching, interruption or second wake. No extra relay/delay of native
queue completion. If actual no-duplicate behavior cannot be proved, leave unknown.

### L8 — holds, retention and rollback

Every path preserves Owner pauses, disabled wakes, role delivery pause, access,
scope, independent spend/consent/safety holds and queue/session/source-permission
binding. A committed/visible held state cannot wake a paused role, start/resume a task,
judge/reader, clear a task question or grant action/spending/expanded access.

`GuardRetention` requires finite positive safe-integer caps for requests/grants/
transactions/audits/outbox/usage/tombstones/context and finite settled retention.
Exact additional storage numbers/replay horizons are NOT set by Owner policy:
E proposes them to Ops/I before runtime integration. No unlimited/default allocation.
At exhaustion retain bounded overflow count/status, not unlimited incident bodies;
saturate the count rather than overflow it. Preserve active/unknown/unsettled records
and quota/proof evidence through safe settlement/expiry. Cannot prune a still-relevant
unknown reservation or trust a removed id anew. Retain bounded dedupe tombstones;
unknown source replay horizon means no safe tombstone pruning—fail closed on capacity
or unavailable provenance rather than mint fresh allowance. No indefinite full-model,
transcript, prompt/tool-body capture. Native source remains authoritative.

Rollback mode disables issuance/use of grants and protected exemptions, restores hard
depth **6** and ordinary **20/hour**, and preserves all new words/ids/accepted charges,
causality/Owner routing and audit receipts. NO earlier data snapshot overwrite or grant
resurrection on reinstall. Old reader representation uses the existing RoleMessageRecord
schema with a non-report kind, original chain even >6, original timestamp and sender.
New grant/audit state cannot live solely in unknown top-level legacy fields that the
old loader drops. Actual prior-reader accounting, crash consistency and reinstall
proof belong to E/V/I and block deployment until demonstrated.

## Inspected native boundaries and explicit blockers

Source baseline: `9fe5b68cd451cdb3123475408b9898c9efc3ff90`, bundled pi SDK `1.0.1`.
These findings are source observations, not real-chat tests or authority receipts.

| Boundary | Actual supported observation | Requirement NOT supplied by C |
| --- | --- | --- |
| `server/agent-service.ts` role sender closure; `server/role-messages.ts` verified/handlingDepth | native sender identity, current home, exact stored incoming id/hash/target/depth | trusted preserved causal/control/legacy binding under all supported callers |
| `server/identity-service.ts` IdentityDef; registry access | current identity/home definitions, no trusted lead field | authorised lead verification; otherwise COO only, no new registry |
| `server/asks.ts` AskHub; agent-service askUser/resolveQuestion | in-memory first-answer resolution, question ids; source strings and plugin permission | authenticated actual Owner binding, exact generation/choices, durable first-answer arbitration |
| `server/plugins.ts` asks.answer; native protocol/browser response path | plugin id passed by host, asks permission; browser response routing | plugin permission/source label alone does NOT prove the Owner personally answered |
| `server/role-messages.ts` load/save/send | old load rebuilds known top-level fields; save catches write errors; accepted records account hourly before transport | atomic legacy+journal durable publication and honest failure; no save-is-commit assumption |
| `server/role-messages.ts` host deliver/note; agent-service wake routes | existing native delivery/no-wake FYI, after-current-turn routing | durable exact dispatch/wake identity and safe uncertain retry proof |
| SDK SessionManager and appendCustomEntry | session entries/branches and extension APIs | no cross-file role-ledger transaction, native critical incident or Owner authentication API supplied |
| existing native urgent sources | no suitable producer established by C investigation | P qualification required; unsupported categories stay unavailable |

The interface ports intentionally express REQUIRED behavior without claiming those
APIs already exist. Native Owner authentication, durable first answer, atomic legacy
publication, transport/wake dedupe, previous-reader accounting and bounded replay
retention require actual implementation/evidence. C can complete while these remain
explicit integration blockers. It cannot claim full #122 completion or live protection.

## Checks and consumer handoff

The contract tests validate frozen policy literals, exported shapes, nominal separation,
erased emitted module, known positive/negative boundary laws, quantities, scope/control
identity, legacy anchors, replay/clock/unknown/rollback states and storage representations.
The test-local law evaluator is an EXAMPLE ORACLE, never a guard implementation; its
passes are not E/A/U native/runtime acceptance. V independently supplies acceptance.

Run focused tests after additions, required type/build checks, full normal sealed gate
and normal wt land. No hooks, configs, limits or installer changed. Preserve exact
commit/parent/tree/blob/SHA256/path list and limitations in private handoff. Consumers
must use type-only imports, pin this contract, and return interface disagreements to
Ops. Only #122 may later register, qualify, deliver/install once and establish actual
integrated/runtime/installed/rollback evidence. Old FE32/H7 notices remain unsent.
