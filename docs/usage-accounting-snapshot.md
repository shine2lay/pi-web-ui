# Subject snapshot bridge (#315)

Accountable lead: Ops. Worker-only, reporting-only; no collection, timer, source
read, installation, budget inference or permission change.

## H-WIRE-5 — retain subject and collector evidence

Problem/evidence: `input()` alone omits collector quarantine, corruption and
capacity fences. Reusing an accounting report for every role misattributes global
amounts; requiring a policy hides ordinary observed requested/Team usage. A cache
that imports the builder also pulls accounting onto the main thread.

One change: fold pinned, dependency-complete numeric partitions into independently
bound subject views with #307 `projectObservedUsage`, and evaluate #302
`projectUsageCost` only with an explicit supported policy context. Carry the
fault-bearing W0 header into every subject. Keep a separate, types-only cache.

Expected/measured: synthetic exact-decimal fixtures retain every matching leaf,
requested/Team amounts, task birth/event-time parent, revisions, aliases and
nonadditive run reconciliation; every collector fault removes certified remainder.
Closed DTOs contain only public subject identifiers, safe counts and fixed codes.
The cache performs only bounded validation/replacement and scalar age/week checks.
Falsifiers: cross-role/global reuse, omitted collector fault, freshened source on
reread, policy-required observed usage, private reference in a DTO, or any engine
reachable from the cache/main-thread graph. Outcome: HIT after the fixture fixes
below: all 52 new cases and the normal sealed gate pass. The first gate was a MISS
(two invalid initiative fixtures and a missing local compiled CLI dependency).

H-WIRE-5a: the two mixed-initiative fixtures set `payerRole: null` on native-root
exempt allocations, forbidden by the frozen contract (`native-root-required`),
and cloned a Design root for an Ops allocation. Correct the fixtures to retain
native payer/root agreement; make the independent source-role witness null to
prove initiative observations do not require role attribution. Expect exact
`0.3`/`0.6` usage and `4.9` initiative remainder with no production relaxation.
Any wrong subtotal or missing exemption falsifies this fixture correction. Build
server artifacts in this worktree before the final gate, because the existing CLI
print test imports compiled `plugin-updater.js`. Outcome: MISS for the complete
funding expectation; observed initiative usage and compiled CLI now pass. The
frozen #302 binding correctly refuses funding with a null independent role witness.

H-WIRE-5b: keep the verified Ops witness for the complete initiative funding case,
then separately remove it and require the same exact `0.6` observed subtotal with
funding unavailable and UNKNOWN remainder. Expect `4.9` only with full independent
payer agreement; certification with the missing witness falsifies this split.
Outcome: HIT; both the complete and independently unavailable funding cases pass.

## Worker handoff

The builder accepts explicit subject requests, a fault-bearing collector header,
source coverage/inventory metadata and an iterable of pinned **dependency-complete
partitions**. These are not transport pages. W0 `evidencePages()` pages may split
revisions, aliases and run leaves: W6 must assemble each bounded numeric dependency
component using the W0 index before supplying it, retaining all numeric history,
complete task-parent history and the relevant root/policy context. Repeated context
must agree across components; alias/run leaves cannot cross a component boundary.
Every partition carries the identical pinned header and independent per-fact role
witnesses. No global report is copied into a role. Completion is explicit; an
aborted/unsealed iteration is not a complete scan. No supplied callback does I/O
inside this pure builder. Unknown source/policy remains unavailable/not evaluated.

Partitions are bounded by W0's 4096-row/4 MiB dependency limits. Whole-week numeric
arrays are neither required nor retained. A bounded identity set detects a split
or repeated component; duplicate leaves across partitions invalidate the fold,
never add a revision twice. An aborted scan retains already verified component
subtotals, with UNKNOWN completion/remainder. Overflow, changed generation or an
invalid component invalidates the numeric fold; fixed faults survive.
Subject views overlap (role/task/initiative); they must never be added together.
Role attribution means source-attributed usage, own and requested mixed, not payer
or funding attribution. Unknown role binding prevents a complete role view, but
does not invalidate an independently bound task/initiative. Only shared collector
faults are on the outer envelope; subject faults stay in their own views. The
policy-free observation branch excludes funding rows (not usage leaves), so payer
or absent policy cannot override an independent source role. The funding branch
keeps the original allocations/roots/policies.

Task public queue identity is SHA-256 of the private queue reference. Task windows
start at the original `addedAt`; initiative membership is event-time membership,
not the task's current parent. Run snapshots reconcile against their complete leaf
set once, before subject projection, never become extra charges. Only their
reconciliation faults are carried to affected subjects; neither global totals nor
pruned aggregate leaf sets enter a subject projection. Funding is weekly and evaluated only for role or
initiative policy subjects; task lifetime usage does not inherit a weekly budget.

No worker is started here. W6 owns native independent-witness verification, bounded
index/component assembly, a lifetime-locked Worker, epoch activation and feeding
validated messages into the cache. These functions are reporting seams, not a way
to register native roots, policies, sources or spending authority.

Worker entry: `buildUsageMeterSnapshot(build: SnapshotBuildInput): UsageMeterSnapshot`.
No whole-week numeric array is retained. Identity/context fences have the W0
index-entry cap; dependency rows/bytes and public source/subject/message counts
have W0 bounds. W6 must still set W0 Worker heap/RSS limits and own termination.
At public Cartesian-capacity overflow, all subject keys remain explicitly
unavailable and EVERY shared fault stays on the envelope; if necessary subject
fault lists collapse to `store-capacity`. No amount or remainder is certified.
The Roles getter joins the shared codes back into the selected role, so it cannot
hide a collector fault even in this bounded fallback.

## Main-thread handoff

`usage-accounting-meter-cache.ts` imports only W0 meter-contract **types**. It must
not re-export the builder or import accounting, filesystem, Worker or protocol
code. Its own bounded closed-message validation is checked against W0's oracle.
An explicit active epoch is required; sequence replacement is monotonic within
that epoch. Getter results are detached; reading cannot renew source timestamps.
Every read independently checks age and Pacific Monday, even if the Worker is
blocked. Stale/unavailable results retain known subtotals, but never remainder.
The Roles getter returns only that role's snapshot plus shared faults, never
global totals. API: `createUsageMeterCache()` → `activateEpoch(epoch)`,
`accept(wireString)`, `get(asOf)`, `getRole(role, asOf)`. Like W0's parser, acceptance
is wire-string only (non-string objects/accessors are never inspected). W6 must
choose a new epoch before a new Worker may publish; constructing a cache starts
nothing. Fixed health messages downgrade retained evidence and clear remainder;
only a newer validated snapshot in the active epoch may replace evidence.

## Verification and undo

Fixed synthetic cases and W0's real-tree positive/transitive mutation guards pass
in the normal sealed gate: `CI=1 TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh --fast`
(302 seconds of unit tests). All 52 new cases pass, including an exhaustive typed
case for every collector fault (and an omitted count-bucket mutation), exact full
DTO, independent role/task/initiative binding, nonadditive reconciliation, task
birth/reparenting, policy-free and mixed initiative costs, unpriced/zero, stale
reread, capacity/corruption/privacy, zero-filesystem getter and frozen validator
parity. The W0 guards plant transitive engine/builder imports in each main-thread
root and reject them. Existing lint warnings only; protocol, typecheck, lint and
format gates pass. `scripts/sealed.sh npm run build:server` also passes.

A later gate launch was interrupted by the tool's ten-second timeout; its completed
52-case file exposed the remaining fixture binding error, diagnosed by the single
initiative-funding case before the successful full gate. A requested independent
review could not start because the shared subagent pool was full; this is a direct
review plus deterministic gates, not an independent-review claim.

No live source is read and no runtime is activated. Undo is a normal revert of the
#315 commit; no stored or public data is migrated.
