# Authored Board draft persistence (#598)

## Hypothesis recorded before implementation

Ops is accountable. **H-BOARD-DRAFT-PERSISTENCE-1**: at accepted snapshot
`cef87329cd06d33dd0724a0e3fa4903d6f78449a` (which includes #593's Board caller
in `web/src/roles-state.ts` and `web/src/components/RolesView.tsx`), complete
authored Board sources (`BoardDraftSource`) are held only in page memory
(`boardDrafts` / `boardSources`), while the outbound `board_post` and
`board_close` wire messages trim `title`, `text` and `note`, sort active
recipients, omit `picked` when `toAll` is `true`, and omit empty/whitespace-only
close notes. Because the wire format is lossy and page memory vanishes on
reload, a reload loses unsent edits, inactive recipient selections, original
recipient selection order, raw whitespace, and empty-note close context.

One bounded change: add a purpose-specific transactional IndexedDB store
(`web/src/board-draft-store.ts`) and an independent look-only recovery reader
(`web/src/board-draft-reader.ts`, `web/board-draft-recovery.html`) that retain
both evolving `current` edits and immutable `submitted` originals under strict
same-transaction key-presence checks, transaction-completion resolution, exact
full-record CAS + post-commit readback, atomic creation with optional initial
submitted originals, and byte-retaining retirement markers.

Expected positive result: synthetic `board_post` (`news` and `order`, `toAll`
`true` and `false` with inactive `picked` order preserved) and `board_close`
(including raw whitespace, Unicode, and empty clears) survive native IndexedDB
transaction completion, page reload, and standalone look-only export without
posting, closing, or replaying any Board action. Creating an initial record with
both `current` and an initial `submitted` original succeeds in one atomic record
change.

Expected negative result: the genuine #593 page-memory-only path loses its
recovered/authored state across reload; malformed, extra-field, authority-field,
sparse-array, or accessor-bearing sources/records are rejected without invoking
getters; present `undefined`, `null`, `false`, `0`, `""`, and foreign objects in
the purpose store are detected via same-transaction `get(key)` + `count(key)` as
`invalid-record` and never treated as absent or overwritten; stale incarnation,
`editorId`, target (`board_post` vs `board_close` or different close `id`), and
revision writes (including A/B/ABA and concurrent two-page writers) reject with
`conflict`; `put` request success followed by transaction abort rejects with
`transactionCompleted: false` and leaves prior bytes intact; committed writes
followed by readback failure/mismatch reject with `transactionCompleted: true`
while leaving committed bytes recoverable; reader inspection on a missing DB
commits no schema and performs zero writes or network actions.

Falsifier: any lost or normalized field (`picked` order, inactive `picked` when
`toAll: true`, raw whitespace, empty strings, `-0` revision), a two-commit window
when creating initial current + submitted sources, a present `undefined` or
corrupt row hidden or overwritten, a stale/wrong-target write overwriting newer
state, confirmation before transaction complete + readback, or any Board
post/close/network side effect.

## Scope and integration boundary

Only these six new files belong to this handoff:

- `web/src/board-draft-store.ts`
- `web/src/board-draft-reader.ts`
- `web/board-draft-recovery.html`
- `tests/unit/board-draft-store.test.ts`
- `tests/board-draft-store-test.mjs`
- `docs/durable-board-draft-store.md`

`web/src/board-draft-store.ts` has only a type-only dependency on
`web/src/roles-state.ts` (`import type { BoardDraftForm, BoardDraftSource }`).
No existing file (`web/src/roles-state.ts`, `web/src/components/RolesView.tsx`,
`web/src/App.tsx`, `web/src/hooks/use-chat.ts`, server routes, build config, or
Scheduler modules) is edited in this task. #570/c108 owns caller/host wiring,
synchronous `getBoardAdmissionSource(originalMessage)` observation before
clone/await, source-versus-wire binding, live route publication, recovery UI
restoration, full release gate, and paired rollback.

## Exact positive source schema, identity/target and revision rules

`BoardDraftSource` and `BoardDraftForm` are derived directly from accepted #593
(`web/src/roles-state.ts`):

```ts
type BoardDraftForm =
	| Readonly<{
			type: "board_post";
			kind: "news" | "order";
			toAll: boolean;
			picked: readonly string[];
			title: string;
			text: string;
	  }>
	| Readonly<{
			type: "board_close";
			id: string;
			note: string;
	  }>;

interface BoardDraftSource {
	readonly editorId: string;
	readonly revision: number;
	readonly form: BoardDraftForm;
}
```

### Positive source validation (`copyBoardDraftSource`)

- Top-level source must be a plain or null-prototype object with exact own
  enumerable data properties `["editorId", "revision", "form"]` (no extra keys,
  symbols, inherited properties, non-enumerable properties, or accessors).
- `editorId`: non-empty `string`.
- `revision`: safe non-negative integer (`Number.isSafeInteger(revision) && revision >= 0`;
  `-0` is preserved by `encodeBoardDraftSource` as `"-0"`).
- `form`: plain or null-prototype object whose own enumerable data property
  `type` selects one of two closed shapes:
  1. `"board_post"`: exact own enumerable data properties
     `["type", "kind", "toAll", "picked", "title", "text"]`, where
     `kind === "news" || kind === "order"`, `typeof toAll === "boolean"`,
     `typeof title === "string"`, `typeof text === "string"`, and `picked` is a
     dense plain `Array` (`Object.getPrototypeOf(picked) === Array.prototype`,
     `Reflect.ownKeys(picked).length === picked.length + 1`) whose elements are
     own enumerable data properties of type `string`.
  2. `"board_close"`: exact own enumerable data properties
     `["type", "id", "note"]`, where `typeof id === "string" && id.length > 0`
     and `typeof note === "string"`.
- No authority or wire fields (`ownerWords`, `reqId`, `to`, `act`, `from`,
  grants, capabilities, timestamps) are accepted.
- Strings (`title`, `text`, `note`, `picked` entries, `id`, `editorId`) are
  copied verbatim with all leading/trailing whitespace, newlines, tabs, Unicode
  combining marks, and empty-string clears intact. `picked` preserves its exact
  authored order even when `toAll === true`.
- The returned `BoardDraftSource`, `form`, and `picked` array are recursively
  frozen plain objects/arrays.

### Identity, target and revision rules

- **Purpose database and store**: database `pi-authored-board-drafts-v1`
  (`BOARD_DRAFT_DATABASE`), object store `authored-board-drafts`
  (`BOARD_DRAFT_OBJECT_STORE`), record purpose `"authored-board-draft"`
  (`BOARD_DRAFT_PURPOSE`), `schemaVersion: 1`.
- **Key (`boardDraftKey`)**: validates `BoardDraftIdentity`
  (`{ readonly editorId: string; readonly form?: BoardDraftTarget }`, which
  accepts either `{ editorId }` or a full `BoardDraftSource`) and returns the
  exact `editorId` string. If `identity.form` is provided, it must be an own
  data property with a valid target (`{ type: "board_post" }` or
  `{ type: "board_close", id: "<non-empty>" }`).
- **Target & lifetime fence (`sameLifetime`)**: per `useBoardEditor` in
  `web/src/components/RolesView.tsx`, an `editorId` is bound for its entire
  lifetime to one resource target:
  - `type: "board_post"` for a new-post editor, or
  - `type: "board_close"` plus exact `id` for a post-close editor (switching
    close target A -> B -> A is a fresh editor lifetime).
    Two sources share a lifetime if and only if `a.editorId === b.editorId`,
    `a.form.type === b.form.type`, and (for `"board_close"`) `a.form.id === b.form.id`.
    Because the storage key is `editorId`, attempting to `create` a different
    target under an existing `editorId` also conflicts rather than creating a
    second record for the same `editorId`. Calling `load(identity)` with an
    `identity.form` whose target mismatches the stored record rejects with
    `BoardDraftError("conflict")`.
- **Revision & record fences**:
  - `BoardDraftRecord` has exact keys
    `["purpose", "schemaVersion", "recordId", "version", "retired", "current", "submitted"]`.
  - Every source in `submitted` must share `current`'s exact lifetime (`editorId`
    and target), have `source.revision <= current.revision`, appear at most once
    per `revision`, and if `source.revision === current.revision`, match
    `encodeBoardDraftSource(current)` byte-for-byte.
  - `create(value, submitted = [])` atomically writes `version: 0`,
    `retired: false`, `current`, and `submitted` (accepting an omitted second
    argument, a single `BoardDraftSource`, or a dense array of
    `BoardDraftSource`s) in a single `swap(key, null, record)` transaction plus
    readback. There is no two-commit gap between creating `current` and retaining
    an initial submitted source.
  - `updateCurrent(expectedRecord, nextSource)` requires an unretired
    `expectedRecord`, identical lifetime/target, and `nextSource.revision >= expectedRecord.current.revision`.
    Same-revision calls with identical source bytes perform an exact CAS +
    readback without advancing `version`; same-revision calls with different
    bytes reject with `conflict`. Increasing revisions advance `version` by 1
    and preserve `submitted` untouched, including A -> B -> A edits.
  - `retainSubmitted(expectedRecord, submittedSource)` requires an unretired
    `expectedRecord`, identical lifetime/target, and
    `submittedSource.revision <= expectedRecord.current.revision`. An already
    retained revision with identical bytes performs an exact CAS + readback;
    conflicting bytes at the same revision (against `submitted` or `current`)
    reject with `conflict`. Appending a new submitted original (such as
    original A alongside newer current B using a freshly loaded B record)
    advances `version` by 1 and keeps `current` at B.
  - `retire(expectedRecord)` sets `retired: true` and advances `version` by 1
    under exact full-record CAS + readback, retaining all `current` and
    `submitted` bytes. Retiring an already retired record still verifies exact
    CAS + readback. Any subsequent `create`, `updateCurrent`, or
    `retainSubmitted` on a retired key rejects.

## Typed API and failure semantics

Exports from `web/src/board-draft-store.ts`:

- `BOARD_DRAFT_DATABASE`, `BOARD_DRAFT_OBJECT_STORE`, `BOARD_DRAFT_PURPOSE`
- Types: `BoardDraftForm`, `BoardDraftSource`, `BoardDraftTarget`,
  `BoardDraftIdentity`, `BoardDraftRecord`, `BoardDraftRow`, `BoardDraftScan`,
  `BoardDraftStorage`, `BoardDraftInspection`
- `BoardDraftError` with `code`:
  `"invalid-source" | "invalid-record" | "conflict" | "retired" | "unavailable" | "blocked" | "transaction-failed" | "readback-failed" | "readback-mismatch"`
  and `transactionCompleted: boolean | "unknown"`
- `copyBoardDraftSource(value: unknown): BoardDraftSource`
- `boardDraftKey(identity: BoardDraftIdentity): string`
- `encodeBoardDraftSource(value: unknown): string`
- `copyBoardDraftRecord(value: unknown): BoardDraftRecord`
- `encodeBoardDraftRecord(value: unknown): string`
- `inspectBoardDrafts(storage: Pick<BoardDraftStorage, "scan">): Promise<BoardDraftInspection>`
- `createBoardDraftStore(storage: BoardDraftStorage, newRecordId?: () => string)`
  -> `{ create, load, inspect, updateCurrent, retainSubmitted, retire }`
- `createBoardDraftIndexedDB(factory: IDBFactory | undefined, options?: { existingOnly?: boolean; databaseName?: string }): BoardDraftStorage`

Exports from `web/src/board-draft-reader.ts`:

- `exportRawBoardDraftRow(row: BoardDraftRow): Promise<string>` (format
  `"board-purpose-store-raw-graph-v1"`)
- `mountBoardDraftReader(root: HTMLElement, storage?: Pick<BoardDraftStorage, "scan">): { inspect(): Promise<void> }`

### Native IndexedDB and key-presence invariants

- `createBoardDraftIndexedDB` performs no I/O at construction.
- Existing-only opens (`existingOnly: true`, and `read`/`scan` on any boundary)
  call `factory.open(name)` without a version and abort `onupgradeneeded` when
  `event.oldVersion === 0`, resolving as `missing` without creating a database or
  object store.
- Readwrite transactions open v1 and request `{ durability: "strict" }`.
- Both `read(key)` and `swap(key, expected, replacement)` issue `store.get(key)`
  and `store.count(key)` in the **same** IndexedDB transaction and evaluate both
  in `presence.onsuccess`:
  - In `read(key)`: if `presence.result !== 0 && request.result === undefined`,
    the transaction aborts with `BoardDraftError("invalid-record", false)`. Only
    `presence.result === 0` returns `undefined`.
  - In `swap(key, expected, replacement)`: `actual` is `null` only when
    `presence.result === 0`; any present value (including stored `undefined`) is
    passed through `encodeBoardDraftRecord(request.result)`, which rejects
    corrupt/unknown rows with `invalid-record` before `store.put` can run.
- `swap` resolves only on `tx.oncomplete`, never on `putRequest.onsuccess`, and
  every store write is followed by `storage.read(key)` and full canonical byte
  comparison (`encodeBoardDraftRecord(readback) === encodeBoardDraftRecord(next)`).

## Host obligations for #570

1. Wire `BoardForm` / `BoardCloseForm` and the #585 `appAdmit` handler to
   checkpoint evolving current edits and submitted originals into
   `createBoardDraftStore(createBoardDraftIndexedDB(globalThis.indexedDB))`.
2. Call `getBoardAdmissionSource(originalMessage)` synchronously before cloning
   or awaiting. When the first durable checkpoint for an editor occurs at
   submission time (for example, an unedited `board_close` with an empty note),
   use `store.create(currentSource, submittedSource)` so initial `current` and
   `submitted` persist in one atomic transaction. When a record already exists
   (including when `current` has advanced to B while original A is being
   checkpointed), use `store.retainSubmitted(freshRecord, submittedSource)` under
   freshly loaded full-record CAS.
3. Keep all Board drafts non-executable: never auto-post, auto-close, synthesize
   `ownerWords` or grants, or replay `board_post` / `board_close` from storage.
   A `board_close` draft (with or without a note) is inert authored context only.
4. Retire a record via `store.retire(expectedRecord)` only after a genuine
   correlated `board_result` (`ok: true`, matching `reqId`, `op`, and non-empty
   `id` matching the close target when `op === "close"`) AND unchanged editor
   lifetime/revision. Marker retirement retains all bytes; never delete rows.
5. Publish `web/board-draft-recovery.html` + `web/src/board-draft-reader.ts` on
   an authenticated same-origin route (without App/React/bootstrap imports) and
   preserve the `pi-authored-board-drafts-v1` database and reader across rollback.
   Offer look/edit restoration through `restoreBoardDraft` without overwriting
   active edits or triggering actions.

## Verification and handoff

### Hypothesis outcome: **HIT** (`H-BOARD-DRAFT-PERSISTENCE-1`)

- **Negative control verified:** In `tests/board-draft-store-test.mjs`, the
  accepted #593 Board caller (`createBoardDraft`, `reviseBoardDraft`,
  `boardRequest`, `getBoardDraftRecoveries` in `web/src/roles-state.ts`) keeps
  the complete raw `BoardDraftSource` (including inactive `picked` recipients
  when `toAll: true` and untrimmed whitespace/Unicode) only in page memory while
  emitting a lossy trimmed/sorted outbound wire packet, and loses both `current`
  and `attempts` on a real page reload (`page.goto(url)`), with
  `inspectBoardDrafts` reporting `status: "missing"`.
- **Positive proof verified:**
  - `tests/unit/board-draft-store.test.ts`: **64 unit tests passed** (exact
    post/close round trips, inactive recipients, whitespace/Unicode/empty clears,
    atomic `create(current, submitted)` and `create(current, [submitted])`
    single-commit initialization, immutable submitted `A` beside current `B`,
    same-revision conflicting bytes, stale incarnation/identity/post-vs-close
    type/close-`id` target fences, ABA and concurrent CAS,
    unavailable/quota/abort, request-success then transaction-abort, committed
    write then failed/mismatching readback, genuine missing vs present
    `undefined`/`null`/`false`/`0`/`""`/foreign records with unchanged unknown
    bytes, standalone reader status/XSS-safe text rendering/lossless raw graph
    export, and #593 `restoreBoardDraft` look-only compatibility).
  - `tests/board-draft-store-test.mjs`: **30 isolated native Chromium/IndexedDB
    cases passed** (strict-durability transactions, same-transaction `get(key)` +
    `count(key)` key-presence checks in `readonly` and `readwrite` modes, atomic
    single-transaction initial `current` + `submitted` creation, reload survival
    across `news`/`order` and `toAll: true`/`false` and `board_close`
    whitespace/empty notes, present `undefined` and other corrupt native values
    retained and exported without mutation, two-page competing writers,
    put-success then transaction-abort rollback, quota refusal, uncertain
    committed-then-failed readback recovery, retained retirement markers,
    standalone reader operation and actual file downloads while the app bundle
    `/fixture.js` returns HTTP 404, zero writes/schema creation/network/board
    effects from the reader, and fresh #593 `restoreBoardDraft` look-only
    compatibility).
  - Unchanged existing Board regressions:
    `tests/unit/durable-board-admission.test.ts` (**91 passed**),
    `tests/unit/role-board.test.ts` (**37 passed**),
    `tests/unit/no-plan-board.test.ts` (**7 passed**),
    `tests/unit/roles-view.test.ts` (**27 passed**),
    `tests/durable-board-admission-test.mjs` (**38 native cases passed**), and
    `tests/no-plan-board-test.mjs` (**all checks passed**).
  - Static/build checks: `npm run typecheck` (including `web/tsconfig.json` and
    `tsconfig.tests.json`), `oxlint` (0 warnings, 0 errors), `prettier --check`,
    `npm run build`, and `git diff --check` all passed cleanly.

### Limitations (owned by #570)

- This delivery finishes the standalone typed storage module, standalone
  look-only recovery reader, and isolated unit/native proofs in the six allowed
  files only.
- It does **not** wire `web/src/roles-state.ts`,
  `web/src/components/RolesView.tsx`, `web/vite.config.ts`, or `server/` routes,
  and makes no live-app recovery, migration, or no-data-loss claim until #570
  integrates the caller lifecycle and authenticated route and passes the
  integrated gate.

## Raw binary-view preservation repair (#599)

### Hypothesis recorded before implementation (`H-BOARD-RAW-VIEW-1`)

Ops is accountable. **H-BOARD-RAW-VIEW-1**: at #598 Board commit
`a875d2bc676a2ee90ade541b0d7fbfb4db364c74` (reader blob
`c4c554243e509b97a79e8489efabbb4608e688ec`), `web/src/board-draft-reader.ts:32-36`
encodes `ArrayBuffer.isView(value)` as
`{ id, type: Object.prototype.toString.call(value), bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] }`.
Because it slices only the visible window and never visits `value.buffer`
through the `seen` reference map, it drops:

1. all backing `ArrayBuffer` bytes outside `[byteOffset, byteOffset + byteLength)`,
2. the view's `byteOffset` and `byteLength` metadata, and
3. shared-buffer identity when multiple views or object properties reference the
   same backing `ArrayBuffer`.

One bounded change: in `exportRawBoardDraftRow` (`web/src/board-draft-reader.ts`),
encode `ArrayBuffer.isView(value)` by visiting `value.buffer` through the
existing graph-reference visitor (`buffer: await visit(value.buffer)`) and
recording `type: Object.prototype.toString.call(value)`,
`byteOffset: value.byteOffset`, and `byteLength: value.byteLength`. Leave
`web/src/board-draft-store.ts`, `web/board-draft-recovery.html`, ordinary
`current`/`submitted` exports, and the `"board-purpose-store-raw-graph-v1"`
envelope unchanged.

### Fixed expected outputs and reconstruction oracles

1. **Equal-visible / unequal-backing-buffer pair:**
   - Row A (`key: "equal-visible"`):
     `value = { view: new Uint8Array(new Uint8Array([1, 7, 8, 4]).buffer, 1, 2) }`
     (visible bytes `[7, 8]`, non-visible prefix `[1]`, non-visible suffix `[4]`).
     Expected view node in `exportRawBoardDraftRow`:
     <!-- prettier-ignore -->
     ```json
     {
       "id": 2,
       "type": "[object Uint8Array]",
       "buffer": {
         "id": 3,
         "type": "ArrayBuffer",
         "bytes": [1, 7, 8, 4]
       },
       "byteOffset": 1,
       "byteLength": 2
     }
     ```
   - Row B (`key: "equal-visible"`):
     `value = { view: new Uint8Array(new Uint8Array([9, 7, 8, 6, 5]).buffer, 1, 2) }`
     (visible bytes `[7, 8]`, non-visible prefix `[9]`, non-visible suffix `[6, 5]`).
     Expected view node in `exportRawBoardDraftRow`:
     <!-- prettier-ignore -->
     ```json
     {
       "id": 2,
       "type": "[object Uint8Array]",
       "buffer": {
         "id": 3,
         "type": "ArrayBuffer",
         "bytes": [9, 7, 8, 6, 5]
       },
       "byteOffset": 1,
       "byteLength": 2
     }
     ```
   - Oracle requirement: the two exports must not be equal; independent graph
     reconstruction must yield `Uint8Array` views with visible bytes `[7, 8]`,
     `byteOffset === 1`, `byteLength === 2`, and full backing buffer bytes
     `[1, 7, 8, 4]` vs `[9, 7, 8, 6, 5]`.

2. **Sliced `Uint8Array`, nonzero-offset `DataView`, multiple views sharing one
   backing `ArrayBuffer`, explicit `ArrayBuffer` reference, view alias, and
   cycle:**
   - Backing `ArrayBuffer` `shared`: `new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer`.
   - `slicedUint8`: `new Uint8Array(shared, 2, 3)` (visible `[30, 40, 50]`,
     non-visible prefix `[10, 20]`, non-visible suffix `[60, 70, 80]`,
     `byteOffset: 2`, `byteLength: 3`).
   - `dataView`: `new DataView(shared, 1, 5)` (visible `[20, 30, 40, 50, 60]`,
     `byteOffset: 1`, `byteLength: 5`).
   - `sharedUint16`: `new Uint16Array(shared, 2, 2)` (`byteOffset: 2`,
     `byteLength: 4`, sharing `shared`).
   - `backing`: direct reference to `shared`.
   - `slicedAlias`: direct reference to `slicedUint8`.
   - `self`: self-reference cycle on the row `value` object alongside existing
     special numbers (`NaN`, `Infinity`, `-0`), `BigInt`, `undefined`, `Date`,
     `RegExp`, `Map`, `Set`, and `Blob`.
   - Expected binary graph nodes when `slicedUint8` is visited before
     `dataView`, `sharedUint16`, and `backing`:
     - `slicedUint8`:
       `{ id: 2, type: "[object Uint8Array]", buffer: { id: 3, type: "ArrayBuffer", bytes: [10, 20, 30, 40, 50, 60, 70, 80] }, byteOffset: 2, byteLength: 3 }`
     - `dataView`:
       `{ id: 4, type: "[object DataView]", buffer: { reference: 3 }, byteOffset: 1, byteLength: 5 }`
     - `sharedUint16`:
       `{ id: 5, type: "[object Uint16Array]", buffer: { reference: 3 }, byteOffset: 2, byteLength: 4 }`
     - `backing`: `{ reference: 3 }`
     - `slicedAlias`: `{ reference: 2 }`
       (And when `backing` is visited first, `backing` defines
       `{ id: 2, type: "ArrayBuffer", bytes: [10, 20, 30, 40, 50, 60, 70, 80] }`
       and every view's `buffer` is `{ reference: 2 }`.)
   - Oracle requirement: after both in-memory export and native IndexedDB
     structured-clone round trip + standalone reader download (with `/fixture.js`
     returning HTTP 404), independent graph reconstruction must recover:
     - full backing bytes `[10, 20, 30, 40, 50, 60, 70, 80]`,
     - `slicedUint8` as a `Uint8Array` with `byteOffset === 2`,
       `byteLength === 3`, visible `[30, 40, 50]`,
     - `dataView` as a `DataView` with `byteOffset === 1`, `byteLength === 5`,
       visible `[20, 30, 40, 50, 60]`,
     - `sharedUint16` as a `Uint16Array` with `byteOffset === 2`,
       `byteLength === 4`, `length === 2`,
     - exact object identity `slicedUint8.buffer === dataView.buffer`,
       `slicedUint8.buffer === sharedUint16.buffer`,
       `slicedUint8.buffer === backing`, `slicedAlias === slicedUint8`, and
       `self === reconstructedValue`.

3. **Genuine pinned-old negative control (`a875d2bc676a2ee90ade541b0d7fbfb4db364c74`):**
   - Load the unmodified `a875d2bc676a2ee90ade541b0d7fbfb4db364c74:web/src/board-draft-reader.ts`
     via `git show` + `esbuild`.
   - It must execute and emit valid `"board-purpose-store-raw-graph-v1"` JSON
     (not fail due to setup or loading), and fail the preservation oracle:
     the `[1, 7, 8, 4]` and `[9, 7, 8, 6, 5]` offset-1/length-2 views collapse
     into identical exports with `bytes: [7, 8]`, missing `buffer`, `byteOffset`,
     `byteLength`, non-visible prefix/suffix bytes, and shared-buffer references.

4. **Falsifier:**
   - Any lost backing byte, lost `byteOffset`/`byteLength`/`type`, broken
     shared-buffer or view-alias identity, source-row or IndexedDB mutation,
     weakened negative control, or regression in existing Board unit/native checks.

### Verification and outcome (`H-BOARD-RAW-VIEW-1`: **HIT**)

- **Repaired exporter (`web/src/board-draft-reader.ts`):**
  - `ArrayBuffer` values match across realms via
    `value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]"`
    and emit `{ id, type: "ArrayBuffer", bytes: [...new Uint8Array(value as ArrayBuffer)] }`.
  - `ArrayBuffer.isView(value)` visits the backing buffer through the existing
    `seen` object-reference graph (`buffer: await visit(value.buffer)`) and
    records `type: Object.prototype.toString.call(value)`,
    `byteOffset: value.byteOffset`, and `byteLength: value.byteLength`.
- **Commands and results (sealed synthetic environments only, no live data or model calls):**
  - `scripts/sealed.sh npx vitest run tests/unit/board-draft-store.test.ts tests/unit/durable-board-admission.test.ts tests/unit/role-board.test.ts tests/unit/no-plan-board.test.ts tests/unit/roles-view.test.ts`
    -> **5 test files passed, 229 tests passed** (`board-draft-store.test.ts`:
    **67 passed**, including equal-visible/different-backing-buffer distinction,
    sliced `Uint8Array` + nonzero-offset `DataView` + shared `Uint16Array` +
    explicit `ArrayBuffer` reference + view alias + cycle reconstruction in both
    traversal orders, and genuine pinned `a875d2bc676a2ee90ade541b0d7fbfb4db364c74`
    negative control; `durable-board-admission.test.ts`: **91 passed**;
    `role-board.test.ts`: **37 passed**; `no-plan-board.test.ts`: **7 passed**;
    `roles-view.test.ts`: **27 passed**).
  - `scripts/sealed.sh node tests/board-draft-store-test.mjs`
    -> **PASS 32 isolated native Board storage/reader cases** (real Chromium
    IndexedDB structured-clone round trip + standalone reader download while
    `/fixture.js` returns HTTP 404, independent graph reconstruction of equal-visible
    pair and shared-buffer topology in both visit orders, genuine pinned
    `a875d2bc676a2ee90ade541b0d7fbfb4db364c74` standalone reader negative control
    over the same native IndexedDB rows, zero writes/schemas/actions, and
    unchanged IndexedDB snapshot before/after export).
  - `scripts/sealed.sh node tests/durable-board-admission-test.mjs`
    -> **38 native Board cases passed**.
  - `scripts/sealed.sh node tests/no-plan-board-test.mjs`
    -> **all checks passed**.
  - `scripts/sealed.sh npm run typecheck`,
    `scripts/sealed.sh npx oxlint web/src/board-draft-reader.ts tests/unit/board-draft-store.test.ts tests/board-draft-store-test.mjs`,
    `scripts/sealed.sh npx prettier --check web/src/board-draft-reader.ts tests/unit/board-draft-store.test.ts tests/board-draft-store-test.mjs docs/durable-board-draft-store.md`,
    `scripts/sealed.sh npm run build`, and `git diff --check`
    -> **all passed with 0 warnings and 0 errors**.
- **Remaining #570 host obligations:**
  - Wire `createBoardDraftIndexedDB()` into `web/src/roles-state.ts` and
    `web/src/components/RolesView.tsx` so Board post/close authoring, submit
    retention, and correlated `board_result` marker retirement persist through
    this store.
  - Serve `web/board-draft-recovery.html` + `web/src/board-draft-reader.ts` on
    an authenticated same-origin host route and retain the database + standalone
    reader across rollback, then run the integrated #570 gate.
