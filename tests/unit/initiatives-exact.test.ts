/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-exact (docs/initiatives-exact.md): the supplied Initiatives template, bound by the shared
// binder to the ported view, on fixed input only. The fixture (the design's own 4 sample initiatives,
// converted) lives in tests; no chats, model calls or production fonts are touched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { INITIATIVE_FONT_FILES, INITIATIVE_FONT_KEYS } from "../../web/src/initiatives-u0/font-pins";
import { initiativeFontRoot, initiativesDesignAssets, readInitiativeFonts } from "../../web/initiatives-design-assets";
import { DESIGN_FIXTURE, drawnState } from "./initiatives-exact-fixture";

// Vitest runs from the repo root (in jsdom, import.meta.url isn't a file URL).
const root = process.cwd();
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** A list card's button: its name first, after the card's ON YOU chip when it has one. The binder drops
 * whitespace-only text between tags, so the name runs straight into the chip's count and the status. */
const card = (name: string) => new RegExp(`^(ON YOU · \\d+)?${name}`);
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	delete process.env.PI_INITIATIVES_DESIGN_ASSETS;
	document.body.replaceChildren();
});

/** Mounts the real template with the view, on `input`, with the given host callbacks (`open` always). */
function mount(input: InitiativesExactInput, given: Partial<InitiativesExactActions> = {}) {
	const actions: InitiativesExactActions = { open: vi.fn(), ...given };
	let binding: ReturnType<typeof bindInitiativesSurface> | null = null;
	let dirty = false;
	const view = createInitiativesExactView(
		() => input,
		() => actions,
		() => {
			dirty = true;
		},
	);
	binding = bindInitiativesSurface(document, () => view.values());
	cleanups.push(() => {
		binding?.dispose();
		view.dispose();
	});
	const flush = () => {
		if (dirty) binding?.update();
		dirty = false;
	};
	const buttons = () => Array.from(document.querySelectorAll("button"));
	const button = (text: string | RegExp) =>
		buttons().find((b) => (typeof text === "string" ? norm(b.textContent) === text : text.test(norm(b.textContent))));
	return {
		actions,
		text: () => norm(document.body.textContent),
		button,
		click(text: string | RegExp) {
			const b = button(text);
			if (!b) throw new Error(`no button ${text}`);
			b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			flush();
		},
	};
}
const everyCallback = (): Required<InitiativesExactActions> => ({
	open: vi.fn(),
	retry: vi.fn(),
	newInitiative: vi.fn(),
	changeLead: vi.fn(),
	messageLead: vi.fn(),
	resume: vi.fn(),
	markRead: vi.fn(),
	askDesign: vi.fn(),
	answer: vi.fn(),
	select: vi.fn(),
});

describe("the supplied Initiatives design, bound to typed input", () => {
	// Ops #252 (docs/gate-near-limit.md): its own limit, 3x its slowest land-gate time (4626 ms) rounded up to whole
	// 5 s. One mount and its checks, and it is this file's first mount: most of its time is the view's and jsdom's
	// cold start (the drawn-state cases below mount once in a fraction of it). It can't be split, and only
	// production code could make it faster.
	it("renders the design's sample (converted, test-only) with its names, counts, pills, chips and tabs", () => {
		const page = mount(DESIGN_FIXTURE, everyCallback());
		const text = page.text();
		for (const name of ["Team in Temper", "Reliability", "Notebook import", "Budget & tokens"])
			expect(text).toContain(name);
		expect(text).toContain("4 initiatives · Sun Oct 11");
		expect(text).toContain("Live · updated 13:05");
		expect(text).toContain(
			"3 things are waiting on you across initiatives. Team in Temper has 12 decisions with a credit flag; Budget & tokens is paused by you.",
		);
		// initiatives-live: the design's "Needs attention" reads "Blocked" (docs/live-progress.md).
		for (const pill of ["All 4", "Needs you 1", "Blocked 1", "Paused by you 1"]) expect(page.button(pill)).toBeTruthy();
		expect(text).not.toContain("Needs attention");
		for (const chip of ["Blocked", "Moving", "Paused by you", "ON YOU · 2"]) expect(text).toContain(chip);
		for (const tab of ["Overview", "Current design 3 new", "Decisions 220", "Activity 3"])
			expect(page.button(tab)).toBeTruthy();
		expect(text).toContain("Roles in no initiative · 1");
		expect(text).toContain("Marketing");
		// Team in Temper is first and selected, as drawn: its goal and its lead's controls.
		expect(text).toContain("Build the team into Temper as real code");
		expect(page.button("Message Temper")).toBeTruthy();
		expect(page.button("Change lead")).toBeTruthy();
		expect(page.button("New initiative")).toBeTruthy();
	}, 15_000);

	it("selects, switches tabs and filters the way the design does", () => {
		const page = mount(DESIGN_FIXTURE, everyCallback());
		page.click(card("Reliability"));
		expect(page.text()).toContain("Answers you send and receive always reach your chat");
		page.click("Decisions 3");
		expect(page.text()).toContain("Nothing goes live without an independent check");
		page.click("Paused by you 1");
		expect(page.button(card("Budget & tokens"))).toBeTruthy();
		expect(page.button(card("Notebook import"))).toBeFalsy();
	});

	it("shows child task rows under a role, indented 16 px", () => {
		const [team, ...rest] = DESIGN_FIXTURE.initiatives ?? [];
		const input: InitiativesExactInput = {
			...DESIGN_FIXTURE,
			initiatives: [
				{
					...team,
					roles: [
						{
							name: "Ops",
							lead: true,
							task: "#1",
							taskTitle: "Parent",
							tasks: [{ name: "Ops", task: "#2", taskTitle: "Child" }],
						},
					],
				},
				...rest,
			],
		};
		mount(input);
		const padded = (p: string) =>
			Array.from(document.querySelectorAll<HTMLElement>("div")).filter((d) => d.style.padding === p);
		const child = padded("14px 14px 14px 30px");
		expect(child).toHaveLength(1);
		expect(norm(child[0].textContent)).toContain("#2 Child");
		expect(norm(child[0].textContent)).not.toContain("Parent");
		const parent = padded("14px").filter((d) => norm(d.textContent).includes("Parent"));
		expect(norm(parent.at(-1)?.textContent)).not.toContain("Child");
	});

	it("renders an empty input as the design's empty state", () => {
		for (const input of [{}, drawnState("empty")]) {
			const page = mount(input);
			expect(page.text()).toContain("No initiatives yet");
			expect(page.text()).toContain("This isn’t a loading or connection problem.");
			document.body.replaceChildren();
		}
	});

	it.each([
		["loading", "Loading initiatives"],
		["server-error", "Couldn’t load initiatives"],
		["out-of-date", "Not live. This page last updated at 13:05 and can’t reach the server now."],
		["button-failed", "Couldn’t send your request to Data at 13:05. Nothing was sent, so Data hasn’t been asked."],
		["no-access", "You don’t have access to Initiatives"],
		["old-data", "Old data, not confirmed. Team in Temper’s records were last read Sat 23:03"],
		["missing-evidence", "Data says the dry run passed at 11:58, but no receipt backs it."],
	])("renders the drawn state %s from input", (state, words) => {
		const page = mount(drawnState(state), everyCallback());
		expect(page.text()).toContain(words);
		if (state === "server-error") expect(page.text()).toContain("The server sent an error at 13:05.");
		if (state === "loading") expect(page.text()).not.toContain("Team in Temper");
	});

	it("hides each control whose callback is absent", () => {
		const bare = mount(DESIGN_FIXTURE);
		for (const control of ["New initiative", "Message Temper", "Change lead"]) expect(bare.button(control)).toBeFalsy();
		bare.click(/^Current design/);
		expect(bare.text()).toContain("L2 is now built by Architecture");
		expect(bare.button("Mark as read")).toBeFalsy();
		bare.click(card("Notebook import"));
		expect(bare.text()).toContain("No current design written yet. The lead (Data) keeps this section");
		expect(bare.button("Ask Data to write it")).toBeFalsy();
		bare.click(card("Budget & tokens"));
		expect(bare.text()).toContain("You paused Product’s and Backend’s own work");
		expect(bare.button("Resume own work")).toBeFalsy();
		bare.click(card("Reliability"));
		bare.click("Overview");
		expect(bare.button("Approve")).toBeFalsy();
		document.body.replaceChildren();

		const actions = everyCallback();
		const full = mount(DESIGN_FIXTURE, actions);
		full.click(/^Current design/);
		full.click("Mark as read");
		expect(actions.markRead).toHaveBeenCalledWith("team");
		full.click(card("Notebook import"));
		full.click("Ask Data to write it");
		expect(actions.askDesign).toHaveBeenCalledWith("notebook");
		full.click(card("Budget & tokens"));
		full.click("Resume own work");
		expect(actions.resume).toHaveBeenCalledWith("budget");
		full.click(card("Reliability"));
		full.click("Overview");
		full.click("Approve");
		expect(actions.answer).toHaveBeenCalledWith({ initiative: "reliability", ask: "i2" }, "Approve");
		full.click("Change lead");
		expect(actions.changeLead).toHaveBeenCalledWith("reliability");
	});

	it("keeps the design's sample data out of every shipped file", () => {
		const shipped = [
			"web/src/initiatives-exact-model.ts",
			"web/src/initiatives-exact-view.ts",
			"web/src/initiatives-exact-fonts.ts",
			"web/src/initiatives-u0/surface.html",
			"web/src/initiatives-u0/surface.ts",
			"web/src/initiatives-u0/font-pins.ts",
			"web/src/exact-surface.ts",
			"web/src/components/InitiativesExactView.tsx",
			"web/initiatives-design-assets.ts",
		];
		const sample = [
			"Team in Temper",
			"Reliability",
			"Notebook import",
			"Budget & tokens",
			"Marketing",
			"Frontend",
			"credit flag",
			"13:05",
			"Sat 23:03",
			"Oct 11",
			"R-14",
			"#98",
			"#112",
		];
		for (const file of shipped) {
			const source = readFileSync(join(root, file), "utf8");
			for (const s of sample) expect(source.includes(s), `${file} holds "${s}"`).toBe(false);
		}
	});
});

describe("the design's 11 pinned fonts", () => {
	it("fails the build when a font is missing or changed", () => {
		const real = initiativeFontRoot();
		const start = () => (initiativesDesignAssets().buildStart as () => void).call({});
		expect(Object.keys(readInitiativeFonts(real))).toEqual([...INITIATIVE_FONT_KEYS]);
		const dir = mkdtempSync(join(tmpdir(), "initiatives-font-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		process.env.PI_INITIATIVES_DESIGN_ASSETS = dir;
		expect(start).toThrow("Exact Initiatives font geist-cyrillic-ext");
		for (const key of INITIATIVE_FONT_KEYS) {
			const file = `${INITIATIVE_FONT_FILES[key].sha256}.woff2`;
			copyFileSync(join(real, file), join(dir, file));
		}
		expect(start).not.toThrow();
		const pin = INITIATIVE_FONT_FILES["mono-latin"];
		const changed = Buffer.from(readFileSync(join(dir, `${pin.sha256}.woff2`)));
		changed[changed.length - 1] ^= 1;
		writeFileSync(join(dir, `${pin.sha256}.woff2`), changed);
		expect(start).toThrow("Exact Initiatives font mono-latin");
	});
});
