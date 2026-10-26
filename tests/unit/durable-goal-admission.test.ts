// @vitest-environment jsdom
// Fixed inputs against the actual GoalBar, authored before the repair. The native
// browser companion runs the genuine pinned old component as the loss control.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppAdmit, type AppAdmit } from "../../web/src/app-admit.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ClientMessage, GoalStatus, ModelInfo } from "../../web/src/types.js";

const RAW = "  Keep exact Ω goal / wizard text\t  ";
const MODEL = "fixture/reviewer";
const MODELS: ModelInfo[] = [
	{ id: MODEL, name: "Fixture reviewer", provider: "fixture", reasoning: false, vision: false },
	{ id: "fixture/other", name: "Other reviewer", provider: "fixture", reasoning: false, vision: false },
];
const DEFAULT_GOAL: GoalStatus = {
	conversationId: null,
	goal: null,
	reviewModel: MODEL,
	maxRounds: 7,
	locked: true,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: { active: false, draft: "", model: null, step: 0, maxSteps: 6, status: "" },
};
type Kind = "set_goal" | "start_goal_wizard";
type Props = Parameters<typeof GoalBar>[0];
let root: Root;
let container: HTMLDivElement;
let props: Props;
let mounted: boolean;
let serial = 0;
let live: ClientMessage[];
let admitted: ClientMessage[];

function render(patch: Partial<Props> = {}) {
	props = { ...props, ...patch };
	act(() => {
		root.render(createElement(StrictMode, null, createElement(LanguageProvider, null, createElement(GoalBar, props))));
	});
}
function click(selector: string) {
	const node = container.querySelector<HTMLButtonElement>(selector);
	expect(node, selector).not.toBeNull();
	act(() => node!.click());
}
function edit(selector: string, value: string) {
	const node = container.querySelector<HTMLInputElement>(selector);
	expect(node, selector).not.toBeNull();
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
		node!.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
const text = () => container.querySelector<HTMLInputElement>(".goalbar-input");
const rounds = () => container.querySelector<HTMLInputElement>('input[type="number"]');
function open() {
	if (!text()) click(".goalbar-hint");
}
function enter() {
	act(() => {
		text()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
}
function submit(kind: Kind) {
	click(kind === "set_goal" ? ".goalbar-btn:not(.wizard)" : ".goalbar-btn.wizard");
}
function intent(kind: Kind, target = props.activeConversationId, value = RAW) {
	return {
		type: kind,
		...(kind === "set_goal" ? { goal: value, reviewModel: MODEL } : { text: value, wizardModel: MODEL }),
		maxRounds: 7,
		locked: true,
		conversationId: target,
	};
}
function retained() {
	return Array.from(container.querySelectorAll<HTMLTextAreaElement>(".goalbar-admission textarea"), (el) =>
		JSON.parse(el.value),
	);
}
function defer() {
	let resolve!: (value: boolean) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<boolean>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function handler(fn: AppAdmit) {
	setAppAdmit((message) => {
		admitted.push(message);
		return fn(message);
	});
}
async function settle(fn: () => void = () => {}) {
	await act(async () => {
		fn();
		await Promise.resolve();
	});
}
function remount() {
	act(() => root.unmount());
	root = createRoot(container);
	render();
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetAppGlobals();
	setAppGlobals({ engine: "pi" });
	setAppAdmit(null);
	live = [];
	admitted = [];
	setAppSend((message) => {
		live.push(message);
		return false;
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	mounted = true;
	props = {
		goal: DEFAULT_GOAL,
		models: MODELS,
		modelsLoading: false,
		activeConversationId: `goal-fixture-${++serial}`,
	};
	render();
	open();
	edit(".goalbar-input", RAW);
});
afterEach(() => {
	if (mounted) act(() => root.unmount());
	container.remove();
	setAppSend(null);
	setAppAdmit(null);
	resetAppGlobals();
	vi.unstubAllGlobals();
});

for (const kind of ["set_goal", "start_goal_wizard"] as const) {
	describe(kind, () => {
		it("captures complete immutable intent once before awaiting; only current exact true clears", async () => {
			const gate = defer();
			handler(() => gate.promise);
			submit(kind);
			expect(admitted).toEqual([intent(kind)]);
			expect(Object.isFrozen(admitted[0])).toBe(true);
			expect(text()!.value).toBe(RAW);
			expect(rounds()!.value).toBe("7");
			expect(container.textContent).toContain("Waiting for local admission");
			expect(retained()).toEqual([intent(kind)]);
			enter();
			enter();
			submit(kind);
			click(kind === "set_goal" ? ".goalbar-btn.wizard" : ".goalbar-btn:not(.wizard)");
			expect(admitted).toHaveLength(1);
			expect(live).toEqual([]);
			await settle(() => gate.resolve(true));
			expect(text()!.value).toBe("");
			expect(retained()).toEqual([intent(kind)]);
			expect(container.textContent).toContain("not server confirmation");
		});

		for (const result of [false, undefined, null, 1, "yes", {}]) {
			it(`retains exact source/options/target on nontrue ${String(result)}`, async () => {
				handler((() => Promise.resolve(result)) as unknown as AppAdmit);
				submit(kind);
				await settle();
				expect(admitted).toEqual([intent(kind)]);
				expect(text()!.value).toBe(RAW);
				expect(rounds()!.value).toBe("7");
				expect(container.querySelector('[title="Locked: applies to every later turn"]')).not.toBeNull();
				expect(retained()).toEqual([intent(kind)]);
				expect(container.textContent).toContain("Admission not confirmed");
				expect(live).toEqual([]);
			});
		}
		for (const committed of [false, true]) {
			it(`retains and reports rejected/uncertain intent (payloadCommitted=${committed})`, async () => {
				const error = Object.assign(new Error("synthetic checkpoint/dispatch uncertainty"), {
					payloadCommitted: committed,
				});
				handler(() => Promise.reject(error));
				submit(kind);
				await settle();
				expect(admitted).toEqual([intent(kind)]);
				expect(text()!.value).toBe(RAW);
				expect(retained()).toEqual([intent(kind)]);
				expect(container.textContent).toContain("Admission uncertain");
				expect(live).toEqual([]);
				remount();
				expect(text()!.value).toBe(RAW);
				expect(retained()).toEqual([intent(kind)]);
				expect(admitted).toHaveLength(1);
			});
		}
		it("captures actual pre-submit option edits, including unlimited/main-model/one-turn selections", async () => {
			click('.goalbar-row .goalbar-icon-btn[title^="Locked"]');
			edit('input[type="number"]', "0");
			click(".dropdown > button");
			click(".dd-menu .dd-item");
			handler(async () => false);
			submit(kind);
			await settle();
			const message = {
				type: kind,
				...(kind === "set_goal" ? { goal: RAW } : { text: RAW }),
				maxRounds: 0,
				locked: false,
				conversationId: props.activeConversationId,
			};
			expect(admitted).toEqual([message]);
			expect(retained()).toEqual([message]);
			expect(text()!.value).toBe(RAW);
			expect(rounds()!.value).toBe("0");
			expect(container.querySelector(".goalbar-opt")!.textContent).toContain("Use the main model");
		});
		it("guards duplicate Enter and click within the same event turn before React commits", async () => {
			const gate = defer();
			handler(() => gate.promise);
			act(() => {
				const action = container.querySelector<HTMLButtonElement>(
					kind === "set_goal" ? ".goalbar-btn:not(.wizard)" : ".goalbar-btn.wizard",
				)!;
				action.click();
				action.click();
				text()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			});
			expect(admitted).toEqual([intent(kind)]);
			await settle(() => gate.resolve(false));
			expect(text()!.value).toBe(RAW);
		});
		it("retains when no handler exists and when a handler throws synchronously", async () => {
			submit(kind);
			await settle();
			expect(text()!.value).toBe(RAW);
			handler(() => {
				throw new Error("synthetic synchronous failure");
			});
			submit(kind);
			await settle();
			expect(text()!.value).toBe(RAW);
			expect(retained()).toEqual([intent(kind), intent(kind)]);
			expect(live).toEqual([]);
		});

		for (const editKind of [
			"text",
			"text ABA",
			"rounds",
			"rounds ABA",
			"lock",
			"lock ABA",
			"model",
			"model ABA",
			"collapse ABA",
		] as const) {
			it(`does not clean a newer ${editKind} revision after true`, async () => {
				const gate = defer();
				handler(() => gate.promise);
				submit(kind);
				if (editKind.startsWith("text")) {
					edit(".goalbar-input", "newer source");
					if (editKind.endsWith("ABA")) edit(".goalbar-input", RAW);
				} else if (editKind.startsWith("rounds")) {
					edit('input[type="number"]', "11");
					if (editKind.endsWith("ABA")) edit('input[type="number"]', "7");
				} else if (editKind.startsWith("lock")) {
					click('.goalbar-row .goalbar-icon-btn[title^="Locked"]');
					if (editKind.endsWith("ABA")) click('.goalbar-row .goalbar-icon-btn[title^="This turn"]');
				} else if (editKind.startsWith("model")) {
					click(".dropdown > button");
					click(".dd-menu .dd-item:nth-of-type(3)");
					if (editKind.endsWith("ABA")) {
						click(".dropdown > button");
						click(".dd-menu .dd-item:nth-of-type(2)");
					}
				} else {
					click('.goalbar-row .goalbar-icon-btn[title="Cancel"]');
					open();
				}
				await settle(() => gate.resolve(true));
				expect(text()!.value).toBe(editKind === "text" ? "newer source" : RAW);
				expect(rounds()!.value).toBe(editKind === "rounds" ? "11" : "7");
				expect(container.querySelector(".goalbar-opt")!.textContent).toContain(
					editKind === "model" ? "Other reviewer" : "Fixture reviewer",
				);
				expect(container.querySelector(".goalbar-row .goalbar-icon-btn")!.getAttribute("title")).toBe(
					editKind === "lock" ? "This turn only (cleared afterwards)" : "Locked: applies to every later turn",
				);
				expect(retained()).toEqual([intent(kind)]);
				expect(admitted).toHaveLength(1);
			});
		}

		for (const outcome of ["pending", "true", "false", "reject"] as const) {
			it(`keeps original A and independent B through target ABA (${outcome})`, async () => {
				const gate = defer();
				handler(() => gate.promise);
				submit(kind);
				const targetA = props.activeConversationId;
				render({ activeConversationId: `${targetA}-B` });
				open();
				expect(text()!.value).toBe("");
				edit(".goalbar-input", "B draft");
				edit('input[type="number"]', "12");
				render({ activeConversationId: targetA });
				expect(text()!.value).toBe(RAW);
				if (outcome !== "pending")
					await settle(() =>
						outcome === "reject" ? gate.reject(new Error("uncertain")) : gate.resolve(outcome === "true"),
					);
				expect(text()!.value).toBe(RAW);
				expect(rounds()!.value).toBe("7");
				expect(retained()).toEqual([intent(kind, targetA)]);
				expect(admitted).toEqual([intent(kind, targetA)]);
				render({ activeConversationId: `${targetA}-B` });
				expect(text()!.value).toBe("B draft");
				expect(rounds()!.value).toBe("12");
				expect(live).toEqual([]);
			});
		}
		it("never clears the recovered remounted lifetime on late true or auto-submits on recovery", async () => {
			const gate = defer();
			handler(() => gate.promise);
			submit(kind);
			remount();
			expect(text()!.value).toBe(RAW);
			enter();
			expect(admitted).toHaveLength(1);
			await settle(() => gate.resolve(true));
			expect(text()!.value).toBe(RAW);
			expect(retained()).toEqual([intent(kind)]);
			expect(admitted).toHaveLength(1);
			expect(live).toEqual([]);
		});
		it("retains source while unmounted even if completion precedes remount", async () => {
			const gate = defer();
			handler(() => gate.promise);
			submit(kind);
			act(() => root.unmount());
			mounted = false;
			await settle(() => gate.resolve(true));
			root = createRoot(container);
			mounted = true;
			render();
			expect(text()!.value).toBe(RAW);
			expect(retained()).toEqual([intent(kind)]);
			expect(admitted).toHaveLength(1);
		});
		it("invalidates inactive→active→inactive view ABA without replacing the editor", async () => {
			const gate = defer();
			handler(() => gate.promise);
			submit(kind);
			render({ goal: { ...DEFAULT_GOAL, conversationId: props.activeConversationId, goal: "existing server goal" } });
			expect(text()).toBeNull();
			expect(retained()).toEqual([intent(kind)]);
			render({ goal: DEFAULT_GOAL });
			await settle(() => gate.resolve(true));
			expect(text()!.value).toBe(RAW);
		});
		it("does not let server preference updates overwrite authored options", async () => {
			const gate = defer();
			handler(() => gate.promise);
			submit(kind);
			render({ goal: { ...DEFAULT_GOAL, reviewModel: "fixture/other", maxRounds: 99, locked: false } });
			expect(rounds()!.value).toBe("7");
			expect(container.querySelector(".goalbar-opt")!.textContent).toContain("Fixture reviewer");
			await settle(() => gate.resolve(false));
			expect(text()!.value).toBe(RAW);
			expect(admitted).toEqual([intent(kind)]);
		});
	});
}

it("recovers an unsent conversation-scoped draft/options without any admission or automatic start", () => {
	const target = props.activeConversationId;
	handler(async () => true);
	edit('input[type="number"]', "17");
	render({ activeConversationId: `${target}-B` });
	open();
	expect(text()!.value).toBe("");
	render({ activeConversationId: target });
	remount();
	expect(text()!.value).toBe(RAW);
	expect(rounds()!.value).toBe("17");
	expect(admitted).toEqual([]);
	expect(live).toEqual([]);
});
it("preserves multiple originals and the newer edit after uncertain manual resubmission", async () => {
	handler(() => Promise.reject(Object.assign(new Error("uncertain"), { payloadCommitted: true })));
	submit("set_goal");
	await settle();
	edit(".goalbar-input", "newer intent");
	submit("start_goal_wizard");
	await settle();
	expect(retained()).toEqual([
		intent("set_goal"),
		intent("start_goal_wizard", props.activeConversationId, "newer intent"),
	]);
	expect(text()!.value).toBe("newer intent");
	expect(admitted).toHaveLength(2);
});
it("uses trim only for emptiness and refuses a missing target without inventing one", () => {
	handler(async () => true);
	edit(".goalbar-input", " \t ");
	enter();
	submit("start_goal_wizard");
	expect(admitted).toEqual([]);
	render({ activeConversationId: "" });
	open();
	edit(".goalbar-input", RAW);
	enter();
	submit("set_goal");
	expect(admitted).toEqual([]);
	expect(text()!.value).toBe(RAW);
});
it("keeps model reads, preference/lock/clear controls live and out of admission", async () => {
	handler(async () => true);
	edit('input[type="number"]', "9");
	act(() => {
		rounds()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	click('.goalbar-row .goalbar-icon-btn[title^="Locked"]');
	render({ models: [] });
	click(".dropdown > button");
	click(".dd-menu .dd-item");
	expect(live).toEqual([
		{ type: "set_goal_prefs", maxRounds: 9 },
		{ type: "set_goal_prefs", locked: false },
		{ type: "list_models" },
		{ type: "set_goal_prefs", reviewModel: "" },
	]);
	render({ goal: { ...DEFAULT_GOAL, conversationId: props.activeConversationId, goal: "old server goal" } });
	click(".goalbar-x");
	expect(live.at(-1)).toEqual({ type: "clear_goal" });
	render({ goal: DEFAULT_GOAL });
	expect(text()!.value).toBe(RAW); // clear must not replace a newer authored draft
	expect(admitted).toEqual([]);
});
it("retains the DSH picker gating and does not admit control actions", () => {
	act(() => setAppGlobals({ engine: "dsh" }));
	expect(container.querySelector(".dropdown")).toBeNull();
	expect(container.querySelector(".goalbar-dsh-note")).not.toBeNull();
	expect(admitted).toEqual([]);
});
