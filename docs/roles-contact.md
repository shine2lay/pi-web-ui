# Roles: owner contact and channel receipts (I-CONTACT, unit O0)

Ops #140, Roles build R6. **Inert:** nothing in production imports these files; there is no instance, route,
registration, timer, file, key or Telegram send. Wiring is J0's (below). Records are display-only (C01).

## Files

- `server/roles-contact.ts`: browser and plugin (Telegram) contact classification from Ops108's native marks
  (`classifyOwnerContact`), the per-stage view (`contactStages`), the callback adapter (`ownerSavedRoot`), the
  render/open roots (`ownerActionRoot`) and the read-only observer view (`observeContact`).
- `server/roles-owner-challenge.ts`: the authorized owner challenge handler (`createOwnerChallengeHandler`).
- `server/roles-owner-native.ts`: the only native inputs (T03 owner admitter, session owner, T05 capability,
  server wall and monotonic clocks). While T03/T05 are missing they admit nobody and return no owner or capability.
- Tests: `tests/unit/roles-contact.test.ts`, `tests/unit/roles-owner-challenge.test.ts`.

## Meanings

- Stages are separate and none implies the next: contact accepted, role delivered, reply, answer saved
  (callback persisted), Telegram transport, matching-client rendered, explicitly opened.
- A missing callback is "Delivery not recorded", never failed without a native failure proof. No reply index or an
  incomplete one is "Reply not recorded"; a complete empty index is "Not yet".
- Telegram API acceptance is transport only ("Accepted by Telegram (not a read)"); some parts sent is partial.
- A task-only answer stays task-only: never owner delivery, never rendered or opened.
- Untyped owner turns are neutral "Your contacts" (C02). The classifier reads no text; "?" types nothing.
- Mixed causes, pseudo clients, invalid or conflicting stamps and any model/tool/plugin/client owner flag are
  unknown. Ops108 routing is unchanged (role-replies.ts, plugins.ts and the Telegram plugin keep their bytes).
- Render is not open, sight, consent, acknowledgement or confirmation. Only `render` and `open` can be challenged.

## Challenge handler (BINDING.md, SPEC v2 §4)

Security accepted the binding in documents only (rm-4c755cd7: B1, B3, B4 with 60000 ms, B5). The code below meets
its code-verdict checks but has not had that verdict; it is needed before any wiring.

- Principal: only a native T03 owner principal, read from `roles-owner-native.ts`. No admitter, clock or randomness
  can be passed as an option, env, config or flag. T03 is missing, so every connection is unknown
  `owner-principal-not-admitted` and no challenge is ever issued. Browser origin, Ops108's ownerChannel, a Telegram
  chat, a client label and model/tool/plugin flags are refused (`origin-admission-not-owner-auth`): agents drive
  the owner's own browser, so none of them can be the owner.
- Host scope `owner-client` or `observer`, from the server route/connection, never a label. Observers get no
  challenge and answer none. Owner-client scope is not the owner.
- Client id, incarnation and build come from the answering connection as the host knows it; the reply carries only
  the challenge id and value. A mismatch refuses.
- 256-bit value in server memory only, with an id drawn separately; the value is in no receipt, refusal, ref id,
  revision or log. Bound to principal, session, window, client incarnation + build, channel, action and the current
  artifact/projection/coverage/policy; single use.
- 60000 ms on the server wall clock and on a monotonic clock: accepted at expiresAt - 1, refused at expiresAt; a
  wall-clock step does not extend it. The older "TTL120s" text is superseded.
- The answer is compared as exact UTF-8 bytes (length first, then a constant-time compare), never decoded.
- One pending challenge per binding (a new issue replaces it); at most 256 pending, then unavailable
  `challenge-capacity`.
- Wrong answer or changed binding (reload, new build, moved subject) invalidates it; no automatic reissue.
- The same accepted action again returns the original receipt only (also after expiry), minting nothing; other
  bytes are a conflict.

## Under the C0 seams

T02, T03 and T05 are absent, so every owner-saved/rendered/opened root validates unknown
(`canonical-source-not-committed` or `owner-principal-not-admitted`) or unavailable. Tests replace
`roles-owner-native.ts` with `vi.mock` to show acceptance with a fixture principal and an `rtpi-fixture`
capability; the O0 modules export no fixture admitter or capability. (C0's `createRtpiFixtureCapability` in
`rtpi-core.ts` validates only `rtpi-fixture` roots; O0 production code never imports it.)

## For J0 (wiring, not done here)

O0 shares agent-service hooks with M0 (#139), so it edits no existing file. J0, under its own approved plan and
off-by-default switch, would:

1. agent-service.ts, where role turns record `cause` and `ownerChannel` (around `collectRoleInput` callers and the
   Telegram path that stamps `ownerChannel: "telegram"`): build `NativeContactInput` from the stored
   RoleTurnRecord (source `native-record`), never from tool arguments.
2. agent-service.ts native reply/callback persistence (`onReply` / forOwner answer save): feed
   `NativeCallback` (`persisted` with the store time, or `failed` only with the store's own error).
3. Telegram plugin send outcome (plugins.ts host API): feed `NativeTransport` from the Bot API result
   (message ids per part, or the API error code). No new send and no change to routing.
4. index.ts browser connection: host scope, client id/incarnation/build (server-minted at page load) and
   pseudo-client flag, for `OwnerHostConnection`; `invalidateClient` on reconnect, reload and close. A handler
   instance (`currentBuild`, `currentIncarnation`) is created only when a native T03 admitter exists, after
   Security's code verdict on these files and the owner's approval.
5. Add the `rtpi` / `roles-contact` row to PATCHES.md with the first production importer.

## Undo

Delete the six files (or revert the O0 commit). No store, route or record depends on them.
