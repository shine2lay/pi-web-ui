# Durable notebook/note admission — Ops #586

Accountable lead: Ops. Integration owner: #570 / c108. Base: `4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92` (#585's shared `app-admit.ts`). This caller patch stays on a committed handoff branch; it is not independently landed, deployed or a no-data-loss/release qualification.

## Hypothesis, written before implementation

**H-NOTE-ADMISSION-1.** The accepted #582 B1/G2/common matrix and #583 R3–R5 audit identify a paired failure: `NotebookPanel.send` tests a boolean save result, and notebook/note success effects clear whichever draft is current. The original `notebook-state.ts` matches saves only by identity/file/ref and mutates the current resource after transport calls. Changing only the sender to async would introduce truthy-Promise acceptance and stale-resource rollback, while leaving late-success draft loss intact.

One change: make the paired store/editor an operation-owned admission lifecycle. Capture complete authored text, original identity/ref/base, view/open/edit generations and a unique request ID before dispatch; register busy/correlation first; await literal admission; keep the original and newer editable generations separately; allow only a matching real server result to update its submitted baseline. Keep transient reads/watches/search and metadata deletion outside admission.

Expected measurement: deterministic tests against the actual store and an isolated browser rendering the actual panel preserve A and newer B on deferred/false/rejection/committed-then-failed admission, protect A→B→A and same-resource reopen, accept only matching echoed results, and make zero admission calls for excluded operations. Genuine baseline behavioral negative controls must exhibit the old loss. A lost or retargeted draft, eager Saved label, fallback write, stale receipt applied to a newer generation, or journalled read/delete falsifies this hypothesis.

## Paired caller contract

- `saveNotebook(text: string, baseHash: string, editGeneration?: number): Promise<boolean>` and `saveOpenNote(text: string, editGeneration?: number): Promise<boolean>` await #585's `appAdmit`. Literal `true` means only local admission, never server execution or persistence. Save, Ctrl-S and conflict-save all use the async boundary. No eligible save calls `appSend` as a fallback.
- Before dispatch, the store freezes the complete original message (text, original identity, notebook file/ref or note ref, original base hash and unique `reqId`) and records view/open/edit generations plus busy ownership. A same-turn second action is refused without another admission call. Newer text remains editable while A is admitting/awaiting.
- Authored drafts live in the actual store, separately from fetched content and separately from exact submitted attempts. False/rejection is unknown, including a possible commit followed by failure; it never rolls A back over B or silently retries. Reconnect changes outstanding attempts to unknown and resends observations only. Unmount, identity switch, close/reopen and same-resource reopen retain authored drafts with new generations.
- Only a real matching `reqId`, identity, resource, active operation and view/open generation can finish an edit. An early real reply is held until admission resolves exactly true. Missing/mismatched/no-echo, stale, duplicate and detached replies cannot clear work. A successful reply without a hash is unknown. An A reply updates only A's baseline; it clears the draft only if that very submitted edit generation is still current. Newer B (even A→B→A) keeps its generation and rebases to A's confirmed hash. No React success effect clears the current draft.
- Live notebook pushes remain observations; they can update fetched content but never clear a draft or complete an operation. Post-save note canonical reads are separately correlated and preserve B. Failed observations after a loaded baseline leave retained editing available and show an error. Initial read failures remain errors, not invented content.
- Read/watch/search stay on synchronous transient `appSend`. Metadata deletion also stays transient and is not an authored replay item. Its confirmation remains visible on transport false/throw and until a matching real `identity_note_saved` with `deleted: true`; transport acceptance alone, old save replies and no-echo replies are not evidence of deletion.

## Required #570 glue before integration/activation

1. Register #585's exact shared `setAppAdmit` handler before an eligible caller can be used, and unregister it safely with the host lifecycle. Keep `appSend` and plugin contracts synchronous. The handler owns eligibility, complete-payload checkpointing, original ownership, and the real admission result; an unregistered handler returns false with no transport fallback. Do not register a plain synchronous transport as admission.
2. Extend the shared protocol additively with optional `reqId` on these messages and echo the received request ID on **both success and error** paths:
   - `identity_file_save` → `identity_file_saved`, preserving original identity, file and the existing notebook-tab `ref`.
   - `identity_note_save` / `identity_note_delete` → `identity_note_saved`, preserving original identity/ref and deletion semantics.
   - `identity_note_get` → `identity_note`, preserving original identity/ref, including post-save canonical reads.
3. Forward the actual reply objects through `use-chat` to this store without stripping or fabricating `reqId`. Locally typed intersection boundary shapes keep this helper type-safe before shared protocol edits. They do not claim the current server echoes anything. Never infer an absent echo from the active request, or treat an ID as permission/deduplication.
4. Keep only authored notebook/note saves eligible for this admission slice. Never journal its live reads/watches/search, fetched content or metadata deletes. Reconnect must not replay them as authored saves.
5. Combine this pin with the identity/Message slices and the host coordinator on #570's integration branch. Run the unchanged full application gate and the required real persistence/recovery/rollback checks there. This helper does not edit App, use-chat, globals, shared protocol, server, coordinator, packages, locales or unrelated tests.
6. Adapt the legacy notebook API fixtures in `tests/unit/identity-notebook.test.ts` during integration (outside this helper's owned files). Source review finds old synchronous assertions at lines 545/555/607/664/672, exact no-request-ID reads at 649/690/736, and no-echo injected receipts at 560/579/587/673/687/698/907. They must install the real shared admission handler, await the changed save API, and echo the actual dispatched request IDs/ref, keeping their behavioral assertions. They are not unchanged boolean production consumers, but cannot truthfully pass against the new async contract as written. No test/gate exclusion or invented no-echo compatibility is acceptable; #570 owns this precise integration dependency before the full gate.

## Checks and limitations

**H-NOTE-ADMISSION-1: HIT for this focused caller slice.** Final actual-store suite: **41/41 passed**, 1.34 s total. Isolated actual-panel/store browser fixture: **19/19 passed**, including both genuine baseline loss controls; zero browser runtime errors. Build, typecheck, lint (50 existing warnings, zero errors), Prettier on all five owned files, and `git diff --check` passed. No full-application gate, model call, live data/browser profile, landing, deployment or recovery/rollback proof was performed here.

Focused verification commands:

**H-NOTE-HARNESS-1 (before harness repair).** The first store pass was 40/41: the >1 MB test spent 9,658 ms in generic deep equality of two full typed arrays and hit the unchanged 5,000 ms test limit; all lifecycle cases passed. The browser pass completed its first 15 lifecycle/conflict checks but native `.fill()` of the 18,000-line Unicode fixture timed out before Save. Hypothesis: these are expensive assertion/native-input paths, not lost/changed stored text. Replace only that byte comparison with native `Buffer.compare` (same full bytes) and that large native fill with a browser-native textarea setter plus bubbling input through the real React handler. Assert the actual store received the full same long text before Save. Keep all text sizes, lifecycle checks and timeout settings unchanged. Expected: the identical full-text tests finish and preserve exact bytes; any unequal capture, missing React update or continued timeout falsifies the hypothesis. **HIT:** with the same payload sizes and unchanged limits the final 41-test store suite and all 19 native cases passed, including exact full-text capture after the real React input handler. No production fix or timeout increase was needed for this harness repair.

```sh
scripts/sealed.sh env VITEST_MAX_WORKERS=4 npx vitest run tests/unit/durable-notebook-admission.test.ts
scripts/sealed.sh node tests/durable-notebook-admission-test.mjs
scripts/sealed.sh npm run build
scripts/sealed.sh npm run typecheck
scripts/sealed.sh npm run lint
scripts/sealed.sh npx prettier --check web/src/notebook-state.ts web/src/components/NotebookPanel.tsx tests/unit/durable-notebook-admission.test.ts tests/durable-notebook-admission-test.mjs docs/durable-notebook-admission.md
```

The native fixture bundles the actual store/panel and a second copy of the actual unmodified two files at the base pin. Its old-behavior controls deliberately reproduce notebook and note loss of newer B on an old A success, while bypassing a real installed deferred admission handler: behavioral reds, not missing-import/API reds. It serves only synthetic fixtures on an ephemeral loopback origin, uses a new headless Chromium context, blocks other origins/service workers, and never launches the app server or reads a live profile/chat. It does not exercise recovery storage or use a model.

The retained drafts/attempts here are in-memory caller ownership, **not durable storage, no-loss proof, automatic replay, server execution, authenticated receipt or production recovery qualification**. They contain complete authored originals; there is no content truncation, TTL, quota or automatic deletion on failure. #570 owns durable recovery and final lifecycle verification. Independent landing/deployment of these active callers is prohibited until that integration is complete.
