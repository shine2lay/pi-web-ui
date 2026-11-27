// @vitest-environment jsdom
/** Shared Architecture literals -> ACTUAL Tile / page / roles store; no reference-oracle self-test. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boardStateOf } from "../../server/shared/roles-by-project/groups";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals";
import { LanguageProvider } from "../../web/src/i18n";
import { RolesByProjectView } from "../../web/src/roles-by-project/RolesByProjectView";
import { contextOf, projectTiles } from "../../web/src/roles-by-project/model";
import { Tile } from "../../web/src/roles-by-project/tile";
import { receiveRoles, resetRolesState } from "../../web/src/roles-state";
import { receiveRoleAnswer, disconnectRoleAnswers } from "../../web/src/roles-answer-state";
import { bad, expanded, frame, good, GROUP, type Scenario } from "./roles-project-progress-data";
import type { UiRolesOverview, ClientMessage } from "../../web/src/types";

let host: HTMLDivElement;
let root: Root;
let checked: number;
let sent: ClientMessage[];
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetAppGlobals();
	resetRolesState();
	localStorage.clear();
	setAppGlobals({ status: "open", ready: true });
	sent = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	checked = Date.now();
});
afterEach(() => {
	act(() => {
		root.unmount();
		disconnectRoleAnswers();
	});
	host.remove();
	setAppSend(null);
	resetRolesState();
	resetAppGlobals();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const text = () => {
	const copy = host.cloneNode(true) as HTMLElement;
	copy.querySelectorAll("style").forEach((s) => s.remove());
	return copy.textContent ?? "";
};
const contents = (selector: string) => [...host.querySelectorAll(selector)].map((el) => el.textContent ?? "");
async function page() {
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(RolesByProjectView, { active: true, onOpen: () => {}, onAbout: () => {} }),
			),
		),
	);
}
async function openQuiet() {
	const mini = host.querySelector<HTMLButtonElement>(".rbp-mini");
	if (mini) await act(async () => mini.click());
}
async function push(overview: UiRolesOverview, stamp = ++checked) {
	await act(async () => receiveRoles({ type: "roles", asks: overview.asks.length, checkedAt: stamp, overview }));
}
async function tile(input: Scenario, variant?: unknown, open = true) {
	const overview = frame(input, variant);
	const ctx = contextOf(overview, overview.taskBoard!);
	const groups = projectTiles(ctx, "", new Set(ctx.board.groups.map((g) => g.key)));
	let model = groups.tiles.find((t) => t.group.kind === "project")!;
	if (input.tile) model = { ...model, shown: [] };
	await act(async () =>
		root.render(
			createElement(Tile, {
				ctx,
				tile: model,
				open,
				onToggle: () => {},
				...{ filtered: !!input.search },
			}),
		),
	);
}
/** Read user-visible output, never fill an observation from expected literals. */
function observe(): Scenario {
	const body = text();
	const milestones = host.querySelector('[aria-label="Milestones"]');
	const rows = [...(milestones?.querySelectorAll("li") ?? [])];
	const warning = !!host.querySelector(".rpp-warning, .rbp-banner");
	const known = /Last-known/.test(body);
	const unknown = /unknown|unavailable|inconsistent|not supplied|not sent.*registry/i.test(body);
	const partial = /incomplete/i.test(body);
	const loading = /Loading projects and queues/.test(body);
	const now = contents(".rpp-now [data-ref]").map((_, n) =>
		host.querySelectorAll(".rpp-now [data-ref]")[n].getAttribute("data-ref"),
	);
	return {
		fraction: /\d+ of \d+ met/.exec(milestones?.textContent ?? "")?.[0] ?? null,
		names: rows.length ? rows.map((r) => r.querySelector(".rpp-criterion")?.textContent) : null,
		marks: rows.length ? rows.map((r) => r.classList.contains("is-met")) : null,
		activity: host.querySelector(".rpp-activity p")?.textContent,
		lifecycle: /Lifecycle: (active|done|dropped)/.exec(body)?.[1] ?? "unknown",
		snapshot: loading ? "loading" : known ? "last-known" : partial ? "partial" : unknown ? "unknown" : "live",
		warning,
		freshPair: !known,
		canDeclareEmpty: !loading && !known && !unknown && !partial && !/No matching|Queues.*incomplete/i.test(body),
		next:
			/Next: not recorded|no project-wide order recorded/.test(body) && !/No matching|Queues.*incomplete/i.test(body)
				? "not-recorded"
				: "unknown",
		nowRefs: now,
		queuedRefs: [...host.querySelectorAll(".rpp-queued [data-ref]")].map((r) => r.getAttribute("data-ref")),
		unblockText: contents(".rpp-unblock").join(""),
		blockerOwner: host.querySelector(".rpp-blocker-owner")?.textContent ?? null,
		milestoneTaskLinks: milestones?.querySelector("[data-ref], a") ? ["unexpected binding"] : null,
		orderScope: /no project-wide order recorded/.test(body) ? "role-local" : undefined,
		inferredLinks: [...host.querySelectorAll(".rpp-unblock a")].map((a) => a.getAttribute("href")),
	};
}
function selected(expected: Scenario, observed: Scenario) {
	for (const [key, value] of Object.entries(expected)) {
		if (key === "notice") expect(text()).toContain(value);
		else expect(observed[key], key).toEqual(value);
	}
}
const special = new Set([10, 11, 12, 13, 14, 24, 25, 26, 27, 30, 31]);
const numberOf = (id: string) => Number(id.split("-")[1]);

for (const c of expanded.filter((c) => !special.has(numberOf(c.id)))) {
	it(`${c.key}: source-backed actual Tile observation`, async () => {
		await tile(c.input, c.variant);
		selected(c.expected, observe());
	});
}
for (const c of bad.cases.filter((c) => !special.has(numberOf(c.twin)))) {
	const twin = expanded.filter((g) => g.id === c.twin);
	for (const g of twin)
		it(`${c.id} rejects actual consumer counterexample (${g.key})`, async () => {
			await tile(g.input, g.variant);
			const observed = observe();
			expect(
				Object.entries(c.reject).some(([key, value]) => JSON.stringify(observed[key]) !== JSON.stringify(value)),
			).toBe(true);
			// Also enforce the good twin: an unrelated broken consumer must not make every rejection pass.
			selected(g.expected, observed);
		});
}

it("RPP-10 / RPP-110 actual full watch starts loading, never zero", async () => {
	await page();
	selected(good.cases[9].expected, observe());
});
it("RPP-11 / RPP-111 missing board never presents newer work as fresh", async () => {
	await page();
	const first = frame({ project: { items: 1, met: 0, doneWhen: [{ item: "Old criterion", met: false }] } });
	await push(first);
	await push(first);
	await openQuiet();
	const next = frame({ project: { items: 1, met: 1, doneWhen: [{ item: "New criterion", met: true }] } });
	delete next.taskBoard;
	await push(next);
	expect(host.querySelector(".rbp-banner")).not.toBeNull();
	expect(text()).toContain("Try again");
	expect(text()).not.toContain("New criterion");
	expect(observe().freshPair).toBe(false);
});
it("RPP-12 / RPP-112 cache replay isn't a second look", async () => {
	await page();
	const overview = frame({});
	await push(overview, checked);
	await push(overview, checked);
	await openQuiet();
	expect(observe().snapshot).toBe("last-known");
	expect(observe().freshPair).toBe(false);
});
it("RPP-13 / RPP-113 ready overview retains visible error and retry", async () => {
	await page();
	const overview = frame({});
	await push(overview);
	await push(overview);
	await openQuiet();
	await act(async () => receiveRoles({ type: "roles", asks: 0, error: "read failed" }));
	expect(host.querySelector(".rbp-banner")).not.toBeNull();
	expect(text()).toContain("Try again");
	expect(observe().snapshot).toBe("last-known");
});
it("RPP-14 / RPP-114 count heartbeat cannot repair unread registry", async () => {
	await page();
	await push(frame({ previousWorkProblem: "unreadable" }));
	await openQuiet();
	await act(async () => receiveRoles({ type: "roles", asks: 0, checkedAt: ++checked }));
	expect(observe().fraction).toBeNull();
	expect(observe().warning).toBe(true);
	expect(text()).toContain("Milestones couldn't be read just now (not zero: unknown).");
});
it("RPP-24 / RPP-124 stable live refs preserve disclosure, focus, search and caret", async () => {
	await page();
	const overview = frame({ tasks: [{ ref: "qa #1", state: "working", title: "Searchable work" }] });
	await push(overview);
	await push(overview);
	const button = host.querySelector<HTMLButtonElement>(`[data-group="${GROUP}"] .rbp-th`)!;
	await act(async () => button.click());
	button.focus();
	const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Searchable");
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
	search.setSelectionRange(2, 5);
	host.scrollTop = 19;
	await push(structuredClone(overview));
	expect(document.activeElement).toBe(button);
	expect(button.getAttribute("aria-expanded")).toBe("true");
	expect(search.value).toBe("Searchable");
	expect(search.selectionStart).toBe(2);
	expect(host.scrollTop).toBe(19);
	// Answer choice / real pointer press / actual scroll are retained in roles-by-project-test.mjs L1/L2.
});
it("RPP-25 / RPP-125 body only; header and non-project markup remain native", async () => {
	await tile({}, undefined, false);
	const header = host.querySelector(".rbp-th")!;
	expect(header.querySelector(".rbp-gname .rbp-h")?.textContent).toBe("Roles by project");
	expect(header.querySelector(".rbp-chip")).not.toBeNull();
	expect(header.querySelector(".rbp-chev")).not.toBeNull();
	expect(host.querySelector(".rpp")).not.toBeNull();
	expect(header.querySelector(".rpp, .rbp-fig, .rbp-draw, .rbp-counts")).toBeNull();
	expect(host.querySelector("#stateStrip, #prototypeBanner, [data-prototype]")).toBeNull();
});
it("RPP-26 / RPP-126 open shows full sentences and extra work outside header", async () => {
	const tasks = Array.from({ length: 8 }, (_, n) => ({
		ref: `qa #${n + 1}`,
		state: n < 5 ? "working" : "queued",
		title: `Full task ${n}`,
	}));
	const criterion = "Full criterion sentence remains available".repeat(8);
	const input = { tasks, project: { items: 1, met: 0, doneWhen: [{ item: criterion, met: false }] } };
	await tile(input, undefined, false);
	expect(host.querySelectorAll(".rpp-now [data-ref]")).toHaveLength(3);
	expect(host.querySelectorAll(".rpp-queued [data-ref]")).toHaveLength(2);
	expect(text()).toContain("2 more");
	expect(text()).toContain("1 more");
	await tile(input);
	expect(host.querySelectorAll(".rpp-now [data-ref]")).toHaveLength(5);
	expect(host.querySelectorAll(".rpp-queued [data-ref]")).toHaveLength(3);
	expect(contents(".rpp-criterion")).toContain(criterion);
	expect(host.querySelector("button button, button a, button ul")).toBeNull();
	expect(host.querySelector(".rpp-strip")?.getAttribute("aria-hidden")).toBe("true");
	expect(host.querySelector(".rbp-gbody .rbp-tasks, .rbp-gbody .rbp-dag")).not.toBeNull();
});
it("RPP-27 / RPP-127 healthy empty registry isn't finished project work", async () => {
	await page();
	const overview = frame({ work: { projects: [], initiatives: [] } });
	overview.taskBoard!.groups = overview.taskBoard!.groups.filter((g) => g.kind !== "project");
	await push(overview);
	await push(overview);
	expect(text()).toContain("No recorded projects");
	expect(observe().fraction).toBeNull();
	expect(host.querySelector(".rpp")).toBeNull();
});
it("RPP-31 / RPP-131 inert prose, native map refs and existing answer RPC survive", async () => {
	const c = good.cases[30];
	const raw = c.input.howToUnblock!;
	await page();
	const overview = frame({
		tasks: [
			{ ref: "qa #1", state: "blocked", howToUnblock: raw },
			{ ref: "frontend #2", state: "needs-you", title: "Pick a choice" },
		],
	});
	await push(overview);
	await push(overview);
	await act(async () => host.querySelector<HTMLButtonElement>(`[data-group="${GROUP}"] .rbp-th`)!.click());
	const preserved: string[] = [];
	if (host.querySelector(".rpp-unblock")?.textContent === raw && !host.querySelector(".rpp-unblock a"))
		preserved.push("escaped-text");
	if (
		host.querySelector('.rbp-gbody .rbp-task[data-ref="qa #1"]') &&
		!host.querySelector('a[href^="javascript:"],a[href^="file:"]')
	)
		preserved.push("canonical-task-links");
	await act(async () =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Answer")!.click(),
	);
	const req = sent.find((m) => m.type === "roles_ask_open");
	expect(req?.type).toBe("roles_ask_open");
	if (req?.type !== "roles_ask_open") throw Error("missing answer RPC");
	expect(req.key).toBe("frontend:task:2");
	await act(async () =>
		receiveRoleAnswer({
			type: "roles_ask",
			reqId: req.reqId,
			ok: true,
			ask: {
				id: "ask-frontend-2",
				revision: "b".repeat(64),
				kind: "stuck",
				title: "Pick a choice",
				fields: [
					{
						id: "q1",
						text: "Pick a choice",
						options: [
							{ value: "Yes", label: "Yes" },
							{ value: "No", label: "No" },
						],
						multi: false,
						allowText: false,
					},
				],
			},
		}),
	);
	if (document.querySelector('dialog input[type="radio"]')) preserved.push("existing-answer-flow");
	selected(c.expected, { ...observe(), preserve: preserved });
	expect(observe().inferredLinks).not.toEqual(
		bad.cases.find((b) => b.id === "RPP-131-linkify-prose")!.reject.inferredLinks,
	);
});

it("malformed null registry projects stay visibly unknown on the actual page", async () => {
	await page();
	const overview = frame({ work: { projects: null, initiatives: [] }, tasks: [{ ref: "qa #1", state: "working" }] });
	await push(overview);
	await push(overview);
	expect(host.querySelector(".rpp-warning")?.textContent).toContain("inconsistent project registry");
	expect(host.querySelector(".rpp-fraction")).toBeNull();
});

it("recorded unblock wording is shown once without an invented second heading", async () => {
	const raw = "How to unblock: Have architecture lead provide land receipt";
	await tile({ tasks: [{ ref: "design #347", state: "blocked", howToUnblock: raw }] });
	expect(host.querySelector(".rpp-unblock")?.textContent).toBe(raw);
});

it("closed milestone hover text keeps the complete source criterion", async () => {
	await tile(good.cases[0].input, undefined, false);
	const criteria = [...host.querySelectorAll(".rpp-criterion")];
	expect(criteria.length).toBeGreaterThan(0);
	for (const criterion of criteria) {
		expect(criterion.textContent).not.toBe("");
		expect(criterion.getAttribute("title")).toBe(criterion.textContent);
	}
});

it("RPP-30 / RPP-130 producer's canonical terminal/paused precedence (no UI remapper)", () => {
	const c = good.cases[29];
	const states = (c.input as Scenario).tasks.map((t: Scenario) =>
		boardStateOf(t as Parameters<typeof boardStateOf>[0]),
	);
	expect(states).toEqual(c.expected.states);
});
