# L0: resource loads, save actor and runtime selections (#142 / R8)

**Inert source only.** `roles-resource.ts` and `roles-resource-native.ts` have no production importer, route, instance, writer, timer or registered hook. There is no change to the live Roles page, SDK, identity settings, About/rules/focus access, authentication or model handling. No private resource contents, content hashes or profile values are read or transported. Same-UID records remain display-only under C01, not verified evidence or authority.

## Interfaces

`ResourceRecord` implements pi-identity's closed `i-resource/1` structural seam. Only UUIDv4 resource revision/integrity references are allowed; integrity is an opaque attestation reference, not a content digest or a cryptographic authentication claim. Other references are exact closed whole refs. The host supplies the canonical role/session/epoch/operation binding independently of the DTO and the operation timestamp in the common C0 envelope.

`rolesNativeResourceRoot()` accepts **no arguments**. Only the sealed native module can supply input, canonical host binding, qualification, capability and the session-bound O0 principal lookup. Its null owner seam is wired by J0 only after approval; it does not import O0 now. It maps the DTO into the accepted C0 resource body, without changing the C0 schema or validators:

- incorporation → resource-incorporated, known only after the native successful-incorporation callback; prepared/failed remain unknown;
- save → config-saved, known only after canonical native commit and authenticated save actor; owner additionally must match O0's native owner principal for that session and its T03 qualification;
- selection → profile-selected, with independent requested/launch/current-selected scope.

C0 checks capability, atomic outbox/source commit, lineage/incarnation/sequence/revision and closed metadata. Its body carries the accepted resource revision and an empty generic evidence list: integrity and authenticated actor belong only to L0's closed, scoped native association, never the core's non-authority evidence refs. Only verdicts this adapter minted have its process-local record association; copied JSON or a generic structurally/C0 accepted root cannot project a native fact. The adapter does not write a journal; J0 must atomically persist a canonical operation's outbox before producing durable receipts. Conflicting duplicate operation records or ambiguous newest records project unknown; failure does not silently fall back to a stale success.

`rolesResourceProjection(scope, receipts)` produces an additive `i-resource-view/1` sidecar:

| Field | Known only from | Missing/failed |
| --- | --- | --- |
| resources[].loaded | successful native incorporation; opaque revision/integrity and incorporation time | Not recorded, null time/refs |
| resources[].changed | successful separately scoped current metadata observation at/after the load, whole-ref revision comparison | Not recorded, null observedAt |
| resources[].saved.editedAt / actor | authenticated canonical save event (owner gated through O0) | Not recorded, null editedAt/actor |
| runtime.requested / launch / currentSelected | each corresponding native transition independently | Not recorded, no inference from another selection |
| runtime.saved.editedAt / actor | authenticated runtime-settings save metadata, not its values | Not recorded |
| runtime.executedModel | no execution evidence is collected here | Always Not recorded |

A newer current revision yields Changed since load; an equal one yields Unchanged. Neither changes the historical load. A failed current read leaves a known prior load intact, but its changed state is Not recorded. Role/session/epoch rebinds never inherit old receipts. Projection does not change any existing DTO/store fields; J0 merges only the additive sidecar and wires the separately accepted renderer.

## D-MISSING / J0 handoff

Native input/capability/current readers return null. O0/T03 still admits no principal. T02/T05 and a successful host incorporation callback are missing; therefore native resource/save/selection facts remain Not recorded. Synthetic tests qualify only fixed fixture metadata; they do not prove any real role loaded, owner saved, or model ran. No authority-bearing caller options, environment switch, backfill from mtime/current profile, private body extraction or install is supplied.

J0 owns shared `pi-identity/index.ts` and `server/agent-service.ts` hooks. This unit changes neither. The bounded native proposal is `~/company-lab/shared/roles-resource-l0-2026-10-14/J0-PATCH.md`; it is not approval to implement/activate native primitives. Core, native integration, installation and switch-on follow their separate approved tasks.

## Verification and rollback

`tests/unit/roles-resource.test.ts`: V09/V15/V18, S01/S02/S07, known/prepared/failed/changed cases, native missing gates, owner/role actor authentication, selection override without execution, forbidden-content/hash/key tests, exact-context rebind, copies/replay/conflict, immutable metadata and inert importer checks. Locally it uses the actual identity structural helper on fixed metadata (no deployment-path dependency); that cross-repository proof is skipped if the adjacent repository is absent. Old pi-identity tests remain unchanged.

Normal gates run after all source changes. Source/undo audit pins the two base commits and shows only new files. Before activation, revert the web commit then identity commit through normal worktree gates; nothing live is detached or rewritten. After a future approved integration, disable the producer/readers first and use the separately proved compatible rollback. No receipt resends, canonical chat edits or evidence deletion.
