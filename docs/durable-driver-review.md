# Durable native ACP contract repair — Ops #575

Accountable lead: Ops. Scope is library/driver repair only, before W2 host integration (#570). No deployment, migration, live settings edits or model requests.

## H-NATIVE-ACP-PARITY-1 (before changes)

Evidence at `7ec462dc`: `loadBillionContextExtension` uses CommonJS `require.resolve` and treats `ERR_PACKAGE_PATH_NOT_EXPORTED` as absence, but BCP's real `./durable` export supplies only `types` and `import` conditions. `DurableAgentDriver.registrations` intersects native registrations with a bridge list that only knows coding tools and SDK/plugin tools, so installed native ACP tools are not callable. `DurableSessionState.syncNow` prefers the inherited migration header ID over the host mapping, giving forks their parent's guard identity.

Change: resolve the native adapter's ESM export without disguising a broken installed adapter as absent; supply the bridge with the applicable base native tool registrations before it reconciles the callable loadout; keep explicit host identity separate from numeric fallback and prefer it over historical header provenance.

Expected result: disposable packages with the exact import/types-only manifest load lazily and their harmless native tools actually execute. Persisted allowlists/removals and plugin exposure/default filters still win after startup, selection changes and reopen. Native and classic ACP do not both handle a session. Forks with a copied migration document use separate mapped host UUIDs for SDK state and pre/post guards without rewriting the original header or losing inherited active context.

Falsification: import-only export is skipped; a broken export, missing file/dependency or evaluation error becomes absence; an explicitly disabled/filtered tool executes; classic ACP also starts; a child's guard sees the parent's ID; provenance, edited context, archive mapping or foreign-reference denial regresses.

## H-NATIVE-ACP-SELECTION-1 (static review, before verification)

Review found that membership-only reconciliation rebuilt persisted native extension selection in installation order. Durable resolves duplicate tool names and wrappers in selected order; reopening could therefore substitute a less restrictive registration. Preserve `configured.extensions` order while retaining only applicable base extensions. Expect a persisted reordered, duplicate-name caller restriction to remain enforced after reopening; an executable model-only fallback or changed winner disproves this. The direct-tool fixture must append the public `AssistantEntry` token and require both a completed task and a real tool result, so a malformed fixture cannot masquerade as a deny.

## Verification design

All fixtures are authored, disposable and sealed; no owner session contents or app/mock model payloads are printed. Tests exercise tools directly through durable's public tool API, not a provider request. Old-code controls cover the exact CommonJS export failure, the missing native-name intersection and inherited-header precedence. The existing isolated W1-C fixture suite also runs after the repair. Build and full normal landing gate remain required.

## Host contract (#570)

The host must keep using the validated migrator manifest to map durable IDs to host UUIDs, including fresh fork IDs; a source migration header is provenance, not a child identity. #573 confirmed the mapping contract is unchanged: `entryIds` are archive IDs; `contextEntryIds`/`contextOrder` are active IDs; legacy refs are never rewritten. Optional `MigrationOptions.parentSessionMap` explicitly enumerates offline parent sources; missing inherited state refuses, with no basename guessing or live-parent reads. W2 must install the built native BCP adapter at its explicit agent npm root; no TypeScript-source fallback or general conditional-exports resolver is added. Unsupported installed export shapes fail visibly. Keep host pi-ai 1.0.1 and durable's pi-ai 1.4.0 peer resolution separate. The disposable type/import proof below is not live host parity. No cutover or release approval is implied.

## H-NATIVE-ACP-FIXTURE-1 (first verification)

Initial sealed run: 38/39 fixtures passed; actual BCP source declaration/type/import check passed. One comparison bridge intentionally omitted native registrations but also omitted the native-ACP suppression flag, so its SDK resource discovery started classic ACP. The driver bridge itself had already executed native ACP correctly. Keep native suppression in this old-intersection comparison; only omit the native registrations. The five-target typecheck also caught the context stub's missing required `head` field. Add `head: undefined` to the stub. Expected: all 39 fixtures and typecheck pass without another production change; a driver suppression or native execution failure disproves this fixture diagnosis.

## Results

- **H-NATIVE-ACP-PARITY-1 HIT (library proof):** 18 existing W1-C fixtures and 21 dedicated review fixtures verified: the initial combined run passed 38/39; the one comparison-fixture defect above was corrected and that execution test passed on its targeted rerun. Both real import/types and older unconditional export shapes execute harmless native ACP. Native calls, explicit allowlists/removals, reopen/selection changes, plugin caller/default/exposure/deferred filters, classic suppression, fork guards, immutable provenance, archive/active context and foreign refs are covered.
- **H-NATIVE-ACP-SELECTION-1 HIT:** reordered duplicate-name caller restrictions survive reopen; the direct task fixture requires the public assistant token, a completed outcome and an actual result, not merely absence of output.
- **H-NATIVE-ACP-FIXTURE-1 HIT:** corrected comparison bridge passed without another production change; all five TypeScript targets then passed.
- `scripts/sealed.sh env TZ=UTC node tests/durable-driver-review-controls.mjs`: **3/3 intended failures** on actual `7ec462dc` source, matched to separate export, callable-loadout and child-identity assertion markers. Controls never print app/mock model data.
- `scripts/sealed.sh env TZ=UTC node tests/durable-driver-review-peer-check.mjs /home/shinelay/projects/billion-context-pi`: **PASS**. Actual BCP source was copied/compiled only in a disposable package carrying its real manifest, declaration/typechecked against installed peers and imported natively; all five expected tools registered. SDK pi-ai 1.0.1 and durable/pi-ai 1.4.0 remain unchanged. No native owner-data tool or provider was invoked.
- Sealed five-target typecheck and complete build **PASS**; all changed TS/MJS files pass Prettier; `oxlint server/durable` reports no errors. Production diff is confined to the driver slice; manifests and lockfile are untouched.
- The normal detached `wt land` full gate remains mandatory; its final checked commit/receipt belongs to task completion, not a live install. The unit wrapper keeps all 21 review cases in that gate. No deployment, cutover, migration, live settings/config read or owner session access occurred.

Undo: revert the isolated `durable-native-acp-parity` commit before W2 integration. No persisted schema, mapping or provenance is rewritten; source sessions and live settings are unaffected.
