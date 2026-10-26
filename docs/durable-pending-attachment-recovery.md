# Complete pending-send recovery (Ops #578)

Module-level repair for #570; **not integrated losslessness or deployment proof**.
Ops is accountable. #570 alone owns `web/src/use-chat.ts`, UI, protocol and host wiring.

## Hypothesis, written before implementation

**H-PENDING-ATTACHMENT-RECOVERY-1.** `serializePending` omits inline image/file bytes when
its JSON exceeds 1,500,000 characters. The persistence effect in `use-chat.ts` catches and
ignores sessionStorage errors, after sending and allowing the composer to clear. A native
IndexedDB transaction holding each complete send, with explicit failure handling, should
allow exact recovery without enlarging that small sessionStorage envelope.

Expected: byte-for-byte text, attachment data, Unicode names, MIME, sizes, ordering, prompt
ID, session identity and queue flag survive reload/retry. A reference is published only
after transaction completion. Aborted/quota/disabled storage fails explicitly and does not
mutate the caller's complete draft or erase previous recovery data.
Wrong if: any bytes or metadata disappear, a missing reference becomes an empty attachment
list, a rejected transaction looks successful, or another tab/session's work is consumed.
Result and verification receipts are recorded below after testing.

## Contract (commit, restore, acknowledgement, discard)

`createPendingSendStorage({ ownerId, ... })` creates an asynchronous, serialized recovery
API. `ownerId` is a caller-provided, nonempty, stable **tab recovery identity**, not the
WebSocket client ID (that changes on reload). Every key also includes the stable session
ID (conversation ID only for legacy sends with no session) and original prompt ID.

- `save(list)` snapshots complete inputs before awaiting anything, commits full payloads
  atomically, then updates `pi-web-pending-sends`. Small records retain the legacy array
  format; large records use a versioned manifest of committed keys. The existing 1,500,000
  character inline-envelope boundary is unchanged, not a new payload quota. All sends are
  committed to IndexedDB, including small ones, to survive interruption between the two
  storage writes. Neither omitting an entry nor saving `[]` deletes its recovery copy:
  `save` first merges readable older work and commits omitted legacy-only payloads before
  replacing their envelope. It refuses an unresolved/corrupt source, unless a complete
  supplied record repairs that specific missing/corrupt payload. An unreadable envelope
  is not overwritten, even if new payloads have committed successfully.
- `restore()` reads only this owner's records and the tab's existing envelope. It discovers
  committed payloads even if interruption prevented publishing the envelope. Native
  records take precedence over stale legacy arrays. Payload digests, identity and manifest
  references are checked. It returns `{ pending, blocked, issues, complete }`; unresolved
  external references retain their full record in `blocked`, not an attachment-stripped
  send. Missing/corrupt payloads have explicit issues and untouched source records. Restore
  never consumes, migrates, clears or sends anything. Sending records get `needsCheck`.
- `release(pending, "acknowledged" | "discarded")` is the **only deletion hook**. Its native
  transaction replaces payload bytes with a small release marker. That marker prevents a
  stale envelope/effect from resurrecting an acknowledged/discarded send and makes cleanup
  safe if the page reloads immediately afterward. It is not proof of a server ack: the
  caller supplies that proof before calling. No automatic expiry, eviction or quota.
- Storage/transaction/envelope-write failures reject with `PendingSendStorageError`.
  `payloadCommitted` distinguishes failure after the payload commit. The complete caller
  record and previous committed records remain available; never treat rejection as saved.
- Non-inline attachment references require `verifyReference(attachment, pending)` on save
  and restore. It must check actual resolvability in the appropriate host/session, not just
  accept a path's syntax. No verifier means explicit unresolved-reference failure. A bare
  Object URL is never recovery evidence; inline bytes accompanying an Object URL are
  independently recoverable. Existing workspace/upload/page/conversation references keep
  all their metadata, but the module cannot promise their external targets persist.

The native adapter uses one origin-local IndexedDB database/store, transaction completion
(not request success), strict durability and no additional package or upload service.
`backend` is an injectable transactional port for deterministic independent unit fixtures;
real-browser tests exercise the native adapter too. There is no browser-profile access.

### Required #570 integration sequence

1. Obtain a stable, unshared tab recovery owner before restoring. Preserve it across reload.
   Do **not** reuse `getClientId()`. A browser can clone sessionStorage when opening a tab
   with an opener: use `noopener`/a tab-ownership claim and detect duplicate active owners
   (for example with Web Locks) before accessing recovery. Do not guess another tab's ID
   or enumerate its records. The module namespaces by the supplied owner; it cannot
   authenticate ownership of a token the host deliberately shares.
2. Await `restore()` before writing a new list or enabling replay/clear. Merge by original
   prompt ID and stable session, not a renumbered conversation ID or text alone. Surface
   every issue and blocked record; retain the raw legacy envelope on failure. Do not turn
   a missing reference into `attachments: []`, or overwrite it with a successful empty list.
3. For each new non-slash send, build the complete `PendingSend` with its original ID and
   target session. Await `save` **before** WS send, held-send publication, optimistic success
   or destructive composer/attachment clearing. On rejection show a persistence failure,
   return send failure and keep the complete draft/chips available for retry. A React
   effect after WS send is insufficient. All producers, including attachment-only sends,
   plugin/template sends, held switches and retry, must use this ordered boundary.
4. If the UI changes chat while awaiting persistence, retain the original target/session.
   Recheck connection/target before sending; do not send into whichever chat is now open.
   Reconnect asks `prompt_status` with the original ID first, rather than blindly re-sending.
   Retry uses the same ID/body/attachment order and awaits `save` again before WS send.
5. On a **persisted, correctly session-correlated server acknowledgement**, await `release`
   before dropping recovery. Negative acks, socket errors, attachment cards appearing,
   text-only heuristic matching, or a new snapshot revision alone are not persisted-send
   proof. Existing `applyPromptAck`/`reconcilePending` UI behavior is unchanged here;
   #570 must separate visual reconciliation from this authoritative cleanup boundary.
   A cleanup failure stays visible/retryable; deduplication remains the server's job.
6. After explicit user discard, await `release(..., "discarded")`. The current × action
   returns the send to the composer: that is **not** discard. Preserve its recovery copy
   until replacement draft persistence is committed, or the user explicitly discards it.
   After successful release, `save(remaining)` can compact the tab envelope; retained
   release markers suppress stale legacy copies if that envelope update fails.
7. Remove/replace the old synchronous load and silent persistence effect. Do not run old
   `serializePending` over a new manifest. Preserve originals during rollout; the old
   serializer remains intentionally compatible but is **not** a lossless API for large
   attachments. Keep acknowledgements/status checks/dedup/same-session routing unchanged
   except where the stronger persisted-ack boundary explicitly needs host support.

#570's final isolated browser fixture must prove persistence-before-clearing, visible
failure with complete draft retained, async restore, reload/reconnect/retry send-once,
owner/session isolation, external reference validation and safe acknowledged/discard cleanup.
This module cannot establish those UI/host facts. It cannot reconstruct bytes already
omitted by the legacy serializer, or guarantee survival of browser-origin data being cleared
or evicted. It reports detectable missing payloads explicitly; it is not a server backup.
No live chat, model, migration, engine switch, configuration change or deployment is
authorized by this task.

## Verification and landing

**H-PENDING-ATTACHMENT-RECOVERY-1: HIT at module level.** These checks use synthetic
fixtures only, in `scripts/sealed.sh` (temporary home/no real credentials or chats):

- `env TZ=UTC VITEST_MAX_WORKERS=4 PENDING_RECOVERY_BASELINE=1 ./node_modules/.bin/vitest run tests/unit/pending-send-storage.test.ts -t exact-content --reporter=dot`:
  intentional red counterfactual against the unchanged legacy serializer/load transform.
  The below-boundary and exactly-at-boundary controls pass; the just-above-boundary and
  multiple-large-image/file attachment-only exact-content assertions fail (2 red, 2 green).
  Default serializer behavior is unchanged by this patch apart from exporting its constant.
- `env TZ=UTC VITEST_MAX_WORKERS=4 ./node_modules/.bin/vitest run tests/unit/pending-send-storage.test.ts tests/unit/pending-sends.test.ts --reporter=dot`:
  **63 passed** (19 dedicated recovery cases plus 44 existing pending-send regressions).
  Exact-content fixtures cover both sides of the old boundary, multiple full image/file
  payloads, attachment-only, Unicode/MIME/names/order, original IDs and queue flags.
  Independent transactional fixtures cover interruption/quota/disabled stores, publication
  ordering, mutation during await, legacy import, session/tab isolation, missing/corrupt
  payloads, reconnect/retry, external references, failed cleanup and release markers.
- `node tests/pending-send-storage-test.mjs`: **PASS, all 8 native-browser scenario groups**.
  Fresh Chromium context, isolated static origin on an ephemeral port >=8900, no app server
  or model. Native IndexedDB survives actual page reload with complete byte/metadata equality.
  An injected abort _after a successful native put request_ still rejects and rolls back the
  batch. Quota, disabled storage and envelope-write interruption fail explicitly; unpublished
  commits are rediscovered; missing references remain intact; an upload reference is checked
  against actual fixture bytes; ack cleanup cannot resurrect or consume another tab's work.
  No uncaught page errors. Missing Chromium is a hard blocker, never a successful skip.
- `npm run build`: **PASS** (worktree-only build; standard large-chunk warning).
- `npm run typecheck`: **PASS**, all five project configurations.
- Changed-file Prettier and `git diff --check`: **PASS** before submission.

The unchanged normal `wt land` gate runs all units, protocol/PATCHES checks, types, lint and
format checks. Its final landed SHA/receipt and gate result accompany the task completion
and #570 handoff, rather than making a commit self-reference. No deployment is part of this
repair. Reverting this unintegrated opt-in module does not change existing callers; after
#570 integrates it, rollback must preserve the recovery database and restoration path until
all pending work has an authoritative acknowledgement or explicit discard.
