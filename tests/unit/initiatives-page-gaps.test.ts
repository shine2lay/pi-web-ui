/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-page-gaps (docs/initiatives-page-gaps.md, Ops #228): step 4's gaps, all activity and hand-offs on a
// fixed registry page, alone, through the core model and drawn by the supplied design; and the role-message
// store's open hand-offs on a fixed file. No chats, server or model calls; the names are made up.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleMessages, type RoleMessageHost } from "../../server/role-messages.js";
import type { InitiativesExactInitiative, InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { BOX_HANDOFFS, NO_HANDOFFS, NOT_RECORDED, gapsPart } from "../../web/src/initiatives-page/gaps";
import { buildInitiativesPage } from "../../web/src/initiatives-page/model";
import { NO_INITIATIVE } from "../../web/src/initiatives-page/types";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import type { UiProgress, UiWorkPage } from "../../web/src/types";
import { AT, GAPS_PAGE, GAPS_PROGRESS, NOW, pageArgs } from "./initiatives-page-gaps-fixture";

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const MIN = 60_000;

function part(page: UiWorkPage = GAPS_PAGE) {
	return gapsPart(page, undefined, vi.fn(), { progress: GAPS_PROGRESS, now: NOW }).initiatives ?? {};
}

const ALPHA_GAPS = [
	"Ops #12 \u201cWire the form\u201d is blocked: waits on #11, temper #38; a test account; Backend owes the API shape (due 10:40)",
	"Ops #15 \u201cCheck the copy\u201d is blocked: what it waits on is not recorded",
	"Frontend #3 \u201cPick the colours\u201d is stuck: waits on an answer from Design",
	"Design #4 \u201cChoose the font\u201d is stuck: waits on your answer (you paused it)",
	"Project \u201cSignup form\u201d (lead Design): 2 of 2 done-when items unmet, and no open task",
];
const ALPHA_ACTIVITY = [
	[
		"09:10",
		"Architecture",
		"Marked met on the initiative \u201cAlpha launch\u201d: \u201cForm ships\u201d \u00b7 proof: seen live",
	],
	["09:10", "Architecture", "Progress update: Signup next."],
	["08:40", "Frontend", "Linked Frontend #3 \u201cPick the colours\u201d to the initiative \u201cAlpha launch\u201d"],
	["08:40", "Ops", "#5 \u201cNo queue name\u201d: waiting"],
	["07:40", "Architecture", "Progress update: Form landed."],
	["06:10", "Architecture", "Changed the initiative \u201cAlpha launch\u201d: done-when items"],
	["05:40", "Ops", "Ops #12 \u201cWire the form\u201d: blocked"],
	[
		"05:30",
		"QA",
		"Took back the met mark on the project \u201cLogin form\u201d: \u201cErrors shown\u201d \u00b7 why: came back",
	],
	[
		"05:10",
		"Frontend",
		"Marked met on the project \u201cLogin form\u201d: \u201cFields drawn\u201d \u00b7 proof: seen live",
	],
	["05:00", "Ops", "Linked Ops #12 \u201cWire the form\u201d to the project \u201cLogin form\u201d"],
	["04:50", "Architecture", "Made the project \u201cLogin form\u201d"],
	["04:40", "You", "Made the initiative \u201cAlpha launch\u201d"],
];

describe("gaps the lead hasn't covered", () => {
	it("lists each kind in order: blocked or stuck tasks, projects with no open task, items with no project", () => {
		const p = part();
		expect(p.alpha?.gaps).toEqual(ALPHA_GAPS);
		expect(p.beta?.gaps).toEqual([
			"Done-when item with no active project: \u201cGuide published\u201d",
			"Done-when item with no active project: \u201cTwo teams use it\u201d",
		]);
		expect(p[NO_INITIATIVE]?.gaps).toEqual([
			"Docs #7 \u201cSweep the guides\u201d is stuck: waits on your answer",
			"Project \u201cOld lane\u201d (lead Ops): 1 of 2 done-when items unmet, and no open task",
		]);
	});

	it("claims none where the rules say none", () => {
		const p = part();
		// Dropped: no gaps, even with an unmet item.
		expect(p.gamma?.gaps).toEqual([]);
		const all = Object.values(p).flatMap((i) => i.gaps ?? []);
		// A project with an open task, all items met, a task of unknown state, done or dropped: not a gap.
		for (const name of ["Login form", "Full lane", "Quiet lane", "Search box", "Old idea", "Beta notes", "Docs sweep"])
			expect(all.some((g) => g.startsWith(`Project \u201c${name}\u201d`))).toBe(false);
		// Waiting, working, done, dropped or standalone tasks: not a gap.
		for (const n of ["#5 ", "#13 ", "#14 ", "#16 ", "#9 ", "#17 "]) expect(all.some((g) => g.includes(n))).toBe(false);
	});

	it("names an active initiative's unmet items when none of its projects is active, or it has none", () => {
		const page: UiWorkPage = {
			...GAPS_PAGE,
			initiatives: GAPS_PAGE.initiatives.map((i) => (i.id === "gamma" ? { ...i, status: "active" } : i)),
			projects: GAPS_PAGE.projects.map((r) => (r.initiative === "alpha" ? { ...r, status: "done" } : r)),
			tasks: [],
		};
		const p = part(page);
		expect(p.alpha?.gaps).toEqual([
			"Done-when item with no active project: \u201cSearch ships\u201d",
			"Done-when item with no active project: \u201cFirst user signs in\u201d",
		]);
		expect(p.gamma?.gaps).toEqual(["Done-when item with no active project: \u201cOld pages moved\u201d"]);
	});
});

describe("all activity", () => {
	it("lists the registry's changes and the lead's updates newest first, items and proof as recorded", () => {
		const p = part();
		expect(p.alpha?.activity?.map((a) => [a.at, a.role, a.text])).toEqual(ALPHA_ACTIVITY);
		expect(p.beta?.activity?.map((a) => [a.at, a.role, a.text])).toEqual([
			["05:20", "You", "Made the initiative \u201cBeta rollout\u201d"],
		]);
		expect(p.gamma?.activity).toEqual([]);
		expect(p[NO_INITIATIVE]?.activity?.map((a) => [a.at, a.role, a.text])).toEqual([
			[
				"06:05",
				"Ops",
				`Marked met on the project \u201cOld lane\u201d: \u201cLane drawn\u201d \u00b7 proof: ${NOT_RECORDED}`,
			],
			["06:00", "You", "Changed the project \u201cDocs sweep\u201d: lead, status active"],
		]);
	});

	it("takes the lead's updates only for the initiative the progress feed is for", () => {
		const none = gapsPart(GAPS_PAGE, undefined, vi.fn(), { now: NOW }).initiatives ?? {};
		expect(none.alpha?.activity?.length).toBe(10);
		expect(none.alpha?.activity?.some((a) => a.text?.startsWith("Progress update"))).toBe(false);
		const beta = gapsPart(GAPS_PAGE, undefined, vi.fn(), {
			progress: { ...GAPS_PROGRESS, initiative: "beta" },
			now: NOW,
		}).initiatives;
		expect(beta?.alpha?.activity?.length).toBe(10);
		expect(beta?.beta?.activity?.length).toBe(3);
	});

	it("lists the updates the feed sends in brief too, in time order among the rest (H-INITIATIVES-PAGE-4b)", () => {
		const progress: UiProgress = {
			...GAPS_PROGRESS,
			updatesTotal: 4,
			older: [
				{ id: "u0", at: AT - 200 * MIN, by: "architecture", byName: "Architecture", changed: "Plan agreed." },
				{ id: "u-1", at: AT - 295 * MIN, by: "architecture", byName: "", changed: "Started." },
			],
		};
		const p = gapsPart(GAPS_PAGE, undefined, vi.fn(), { progress, now: NOW }).initiatives ?? {};
		const rows = [...ALPHA_ACTIVITY];
		rows.splice(5, 0, ["06:20", "Architecture", "Progress update: Plan agreed."]);
		rows.splice(12, 0, ["04:45", "Architecture", "Progress update: Started."]);
		expect(p.alpha?.activity?.map((a) => [a.at, a.role, a.text])).toEqual(rows);
		expect(p.alpha?.activity?.filter((a) => a.text?.startsWith("Progress update"))).toHaveLength(4);
	});
});

describe("hand-offs between roles", () => {
	it("shows the open ones carrying the initiative's id: from \u2192 to, what, and where each stands", () => {
		const p = part();
		expect(p.alpha?.handoffs).toEqual([
			{
				from: "Ops",
				fromTask: "#12",
				to: "Backend",
				what: "Request: Please send the API shape",
				state: "Delivered 08:11 \u00b7 no reply yet",
				kind: "wait",
			},
			{
				from: "Design",
				to: "Frontend",
				what: "Question: Which colours are allowed?",
				state: "Not delivered yet \u00b7 sent 09:20",
				kind: "active",
			},
		]);
		expect(p.alpha?.handoffsNote).toBeUndefined();
		expect(p.beta?.handoffs).toEqual([
			{
				from: "QA",
				to: "Docs",
				toTask: "#7",
				what: "Request: Add the guide link",
				state: "Held: role messages are paused \u00b7 sent 09:30",
				kind: "paused",
			},
		]);
		expect(p.gamma?.handoffs).toEqual([]);
		expect(p.gamma?.handoffsNote).toBe(NO_HANDOFFS);
		expect(p[NO_INITIATIVE]?.handoffs).toEqual([]);
		expect(p[NO_INITIATIVE]?.handoffsNote).toBe(BOX_HANDOFFS);
	});

	it("says Not recorded when the server sends none", () => {
		const { handoffs: _gone, ...old } = GAPS_PAGE;
		const p = part(old);
		for (const id of ["alpha", "beta", "gamma"]) {
			expect(p[id]?.handoffs).toEqual([]);
			expect(p[id]?.handoffsNote).toBe(NOT_RECORDED);
		}
		expect(p[NO_INITIATIVE]?.handoffsNote).toBe(BOX_HANDOFFS);
	});
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	document.body.replaceChildren();
});

/** The real template with the view, on `input`. */
function mount(input: InitiativesExactInput) {
	const actions: InitiativesExactActions = {
		open: vi.fn(),
		retry: vi.fn(),
		messageLead: vi.fn(),
		changeLead: vi.fn(),
		select: vi.fn(),
	};
	let dirty = false;
	const view = createInitiativesExactView(
		() => input,
		() => actions,
		() => {
			dirty = true;
		},
	);
	const binding = bindInitiativesSurface(document, () => view.values());
	cleanups.push(() => {
		binding.dispose();
		view.dispose();
	});
	const sectionText = (selector: string) => norm(document.querySelector(selector)?.textContent);
	return {
		sectionText,
		buttons: () => Array.from(document.querySelectorAll("button")).map((b) => norm(b.textContent)),
		click(text: string) {
			const b = Array.from(document.querySelectorAll("button")).find((el) => norm(el.textContent) === text);
			if (!b) throw new Error(`no button ${text}`);
			b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			if (dirty) binding.update();
			dirty = false;
		},
	};
}

describe("through the core model and the supplied design", () => {
	it("fills the three sections for every initiative and the box, with no Not connected yet left", () => {
		const { input } = buildInitiativesPage(pageArgs());
		const all: InitiativesExactInitiative[] = [...(input.initiatives ?? []), input.loose!.detail!];
		expect(all.map((i) => i.id)).toEqual(["alpha", "beta", "gamma", NO_INITIATIVE]);
		for (const i of all) {
			expect(i.gaps).toBeDefined();
			expect(i.activity).toBeDefined();
			expect(i.handoffs).toBeDefined();
			for (const note of [i.gapsNote, i.activityNote, i.handoffsNote]) expect(note ?? "").not.toMatch(/Not connected/);
		}
		const box = input.loose!.detail!;
		// The box has no lead: Latest updates keeps the core's note instead of activity lines.
		expect(box.latest).toEqual([]);
		expect(box.latestNote).toBe("No lead, so no updates.");
	});

	it("draws the gap count, gaps, hand-offs and activity count, and the activity tab newest first", () => {
		const page = mount(buildInitiativesPage(pageArgs()).input);
		const gaps = page.sectionText('section[aria-labelledby="gaps"]');
		expect(gaps).toContain(`Gaps the lead hasn\u2019t covered \u00b7 ${ALPHA_GAPS.length}`);
		for (const g of ALPHA_GAPS) expect(gaps).toContain(g);
		const hand = page.sectionText('section[aria-labelledby="hand"]');
		expect(hand).toContain("Ops #12");
		expect(hand).toContain("Request: Please send the API shape");
		expect(hand).toContain("Delivered 08:11 \u00b7 no reply yet");
		expect(hand).toContain("Question: Which colours are allowed?");
		for (const text of [gaps, hand]) expect(text).not.toMatch(/Not connected/);
		expect(page.buttons()).toContain(`All activity \u00b7 ${ALPHA_ACTIVITY.length}`);
		page.click(`All activity \u00b7 ${ALPHA_ACTIVITY.length}`);
		expect(page.sectionText('section[aria-label="Activity"]')).not.toMatch(/Not connected/);
		// One row per line: its time, role and text spans, in the order drawn.
		const rows = Array.from(document.querySelectorAll('section[aria-label="Activity"] div')).map((row) =>
			Array.from(row.querySelectorAll(":scope > span")).map((s) => norm(s.textContent)),
		);
		expect(rows).toEqual(ALPHA_ACTIVITY);
	});

	it("draws the box's gaps, its Not recorded hand-offs and its activity", () => {
		const page = mount(buildInitiativesPage(pageArgs({ selected: NO_INITIATIVE })).input);
		expect(page.sectionText('section[aria-labelledby="gaps"]')).toContain("Gaps the lead hasn\u2019t covered \u00b7 2");
		expect(page.sectionText('section[aria-labelledby="hand"]')).toContain(BOX_HANDOFFS);
		expect(page.buttons()).toContain("All activity \u00b7 2");
	});
});

describe("the role-message store's open hand-offs", () => {
	const msg = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		at: AT,
		from: { role: "ops", title: "Ops", chat: "Queue #12", file: "/chats/a.jsonl" },
		to: { role: "backend", title: "Backend" },
		kind: "request",
		chain: 1,
		text: "Please send the API shape\nSecond line stays out.",
		state: "waiting",
		sends: 1,
		attempts: 0,
		initiative: "alpha",
		...over,
	});

	function storeOn(file: object) {
		const dir = mkdtempSync(join(tmpdir(), "initiatives-gaps-"));
		const path = join(dir, "role-messages.json");
		writeFileSync(path, JSON.stringify(file));
		const store = new RoleMessages(path, {} as unknown as RoleMessageHost, () => NOW);
		cleanups.push(() => {
			store.stop();
			rmSync(dir, { recursive: true, force: true });
		});
		return store;
	}

	it("keeps open questions and requests between two roles that carry an initiative, first lines only", () => {
		const long = "x".repeat(130);
		const store = storeOn({
			v: 1,
			paused: false,
			messages: [
				msg("rm-delivered", { state: "delivered", deliveredAt: AT + MIN, targetChat: "home chat" }),
				msg("rm-question", {
					kind: "question",
					from: { role: "design", title: "Design", chat: "home chat", file: "/b" },
				}),
				msg("rm-fyi", { kind: "fyi" }),
				msg("rm-replied", { state: "replied", replyId: "rm-x" }),
				msg("rm-answered", { state: "delivered", replyId: "rm-y" }),
				msg("rm-failed", { state: "failed" }),
				msg("rm-none", { initiative: undefined }),
				msg("rm-self", { to: { role: "ops", title: "Ops" } }),
				msg("rm-long", { text: `\n  ${long}\nmore` }),
			],
		});
		const open = store.openHandoffs();
		expect(open.map((h) => h.id)).toEqual(["rm-delivered", "rm-question", "rm-long"]);
		expect(open[0]).toEqual({
			id: "rm-delivered",
			initiative: "alpha",
			at: AT,
			from: "ops",
			fromChat: "Queue #12",
			to: "backend",
			toChat: "home chat",
			kind: "request",
			firstLine: "Please send the API shape",
			state: "delivered",
			deliveredAt: AT + MIN,
		});
		expect(open[1]?.state).toBe("waiting");
		expect(open[2]?.firstLine).toBe(`${"x".repeat(119)}\u2026`);
		expect(JSON.stringify(open)).not.toContain("Second line");
	});

	it("marks an undelivered one held while the owner has role messages paused", () => {
		const store = storeOn({ v: 1, paused: true, messages: [msg("rm-1"), msg("rm-2", { state: "delivered" })] });
		expect(store.openHandoffs().map((h) => h.state)).toEqual(["held", "delivered"]);
	});
});
