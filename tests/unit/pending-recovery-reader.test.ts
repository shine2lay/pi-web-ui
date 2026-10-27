import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failure = vi.hoisted(() => ({ index: false }));
vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		rename: async (from: string, to: string) => {
			if (failure.index && String(to).endsWith("/index.html"))
				throw new Error("synthetic index publication interruption");
			return real.rename(from, to);
		},
	};
});
// The CLI bundles checked modules separately. These deterministic cases exercise
// additive filesystem publication, not a fake browser/module losslessness claim.
import {
	installReaders,
	readerAssets,
	READER_PLUGIN_ID,
	verifyReaders,
} from "../../scripts/pending-recovery-reader.mjs";

const roots: string[] = [];
async function root() {
	const path = await mkdtemp(join(tmpdir(), "pending-reader-artifacts-"));
	roots.push(path);
	return path;
}
const assets = (version = "a") =>
	readerAssets({
		pendingHtml: `<!doctype html><title>Pending ${version}</title><p> exact 字节\n and whitespace </p>`,
		pluginHtml: `<!doctype html><title>Plugin ${version}</title><p>Original option presence remains separate.</p>`,
		revision: version.repeat(40),
		sources: { pending: "1".repeat(64), plugin: "2".repeat(64) },
	});
afterEach(async () => {
	failure.index = false;
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("retained reader artifact publication", () => {
	it("requires both complete reader documents and a source revision", () => {
		expect(() => readerAssets({ pendingHtml: "", pluginHtml: "", revision: "a".repeat(40), sources: {} })).toThrow(
			/complete/,
		);
		expect(() =>
			readerAssets({ pendingHtml: "<!doctype html>", pluginHtml: "<!doctype html>", revision: "unknown", sources: {} }),
		).toThrow(/revision/);
	});

	it("installs exact full contents with integrity and no browser/source record reads", async () => {
		const path = await root();
		const canary = join(path, "original-session.jsonl");
		const original = '{"type":"synthetic-canary","text":" leave exact bytes 未变 "}\n';
		await writeFile(canary, original);
		const input = assets();
		const result = await installReaders(path, input);
		expect(result.url).toBe(`/plugins/${READER_PLUGIN_ID}/client/index.html`);
		for (const name of ["pending.html", "plugin-start.html"] as const) {
			expect(await readFile(join(result.path, input.manifest.version, name), "utf8")).toBe(input.html[name]);
		}
		expect(await readFile(canary, "utf8")).toBe(original);
		expect((await verifyReaders(path)).versions).toEqual([input.manifest]);
	});

	it("retains standalone typed modules without weakening their original CSP or replacing old readers", async () => {
		const path = await root();
		const old = assets("a");
		await installReaders(path, old);
		const extraFiles = {
			"composer.html":
				'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><script type="module" src="./composer.mjs"></script>',
			"composer.mjs": 'document.body.append("complete original 字节");',
			"scheduler.html": '<!doctype html><script type="module" src="./scheduler.mjs"></script>',
			"scheduler.mjs": 'document.body.append("no automatic scheduling");',
		};
		const next = readerAssets({
			pendingHtml: old.html["pending.html"],
			pluginHtml: old.html["plugin-start.html"],
			revision: "b".repeat(40),
			sources: { fixture: "typed" },
			extraFiles,
		});
		const result = await installReaders(path, next);
		for (const [name, content] of Object.entries(extraFiles))
			expect(await readFile(join(result.path, next.manifest.version, name), "utf8")).toBe(content);
		const index = await readFile(join(result.path, "index.html"), "utf8");
		for (const name of ["pending.html", "plugin-start.html", "composer.html", "scheduler.html"])
			expect(index).toContain(`./${next.manifest.version}/${name}`);
		expect(index).toContain(`./${old.manifest.version}/pending.html`);
		expect(index).not.toContain(`href="./${next.manifest.version}/composer.mjs"`);
		expect((await verifyReaders(path)).versions).toEqual([old.manifest, next.manifest]);
	});

	it.each([
		{ "composer.html": "<!doctype html>" },
		{ "scheduler.mjs": "export {};" },
		{ "../outside.html": "<!doctype html>" },
		{ "unreviewed.html": "<!doctype html>", "unreviewed.mjs": "export {};" },
		{ "pending.html": "<!doctype html>" },
	])("refuses incomplete, unknown or overriding typed assets before publication (%j)", (extraFiles) => {
		expect(() =>
			readerAssets({
				pendingHtml: "<!doctype html>",
				pluginHtml: "<!doctype html>",
				revision: "a".repeat(40),
				sources: {},
				extraFiles,
			}),
		).toThrow();
	});

	it("detects damage in a typed module rather than qualifying its HTML alone", async () => {
		const path = await root();
		const input = readerAssets({
			pendingHtml: "<!doctype html>",
			pluginHtml: "<!doctype html>",
			revision: "a".repeat(40),
			sources: {},
			extraFiles: { "composer.html": "<!doctype html>", "composer.mjs": "export {};" },
		});
		const result = await installReaders(path, input);
		await writeFile(join(result.path, input.manifest.version, "composer.mjs"), "damaged bytes");
		await expect(verifyReaders(path)).rejects.toThrow(/hash mismatch/);
		await expect(installReaders(path, assets("b"))).rejects.toThrow(/older retained reader is damaged/);
		expect(await readFile(join(result.path, input.manifest.version, "composer.mjs"), "utf8")).toBe("damaged bytes");
	});

	it("keeps all prior versions reachable and makes repeated install idempotent", async () => {
		const path = await root();
		const old = assets("a");
		const newer = assets("b");
		await installReaders(path, old);
		const result = await installReaders(path, newer);
		await installReaders(path, newer);
		expect((await verifyReaders(path)).versions).toEqual([old.manifest, newer.manifest]);
		const index = await readFile(join(result.path, "index.html"), "utf8");
		for (const input of [old, newer]) {
			expect(index).toContain(`./${input.manifest.version}/pending.html`);
			expect(index).toContain(`./${input.manifest.version}/plugin-start.html`);
			for (const name of ["pending.html", "plugin-start.html"] as const)
				expect(await readFile(join(result.path, input.manifest.version, name), "utf8")).toBe(input.html[name]);
		}
	});

	it("survives removal of a separate application bundle (filesystem boundary only)", async () => {
		const path = await root();
		const app = join(path, "versioned-application");
		await mkdir(app);
		await writeFile(join(app, "app.js"), "synthetic old app");
		const input = assets();
		const result = await installReaders(path, input);
		await rm(app, { recursive: true });
		expect(await readFile(join(result.path, input.manifest.version, "pending.html"), "utf8")).toBe(
			input.html["pending.html"],
		);
		expect((await verifyReaders(path)).versions).toEqual([input.manifest]);
	});

	it("preserves the old index and every version when final publication is interrupted", async () => {
		const path = await root();
		const old = assets("a");
		const newer = assets("b");
		const first = await installReaders(path, old);
		const before = await readFile(join(first.path, "index.html"));
		failure.index = true;
		await expect(installReaders(path, newer)).rejects.toThrow(/synthetic index/);
		expect(await readFile(join(first.path, "index.html"))).toEqual(before);
		expect(await readFile(join(first.path, old.manifest.version, "pending.html"), "utf8")).toBe(
			old.html["pending.html"],
		);
		expect(await readFile(join(first.path, newer.manifest.version, "pending.html"), "utf8")).toBe(
			newer.html["pending.html"],
		);
		await expect(verifyReaders(path)).rejects.toThrow(/publication is incomplete/);
		failure.index = false;
		expect((await installReaders(path, newer)).versions).toEqual([old.manifest, newer.manifest]);
	});

	it("does not overwrite another plugin or unrecognized owner metadata", async () => {
		const path = await root();
		const plugin = join(path, "plugins", READER_PLUGIN_ID);
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "existing.txt"), "unrelated source");
		await expect(installReaders(path, assets())).rejects.toThrow(/another source/);
		expect(await readFile(join(plugin, "existing.txt"), "utf8")).toBe("unrelated source");
		await writeFile(join(plugin, ".retained-reader-owner.json"), JSON.stringify({ format: "not-ours" }));
		await expect(installReaders(path, assets())).rejects.toThrow(/not owned/);
	});

	it("refuses damaged prior versions without overwriting the evidence or old index", async () => {
		const path = await root();
		const old = assets("a");
		const result = await installReaders(path, old);
		const before = await readFile(join(result.path, "index.html"));
		const damaged = join(result.path, old.manifest.version, "pending.html");
		await writeFile(damaged, "synthetic damaged reader");
		await expect(installReaders(path, assets("b"))).rejects.toThrow(/older retained reader is damaged/);
		await expect(verifyReaders(path)).rejects.toThrow(/hash mismatch/);
		expect(await readFile(damaged, "utf8")).toBe("synthetic damaged reader");
		expect(await readFile(join(result.path, "index.html"))).toEqual(before);
	});

	it("rejects changed input before publishing a catalogue/index", async () => {
		const path = await root();
		const first = await installReaders(path, assets("a"));
		const before = await readFile(join(first.path, "index.html"));
		const newer = assets("b");
		newer.html["pending.html"] = "<!doctype html><title>changed after capture</title>";
		await expect(installReaders(path, newer)).rejects.toThrow(/no longer matches/);
		expect(await readFile(join(first.path, "index.html"))).toEqual(before);
		expect((await verifyReaders(path)).versions).toHaveLength(1);
	});

	it("refuses concurrent or interrupted owners instead of silently losing a catalogue update", async () => {
		const path = await root();
		const first = await installReaders(path, assets("a"));
		const lock = join(path, "plugins", READER_PLUGIN_ID, ".reader-install-lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), '{"pid":123,"synthetic":true}');
		await expect(installReaders(path, assets("b"))).rejects.toThrow(/reader install owns/);
		expect((await verifyReaders(path)).versions).toEqual(first.versions);
		expect(await readFile(join(lock, "owner.json"), "utf8")).toBe('{"pid":123,"synthetic":true}');
	});

	it("detects source-metadata tampering and rejects traversal/empty catalogues", async () => {
		const path = await root();
		const result = await installReaders(path, assets());
		const catalogue = join(result.path, "readers.json");
		const original = JSON.parse(await readFile(catalogue, "utf8"));
		const changed = structuredClone(original);
		changed.versions[0].revision = "b".repeat(40);
		await writeFile(catalogue, JSON.stringify(changed));
		await expect(verifyReaders(path)).rejects.toThrow(/source\/version metadata/);
		changed.versions[0].version = "../escape";
		await writeFile(catalogue, JSON.stringify(changed));
		await expect(verifyReaders(path)).rejects.toThrow(/Invalid/);
		original.versions = [];
		await writeFile(catalogue, JSON.stringify(original));
		await expect(verifyReaders(path)).rejects.toThrow(/Unrecognized/);
	});
});
