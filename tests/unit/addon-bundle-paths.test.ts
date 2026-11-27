import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { addonBundlePath, addonBundleSettings } from "../../server/addon-bundle-paths.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "addon-bundle-"));
	roots.push(root);
	const bundle = join(root, "bundle");
	const target = join(bundle, "pi-example");
	mkdirSync(target, { recursive: true });
	return { root, bundle, target };
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staged local packages", () => {
	it("is an exact no-op without a nonempty override", () => {
		vi.stubEnv("PI_WEB_ADDONS_DIR", "");
		const settings = SettingsManager.inMemory({ packages: ["/home/shinelay/projects/missing"] });
		expect(addonBundleSettings(settings)).toBe(settings);
		expect(addonBundlePath("/home/shinelay/projects/missing")).toBe("/home/shinelay/projects/missing");
	});
	it("rewrites only immediate local project package directories", () => {
		const { bundle, target } = fixture();
		vi.stubEnv("PI_WEB_ADDONS_DIR", bundle);
		expect(addonBundlePath("/home/shinelay/projects/pi-example")).toBe(target);
		for (const source of [
			"npm:pi-example",
			"git:github.com/a/b",
			"./pi-example",
			"/else/pi-example",
			"/home/shinelay/projects/pi-example/sub",
			"/home/shinelay/projects/..",
		])
			expect(addonBundlePath(source)).toBe(source);
	});
	it("fails closed for missing targets, files and unreadable directories", () => {
		const { bundle, target } = fixture();
		vi.stubEnv("PI_WEB_ADDONS_DIR", bundle);
		expect(() => addonBundlePath("/home/shinelay/projects/absent")).toThrow(/PI_WEB_ADDONS_DIR/);
		rmSync(target, { recursive: true });
		writeFileSync(target, "not a package directory");
		expect(() => addonBundlePath("/home/shinelay/projects/pi-example")).toThrow(/PI_WEB_ADDONS_DIR/);
		rmSync(target);
		mkdirSync(target, { mode: 0o000 });
		try {
			expect(() => addonBundlePath("/home/shinelay/projects/pi-example")).toThrow(/PI_WEB_ADDONS_DIR/);
		} finally {
			chmodSync(target, 0o700);
		}
	});
	it("preserves selection metadata through SDK reload without changing settings bytes", async () => {
		const { root, bundle, target } = fixture();
		vi.stubEnv("PI_WEB_ADDONS_DIR", bundle);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const file = join(agentDir, "settings.json");
		const selected = { source: "/home/shinelay/projects/pi-example", extensions: [], skills: [], autoload: false };
		const bytes = JSON.stringify({ packages: [selected], extensions: ["-builtin:mcp"] });
		writeFileSync(file, bytes);
		const manager = addonBundleSettings(SettingsManager.create(root, agentDir));
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: manager, noContextFiles: true });
		await loader.reload();
		expect(manager.getGlobalSettings().packages).toEqual([{ ...selected, source: target }]);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		rmSync(target, { recursive: true });
		await expect(loader.reload()).rejects.toThrow(/PI_WEB_ADDONS_DIR/);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});
});
