# Roles automatic accounting wiring

Ops #316 · project `automatic-cost-accounting` · accountable lead: Ops.
Reporting only. No install, collector activation, native source read, manual-file
write, enforcement, allowance check or permission change.

## H-WIRE-7 — before implementation

Wrong, with evidence: `RolesOverviewReader.read()` currently supplies the legacy
`spend` projection only. `projectSpend` parses formatted manual USD into Numbers
and the exact view uses that projection for budget ratios. Reusing it for the W5
cache would round exact 12-decimal amounts, conflate a known subtotal with a total,
and risk turning missing coverage/funding into a safe-looking budget balance.
The W5 scalar cache already separates subject-bound list amounts, bases, funding,
counts and sources; its Temper frontier explicitly remains diagnostic-only with
UNKNOWN coverage.

One change: carry an optional closed automatic DTO alongside the unchanged manual
reference through the existing Roles protocol and guarded useful/panel/exact
projections. Read only the W5 main-thread cache boundary, never the numeric
snapshot builder. Display exact text and explicit uncertainty using the existing
Roles surface and geometry. Record generation-ID acknowledgements only after an
active visible client's successful DOM update, over the existing Roles view/read
transport. A push or projection computation is not a rendered acknowledgement.

Expected measurement: fixed synthetic complete/partial/unavailable Pi cases,
exact 12-decimal and zero amounts, null counts, unpriced facts, week mismatch,
source gaps, wrong-role and missing funding controls preserve their distinctions.
Old snapshots retain manual fallback. Temper stays UNKNOWN across fresh polls,
clock advances, frontier recovery and alarm clearing; delayed/stalled/dead-man
labels are diagnostics only. Separate bases and manual references never enter an
automatic sum or safety bar. Import-graph mutation tests reject any worker
builder/engine pulled into the main cache, Roles reader or protocol. Synthetic
browser-view tests correlate the same generation with the successful post-render
client acknowledgement and numeric timings, not merely server push.

Disproof: a decimal changes, unknown becomes zero/allowance, an automatic budget
bar or green balance appears, a global/foreign report repeats under a role,
Temper gains complete coverage, a read refreshes an old source, or a client ack is
recorded before the actual active visible DOM update. Any such result is a MISS.

Status: HIT after H-WIRE-7a; synthetic stages and full sealed gate pass.

Pre-gate review correction: the existing layout puts detailed automatic figures
in the expanded role panel, not every collapsed card. A computed role list must
not acknowledge unopened panels. Limit DOM-completion candidates to the selected
role whose automatic text is bound into that panel; test that a visible but
unopened page emits no receipt. This narrows telemetry without changing layout.

### First sealed gate: MISS; H-WIRE-7a correction

The first full gate found old-server shape regressions (an unconditional new
projection key and two legacy manual-card labels), a preserved source-purity
check forbidding spread syntax, a new source-validator narrowing error, and the
synthetic view test's unresolved virtual font module. The fresh worktree also
needed a build before the CLI installation test could import its dist modules.
No W0 accounting boundary was weakened.

Correction: add the optional useful-model field only when the server supplies
it, retain legacy manual-card utility defaults while labelling new automatic
rows' references, use the existing pure-model style, and mock only the synthetic
font dependency. Build the sealed worktree before final full checks. Expected:
legacy cases unchanged and the real mounted synthetic view suite executes;
continued legacy failures or missing automatic/DOM proof would disprove it.

Stage result: the sealed build passed. The synthetic fixture initially expected
W0's validator to return `true`; its contract returns a validated snapshot or
null. Correcting that fixture assertion (not the validator) let all 48 new cases
pass, including the mounted actual view and null native-timing controls. Final
full checks remain necessary; no live timing or coverage claim follows.

## Scope coordination (Ops technical decision, not activation consent)

The approved ownership list includes `server/roles-overview.ts` (which also owns
`RolesWatch`) and `web/src/roles-exact-view.ts`, but not the three files that own
the real read/view dispatch and render completion:

- `server/index.ts:2757-2762` dispatches `roles_watch`/`roles_unwatch` into the
  existing `RolesWatch` instance; the current message has only `full` and the
  dispatcher cannot forward a generation acknowledgement.
- `web/src/roles-state.ts:85-105` sends `roles_watch`; it has no post-render
  acknowledgement path. `receiveRoles` is receipt/projection state, not render.
- `web/src/components/RolesExactView.tsx:97-120` performs `binding.update()`, refits
  and applies actual DOM changes. The pure exact view cannot certify this has
  succeeded; it must not send an acknowledgement just from `values()`.

Ops approved adding these three paths to the original nine, exclusively for the
existing transport/render hook. They were claimed before editing with no active
overlap. The later #321 `server/index.ts` startup work is a different hunk, not an
ordering dependency. No W5, Worker, singleton, lifecycle, startup or other files
are changed. All manual, privacy, exactness, layout, no-install and UNKNOWN
safeguards remain.

W5 exposes `createUsageMeterCache()` with `get(asOf)`/`getRole(role, asOf)` but no
shared runtime instance or first-native-observation admission timestamp. W6 owns
runtime construction/admission. The Roles wiring must offer a narrow injectable
cache getter, fail unavailable when absent, and expose honest timing fields:
source observations/evaluation, server push and actual client render ack remain
distinct. It must not label the first page read as the first native observation.
Any first-observation-to-ack claim needs W6's pinned generation observation time;
missing timing stays null/unknown until that interface is supplied.

## Implemented interface and runtime handoff to #321

- `RolesOverviewHost.usageMeterCache?()` returns the existing W5 cache's `get`
  interface. The import is **type-only**; there is no runtime import of the cache,
  builder or engine. Missing/throwing injection produces an explicit unavailable
  automatic DTO, with null money rather than zero. `readRoleSpend` and
  `server/roles-spend.ts` are unchanged.
- `RolesOverviewHost.usageMeterFirstObservedAt?(generation)` must return the native
  admission receipt pinned to that exact epoch/sequence. W6/#321 owns its real
  producer and provenance; missing, throwing, invalid or future values become
  null. Do not substitute the cache evaluation, first page read, source frontier,
  client clock or a server push. No real first-observation-to-render latency PASS
  is claimed here.
- Optional `UiRoleUsageCost` (`role-usage-cost/1`) is a closed, scalar, role-only
  projection on `UiRoleRow.usageCost`. Exact money stays string-valued; task and
  initiative identities never reach this DTO. Source `coveredThrough` is a
  reporting diagnostic; no completeness cursor is accepted by this protocol.
- Useful, panel and exact models validate this closed optional object before
  displaying it. Automatic known list subtotals and overlapping gross
  observations are distinct. Other bases are separately labelled, never summed;
  counts, funding status, UTC/date stamps and Pacific week stay explicit.
  Manual references remain marked unverified, alongside automatic diagnostics.
  Automatic values never enter `projectSpend`, a bar, or spending enforcement.
- Temper coverage is always `UNKNOWN`, including fresh frontiers and recovered
  alarms. Recorded frontier age, pending/drain/inspection stamps, delayed,
  stalled and dead-man labels describe collection health only.
- `roles_watch` optionally carries one bounded `{watch, role, generation}`
  `renderedUsage` receipt. `server/index.ts` forwards only that field to the
  existing `RolesWatch`; it neither creates a watch nor mutates collector state.
  The server pins the last sent role/generation to the current socket/watch and
  rejects stale, foreign, superseded, error-state or replayed receipts.
- The real `RolesExactView` sends only for the selected expanded role whose
  automatic figures were bound into the DOM, after its existing binding update
  and refit loop succeeded, while mounted, active, visible and connected. Hidden,
  failed, unmounted and stale generations do not acknowledge. `values()`, model
  computation and a server push are not render receipts. This is DOM-completion
  telemetry, **not** pixel-paint, human-seen, source completeness, funding or
  budget authority.
- Passive timings are available through `RolesWatch.usageRenderTimings(socket)`
  and the existing Roles payload/store `usageRenderTiming` /
  `usageRenderTimings`. They retain the same generation and server-clock
  `pushedAt`, `acknowledgedAt`, `pushToAckMs`, `firstNativeObservedAt` and nullable
  `firstObservationToAckMs`. Server-push latency is not rendered proof. W6/#321
  must provide the native receipt before a real end-to-end latency measurement.

## Verification and rollback

One synthetic test file covers the closed bridge, all three consumers, exact
12-decimal and known-zero values, null counts, unpriced/source gaps, wrong roles,
missing funding, Pi-only complete/partial/unavailable, manual fallback, Pacific
week/age invalidation, and Temper diagnostic recovery. It exercises the actual
server dispatch branch, watch/store transport and mounted iframe DOM-completion
hook (with synthetic font preparation), including failed/unmounted/hidden and
old-server controls. The inherited W0 AST import-graph tests apply to the Roles,
protocol and main-cache roots; their in-memory mutations cover forbidden direct
and transitive builder/engine imports, including type-only links, without
changing any source files. No live data, model calls,
real-chat browser interactions or collector startup are used.

No install is part of #316. To undo after landing, revert this concern;
old servers/clients remain compatible because all automatic/ack fields are
optional. Do not remove or alter any manual references before C0.

### Qualification result — HIT

- Sealed synthetic W7 stage: **48/48 passed**, including the mounted actual
  iframe view, no-ack-before-panel-open, failed/unmounted/hidden controls, exact
  strings, old-server fallback and native timing absent ⇒ null.
- Full `CI=1 NO_COLOR=1 TZ=UTC scripts/check.sh`: **exit 0**; **473 test files**,
  **7,420 tests passed / 6 skipped**; protocol parity, all typechecks, lint (zero
  errors), formatting, normal web/server/vendor build and **74 PTY checks** pass.
- Inherited W0 gate: **147 tests passed**, including all main-thread roots and
  forbidden direct/transitive/type-only engine-import mutations. Its finite
  synthetic ingestion/resource checks also pass; no gate was weakened.
- Final scope: exactly the original nine plus the three Ops-coordinated
  transport/render paths. `server/roles-spend.ts`, W5 cache/builder and startup
  remain unchanged. The advanced main branch adds independent funding files,
  not overlapping W7 hunks; normal `wt land` rebases and rechecks it detached.
- The final landed SHA/receipt belongs in the queue completion, not a self-hash
  in this document. No install, native receipt, live latency PASS, authenticated
  funding producer or collector activation is supplied by this work. #321 must
  inject the already-admitted cache and exact-generation native receipt before
  real end-to-end latency can be assessed.
