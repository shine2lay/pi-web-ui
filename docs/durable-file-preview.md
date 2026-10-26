# FilePreview reply fences (Ops #591 → #570)

## Hypothesis, recorded before implementation

H-FILE-REPLY-FENCE-1: the old component accepts any same-path `file_content`
while `savingRef` is true, exits editing and replaces the draft. A read of the
same path can therefore destroy text typed after dispatch. Match the operation,
original resource, preview/editor lifetime and revision instead. Expected:
unrelated/stale replies never close or replace an editor; an exact successful
write changes only its baseline, closing only its unchanged submitted revision.
Falsifier: any adversarial reply clears newer text, or an exact current reply
cannot complete. Tests were authored before the component change; execution is
reserved for the final verification pass, including an actual-old-source control.

## Agreed additive host contract — NOT wired by this slice

#570 confirmed the following flat contract and bootstrap behavior in the peer
handoffs on 2026-10-26; it supersedes #591's initial nested-object proposal.

`FilePreviewBinding` is an optional prop:

```ts
{
  workspaceId: string;  // actual workspace identity, not conversation identity
  sessionId?: string;  // genuine SDK SID when the engine has one; never fabricated
  openId: string;       // fresh host UUID on actual open/reopen/retarget
  resourceId?: string; // actual authorized server-resolved target, never raw path
}
```

App must pass a stable, immutable **original** binding for an open. It changes
only on a real open/reopen/retarget, including same-file and workspace/session
ABA. App must NOT inject a read's newly resolved resourceId into this prop mid-open
(which would end the component owner). The component adopts that resourceId
internally from its matched full authorized read. Missing resourceId is initial
READ bootstrap only; no editing/write before that resolution. No native session
is required for engines genuinely without one, but absence must match exactly.
Missing all context permits only one legacy read-only preview, not invented
write authority. Existing binary/truncated/office restrictions still apply.

The component exports `FilePreviewCorrelation`, `FilePreviewRequest` and
`FilePreviewContent`. Existing `read_file` / `write_file` carry additive flat
`reqId`, `purpose`, `binding`, `lifetime`, `revision`. `file_content` carries
those exact fields plus `complete` and `writeSucceeded`. The component owns
fresh request UUIDs, a preview UUID used as the read lifetime, a fresh editor
UUID used as the write lifetime, and monotonic edit revisions within an editor.
The host owns authentic resource/workspace/session/open binding. A read has
revision 0. A write captures the entire original path and text synchronously,
before dispatch; no trimming or replay. The server derives reply purpose from
the **actual method**, never a client's claimed purpose.

#570 owns optional protocol fields in the single protocol source, full-response
forwarding in use-chat, the genuine stable App binding, and server echo against
the **original captured authorized target**. Resolve/authorize once, capture
workspace/session/resource before awaits and validate the expected binding
before writing. Do not resolve a relative path against a newly selected cwd,
session or workspace after awaiting. A write result can finish only when
`purpose === "write"`, `writeSucceeded === true`, `complete === true`, all
request/context/lifetime/revision fields match, content is nonbinary/untruncated
text and its full body exactly equals the submitted original. Reads cannot
acknowledge writes. Refusal/errors echo the original operation metadata with
`writeSucceeded: false`, `complete: false`; no fake Saved notice. Missing or
wrong echo remains unresolved. These are correlation identifiers, NOT
authorization, durable receipts, deduplication or extra file access permission.

The existing five-second timer reports unknown and retains the current and
submitted originals (including original baseline/path) in component memory.
False/throw also preserves those originals and reports unknown immediately.
No automatic write retry occurs. Explicit later saves get new identities;
late older replies cannot roll a newer confirmed baseline backwards. A valid
late result can finish only its own unchanged editor revision; newer text,
including text ABA, stays open. Explicit discard or lifetime end abandons
in-memory operations; there is no arbitrary-file journal or reload/crash
recovery here. Legacy hosts must not enable editing before #570's genuine
binding/echo integration. This slice is deliberately not independently shipped.

## Scope and evidence

Only FilePreview and its unit/browser tests plus this document change. Existing
transport, authorization, binary/truncated/office edit restrictions, discard
confirmations, attachment/line selection, markdown/HTML preview and per-file
script opt-in stay. No arbitrary file/config/credential bodies enter a generic
journal. No parent, protocol, server or shared-fixture files change here.

The browser fixture bundles the actual component with synthetic transport and
fixed strings. Each case uses a fresh isolated Chromium context; all browser
URLs are intercepted. There is no app server, model, real chats/files, user
profile or settings. No mocked FilePreview logic/hook state is substituted.
The old control loads the exact component from commit
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`, git blob
`7d9eb253c8a0687b3f995e9f76add37e80393562`, without rewriting its logic.
Both versions receive the same native edit-A/save/edit-B/stale-same-path-read
interaction. Full baseline text is checked through intentional cancel/re-enter,
not inferred from a return value or private test-only state.

## Final-pass setup repairs (recorded before repair)

H-FILE-TYPE-FIXTURE-1: 50/50 real-component tests and the build pass, but the
normal typecheck rejects a test's mutation of readonly `content.binding`
(TS2540). Construct that adversarial response immutably instead. Expected:
typecheck passes with unchanged runtime test meaning; another type error
would falsify the diagnosis.

H-FILE-BROWSER-SETUP-1: the browser fixture did not execute any case: the
hardcoded `/usr/bin/chromium-browser` is a snap wrapper which refuses the
sealed temporary profile in `/dev/shm` (`SingletonLock: Permission denied`).
Use the repository's existing `tests/lib/chrome.mjs` isolated headless-shell
discovery, without editing that shared fixture or touching a user profile.
Expected: the native control and fenced cases actually run in the existing
sealed home; the same launch refusal would falsify the setup diagnosis.

## Verification outcome — HIT (synthetic caller slice only)

- Real-component unit suite: **50/50 pass** in sealed temporary HOME, with actual
  DOM events and only peripheral rendering/identity dependencies stubbed.
- Isolated native browser: **47/47 checks pass**, including the pinned actual-old
  loss control and identical new-component retention scenario. The old component
  genuinely closes and replaces B on an unrelated same-path read; the new one
  keeps all of B and the original baseline. Each other fence, bootstrap, unknown,
  timeout/late completion, manual ordering, lifetime/ABA and safety case passes.
- Normal `npm run build`, `npm run typecheck`, targeted oxlint and Prettier
  checks, and `git diff --check` pass. All test/build/typecheck commands use the
  existing sealed runner; no model or live app was invoked. Build's existing
  large-chunk warning and the synthetic IIFE bundle's import.meta warning are
  non-failing; the root-URL fixture does not rely on Vite's import.meta env.
- H-FILE-TYPE-FIXTURE-1: **HIT**, readonly test construction repaired and normal
  typecheck passes. H-FILE-BROWSER-SETUP-1: **HIT**, shared Chromium discovery
  launches the isolated headless shell and all native cases execute. Initial
  failures were setup/typecheck failures, not fabricated test successes.
- Tested FilePreview source SHA-256:
  `5bad69e611c029e2041515d0e96f0f040538675b68d672468cb33feecd57b05e`.
  Final review confirms only the four planned files changed; no generic journal,
  permission expansion, automatic retry or bypass of existing safety controls.

Reproduce with the sealed runner from the repository root (set
`PI_SEALED_MODEL=none`): `npx vitest run tests/unit/durable-file-preview.test.ts`,
`node tests/durable-file-preview-test.mjs`, `npm run build`, `npm run typecheck`.
Use targeted oxlint on the component and unit suite, and Prettier check on all
four slice files. The browser script's assertion checks the pinned git blob;
its old-source interaction is not a rewritten facsimile.

## Integration, remaining risks and undo

#570 must integrate this commit and its agreed App/protocol/use-chat/FileService
binding/echo as one paired change. A host that strips metadata stays read-only;
transport true or a matching path/body is never a successful write result.
This is not proof of real filesystem persistence, authentic host echo, external
writer concurrency control, reload/crash recovery or durable rollback. The
unchanged integrated full release gate, original-data preservation, backup and
restore, lossless rollback and deployment remain #570's obligations. No
standalone landing/deployment is authorized or performed.

Before integration, undo by excluding/discarding this unlanded slice. After a
paired integration, revert this slice with the corresponding host changes and
re-run #570's unchanged release gate; do not ship a mismatched protocol/editor.
Tests wrote no user file or chat, so they require no user-data rollback; that
says nothing about production restore proof.
