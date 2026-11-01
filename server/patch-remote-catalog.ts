/**
 * Remote-catalog merge patch for @earendil-works/pi-coding-agent.
 *
 * The SDK composes each built-in provider's model lists as
 *     getModels:    mergeModels(builtinStaticCatalog, pi.devRemoteCatalog's chat models)
 *     getAllModels: mergeModels(builtinStaticCatalog incl. image/classifier, pi.devRemoteCatalog)
 * which is a UNION: same-id entries get replaced by the newer pi.dev row, new
 * ids are appended, but stale built-in models are kept forever (and the UI
 * reports "新增 N 个模型" when the overlay grows).
 *
 * pi-web-ui wants the picker to mirror the OFFICIAL remote catalog exactly —
 * an "ensure latest, no merge, no 'new N' noise" behavior. This module rewrites
 * the installed copy of remote-catalog-provider.js so the remote overlay
 * REPLACES the built-in catalog whenever pi.dev data is present:
 *  - getModels (the chat models the picker lists): pi.dev's chat models, or the
 *    built-in ones while no remote chat model has been received yet (so the list
 *    can never be empty);
 *  - getAllModels (all types, pi 1.0+): per type the same rule, so its chat part
 *    always equals getModels.
 *
 * Same pattern as patch-node-pty.ts: idempotent (checks before rewriting) and
 * never a crash at startup (a read-only node_modules or an SDK whose source no
 * longer matches just keeps the SDK's union and logs a warning). A pi update
 * that changes the source fails tests/unit/patch-remote-catalog.test.ts, so the
 * patch can't be skipped silently. MUST be imported before the SDK modules are
 * first loaded (agent-service.ts imports this first).
 */
import {
	patchFile,
	patchSource,
	resolvePiSdkFile,
	type FilePatchStatus,
	type SourcePatchResult,
	type SourceReplacement,
} from "./sdk-file-patch.js";

/** The SDK's union fragments (one occurrence each) and their whole-replace versions. */
export const REMOTE_CATALOG_REPLACEMENTS: ReadonlyArray<SourceReplacement> = [
	{
		old: 'getModels: () => mergeModels(provider.getModels(), dynamicModels.filter((model) => isModelType(model, "chat"))),',
		new: 'getModels: () => ((chat) => (chat.length > 0 ? chat : provider.getModels()))(dynamicModels.filter((model) => isModelType(model, "chat"))),',
	},
	{
		old: "getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),",
		new: "getAllModels: () => ((types) => [...(provider.getAllModels?.() ?? provider.getModels()).filter((model) => !types.has(getModelType(model))), ...dynamicModels])(new Set(dynamicModels.map((model) => getModelType(model)))),",
	},
];

export type CatalogPatchResult = SourcePatchResult;

/** Rewrites remote-catalog-provider.js source (pure; no file access). */
export function patchRemoteCatalogSource(source: string): CatalogPatchResult {
	return patchSource(source, REMOTE_CATALOG_REPLACEMENTS);
}

/** Absolute path of the installed remote-catalog-provider.js, or null. */
export function remoteCatalogFile(): string | null {
	return resolvePiSdkFile("core", "remote-catalog-provider.js");
}

/** Patches the installed file. Returns what happened ("missing" = no SDK file found). */
export function patchRemoteCatalogFile(file: string | null = remoteCatalogFile()): FilePatchStatus {
	return patchFile(file, REMOTE_CATALOG_REPLACEMENTS);
}

function applyPatch(): void {
	try {
		const status = patchRemoteCatalogFile();
		if (status === "mismatch" || status === "missing") {
			console.warn(
				`[patch-remote-catalog] pi's remote-catalog-provider.js ${status === "missing" ? "was not found" : "no longer matches"}: the model list keeps pi's union of built-in and pi.dev models`,
			);
		}
	} catch (err) {
		// e.g. a read-only node_modules: the SDK keeps its default union merge
		console.warn(`[patch-remote-catalog] not applied: ${(err as Error).message}`);
	}
}

applyPatch();
