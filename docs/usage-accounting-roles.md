# Automatic cost view — inert adapter

Ops #302 · project `automatic-cost-accounting` · accountable lead: Ops.

## H-AUTOCOST-3 (before implementation)

Wrong, with evidence: `server/roles-spend.ts` reads only manual v1 tallies;
`AccountingReport` in `server/usage-accounting-contract.ts` has policy context
but no role/task/initiative subject. Reusing an unscoped report for each role
would repeat global totals. A manual `ok` label cannot certify automatic
coverage, prices, payer, or freshness.

One change: one pure, closed subject-bound view adapter using the unchanged #293
contract. Validate explicit source metadata before computing its report; keep
observed, deduplicated, allocated, exempt and other-basis amounts separate.
Unknown remains unknown; legacy manual data is reference-only.

Expected: exact outputs on fixed synthetic subjects, generic Design and
Architecture policies, known exemptions, missing source/price/identity/scope,
wrong-subject controls, and Pacific/DST boundaries. Only complete, fresh,
policy-wide evidence can carry a known reporting remainder. No view changes
permissions. Disproof: unknown becomes free allowance, a global total appears
per role, exempt initiative usage disappears, manual/old observation becomes
fresh automatic data, or any production reader/control changes.

Fixed examples (USD decimal text):

- Complete Design own `0.1`: gross/dedup/own `0.1`, policy remainder `1999.9`.
- Same-attempt alias: gross `0.2`, dedup/own `0.1`; gross is observations, not a
  duplicate-free spend total or certified lower bound.
- Initiative own `0.1` + requested `0.2` + Team `0.3`: dedup `0.6`, eligible own
  `0.1`, exempt `0.5`; a subset of a role budget has UNKNOWN policy remainder.
- Architecture initiative scope: same numeric rules, separate source-backed
  policy; no Design-only special case and no activation from a policy label.
- Unpriced/unresolved/mixed home turn: known zero subtotal/lower bound may be
  shown as such; UNKNOWN total/remainder, never complete zero spend.
- Stale source newly read: covered/observed timestamps stay old; read time is
  not freshness. Previous-week manual data stays a stale manual reference.
- Wrong-role/global/missing task membership: invalid subject projection, no
  numeric automatic view. No guessed payer from lead, queue or task title.

## Boundaries

Only `server/usage-accounting-roles.ts`,
`tests/unit/usage-accounting-roles.test.ts`,
`tests/fixtures/usage-accounting-roles/`, and this document belong to this task.
No production importer, reader switch, layout, polling, install, deploy, stop,
debit, cap, permission, root registration or manual-file write is included.
All fixture roots/role bindings are synthetic; none authenticates a native
producer. Missing supported sources do not block pure tests or authorise scans.

## Ready typed API

`projectUsageCost(source: unknown, request: UsageViewRequest, manual?: unknown): UsageCostView`
from `server/usage-accounting-roles.ts`. It has no I/O, clock, cache, timers or
production callers. Its only value import is the unchanged pure contract;
`UiRoleSpend` is a type-only compatibility import from `server/protocol.ts`.

- `UsageSubject`: role id; canonical task `{queue, task, addedAt}` (original
  birth); or initiative id. No global/project/title/lead subject is supported.
- `UsageViewRequest`: subject, selected `policyRef`, explicit `policySubject`,
  canonical UTC `asOf` evaluation target and `staleAfterMs`. No defaults to the
  read time. Supported policy extents are role and initiative, with exact
  `role:<id>` / `initiative:<id>` scopeRef correspondence. A task is a reporting
  slice, not a newly invented task allowance. Other scope formats fail closed.
- `SubjectUsageSource`: closed `subject-usage/1` envelope, same subject, bounded
  `evidenceRef`, independent `{factId, role|null, evidenceRef}` for every fact
  identity, and unchanged `AccountingInput`. Role bindings must come from a
  supported numeric producer/native identity record, not from this adapter,
  the allocation being evaluated, queue owner, lead, title, or path guess.
- Role projection validates every observed fact's independent role and any
  non-null allocation payer. Task/initiative projection validates every
  observed fact against canonical event-time membership, not today's parent.
  Missing/contradictory evidence invalidates the whole projection; it does not
  silently discard foreign leaves and call the remainder complete. Aggregate
  snapshots require mapped subject leaves and remain reconciliation evidence,
  never extra charges. Null source is unavailable, not a zero report.
- Selected policy must be present, consistent, and bound to its explicit
  extent; a role report cannot borrow a different role's policy. Generic
  source-backed Design and Architecture examples use the same code. Policy
  metadata describes reporting context; it is not owner consent/activation.

The envelope is structural validation, **not authentication** of a native root,
policy or producer. A future supported producer must supply the complete
subject partition, independent payer evidence and subject-valid coverage. A
filtered subset of an unscoped ledger, a total-only Temper payload, or a global
coverage heartbeat is not enough to certify that partition. If those bindings
or a supported policy are absent, pass an unavailable source; never create a
policy just to unlock a view. Membership history may include other parents;
foreign cost leaves must not be included in a claimed subject source. Preserve
reconciliation evidence only when its whole covered leaf set belongs to that
subject; otherwise do not assert complete scope coverage.

### Output and labels

`UsageCostView` is versioned, `reportingOnly: true`, and contains:

| Field | Meaning |
| --- | --- |
| `list.grossObservations` | Gross priced observations; may overlap; **not** a certified lower bound or duplicate-free spend. |
| `list.deduplicatedRecorded` | Contract's deduplicated known list subtotal, all allocation scopes. |
| `list.verifiedOwnLowerBound` | Verified own-policy lower bound only; not all subject usage. |
| `list.exempt` | Verified requested/Team costs, already included in dedup total. Never hide them from an initiative. |
| `list.otherPolicy`, `list.unallocated` | Other-policy and unallocated known list subtotals, already included in dedup total. |
| `otherBases` | Provider-reported and invoice known amounts and unpriced counts, separately labelled. Never added to list estimates or each other. |
| `counts` | Unpriced list facts, unallocated facts and unresolved identities, distinctly. |
| `sources`, `faults`, `issues` | Closed/bounded coverage states and counted contract fault codes, no raw faults, errors, stream names, fact ids or payloads. Unknown contract codes become `unknown-accounting-fault`. |
| `balance` | Neutral reporting remainder only, **not** a permission or enforcement control. `progress` is always null. |

Money remains exact USD decimal text (18 integer / 12 fractional digits per
contract); no floating-point conversion/rounding or currency guessing. Gross,
dedup and allocation rows are not additional amounts to add together. Likewise,
role/task/initiative projections are overlapping views, not additive subtotals
for a global bill. Two roles never receive one reused unscoped report.

States: `complete`, `partial`, `stale`, `source-unavailable`, `invalid`. Complete
means complete *subject list evidence*, not invoice reconciliation or work
permission. Missing prices/identity/allocation/coverage stay explicit even when
the known subtotal or lower bound is exactly zero. An initiative/task slice can
be complete for that subject while its role-policy remainder stays UNKNOWN.
Only complete, fresh evidence for exactly the whole selected policy subject can
expose the contract's reporting remainder. `remainingUsd: null` has the exact
label `UNKNOWN — no certified budget remainder`; never convert it to zero, a
full allowance, green/within-budget wording or a safety-implying progress bar.
Even a known remainder is neutral and labelled not spending permission.

### Week, timestamps and legacy compatibility

Weeks and occurrence attribution use the contract's Monday–Sunday
`America/Los_Angeles` boundaries, including spring/fall DST. `evaluatedAt` is the
caller-supplied evaluation target; it is not freshness. `asOf` is the oldest
required covered watermark; `observedAt` is the oldest required observation.
Missing/unavailable/unknown/conflicting coverage cannot produce a certified
covered as-of. Freshness uses the older of covered/observed timestamps, never
the current read time; recent rereads of old coverage remain stale. Source
coverage still exposes its own bounded timestamps and state. Equal-time
conflicts stay faults; stable input ordering makes secondary fault codes
independent of incidental coverage-row order.

Optional `LegacyManualInput` wraps the **already-read** existing `UiRoleSpend`
projection, its actual role and source timestamps/week dates (nullable when
not available). Supply canonical UTC timestamps from the original source,
not a read-time timestamp. This adapter reads no spend.json, including other
roles' private files. Legacy none/unreadable/old-week/ok/over/stale states remain
`manual.legacyState`, with the label `Manual tally — stale/unverified reference
only`. Source update/week values and formatted amounts remain reference data;
legacy prose/relative age is not relabelled as fresh automatic data. Missing
update time remains null. Only the matching role may receive a manual reference;
never use a role tally as a task/initiative total. Manual `over`/`stopped` is not
an automatic stop or permission input. The existing parser, amounts, weekly
rules and stopped file remain untouched.

## Exact minimal future Roles wiring plan (NOT implemented/approved here)

Prerequisites: landed tested collector and native numeric capture modules,
verified same-attempt identities/revisions, independent supported payer/root
bindings, canonical task births and event-time parent history, a source-backed
selected policy and subject-valid required-stream inventory/coverage. Temper
must supply numeric tokens, price basis/rate status, identity and completeness,
not a prose/aggregate-only total. Missing items must stay unavailable/partial;
fixtures do not register approved native producers. This task is independently
usable/tested without those implementations; it makes no live-meter claim.

A separately planned wiring task should:

1. Add one **read-only** subject-scoped bridge around the tested collector output
   (its own new server file). On the existing Roles snapshot read path, assemble
   exactly one bound source per requested subject, never copy a global report
   into the role loop. No scanning real chats or arbitrary private files, timer,
   new poller, budget file write, activation, debit or stop. Absent source/policy
   returns `projectUsageCost(null, request, legacyReference)` where a valid
   request is available; unsupported policy context is explicitly unavailable,
   not a borrowed Design policy. Keep initiative requested/Team usage visible.
2. In `server/roles-overview.ts`, add an optional `usageCost` alongside unchanged
   `spend`, calling the bridge per role. Keep `readRoleSpend` and
   `server/roles-spend.ts` unchanged; unavailable manual timestamps stay null
   unless the approved reader already provides them. Add the DTO type to
   `server/protocol.ts` / existing generated web type export path
   `web/src/types.ts` (follow `check:protocol`, do not duplicate divergent types).
   Do not expose ledger leaves, raw errors, native records or stream/path names.
3. Add closed consumption of the new DTO in `web/src/roles-useful-model.ts`,
   `web/src/roles-panel-model.ts` and `web/src/roles-exact-model.ts`; keep the old
   manual branch for compatibility. Do **not** squeeze automatic values through
   legacy `projectSpend`: it parses formatted USD as Number and computes a bar
   ratio, which cannot express UNKNOWN/exact automatic evidence. Preserve layout
   and card geometry. In `web/src/roles-exact-view.ts` / the existing Roles
   component path, use neutral labelled text for the new amounts, uncertainty,
   timestamps and separate bases; no automatic safety bar or green balance.
   Initiative consumers reuse the same adapter with an initiative subject, not
   the manual `byInitiative` own-work list (which omits exemptions).
4. Add isolated synthetic bridge/protocol/browser-projection tests for complete,
   partial, unavailable, stale, zero, cross-role, mixed/exempt initiatives and
   exact-money values. Run the unchanged normal sealed gate. Any install is a
   separate authorised `pi-web-deploy` step; after it, a look-only Roles check
   must verify real subject bindings, UNKNOWN labels, all initiative usage and
   source timestamps without touching chats or controls. If actual sources are
   unavailable, the live result is unavailable—not a failed fixture disguised
   as a live meter. No install/look/browser action belongs to #302.

## Verification result

H-AUTOCOST-3 **HIT on fixed evidence**: 92 assigned adapter cases plus all 74
unchanged contract cases passed together once after implementation, in a sealed
home. Full typecheck, assigned-file Prettier check and sealed web/server/vendor
build passed. Exact full-view fixture and negative cases cover subject/policy
binding, uncertainty, exemptions, exact money, freshness, legacy references and
Pacific DST/Monday transitions. Static checks confirm no production reader
wiring or I/O imports. Only the four assigned path areas changed.

Landing additionally requires the unchanged normal `wt land` sealed gate; its
receipt/result is returned with task completion. Build output remains in the
worktree only. No production reader, page/layout, install, live source, budget
file or work permission has been changed; no live-meter claim is made.
