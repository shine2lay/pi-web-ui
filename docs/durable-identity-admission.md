# Identity editor admission — Ops #587

Accountable lead: Ops. Consumer handoff only; #570 owns integrated registration,
protocol/server echo, the unchanged full gate, landing and production proof.

## Hypothesis recorded before editing

**H-IDENTITY-ADMISSION-1:** The accepted #582 G2/B2 and #583 D06/D08/D09,
R1/R2/R4/R5/R6/R9/R10 audits show that file/draft actions ignore `appSend`
refusal and that status/hash React keys discard newer edits when save A is
acknowledged. Replace that paired store/editor path with captured operations,
exact awaited eligible admission, correlated replies and open-generation keys.
Keep complete originals and current edits in operation/editor-owned memory;
config and composite payloads never enter generic admission.

Expected result: deferred/refused/rejected/non-true admission never means Saved;
a matched persistence result makes A the baseline while B (including A→B→A)
survives; old/missing-echo results cannot finish a reopened or newer editor.
Disproof: any changed target, lost field, truthy-Promise success, hash/status
remount, unrelated busy reset, raw config admission, or automatic replay in the
real store or isolated native component tests. **Result: HIT**, on synthetic
caller fixtures (57 real-store cases and 27 native editor cases); not an
integrated persistence or crash-durability claim.

## Boundary and integration contract

- Consume #585 `appAdmit(msg): Promise<boolean>` for positively selected
  `identity_file_save` about/notebook/prompt only. Exact `true` is local
  admission, never persistence. No `appSend` fallback.
- Config file/OwnerFieldsEditor and all draft save/accept/discard actions use
  the existing authorized transient `appSend` path. The complete config stays
  only in page memory; no generic journal, new permissions or replay.
- Every action captures identity/file/action/base hash, open generation, edit
  revision, full fields/options and a unique request ID before dispatch. Store
  state and duplicate guards are registered before a possibly immediate reply.
- #570 must add optional `reqId?: string` to identity file/draft save/action
  messages and their replies and echo it unchanged on **every** result branch.
  This slice uses structural local extensions until the shared protocol lands.
  Missing or mismatched echo is not persistence evidence.
- Existing `tests/unit/identities.test.ts` and
  `tests/unit/identity-config.test.ts` contain legacy synchronous/no-echo
  expectations. #570 must migrate those call sites to await the action APIs,
  install the eligible handler, and echo the captured request ID. They are not
  owned or silently weakened by this patch. The old whole-app identity browser
  fixture also needs the integrated handler/echo; this slice tests the native
  editor in isolation, not an unregistered whole app.

## Caller/API handoff for #570

All save/draft callers identified in #582/#583 are paired in
`web/src/components/IdentitiesSettings.tsx`:

| Consumer                               | Store action                                                          | Transport               |
| -------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| `IdentityEditor` about/notebook/prompt | `await saveOpenIdentityFile(text, file)`                              | #585 `appAdmit`, E      |
| `IdentityEditor` raw config            | same async API                                                        | existing `appSend`, X/M |
| `OwnerFieldsEditor`                    | `await saveOpenIdentityFile(serializedConfig, file, "owner-form")`    | existing `appSend`, X/M |
| `DraftEditor` save/accept/discard      | `await sendIdentityDraftAction(action, prompt, config, about, draft)` | existing `appSend`, X/M |

The optional expected editor argument captures the current resource/generation,
revision and base, preventing stale closures from retargeting a click. The store
checks it and registers the guard before invoking either transport. Both actions
return `Promise<boolean>`: exact true is handoff only; consumers must await and
must not treat the Promise or any other truthy value as success. The owner's
structured form passes the third file argument so saving one config view cannot
clear the other view's separate unsent draft.

`editIdentityFile`, `editIdentityOwnerForm` and `editIdentityDraft` synchronously
retain complete native edits/options in the store. Components use resource/open
generation keys, not status/hash keys. Only a matched real result changes the
baseline to the captured A. A newer B (even A→B→A) is never reset, accepted,
discarded, closed or remounted by A. Admission failure and server refusal keep
all originals/options and current drafts. Unknown outcomes remain in memory and
are never resubmitted automatically. Unsolicited read pushes do not overwrite an
already-ready editor. Same-resource reopen creates a new generation, retaining
its authored content; an old operation cannot finish that generation.

Integration checklist:

1. Register #585's shared `setAppAdmit` handler rather than another draft
   registry; own E eligibility/ownership, full-payload checkpointing and
   refusal/rollback. There is deliberately no ordinary-send fallback for E.
2. Extend the identity messages/results with optional `reqId`, and echo each
   action's exact ID on every success **and** error path, including validation,
   permission, conflict and IO errors. Do not generate replacement reply IDs.
   File and draft-save success also require the persisted hash; draft
   accept/discard success uses the server's matched terminal result. The store
   buffers a synchronous reply until the action is truthfully admitted.
3. Migrate the existing synchronous/no-echo unit and whole-app browser fixtures
   above without weakening their assertions. `appSend` and plugin contracts
   remain synchronous and unchanged. No-echo/mismatched results intentionally
   leave the operation unresolved, not Saved.
4. Combine the handoff commit with the other accepted consumers, then run the
   unchanged sealed full gate and production/no-data-loss/rollback proofs. This
   patch is not independently landable/deployable onto the unregistered host.

## Verification

Run only on synthetic fixtures; the native harness bundles the real component,
real store and shared registry, not a reimplementation or a whole-app server.

- `TZ=UTC npx vitest run tests/unit/durable-identity-admission.test.ts tests/unit/app-admit.test.ts`
- `node tests/durable-identity-admission-test.mjs`
- `node tests/durable-identity-admission-test.mjs --baseline` loads the actual
  old two callers from #585's `4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`
  pin in memory. It must detect false `appSend` success and hash-ACK loss of B;
  controls do not fail because a new API is absent.
- `npm run build`, `npm run typecheck`, `npm run lint`, targeted
  `prettier --check`, `git diff --check`.

Verification correction, **H-IDENTITY-FIXTURE-TYPES-1**: the first focused/native
checks passed, but typecheck correctly rejected the test fixture's string-only
`reqId` intersection with all `ClientMessage` variants (13 errors). Some other
messages have numeric IDs. Widen only the capture fixture to string-or-number
and explicitly narrow identity echoes to string; production API/types stay
unchanged. The draft reply fixture additionally narrows the actual action type,
not merely the presence of an `id` field, since unrelated messages use non-string
IDs. **Result: HIT**; all project typechecks and the same behavioral assertions
pass, without changing production types or weakening a check.

Final verification (sealed temporary HOME for tests/build/typecheck/lint):

| Check                                                       | Result                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Focused real-store regression suite                         | **57 passed**                                                                                      |
| Shared #585 registry suite                                  | **29 passed**, 86 focused total                                                                    |
| Native real component/store/registry                        | **27 passed**, zero browser exceptions                                                             |
| Actual old callers, red controls                            | **3 passed**: baseline loads; refused-send false success reproduced; hash-ACK loss of B reproduced |
| Build                                                       | **PASS**                                                                                           |
| Project-wide typecheck (server/web/tests/desktop/extension) | **PASS**                                                                                           |
| Lint                                                        | **PASS**, zero errors; 50 existing repository warnings                                             |
| Targeted format and whitespace                              | **PASS**                                                                                           |

The unchanged full gate and production/no-data-loss/rollback proof remain
explicitly owed by #570, not claimed here. The legacy synchronous/no-echo tests
are an integration migration dependency above, not a standalone passing full
gate. No active UI is installed from this handoff.

No real identity files, chats, browser profiles, model-bound data or services
are used. Memory retention is not crash durability, server deduplication,
permission, recovery authority or a claim of integrated no loss. Undo: omit this
handoff commit before integration, or revert it together with the corresponding
integrated caller/echo wiring; never undo just the awaited consumer contract.
