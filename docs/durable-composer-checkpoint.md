# Durable composer injection checkpoint (Ops #595)

## Scope and hypothesis

Accountable lead: Ops. This is a six-file, inert handoff to Ops #570, not a
standalone landing, installation, rollout approval or integrated durability proof.
#570 owns `composer-bridge.ts`, `composer-draft.ts`, `App.tsx`, `ChatInput.tsx`,
`plugin-host.ts`, build configuration and actual host ordering.

**H-COMPOSE-CHECKPOINT-1 — before implementation.**
`composeToComposer` currently returns synchronous `true` after invoking only
in-memory text and attachment sinks. The text sink and App attachment state do
not form a complete durable injection record. In particular, the attachment
lifecycle documented in `architecture-attachments.md` is memory-only.

One change: an explicitly supplied synchronous storage/ownership adapter stores
one versioned, complete original/source/incoming/effective record, verifies the
entire stored value and reconstructs it through the same strict codec before
reporting success. A separately built look-only reader can inspect/export it
without the main application, SDK or a live connection.

Expected result: ordinary accepted synthetic text/attachment injections survive
a fresh reader and native browser reload with exact content and metadata,
including multiple inline values larger than the former 1,500,000-character
truncation boundary. Storage, quota, malformed, stale or ownership failures must
not report acceptance, overwrite an existing record or delete original data.

Disproof: any successful checkpoint missing a supported source/incoming/effective
field, any success on uncertain readback, any stale retirement that removes a
different record, any resource fetch/authority acquisition, or any native reload
that loses accepted complete content. Actual sink/checkpoint atomicity and
preservation of the currently edited composer remain separate #570 integration
proof obligations; module success alone cannot prove those.

## Fixed-input expectations (written before testing)

- Exact Unicode, combining characters, lone UTF-16 surrogates, CR/LF, tabs, NUL,
  leading/trailing whitespace and internal-record-looking text remain data.
- The source draft, untrimmed incoming payload and resulting effective draft are
  all recoverable, including attachment metadata dropped by a host merge/dedupe.
- Every declared `DraftAttachment` field survives exactly. Complete inline image
  and file data, rich page/conversation/path/line/directory references and
  duplicate pathless values retain their original order and metadata.
- Unknown fields, accessor/non-plain inputs, sparse arrays, malformed ranges,
  unresolved transient placeholders and invalid ownership fail explicitly.
- Omitted optional fields remain omitted; explicitly malformed/undefined fields
  are not silently erased by JSON. Caller mutation after a call cannot change a
  stored or returned record.
- Disabled/unavailable storage, quota errors, truncated/partial writes,
  throw-after-write, corrupt or missing readback and changed ownership fail
  synchronously and preserve all pre-existing records. A possible or verified
  write despite failure is reported distinctly; it is not permission to retry
  blindly or consume the record.
- An existing key is immutable: different content/revision cannot replace it.
  Explicit retirement must match the complete expected record and revision and
  cannot be inferred from local acceptance/readback.
- Native tests use only a new synthetic browser context and temporary static
  fixture. An actual memory-only baseline loses its draft on reload; the new
  independent reader recovers full checkpoint data. It never interprets HTML,
  restores a draft, sends a message, reads referenced resources or changes grants.

## Actual host decision and requirements answers

Source: **#570 host decision `rm-a7bfa763`, relayed by Ops to #595**. This is
an actual host ABI answer, not owner consent expansion or integrated proof.

Question: which original binding, complete record and synchronous result can
#570 supply and consume? Answer: accept v1 `ComposerCheckpoint` below. The host
supplies genuine exclusive owner/composer/CID/SID/revision, with numeric
`nextRevision = binding.revision + 1`; complete exact source, incoming and
effective drafts are retained. `enabled` defaults false. Check ownership before
and after complete write/readback. Failure or unknown committed state means no
sink and no clear. The host rechecks the original revision, then commits **one
full text-and-attachments sink**, using the returned frozen snapshot, never the
possibly mutated caller input. Snapshot source/incoming/target before awaits.

Question: what does retirement authorize? Answer: `retire(expectedFullRecord)`
requires exact ownership and complete bytes/revision; append a marker containing
the full raw original, never remove or overwrite the original. Call it only for
deliberate discard or genuinely proven equivalence, not compose success, close
or transport acknowledgment. Inspection/export retains unknown, corrupt and
retired originals without writes. Reference metadata remains exact and opaque;
the reader must not describe referenced target bytes as resolved.

Question: who owns integration/publishing? Answer: #570 owns real host atomic
sink/current-edit ordering and the retained independent build/route. #595 has
no host effects, send, fetch or authority acquisition. Complete pathless inline
bytes are valid; incomplete transient placeholders and unknown/accessor fields
refuse instead of silently stripping data. This handoff does not wait for #570
completion and is not permission to enable the feature independently.

## Exact typed API

`web/src/composer-checkpoint.ts` has type-only imports of existing
`ComposerPayload` and `DraftAttachment`. They disappear in the independent
browser build; no composer bridge, App, SDK or connection runs.

```ts
interface ComposerCheckpointBinding {
	ownerId: string;
	composerId: string;
	conversationId: string;
	sessionId: string;
	revision: number; // original nonnegative safe integer
}
interface ComposerCheckpointDraft {
	text: string;
	attachments: DraftAttachment[];
}
interface ComposerCheckpoint {
	kind: "pi-web-ui/composer-checkpoint";
	version: 1;
	purpose: "composer-injection";
	recordId: string; // host-supplied unique injection identity
	createdAt: number; // host-supplied nonnegative integer milliseconds
	binding: ComposerCheckpointBinding;
	nextRevision: number; // exactly original revision + 1
	source: ComposerCheckpointDraft;
	incoming: ComposerPayload; // optional text / attachments stay optional
	effective: ComposerCheckpointDraft;
}
```

All binding identities and record ID must be nonempty, exact strings. The
module does not create them, substitute the active/global target or verify
whether a host-provided identity is genuine. The host must do that.

`createComposerCheckpointStore({storage, owns, enabled?})` captures its explicit
adapter and switch once. `owns(binding)` must return literal synchronous `true`
for the original exclusive binding/revision; Promise/thenable/truthy answers do
not pass. The returned store exposes:

- `checkpoint(input: unknown): ComposerCheckpointResult` — defensive validated
  snapshot, immutable key collision check, write, exact full-string readback,
  complete codec reconstruction, ownership recheck, final raw recheck. `ok:true`
  returns a deeply frozen `record` and `payloadCommitted:true`. No Promise is
  returned. Gate on `result.ok === true`, never on the result object's truthiness.
- Failure: `{ok:false, code, payloadCommitted:false|true|'unknown', detail}`.
  `true` on a failure means the complete checkpoint was observed despite the
  refusal (e.g. throw-after-write or owner loss). `unknown` includes a partial
  write or unprovable readback. Neither authorizes a sink, clear, retry with a
  different identity, retirement or consumption. Failed attempts remain visible
  to inspection where storage made bytes available; nothing is cleaned up.
- `read(recordId, expectedBinding)` — reconstructs only the exact matching full
  binding including revision; returns raw, deeply frozen record and `retired`
  status. Unknown/corrupt values return refusal with the complete raw original;
  unavailable retirement reads retain the already-read raw/decoded original and
  report failure rather than falsely claiming an active state. Disabled writes
  do not disable look-only reading.
- `inspect()` / `inspectComposerCheckpoints(storage)` — read-only namespace
  enumeration, complete raw strings, valid decoded records, matching retirement
  markers, unknown/corrupt entries and explicit enumeration/read errors.
- `retire(expectedFullRecord): ComposerCheckpointResult` — validates the entire
  expected original and original ownership, rechecks the exact stored bytes,
  then appends a separately read-back-verified full-original retirement marker.
  It never has `removeItem` or `clear`. Its success describes only this local
  marker operation, never a send/consume acknowledgment. Failure may leave a
  marker; originals remain. A stale marker cannot hide a different original.
- `snapshotComposerCheckpoint(input)` and `decodeComposerCheckpoint(raw)` —
  exported complete frozen snapshot / strict canonical v1 codec; no storage.
- `composerCheckpointKey(record)` and `COMPOSER_CHECKPOINT_PREFIX` — host/debug
  inspection of the exact immutable identity. Not a permission or lookup of a
  later global composer.

`ComposerCheckpointStorage` requires synchronous `length`, `key`, `getItem`,
`setItem`, structurally implemented by native `localStorage`. `setItem` must
complete synchronously and return `undefined`; Promise/thenable/non-void returns
refuse even if complete bytes were observed. No implicit store,
capability snapshot, fallback success, migration or pruning exists. The key is
`pi-web-ui:composer-checkpoint:record:v1:` plus JSON of
`[ownerId, composerId, conversationId, sessionId, recordId]`. Revision and every
payload byte remain inside the immutable record; reusing an ID for different
bytes/revision refuses. Retirement uses the sibling `retirement:v1:` key and a
versioned `{kind,version,purpose,recordKey,original}` marker. Both full originals
are retained. Existing different records/markers are never overwritten.

### Validation and explicit limits of the format

Every declared attachment field is copied: `path`, `name`, `mode`,
`conversationId`, `sessionPath`, `isDir`, `lines.start/end`, `imageData`,
`fileData`, `mimeType`, `size`, `key`. Optional absence stays absent, empty text
and empty complete file data stay empty, duplicates/order stay unchanged.
Unknown fields (including future fields), accessors, symbols, non-enumerable
fields, exotic objects, sparse/extended arrays and explicit `undefined` fail
instead of being dropped by JSON. Integers must be finite safe values, line
ranges are 1-based and ordered, revisions must advance by one. Complete inline
data is canonical raw base64 (not a Blob, data URL, streaming handle or transient
object URL); image data must not be empty, while an empty uploaded file is
valid. This validates a complete byte representation, not whether a particular
image/file renders or what a referenced resource contains. MIME and other
metadata are preserved as declared, not inferred. Unresolved pathless
placeholders, conversation references without either identifier and line
references without a range fail. No content-size ceiling is imposed; real
platform quota failures are failures, not acceptance or permission to truncate.

Stored JSON is canonical schema-order encoding. Readback compares the entire
string and reconstructs every supported field; duplicate keys, alternate/lossy
numbers, extra JSON whitespace and malformed data are not accepted as this
module's own checkpoint encoding. The reader still exposes their raw originals.
Text that happens to look like a record is never parsed as a carrier: only the
explicit top-level checkpoint input or namespaced storage entry is decoded.

## Independent reader and publishing contract for #570

Build entry: **`web/composer-checkpoint-recovery.html`** imports only
**`/src/composer-checkpoint-reader.ts`**, which imports the pure checkpoint
module. `readComposerCheckpointRecovery(storage)` and
`exportComposerCheckpointRecovery(inspection)` are look-only programmatic
reader/export functions. `mountComposerCheckpointReader(root,{getStorage})`
provides safe text-only UI. The HTML's `data-composer-checkpoint-reader` root
mounts on load, but does not even access storage before the explicit Read
button. Only explicit Export downloads a local JSON Blob. It does not mutate
checkpoint storage. The page has no external resources, SDK, App, live socket,
reference resolver, draft-apply/send/delete control or automatic replay.
Its CSP disables connections, images, frames, workers and object resources;
all potentially hostile draft/key/raw content uses `textContent`.

#570 must add this HTML alongside—not instead of—the existing main HTML in the
Vite multi-page inputs and publish the generated same-origin
`/composer-checkpoint-recovery.html` plus its referenced assets. Standalone
fixture proof uses `vite.build({configFile:false,root:'web',build:{outDir,
rollupOptions:{input:'web/composer-checkpoint-recovery.html'}}})`; it does not
edit build configuration. No reader build entry is published by #595.

Publish and verify the reader before/with any opt-in writer. It must remain
available at the original storage origin and route while rolling back host
changes, including its exact matching hashed assets. A rollback to a bundle
that lacks this entry is **not** a recovery plan: retain the independent reader
and originals independently of reverting the host. Turning writes off preserves
look-only recovery. Do not prune/retire/migrate originals to make rollback work.
An origin/protocol/port change does not carry native storage over: #570 must
retain origin availability, not silently copy or claim recovery across origins.
No rollback command in this handoff installs or removes anything.

### Integration proof still owed by #570

Native storage is not compare-and-swap or a cross-tab transaction. The adapter
cannot itself prove exclusion across writers or make checkpoint-plus-React-sink
atomic. #570 must serialize real ownership/revision transitions, reject stale
operations, retain current user edits, take complete snapshots before awaits,
recheck the genuine original binding after helper success, and commit one
full returned effective draft (text **and** attachments) synchronously. It must
report refusal truthfully and provide recovery of committed-but-refused data
without auto-application. A locally valid record does not prove the effective
draft was the intended merge; compare the real source/incoming/effective in the
host tests, including metadata-rich dedupe cases. A full storage write followed
by ownership loss is explicitly a failed compose, even though inspection can
recover the retained record. Retirement is a separate explicit host decision,
not a cleanup hook. Real integrated gate, reload/recovery/rollback availability,
host boolean behavior and live installation remain #570's obligations.

## Verification evidence and undo

Runtime verification (sealed synthetic data only): focused Vitest **58/58
passed**; native static-fixture test **9/9 checks passed**, including standalone
reader build, true memory-only baseline loss, native quota, committed-then-failed
refusal, exact complete reload/export comparisons and no reference/App traffic.
The complete normal `npm run build` also passed. Its existing Vite config,
advancedChunks and large-chunk notices are unrelated to these unhooked files.
No full integrated gate, actual host sink, live reader route or deployment is
claimed. Independent reviewer could not start because all 16 shared subagent
slots were occupied; source review was local, not an independent approval.

**H-COMPOSE-TYPE-1 — compiler repair.** The final typecheck found seven
narrowing errors (`TS2538`, `TS2731`, `TS2322`, `TS18046`) at validation call
sites. Hypothesis: the inferred variable type of the `never`-returning arrow
helper does not establish control-flow termination for this compiler. One
change: use an explicitly declared `function invalid(where: string): never`
with the same throw body. Expected measurement: all five typecheck projects
pass with no coercions or validation changes. Disproof: remaining narrowing
errors or changed validation behavior. Runtime tests have run once; the repair
changes only the helper declaration and does not repeat the runtime suite.
First repair check removed all seven production narrowing errors, exposing one
separate fixture-only `TS2322`: a getter that always throws inferred `void`
instead of the storage contract's `number`.

**H-COMPOSE-FIXTURE-TYPE-1 — before repair.** Explicitly annotate that synthetic
throwing getter `get length(): number` so the fixture implements the numeric
storage surface without changing its intentional failure behavior. Expected:
all five projects pass; disproved by a remaining compile error. This is a type
annotation only; runtime tests are not repeated. A deliberately malformed
then-shaped adapter fixture has a local lint-rule comment, not a weakened
production rule.

Final outcomes: **H-COMPOSE-CHECKPOINT-1 HIT at the isolated module/reader
boundary**; the genuine old bridge loss control failed recovery as expected,
while accepted checkpoints recovered every exact field after reload. Both
compiler-repair hypotheses **HIT**: all five `npm run typecheck` projects pass.
Targeted oxlint reports **0 warnings, 0 errors**; all six files pass Prettier;
the staged diff passes `git diff --cached --check`. Only the six planned new
files are staged; no existing hook/store/build file is changed.

Reproduction commands, run from the handoff worktree (no model calls):

```sh
scripts/sealed.sh env TZ=UTC npm run test:unit -- --maxWorkers=2 tests/unit/composer-checkpoint.test.ts
scripts/sealed.sh env TZ=UTC node tests/composer-checkpoint-test.mjs
scripts/sealed.sh env TZ=UTC npm run build
scripts/sealed.sh env TZ=UTC npm run typecheck
scripts/sealed.sh env TZ=UTC node_modules/.bin/oxlint web/src/composer-checkpoint.ts web/src/composer-checkpoint-reader.ts tests/unit/composer-checkpoint.test.ts tests/composer-checkpoint-test.mjs
scripts/sealed.sh env TZ=UTC node_modules/.bin/prettier --check web/src/composer-checkpoint.ts web/src/composer-checkpoint-reader.ts web/composer-checkpoint-recovery.html tests/unit/composer-checkpoint.test.ts tests/composer-checkpoint-test.mjs docs/durable-composer-checkpoint.md
git diff --cached --check
```

Unit/native suites and build ran once, after implementation. Typecheck was
rerun only to verify the two runtime-preserving compiler repairs; no runtime
suite was repeated. No test touched real browser storage/profiles, pages,
chats, attachments or model-bound data. Synthetic browser/temp resources were
closed and removed by the native fixture.

Undo before integration: do not consume this six-file commit, or revert it as a
unit. It is default-off and has no host/build hooks. After integration: disable
new host writes and preserve the independent same-origin reader/assets plus
all original records; #570 owns the paired lossless rollback and its proof.
