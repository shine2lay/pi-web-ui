# Shared async local-admission registry

## Scope and hypothesis

Ops #585 supplies only `web/src/app-admit.ts`, `tests/unit/app-admit.test.ts` and this document. Ops is accountable. H-APP-ADMIT-FOUNDATION-1: the additive admission contract otherwise exists only in #570's unlanded integration draft. An independent, inert registry lets parallel caller repairs compile against one reviewed API without landing that integration. Expected evidence: deterministic contract tests, controlled eager/truthy/fallback negatives, build/typecheck/format and the unchanged sealed landing gate. Early success, extra invocation, changed object/error identity or fallback would falsify the contract.

This module does not make any payload durable. It has no storage, journal, replay, retry, transport, eligibility policy, ownership checks or downstream acknowledgement machinery. Importing it installs no handler and invokes nothing. It imports `ClientMessage` through the existing type-only frontend shim; no runtime server or app-globals import is needed.

## Exact API

```ts
import { appAdmit, setAppAdmit, type AppAdmit } from "./app-admit";
import type { ClientMessage } from "./types";

// Exported contract:
type AppAdmit = (msg: ClientMessage) => Promise<boolean>;
// setAppAdmit(fn: AppAdmit | null): void
// appAdmit(msg: ClientMessage): Promise<boolean>
```

- `setAppAdmit(fn)` synchronously replaces the handler for subsequent calls; `null` unbinds it.
- Each `appAdmit(msg)` captures the currently installed handler exactly once, invokes it once with the exact object, awaits it, and returns true only for `result === true`. Unbound calls resolve false without invoking a handler.
- False, undefined and other non-boolean results (including truthy objects/strings) are not admission. Runtime normalization is not permission for handlers to violate their declared `Promise<boolean>` contract.
- Rejection propagates the exact reason. A synchronous throw becomes the call's rejection with the same reason. Neither case retries, falls back, swallows failure or reports success.
- Reset/replacement cannot certify, cancel or redirect an in-flight call. That call still settles from its captured handler, even if a replacement would have returned a different result.
- The registry does not clone, trim, freeze, transform, mutate or retain payloads in a queue. It does not deduplicate separate calls. The handler must not mutate the caller's object; this wrapper supplies no immutability or snapshot isolation for it.
- `appSend` remains a separate synchronous boolean API with its existing meaning. There is never an `appSend` fallback. Existing async APIs and plugin contracts, including synchronous plugin `startChat`, are unchanged.

## Integration owner: #570

#570 must replace its draft registry with this module's imports and registration, and may re-export the same bindings/type from its owned `app-globals.ts`. Do not leave two independent registries. This task changes no current caller and installs no handler; consumers require independent HOME acceptance of the actual result before relying on it.

The installed handler, not this registry, must:

1. Classify eligibility explicitly. Only approved authored payload classes may enter their specific checkpoint path. A `ClientMessage` type is not storage permission; credentials/OAuth/capability secrets, PTY streams, probes/watches and unclassified traffic must not become a generic journal.
2. Bind the exact original intent, full text/attachments/options and source identity before asynchronous work can observe later caller edits. Preserve whitespace and all payload fields. Check ownership, conversation/session identity and authorization at the relevant admission boundary.
3. Finish and verify the complete eligible payload checkpoint and owned local admission before returning literal true. A started Promise, text-only placeholder, transport send, or partial checkpoint is not sufficient.
4. Propagate failures honestly, including failures after a payload was committed. An error carrying `payloadCommitted: true` is still rejection, not permission to clear the source or automatically retry.
5. Preserve readable/editable/exportable recovery, ownership fences and rollback/no-data-loss guarantees through subsequent failures. Provide actual integrated persistence and rollback proof separately; these registry fixtures cannot establish it.

Owner staged rollout dr-2827476c6b11 and no-data-loss m74290 still apply. This API adds no deployment, migration, installation or replay authority.

## Caller responsibilities

Callers must explicitly `await appAdmit(message)` and act only on literal true. Never use the Promise as a boolean or substitute `appSend` on false/rejection. Preserve the exact editable original, attachments/options and the last recoverable copy on every false or rejection, including a post-commit rejection. Show an honest failure/recovery path rather than silently clearing or swallowing it.

Before an eventual success triggers a destructive UI callback (clear input, close an editor, remove an attachment or mark a setting saved), compare the captured source revision and conversation/session/ownership fences with the current ones. An old completion must not clear newer edits, certify a newly opened session, or mark an unrelated value saved. Switching/resetting the registered handler supplies none of these fences and does not cancel old work.

Local true means only that the installed handler reports its local-admission condition. It is not server persistence, execution, delivery, or replay authority. Retirement of the last recoverable copy needs the separately defined, correlated downstream acknowledgement and verified recovery/rollback rules (including stable intent identity and matching source/session/owner). Unrelated or stale acknowledgement must not retire current data. Do not automatically replay uncertain work or discard originals on the strength of this registry's boolean.

## Deterministic proof and limits

`tests/unit/app-admit.test.ts` covers unbound false/no invocation, frozen complete-object identity, pending-before-release, exactly-once invocation per call, literal true versus false/non-boolean truthiness, exact rejection and synchronous-throw identity, null reset and handler replacement during in-flight success/refusal/rejection. A mocked successful `appSend` is a sentinel: the real registry must never call it.

Controlled negatives are deliberately broken local adapters, not claims that a missing pre-change module was a behavioral failure. The same pending probe detects eager success; strict-result observations distinguish truthiness; an unbound probe detects a successful transport-style fallback. All use fixed inputs and explicit Promise/microtask control, no browser, live chats, model requests or sleeps.

Focused command (in the worktree, sealed like the ordinary gate):

```sh
scripts/sealed.sh npx vitest run tests/unit/app-admit.test.ts
```

Also run ordinary build/typecheck/format checks and normal detached `wt land` with its unchanged sealed validation gate. Review the exact three-file diff. Registry proof is separate from #570's still-unverified integrated persistence, stale-source fencing and rollback proof; landing is not deployment.
