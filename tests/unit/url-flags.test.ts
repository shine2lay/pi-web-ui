/**
 * debug-controls (Ops #621): the preset ("Full"), permission ("Full access") and Tools (Tool Inspector) controls
 * stay off the page unless its address asks for them (web/src/url-flags.ts).
 */
import { describe, expect, it } from "vitest";
import { showPermissionControls, showToolInspector, urlFlag } from "../../web/src/url-flags.js";

describe("url-flags", () => {
	it("a switch is on only as name=1", () => {
		expect(urlFlag("debugPerm", "?debugPerm=1")).toBe(true);
		expect(urlFlag("debugPerm", "?chat=a.jsonl&debugPerm=1")).toBe(true);
		expect(urlFlag("debugPerm", "debugPerm=1")).toBe(true);
		for (const search of ["", "?", "?debugPerm", "?debugPerm=0", "?debugPerm=true", "?debugperm=1", "?xdebugPerm=1"])
			expect(urlFlag("debugPerm", search)).toBe(false);
	});

	it("the preset and permission selectors: only with ?debugPerm=1", () => {
		expect(showPermissionControls("")).toBe(false);
		expect(showPermissionControls("?recovery=1")).toBe(false);
		expect(showPermissionControls("?debugTools=1")).toBe(false);
		expect(showPermissionControls("?debugPerm=1")).toBe(true);
	});

	it("the Tools button: only with ?recovery=1 or ?debugTools=1", () => {
		expect(showToolInspector("")).toBe(false);
		expect(showToolInspector("?debugPerm=1")).toBe(false);
		expect(showToolInspector("?recovery=0&debugTools=0")).toBe(false);
		expect(showToolInspector("?recovery=1")).toBe(true);
		expect(showToolInspector("?debugTools=1")).toBe(true);
		expect(showToolInspector("?chat=a.jsonl&recovery=1")).toBe(true);
	});

	it("outside a browser (no window) everything stays off", () => {
		expect(typeof window).toBe("undefined");
		expect(showPermissionControls()).toBe(false);
		expect(showToolInspector()).toBe(false);
	});
});
