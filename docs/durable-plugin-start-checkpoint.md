# Synchronous plugin startChat checkpoint (Ops #584)

Inert module/proof only. Ops accountable; #570/c108 owns production wiring, user-directed
recovery, retained rollback route, final browser proof and release. No existing host/API,
producer, recovery namespace, deployment or SDK version changes here.

## Hypothesis, before implementation

H-PLUGIN-SYNC-CHECKPOINT-1: `createPluginHostApi().startChat` trims the prompt, runs the
first cwd/new-chat effect in the accepting tick, retains the mutable options through later
awaits, and returns a real boolean without first saving the complete intent. Its promise
gate orders effects, not recovery. A separate owner-scoped lifetime native Web Lock plus
a synchronous full original-intent localStorage write/readback should preserve that boolean
API while allowing #570's later asynchronous admission without losing the original.

One change: introduce an opt-in typed boundary and independent reader; do not integrate it.
Expected: exact original prompt/options/IDs/source survive reload and source-page closure;
no true/dispatch/clear permission on storage or ownership failure; no replay on uncertainty;
only exact authorized retirement. Wrong if any acceptance precedes the full readback,
original option presence/bytes change, a cloned/stale owner gets permission, an ambiguous
record is erased, or recovery requires the installed app bundle. Browser quota is a genuine
refusal, not a reason to evict old work. No new size/count/age limit. Result: HIT at the
local module boundary (165 focused cases and 13 isolated native-browser groups).

## Schema and original-versus-effective values

Only `PluginHostStartChatOptions`: required string `prompt`; optional boolean `newChat`,
string `cwd`, string `model`. Capture plain data objects, not commands, arbitrary payloads,
credentials, model request bodies or streams. Unsupported input returns false, leaving
caller input untouched. No generic journal or legacy `serializePending` path.

`original.prompt` is unchanged UTF-16 text (including Unicode, CRLF and whitespace).
Each optional field is tagged `absent`, `undefined`, or `value` with its exact typed value.
This preserves absence versus an explicit undefined and all supported true/false/empty/
whitespace values. `effective` is separately derived using current host semantics:
`prompt.trim()`, `newChat !== false`, and trimmed cwd/model with absent/undefined => empty.
A whitespace-only prompt remains refused. Configured-model/readiness validation remains
host-owned and must run before checkpoint acceptance. No invented model allowlist.

Immutable intent records contain format/version/kind, stable intent and prompt IDs, creation
time, actual source owner, per-open generation, stable source session, conversation and
nullable plugin attribution, plus both original and effective fields. Own namespace:
`pi-web-plugin-start-v1:` followed by JSON `[kind, ownerId, intentId]`. `kind` is only
`intent`, `begin` or `retired`. No existing keys are overwritten. Raw intent records remain
immutable, including after authorized retirement. Small append-only begin/retirement markers
reference exact identity; every write must be absent-first and synchronously read back.
An identity receipt includes the exact original serialized record, not text equality.

## Ownership and ordering

`await openPluginStartCheckpoint({ ownerId, getSource, ... })` must finish before exposing
the synchronous adapter. It independently acquires native Web Lock
`pi-web-plugin-start-owner-v1:<ownerId>` with `ifAvailable`, no timeout/steal/takeover. The
host supplies its actual reload-stable owner (e.g. #579's established owner), never the
reload-changing socket ID. A cloned owner conflicts; different owners can run in parallel.
A fresh generation is made for each opening; closing invalidates it immediately. Native
document destruction releases the lock. Startup catalogue inspection is read-only; corrupt
or unknown records belonging to that owner block mutation and remain inspectable/exportable.

`getSource()` returns `{ ownerId, sessionId, conversationId, pluginId }` from the real host.
Capture it before writing, recheck after serialization/readback, and compare it again at
begin. Reject empty/missing owner/session/conversation, source drift and stale leases. The
source is never guessed from current text or changed to whichever conversation is active
when an await finishes. A recovered old-generation intent is readable but not begin-able.

Public contract (types in `web/src/plugin-start-checkpoint.ts` are authoritative):

- `checkpoint(options, ids?)` is synchronous and returns a discriminated result.
  `ok:true` requires a newly written complete immutable record, exact readback and current
  lease/source. It grants only local preservation acceptance, not server persistence.
  Failure has explicit code, `sourceRetained: true`, `checkpointMayExist` and no dispatch
  permission. Caller must retain its original editable input on every false; capture
  failures do not substitute a sanitized partial copy. Duplicate IDs, including an exact
  old record, refuse new acceptance; existing records are not resumed.
- `begin(identity)` is synchronous and succeeds only for a freshly accepted intent in this
  same generation, with exact stored bytes and matching current source. It commits and
  verifies the begin marker BEFORE granting an effect permit. It is one-shot; every later
  attempt/reload is recovery-required. A permit exposes `valid()` for checks after awaits:
  original intent/owner/generation/marker must still match. #570 must separately check the
  intended target and readiness before each effect; planned new-chat transitions are not
  permission to retarget the source intent. No begin on restored records.
- `createPluginStartAdapter(owner, { validate, continueIntent })` provides the actual
  `startChat(options): boolean`. Synchronous host validation precedes checkpoint. True
  means full local write/readback, not asynchronous admission. A microtask performs guarded
  begin, then invokes the asynchronous continuation with the frozen intent and permit.
  Rejection/throw/fulfilment all leave recovery intact and effects uncertain. No automatic
  retries and no retirement from promise fulfilment, socket acceptance or prompt ack.
  `lastResult()` reports synchronous refusal/acceptance; `issues()` reports later failures.
- `retire({ kind: 'discard', identity })` requires deliberate exact user discard; or
  `retire({ kind: 'persisted', identity, proof })` requires a host-supplied verifier of
  genuine persisted authority covering the complete intent and its effects. No verifier,
  wrong identity, false/throw, ownership drift or failed readback => retained. Revalidate
  identity/lease after the verifier await. Proof is not serialized into browser storage.
  Retirement adds a marker, never deletes/rewrites originals. Default is retention.
- `close()` invalidates permits and releases only the lifetime lock. No unload deletion.

## Recovery and rollback reader

`catalogPluginStarts()` synchronously enumerates this namespace only, retaining every raw
key/value (including unknown versions, malformed JSON, orphan markers and binding errors)
and reporting incomplete reads honestly. Valid originals and lifecycle markers are joined
by full identity. Every unretired entry is `recovery-required` (begin means possible effects,
not known completion). It grants no replay/clear/effect permission and writes nothing.
`exportPluginStarts()` includes raw records in a versioned artifact;
`readPluginStartExport(text)` validates/inspects without executing or rewriting originals.

`createPluginStartReaderHtml(bundledModule)` embeds a pinned browser ESM bundle of this exact
module (esbuild bundle:true/platform:browser/format:esm). It discovers/inspects and exports
raw records using native same-origin localStorage, without importing the installed app.
Rendering uses textContent. It has no sender, replay, discard, retirement or import action.
The independent original and artifact reader preserve explicit undefined/absent tags.

#570 MUST build/pin/hash and retain this self-contained reader outside the rolled-back app
binary, at a fixed SAME ORIGINAL ORIGIN URL protected by the real deployment auth. Verify
that exact retained route, authenticated access and CSP (inline script + Blob module),
including after actual rollback; a file:// download cannot read another origin's storage.
Download/export and independently inspect every unresolved original before rollback. Keep
private artifacts and origin storage intact. A server JSONL backup is not this browser data.
Expose unknown/corrupt records, failures and explicit user-directed recovery; never silently
ignore them or auto-replay possible new-chat/cwd/model/prompt effects. Exact source/session,
original prompt ID and actual server persistence remain #570's integration responsibilities.

## Verification plan

After implementation is ready, use fixed known synthetic inputs, focused units and an
isolated Chromium context/static origin, not the owner's profile or a real chat/model.
Exercise exact Unicode/whitespace/options, original ID/source, capture mutation, synchronous
ordering, old host's real true-before-save behavior (not missing-import failures), storage
unavailable/throw/quota/readback failure, duplicate IDs/owner, source drift, closed/stale
lease, delayed continuation rejection, uncertain work, matched/mismatched retirement,
reload, real opener clone collision, actual page closure/reopen and standalone same-origin
reader with the app bundle removed. Missing native Web Locks/localStorage is a blocker.

Run focused units/native fixture, worktree build, full typecheck, lint/format and unchanged
sealed normal `wt land` gate. Review only these four owned new files; commit and land
detached. Return immutable pin, receipt and measured results to #570/c108. No deploy.

## Verification notes

H-FIXTURE-CLASSIFICATION-1: first focused run passed 163/164; invalid JSON at an ownerless
namespace key was correctly `corrupt`, while the fixture expected `unknown`. Correct the
fixture and add a valid JSON/unknown-key control; both must remain visible with exact raw
bytes and must block mutation. Falsified by dropped raw bytes, accepted mutation, or an
incorrect JSON-versus-schema classification. No module behavior change. Result: HIT in
both fixed cases; final focused run 165/165. The initial failed expectation remains recorded.
Read-only self-review found no module P0/P1; missing required old-host fixture dependency
methods (`getWorkspaceRoots`, `listSessions`) were added before focused tests. An additional
independent review was requested; its result covered a different task, not this module.

H-TYPE-DOUBLES-1: normal land 215-d873be refused three test-only compiler errors despite
the earlier reported typecheck pass: DOM `LockGrantedCallback` needs a type argument, and
the mock `key()` inferred string rather than native string|null. Explicitly type those
three test seams to the platform contract, without changing module behavior or assertions.
Expected: all-five-config compiler and the 165 focused cases pass; any remaining compiler
error or changed runtime outcome falsifies it. Result pending recheck.

H-LOAD-ISOLATION-1: the same full gate passed 8,756 cases with 16 skips but timed out one
unchanged #578 multi-attachment ownership case at its existing 5-second timeout. No module
failure was reported. Test that case alone before retrying the normal gate; no timeout,
assertion, source, gate or production change. Expected isolated pass supports contention;
a deterministic isolated failure would falsify it and require the responsible lead's repair.
The repeat keeps the normal gate unchanged, uses its supported two-worker setting to reduce
runner contention, and waits for the existing quiet-load guard before starting.

Measured local proof (2026-10-26): sealed focused 165/165; native fixture 13/13 with actual
Web Locks/localStorage, genuine quota refusal, opener/session clone collision, reload and
source-tab close/reopen, then same-origin standalone reader/export with app modules returning 410. Exact 540,008-UTF-16-unit Unicode original survives both reopen and independent reader;
8,000,000-character attempted write is refused by native browser quota, without eviction.
Explicit undefined/absence and delayed asynchronous rejection are exercised natively.
No real profile, chat, model or production server is used. Sealed worktree build, format
and lint pass (lint has existing warnings, zero errors). The first normal landing refused
three test-only type errors and an unchanged ownership-test timeout; nothing was landed.
All-five-config typecheck and unchanged sealed landing gate must pass after repair; their
actual results and successful receipt are returned separately, not inferred from local proof.

## Boundaries

localStorage success/readback is an origin-local browser checkpoint, NOT hardware/power-loss,
server-backup, origin-clearance or malicious same-origin-code protection. Writes are atomic
per native key, not across keys; interruption leaves discoverable raw intents/markers, never
permission to replay. Browser policy/quota/security failures refuse acceptance. Retired bytes
also remain for recovery/audit; there is no cleanup/eviction/expiry timer. Module acceptance
is not final production caller, live auth/CSP, backup or rollback proof; do not claim
integrated no-data-loss or activate this module from this task.
