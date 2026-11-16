// @vitest-environment jsdom
/**
 * roles-by-project P-cases (spec-acceptance.md §P; spec-page.md): the page on the real `useRoles` store, fed roles
 * payloads. Failing first (frontend #293 seam); Frontend #294 makes them pass by turning `notBuilt(` into `it(`,
 * never by deleting or weakening a case. Layout-measured counts (3 cards at 1440 px, 1 at 390 px) are checked in
 * the sealed browser test (tests/roles-by-project-test.mjs, P3-layout); here the relation and the stored state.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { ROLES_BY_PROJECT_TOKENS_CSS, RolesByProjectView } from "../../web/src/roles-by-project/RolesByProjectView.js";
import { TASKS_ROLES_V8_TOKENS_CSS } from "../../web/src/tasks-roles-v8/styles-tokens.js";
import { disconnectRoleAnswers, receiveRoleAnswer } from "../../web/src/roles-answer-state.js";
import { receiveRoles, resetRolesState } from "../../web/src/roles-state.js";
import type { ClientMessage, UiRoleAskView } from "../../web/src/types.js";
import { notBuilt } from "./roles-by-project-not-built.js";
import { AT, boardOf, boardTask, LABELS, liveTasks, overviewOf } from "./roles-by-project-page-data.js";
import type { UiTaskBoard } from "../../server/roles-board-protocol.js";

let root: Root | null = null;
let host: HTMLDivElement;
let sent: ClientMessage[];
let renderError: unknown;
let checked = AT;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetAppGlobals();
	resetRolesState();
	localStorage.clear();
	sent = [];
	renderError = undefined;
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	setAppGlobals({ status: "open", ready: true } as Parameters<typeof setAppGlobals>[0]);
});
afterEach(() => {
	act(() => {
		root?.unmount();
		disconnectRoleAnswers();
	});
	root = null;
	host?.remove();
	setAppSend(null);
	resetRolesState();
	resetAppGlobals();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function mount() {
	if (root) act(() => root?.unmount());
	host?.remove();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host, { onUncaughtError: (error) => (renderError ??= error) });
	await act(async () => {
		root?.render(
			createElement(
				LanguageProvider,
				null,
				createElement(RolesByProjectView, { active: true, onOpen: () => undefined, onAbout: () => undefined }),
			),
		);
	});
	if (renderError) throw renderError;
}
async function push(board: UiTaskBoard | undefined) {
	checked += 1000;
	await act(async () =>
		receiveRoles({
			type: "roles",
			asks: board ? overviewOf(board).asks.length : 0,
			checkedAt: checked,
			overview: overviewOf(board, checked),
		}),
	);
	if (renderError) throw renderError;
}
async function fail() {
	await act(async () => receiveRoles({ type: "roles", asks: 0, error: "queue read failed" }));
	if (renderError) throw renderError;
}
const text = () => host.textContent ?? "";
const buttons = () => [...host.querySelectorAll("button")];
const buttonNamed = (name: string | RegExp) =>
	buttons().find((b) =>
		typeof name === "string"
			? b.textContent?.trim() === name || b.getAttribute("aria-label") === name
			: name.test(b.textContent ?? ""),
	);
const radios = () => [
	...host.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"], [role="radiogroup"] input[type="radio"]'),
];
const checkedRadio = () =>
	radios().find((r) => r.getAttribute("aria-checked") === "true" || (r as HTMLInputElement).checked);
const nameOf = (el: Element) =>
	(el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? el.textContent ?? "").trim();
const searchBox = () => host.querySelector<HTMLInputElement>('input[type="search"], [role="searchbox"]');
/** Tiles are buttons with aria-expanded (spec-page.md §Accessibility); a tile's text names its group. */
const tiles = () =>
	[...host.querySelectorAll<HTMLElement>("button[aria-expanded]")].filter((b) => !b.closest("dialog"));
const tileLabels = () => Object.values(LABELS).filter((l) => tiles().some((t) => t.textContent?.includes(l)));
const hiddenIn = (el: Element | null): boolean =>
	!!el &&
	(el.hasAttribute("hidden") ||
		(el instanceof HTMLElement && el.style.display === "none") ||
		hiddenIn(el.parentElement));
const answers = () => buttons().filter((b) => b.textContent?.trim() === "Answer" && !hiddenIn(b));

async function type(value: string) {
	const box = searchBox();
	if (!box) throw new Error("no search box");
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		set?.call(box, value);
		box.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(el: Element | undefined | null) {
	if (!el) throw new Error("nothing to click");
	await act(async () => (el as HTMLElement).click());
}
async function live() {
	await mount();
	await push(boardOf(liveTasks()));
}

describe("roles-by-project P1: exactly two controls", () => {
	notBuilt("P1 a Group by radiogroup (Project, Now, Department, Status) and a search box, nothing else", async () => {
		await live();
		expect(host.querySelectorAll('[role="radiogroup"]').length).toBe(1);
		expect(radios().map(nameOf)).toEqual(["Project", "Now", "Department", "Status"]);
		expect(searchBox()?.getAttribute("aria-label") ?? searchBox()?.labels?.[0]?.textContent).toBe(
			"Find a task, project or role",
		);
		const fields = [...host.querySelectorAll("input, select, textarea")].filter(
			(f) => !f.closest("dialog") && !f.closest('[role="radiogroup"]'),
		);
		expect(fields).toEqual([searchBox()]);
		expect(host.querySelectorAll('[role="radiogroup"], [role="tablist"], select').length).toBe(1);
	});

	notBuilt("P1 default Project; Now is remembered across reload; arrow keys move and select", async () => {
		await live();
		expect(nameOf(checkedRadio()!)).toBe("Project");
		await act(async () =>
			checkedRadio()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
		);
		expect(nameOf(checkedRadio()!)).toBe("Now");
		expect(document.activeElement).toBe(checkedRadio());
		expect(localStorage.getItem("roles.groupBy")).toBe("now");
		await live();
		expect(nameOf(checkedRadio()!)).toBe("Now");
	});

	notBuilt("P1 a stored bogus value or a storage error -> Project", async () => {
		localStorage.setItem("roles.groupBy", "bogus");
		await live();
		expect(nameOf(checkedRadio()!)).toBe("Project");
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		await live();
		expect(nameOf(checkedRadio()!)).toBe("Project");
	});
});

describe("roles-by-project P2: search", () => {
	const cases: [string, string[]][] = [
		["#546", [LABELS.roles]],
		["546", [LABELS.roles]],
		["Quality assurance", [LABELS.smoke]],
		["invites", [LABELS.ink]],
		["inkflow onb", [LABELS.ink]],
		["Team in Temper", [LABELS.roles]],
		["Ops #900", [LABELS.none]],
	];
	for (const [query, groups] of cases) {
		notBuilt(`P2 search ${JSON.stringify(query)} -> ${groups.join(", ")}`, async () => {
			await live();
			expect(tileLabels()).toEqual([LABELS.roles, LABELS.ink, LABELS.smoke, LABELS.none]);
			await type(query);
			expect(tileLabels()).toEqual(groups);
		});
	}

	notBuilt("P2 no match -> Clear search, which brings every group back; search is not stored", async () => {
		await live();
		await type("zzz-nothing");
		expect(tileLabels()).toEqual([]);
		await click(buttonNamed("Clear search"));
		expect(searchBox()?.value).toBe("");
		expect(tileLabels()).toEqual([LABELS.roles, LABELS.ink, LABELS.smoke, LABELS.none]);
		await type("ink");
		await live();
		expect(searchBox()?.value).toBe("");
		expect(JSON.stringify({ ...localStorage })).not.toContain("ink");
	});
});

describe("roles-by-project P3: Needs you", () => {
	notBuilt("P3 Needs you · 5: shown cards + Show N more = 5; closing it survives reload", async () => {
		await live();
		const needs = [...host.querySelectorAll("details")].find((d) =>
			d.querySelector("summary")?.textContent?.includes("Needs you · 5"),
		);
		expect(needs?.open).toBe(true);
		const shown = answers().length;
		expect(shown).toBeGreaterThan(0);
		const more = buttonNamed(/^Show \d+ more$/);
		expect(shown + Number(/\d+/.exec(more?.textContent ?? "Show 0 more")?.[0])).toBe(5);
		await act(async () => {
			needs!.open = false;
			needs!.dispatchEvent(new Event("toggle"));
		});
		expect(localStorage.getItem("roles.needsOpen")).toBe("0");
		await live();
		const again = [...host.querySelectorAll("details")].find((d) =>
			d.querySelector("summary")?.textContent?.includes("Needs you · 5"),
		);
		expect(again?.open).toBe(false);
	});
});

describe("roles-by-project P4: answering through the existing flow", () => {
	const view: UiRoleAskView = {
		id: "ask-frontend-294",
		revision: "b".repeat(64),
		kind: "stuck",
		title: "Pick the tile density?",
		fields: [
			{
				id: "q1",
				text: "Pick the tile density?",
				options: [
					{ value: "Yes", label: "Yes" },
					{ value: "No", label: "No" },
				],
				multi: false,
				allowText: false,
			},
		],
	};
	async function openFirst() {
		await live();
		const card = answers()[0];
		await click(card);
		const open = sent.filter((m) => m.type === "roles_ask_open");
		expect(open.length).toBe(1);
		const req = open[0];
		if (req.type !== "roles_ask_open") throw new Error("no open request");
		expect(req.key).toBe("frontend:task:294");
		await act(async () => receiveRoleAnswer({ type: "roles_ask", reqId: req.reqId, ok: true, ask: view }));
		const dialog = host.querySelector("dialog") ?? document.querySelector("dialog");
		expect(dialog).not.toBeNull();
		const send = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Send answer");
		return { dialog: dialog!, send: send! };
	}
	const answerSent = () => sent.filter((m) => m.type === "roles_ask_answer");

	notBuilt(
		"P4 Send disabled before a choice; Send emits roles_ask_answer with key, id, revision; no local flip",
		async () => {
			const { dialog, send } = await openFirst();
			expect(send.disabled).toBe(true);
			expect(answerSent()).toEqual([]);
			await click(dialog.querySelector('input[type="radio"]'));
			expect(send.disabled).toBe(false);
			await click(send);
			const a = answerSent();
			expect(a.length).toBe(1);
			if (a[0].type !== "roles_ask_answer") throw new Error("no answer");
			expect([a[0].key, a[0].askId, a[0].revision, a[0].answers]).toEqual([
				"frontend:task:294",
				view.id,
				view.revision,
				[{ id: "q1", selected: ["Yes"] }],
			]);
			await act(async () => receiveRoleAnswer({ type: "roles_ask_result", reqId: a[0].reqId, ok: true }));
			expect(text()).toContain("Needs you · 5");
		},
	);

	notBuilt("P4 a refused answer shows the dialog's error and sends nothing more", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { dialog, send } = await openFirst();
		await click(dialog.querySelector('input[type="radio"]'));
		await click(send);
		const a = answerSent()[0];
		if (a?.type !== "roles_ask_answer") throw new Error("no answer");
		await act(async () => receiveRoleAnswer({ type: "roles_ask_result", reqId: a.reqId, ok: false, error: "changed" }));
		expect(dialog.querySelector(".roles-answer-error, [role='alert']")).not.toBeNull();
		await act(async () => vi.advanceTimersByTime(60_000));
		expect(answerSent().length).toBe(1);
		vi.useRealTimers();
	});
});

describe("roles-by-project P5-P6: error, loading, empty", () => {
	notBuilt(
		"P5 a failed look after a good one: banner + Try again above the unchanged last view; one reload per press",
		async () => {
			await live();
			const before = tileLabels();
			await fail();
			expect(text()).toContain("Couldn't read the queues just now");
			expect(tileLabels()).toEqual(before);
			const watches = () => sent.filter((m) => m.type === "roles_watch" && m.full).length;
			const n = watches();
			await click(buttonNamed("Try again"));
			expect(watches()).toBe(n + 1);
			await push(boardOf(liveTasks()));
			expect(text()).not.toContain("Couldn't read the queues just now");
		},
	);

	notBuilt("P5 a payload without taskBoard after a good one shows the banner over the last good view", async () => {
		await live();
		const before = tileLabels();
		await push(undefined);
		expect(text()).toContain("Couldn't read the queues just now");
		expect(buttonNamed("Try again")).toBeDefined();
		expect(tileLabels()).toEqual(before);
	});

	notBuilt("P5 a failed first look: banner alone", async () => {
		await mount();
		await fail();
		expect(text()).toContain("Couldn't read the queues just now");
		expect(tiles()).toEqual([]);
	});

	notBuilt("P6 loading before the first board (a payload without taskBoard keeps loading)", async () => {
		await mount();
		expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading projects and queues");
		await push(undefined);
		expect(text()).toContain("Loading projects and queues");
		expect(text()).not.toContain("Couldn't read the queues just now");
	});

	notBuilt("P6 empty board -> All clear, no fleet bar; quiet projects still listed", async () => {
		await mount();
		await push(boardOf([boardTask("ops #899", "none", "done", "Rotate the logs")]));
		expect(text()).toContain("All clear");
		expect(host.querySelector('[aria-label="All open work"]')).toBeNull();
		expect(text()).not.toMatch(/\d+ open across/);
		expect(text()).toContain("Quiet project");
	});
});

describe("roles-by-project page tokens (spec-build.md §Modules)", () => {
	it("the page's colours and fonts are the v8 carbon tokens, no new ones", () => {
		expect(ROLES_BY_PROJECT_TOKENS_CSS).toBe(TASKS_ROLES_V8_TOKENS_CSS);
	});
});

describe("roles-by-project P7-P8: Now view, no prototype chrome", () => {
	notBuilt("P7 Now: Up next numbered in queue order, 20 then +N more", async () => {
		localStorage.setItem("roles.groupBy", "now");
		const steps = Array.from({ length: 25 }, (_, i) =>
			boardTask(`ops #${700 - i}`, "none", "queued", `Queued step ${String(i + 1).padStart(2, "0")}`, {
				queueIndex: i,
			}),
		);
		await mount();
		await push(boardOf([boardTask("ops #800", "none", "working", "Running now"), ...steps]));
		expect(text()).toContain("Up next, in order");
		const shown = steps.filter((s) => text().includes(s.title)).map((s) => s.title);
		expect(shown).toEqual(steps.slice(0, 20).map((s) => s.title));
		const positions = shown.map((t) => text().indexOf(t));
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(text()).toContain("+5 more");
	});

	notBuilt("P8 no .proto, [data-proto-chrome] or prototype label in any state", async () => {
		const chrome = () =>
			host.querySelectorAll('.proto, [data-proto-chrome], [aria-label="Prototype controls"]').length +
			(/Theme: system|Busy afternoon, before tags/.test(text()) ? 1 : 0);
		await mount();
		expect(chrome()).toBe(0);
		await push(boardOf(liveTasks()));
		expect(tiles().length).toBeGreaterThan(0);
		expect(chrome()).toBe(0);
		await type("zzz-nothing");
		expect(buttonNamed("Clear search")).toBeDefined();
		expect(chrome()).toBe(0);
		await click(buttonNamed("Clear search"));
		await fail();
		expect(chrome()).toBe(0);
		await push(boardOf([]));
		expect(text()).toContain("All clear");
		expect(chrome()).toBe(0);
	});
});
