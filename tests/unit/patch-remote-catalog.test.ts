/**
 * The model picker mirrors pi.dev's catalog (server/patch-remote-catalog.ts rewrites pi's
 * remote-catalog-provider.js at startup). The server only warns when the patch no longer matches,
 * so this test is what stops a pi update from silently bringing back the union with stale built-in
 * models: it fails unless the installed pi's file takes the patch, and checks the patched code.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	patchRemoteCatalogFile,
	patchRemoteCatalogSource,
	REMOTE_CATALOG_REPLACEMENTS,
	remoteCatalogFile,
} from "../../server/patch-remote-catalog.js";

interface FakeModel {
	id: string;
	provider: string;
	type?: string;
}

const chat = (id: string): FakeModel => ({ id, provider: "anthropic" });
const image = (id: string): FakeModel => ({ id, provider: "anthropic", type: "image" });
const ids = (models: FakeModel[]): string[] => models.map((m) => `${m.type ?? "chat"}:${m.id}`).sort();

describe("patch-remote-catalog", () => {
	it("takes the installed pi's remote-catalog-provider.js (fails when pi changed it)", () => {
		const file = remoteCatalogFile();
		expect(file).toBeTruthy();
		// The module import above already patched it (as the server does at startup); a pi
		// whose source no longer matches reports "mismatch" here.
		expect(patchRemoteCatalogFile(file)).toBe("already");
		const source = readFileSync(file!, "utf8");
		for (const r of REMOTE_CATALOG_REPLACEMENTS) expect(source).toContain(r.new);
	});

	it("rewrites the pi source once and leaves it alone afterwards", () => {
		const pristine = REMOTE_CATALOG_REPLACEMENTS.map((r) => `\t\t${r.old}`).join("\n");
		const first = patchRemoteCatalogSource(pristine);
		expect(first.status).toBe("patched");
		expect(patchRemoteCatalogSource(first.source).status).toBe("already");
	});

	it("reports a changed source instead of patching half of it", () => {
		const [getModels, getAllModels] = REMOTE_CATALOG_REPLACEMENTS;
		const changed = `${getModels!.old}\n${getAllModels!.old.replace("dynamicModels", "remoteModels")}`;
		const result = patchRemoteCatalogSource(changed);
		expect(result.status).toBe("mismatch");
		expect(result.source).toBe(changed);
		if (result.status === "mismatch") expect(result.missing).toEqual([getAllModels!.old]);
		expect(patchRemoteCatalogSource("").status).toBe("mismatch");
	});

	it("lists pi.dev's models instead of adding them to the built-in ones", async () => {
		const file = remoteCatalogFile()!;
		const { withRemoteCatalog } = (await import(pathToFileURL(file).href)) as {
			withRemoteCatalog: (
				provider: object,
				baseUrl?: string,
				localGeneratedAt?: number,
			) => {
				getModels(): FakeModel[];
				getAllModels(): FakeModel[];
				refreshModels(context: object): Promise<void>;
			};
		};
		const builtIn = {
			id: "anthropic",
			getModels: () => [chat("stale"), chat("kept")],
			getAllModels: () => [chat("stale"), chat("kept"), image("built-in-image")],
		};
		const provider = withRemoteCatalog(builtIn, "https://catalog.invalid");
		// No pi.dev data yet: the built-in catalog, so the list is never empty.
		expect(ids(provider.getModels())).toEqual(["chat:kept", "chat:stale"]);

		// Restore a stored pi.dev overlay (no network).
		await provider.refreshModels({
			stored: { models: [chat("kept"), chat("new")], checkedAt: Date.now(), lastModified: 1 },
			allowNetwork: false,
			force: false,
			signal: new AbortController().signal,
			publish: async (change: { update?: () => void }) => {
				change.update?.();
				return true;
			},
		});
		// The picker: exactly pi.dev's chat models, without the stale built-in one.
		expect(ids(provider.getModels())).toEqual(["chat:kept", "chat:new"]);
		// All types: per type the same rule (pi.dev sent no image models, so the built-in ones stay).
		expect(ids(provider.getAllModels())).toEqual(["chat:kept", "chat:new", "image:built-in-image"]);
	});
});
