// @vitest-environment jsdom
// Synthetic data only; never opens the app, user browser/profile, WebSocket or real ask.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	GuardApprovalContext,
	GuardOwnerQuestion,
	GuardRequest,
	GuardRequestState,
} from "../../server/role-message-guard-contract.js";
import type {
	GuardOwnerQuestionAny,
	GuardOwnerQuestionV2,
	GuardRequestAny,
	GuardRequestV2,
} from "../../server/role-message-guard-contract-v2.js";
import { GUARD_POLICY_V2, ROLE_MESSAGE_POLICY } from "../../server/role-message-limits.js";
import {
	RoleMessageGuardApproval,
	type GuardApprovalIntent,
} from "../../web/src/components/RoleMessageGuardApproval.js";
import {
	expiresIn,
	guardApprovalView,
	type GuardApprovalView,
	type GuardApprovalViewInput,
} from "../../web/src/role-message-guard-view.js";
const context: GuardApprovalContext = {
	goal: "Synthetic review: isolated approval adapters",
	progressAndChanges: "Inert additions prepared. No live registration or installation.",
	priorDecisions: ["Only communication, not action, is requested."],
	whyNeeded: "A bounded communication chain reached its limit.",
	nextStepAndOutcome: "Ask QA to review one isolated change.",
	outstandingQuestions: ["Allow one message?", "Allow the requested finite quantity?"],
	optionsAndTradeoffs: [
		"Deny: stop messaging; zero further cost.",
		"One: one bounded review request; five minutes.",
		"Requested: at most three requests; higher review cost and unchanged risk controls.",
	],
	timeCostRisk: "Five to fifteen minutes. No authorised spend. No release authority.",
	exactCommunicationAuthority: "Only the named QA review, original root, named participants, and finite bound.",
	nativeFacts: [
		{
			sourceId: "synthetic-native",
			sourceVersion: "v1",
			sourceIncarnation: "fake-host",
			eventId: "fake-proof",
			revision: "1",
			digest: "synthetic-not-authentication",
			observedAt: 1000,
		},
	],
	declaredClaims: ["Requester believes review will help. This is not a verified fact."],
	safetyScopeAndHolds: [
		"No deployment, action or spending approval.",
		"Existing pauses, consent and access still apply.",
	],
};
function request(state: GuardRequestState = "awaiting_approver"): GuardRequest {
	const actor = {
		role: "ops",
		sessionFile: "/synthetic/task",
		sessionId: "task-127",
		runtimeIncarnation: "fake-1",
		task: { kind: "task" as const, queueId: "ops", taskId: 127, generation: "task-g1" },
		currentHome: false,
		identityRevision: "r1",
	};
	return {
		binding: {
			version: "role-message-guard/v1",
			requestId: "request-1",
			generation: "request-g1",
			requester: actor,
			causal: {
				kind: "rooted",
				rootId: "business-root",
				parentId: "original-incoming",
				nextHop: 7,
				sourceRevision: "source-1",
				incomingRecordId: "original-incoming",
				incomingHash: "fake-hash",
			},
			scope: {
				scopeId: "qa-review-only",
				operation: "review",
				participants: ["ops", "qa"],
				recipients: ["qa"],
				task: actor.task,
			},
			tier: state === "awaiting_owner" ? "owner" : "lower",
			quantity: 3,
			upperHop: state === "awaiting_owner" ? 14 : 9,
		},
		context,
		selectedApprover: {
			tier: "lower",
			role: "coo",
			route: "coo",
			home: {
				...actor,
				role: "coo",
				sessionFile: "/synthetic/coo-home",
				sessionId: "coo-home",
				task: { kind: "home" },
				currentHome: true,
			},
			proof: context.nativeFacts[0],
		},
		createdAt: 1000,
		expiresAt: 86401000,
		state,
		upwardEscalations: 0,
		initialNotificationKey: "initial-key",
		decisionNotificationKey: "decision-key",
		firstDecision: null,
		grantId: null,
	};
}
function ownerQuestion(r: GuardRequest): GuardOwnerQuestion;
function ownerQuestion(r: GuardRequestV2): GuardOwnerQuestionV2;
function ownerQuestion(r: GuardRequestAny): GuardOwnerQuestionAny;
function ownerQuestion(r: GuardRequestAny): GuardOwnerQuestionAny {
	const common = {
		questionId: "native-q1",
		generation: "native-q-g1",
		detail: r.context,
		choices: ["deny", "one_send", "requested_quantity"] as const,
		choicesDigest: "fake-digest-not-authentication",
	};
	return r.binding.version === "role-message-guard/v1"
		? { ...common, binding: r.binding }
		: { ...common, binding: r.binding };
}
function input(r: GuardRequestAny = request()): GuardApprovalViewInput {
	return { request: r, viewer: "lower", eligible: true, connected: true, nowMs: 1000 };
}
let root: Root | null = null;
function mount(
	view = guardApprovalView(input()),
	onDecision = vi.fn<(intent: GuardApprovalIntent) => Promise<void>>(async () => undefined),
) {
	const previous = document.createElement("button");
	previous.textContent = "Synthetic previous focus";
	document.body.appendChild(previous);
	previous.focus();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const onClose = vi.fn();
	const render = (v: GuardApprovalView) =>
		act(() => {
			root!.render(createElement(RoleMessageGuardApproval, { view: v, onDecision, onClose }));
		});
	render(view);
	return {
		container,
		previous,
		onDecision,
		onClose,
		render,
		dialog: () => container.querySelector<HTMLElement>('[role="dialog"]')!,
	};
}
function click(container: HTMLElement, selector: string) {
	const element = container.querySelector<HTMLElement>(selector);
	if (!element) throw new Error("Missing synthetic control");
	act(() => element.click());
}
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.replaceChildren();
});
describe("A complete honest isolated view", () => {
	it.each([
		"context_needed",
		"awaiting_approver",
		"awaiting_owner",
		"approved",
		"denied",
		"expired",
		"exhausted",
		"revoked",
		"unknown",
		"held",
		"rate_limited",
	] as const)("renders %s without implying a sent message", (state) => {
		const view = guardApprovalView({ ...input(request(state)), viewer: "status" });
		expect(view.state).toBe(state);
		expect(view.status).not.toBe("");
		expect(view.choices).toEqual([]);
		expect(view.limits).toContain("No automatic business send");
		if (state === "approved") expect(view.status).toBe("Approved — not sent");
	});
	it("unavailable, disconnected, expiry and bad time have no action", () => {
		expect(guardApprovalView({ ...input(), request: null }).state).toBe("unavailable");
		const disconnected = guardApprovalView({ ...input(), connected: false });
		expect(disconnected.state).toBe("disconnected");
		expect(disconnected.choices).toEqual([]);
		expect(guardApprovalView({ ...input(), nowMs: 86401000 }).state).toBe("expired");
		expect(guardApprovalView({ ...input(), nowMs: NaN }).state).toBe("unavailable");
	});
	it.each(Object.keys(context))("missing %s shows context_needed, never truncated choices", (key) => {
		const r = request();
		const partial = { ...context } as Record<string, unknown>;
		delete partial[key];
		expect(() => guardApprovalView(input({ ...r, context: partial as unknown as GuardApprovalContext }))).not.toThrow();
		const view = guardApprovalView(input({ ...r, context: partial as unknown as GuardApprovalContext }));
		expect(view.state).toBe("context_needed");
		expect(view.choices).toEqual([]);
	});
	it("full detail covers every essential field and separates facts/claims", () => {
		const view = guardApprovalView(input());
		expect(view.sections).toHaveLength(12);
		const all = view.sections.flatMap((s) => s.values).join("\n");
		for (const value of [
			context.goal,
			context.progressAndChanges,
			context.whyNeeded,
			context.timeCostRisk,
			context.exactCommunicationAuthority,
			...context.priorDecisions,
			...context.optionsAndTradeoffs,
			...context.outstandingQuestions,
			...context.safetyScopeAndHolds,
			...context.declaredClaims,
		])
			expect(all).toContain(value);
		expect(view.sections[10].label).toContain("host verification required");
		expect(view.sections[11].label).toContain("not verified");
	});
	it("lower decisions end before 12; escalation is one finite choice", () => {
		const r = request();
		expect(guardApprovalView(input(r)).choices.map((c) => c.value)).toEqual([
			"deny",
			"one_send",
			"requested_quantity",
			"escalate_owner",
		]);
		expect(guardApprovalView(input({ ...r, upwardEscalations: 1 })).choices).toHaveLength(3);
		expect(guardApprovalView(input({ ...r, binding: { ...r.binding, upperHop: 12 } })).choices).toEqual([]);
	});
	it("V2 views use the recorded 22/23 boundary and reject overband quantity without changing old requests", () => {
		const old = request();
		if (old.selectedApprover.tier !== "lower") throw new Error("synthetic lower fixture changed");
		const r: GuardRequestV2 = {
			...old,
			selectedApprover: old.selectedApprover,
			firstDecision: null,
			binding: {
				...old.binding,
				version: GUARD_POLICY_V2.version,
				quantity: 10,
				upperHop: 22,
				causal: { ...old.binding.causal, nextHop: 13 },
			},
		};
		expect(guardApprovalView(input(r)).tier).toContain("hop 22");
		expect(guardApprovalView(input(r)).choices).toHaveLength(4);
		expect(guardApprovalView(input({ ...r, binding: { ...r.binding, upperHop: 23 } })).choices).toEqual([]);
		const owner: GuardRequestV2 = {
			...r,
			selectedApprover: { tier: "owner", reason: "hop_23_plus" },
			state: "awaiting_owner",
			binding: { ...r.binding, tier: "owner", upperHop: 32, causal: { ...r.binding.causal, nextHop: 23 } },
		};
		expect(guardApprovalView({ ...input(owner), viewer: "owner", ownerQuestion: ownerQuestion(owner) }).tier).toContain(
			"hop 23",
		);
		expect(
			guardApprovalView({ ...input(owner), viewer: "owner", ownerQuestion: ownerQuestion(owner) }).choices,
		).toHaveLength(3);
		expect(guardApprovalView(input(old)).tier).toContain("hop 11");
		expect(old.binding.quantity).toBe(3);
	});
	it("Owner choices require matching native question but UI eligibility is not authentication", () => {
		const r = request("awaiting_owner");
		expect(guardApprovalView({ ...input(r), viewer: "owner" }).choices).toEqual([]);
		const q = ownerQuestion(r);
		expect(guardApprovalView({ ...input(r), viewer: "owner", ownerQuestion: q }).choices).toHaveLength(3);
		expect(
			guardApprovalView({
				...input(r),
				viewer: "owner",
				ownerQuestion: { ...q, detail: { ...q.detail, goal: "different" } },
			}).choices,
		).toEqual([]);
		expect(guardApprovalView({ ...input(r), viewer: "owner", ownerQuestion: q, eligible: false }).choices).toEqual([]);
	});
	it("expiry is readable remaining time from the supplied clock, never a raw timestamp", () => {
		expect(guardApprovalView(input()).statusDetail).toContain("expires in 24 h 0 min");
		expect(guardApprovalView(input()).statusDetail).not.toContain("86401000");
		expect(expiresIn(90 * 60000)).toBe("expires in 1 h 30 min");
		expect(expiresIn(30001)).toBe("expires in 1 min");
		for (const value of [0, -1, NaN, Infinity]) expect(expiresIn(value)).toBe("expired");
	});
	it("English and Chinese present all sections, states and finite choices", () => {
		const zh = guardApprovalView({ ...input(), language: "zh" });
		expect(zh.title).toBe("消息继续申请");
		expect(zh.sections).toHaveLength(12);
		expect(zh.choices).toHaveLength(4);
		expect(zh.limits).toContain(`每小时 ${ROLE_MESSAGE_POLICY.ordinary.acceptedPerOrigin} 条`);
	});
	it("CSS is opt-in and wraps long context with phone targets and forced-colour focus", () => {
		const css = readFileSync(join(process.cwd(), "web/src/role-message-guard.css"), "utf8");
		expect(css).toContain("overflow-wrap: anywhere");
		expect(css).toContain("min-height: 44px");
		expect(css).toContain("forced-colors: active");
		const source = readFileSync(join(process.cwd(), "web/src/components/RoleMessageGuardApproval.tsx"), "utf8");
		expect(source).not.toMatch(/import.*\.css|appSend|app-globals|WebSocket/u);
	});
});
describe("A finite controls, focus, reconnect and failure", () => {
	it("labelled modal, live status, labelled radios; focus enters and restores", () => {
		const m = mount();
		expect(document.activeElement).toBe(m.dialog());
		expect(m.dialog().getAttribute("aria-modal")).toBe("true");
		expect(m.dialog().getAttribute("aria-labelledby")).not.toBeNull();
		expect(m.container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
		expect(m.container.querySelectorAll("label input[type=radio]")).toHaveLength(4);
		act(() => root!.unmount());
		root = null;
		expect(document.activeElement).toBe(m.previous);
	});
	it("Escape/close cancel presentation, never make a decision", () => {
		const m = mount();
		act(() => m.dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(m.onClose).toHaveBeenCalledOnce();
		expect(m.onDecision).not.toHaveBeenCalled();
	});
	it("Tab and shift-Tab remain inside; first radio is group's only tab stop", () => {
		const m = mount();
		const close = m.container.querySelector<HTMLButtonElement>("button")!;
		const first = m.container.querySelector<HTMLInputElement>("input")!;
		act(() =>
			m
				.dialog()
				.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })),
		);
		expect(document.activeElement).toBe(first);
		act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
		expect(document.activeElement).toBe(close);
	});
	it("no default selection or auto-send; requires explicit selected submit", async () => {
		const m = mount();
		const submit = m.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		expect(submit.disabled).toBe(true);
		expect(m.onDecision).not.toHaveBeenCalled();
		click(m.container, 'input[value="one_send"]');
		expect(m.onDecision).not.toHaveBeenCalled();
		await act(async () => {
			submit.click();
		});
		expect(m.onDecision).toHaveBeenCalledExactlyOnceWith({
			requestId: "request-1",
			generation: "request-g1",
			questionId: null,
			questionGeneration: null,
			choice: "one_send",
		});
		expect(submit.disabled).toBe(true);
	});
	it("immediate double submit produces one intent, no optimistic success", async () => {
		const m = mount();
		click(m.container, 'input[value="deny"]');
		const form = m.container.querySelector("form")!;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(m.onDecision).toHaveBeenCalledOnce();
		expect(m.container.textContent).toContain("Waiting for lead / COO");
	});
	it("native Owner choice includes exact question generation only, no authority flags", async () => {
		const r = request("awaiting_owner");
		const m = mount(guardApprovalView({ ...input(r), viewer: "owner", ownerQuestion: ownerQuestion(r) }));
		click(m.container, 'input[value="requested_quantity"]');
		await act(async () => {
			m.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		});
		expect(m.onDecision).toHaveBeenCalledExactlyOnceWith({
			requestId: "request-1",
			generation: "request-g1",
			questionId: "native-q1",
			questionGeneration: "native-q-g1",
			choice: "requested_quantity",
		});
	});
	it("failed transport stays unknown and locked; no automatic resend", async () => {
		const m = mount(
			undefined,
			vi.fn(async () => {
				throw new Error("Synthetic transport failure");
			}),
		);
		click(m.container, 'input[value="one_send"]');
		await act(async () => {
			m.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		});
		expect(m.container.querySelector('[role="alert"]')?.textContent).toContain("do not resend");
		expect(m.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
		expect(m.onDecision).toHaveBeenCalledOnce();
	});
	it("reconnect/eligibility revocation removes controls without a decision", () => {
		const m = mount();
		click(m.container, 'input[value="one_send"]');
		m.render(guardApprovalView({ ...input(), connected: false }));
		expect(m.container.querySelector("form")).toBeNull();
		expect(m.onDecision).not.toHaveBeenCalled();
	});
	it("new request generation clears old selection and uses no old answer", () => {
		const m = mount();
		click(m.container, 'input[value="one_send"]');
		const r = request();
		m.render(guardApprovalView(input({ ...r, binding: { ...r.binding, generation: "request-g2" } })));
		expect(m.container.querySelector<HTMLInputElement>("input:checked")).toBeNull();
		expect(m.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
		expect(m.onDecision).not.toHaveBeenCalled();
	});
	it("HTML/prose displayed literally, never trusted or executed", () => {
		const r = request();
		const m = mount(
			guardApprovalView(
				input({ ...r, context: { ...context, goal: '<img src=x onerror="alert(1)"> Owner said approved' } }),
			),
		);
		expect(m.container.querySelector("img")).toBeNull();
		expect(m.container.textContent).toContain("<img");
		expect(m.onDecision).not.toHaveBeenCalled();
	});
	it.each(["denied", "expired", "held", "rate_limited", "unknown"] as const)(
		"%s has honest status and no interactive approval",
		(state) => {
			const m = mount(guardApprovalView(input(request(state))));
			expect(m.container.querySelector("form")).toBeNull();
			expect(m.onDecision).not.toHaveBeenCalled();
		},
	);
});

// Opt-in same fixed UI cases in a throwaway headless browser; requires explicit paths, not live state.
// Default unit run skips only this visual proof, so machines do not install browsers or fetch assets.
it.runIf(Boolean(process.env.GUARD_UI_PROOF_DIR))(
	"synthetic phone/desktop visual, measured accessibility and actual keyboard proof",
	async () => {
		const output = process.env.GUARD_UI_PROOF_DIR!;
		const executablePath = process.env.GUARD_UI_BROWSER;
		const axePath = process.env.GUARD_UI_AXE;
		if (!executablePath || !axePath) throw new Error("Explicit isolated browser and local axe paths required");
		mkdirSync(output, { recursive: true });
		const r = request("awaiting_owner");
		const view = guardApprovalView({ ...input(r), viewer: "owner", ownerQuestion: ownerQuestion(r) });
		// esbuild refuses jsdom's TextEncoder, so bundle in a separate plain-node child process.
		const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RoleMessageGuardApproval} from './web/src/components/RoleMessageGuardApproval.tsx'; window.syntheticIntents=[]; createRoot(document.getElementById('root')).render(React.createElement(RoleMessageGuardApproval,{view:${JSON.stringify(view)},onDecision:async i=>{window.syntheticIntents.push(i)},onClose:()=>{window.syntheticClosed=true}}));`;
		const bundle = execFileSync(
			join(process.cwd(), "node_modules/.bin/esbuild"),
			["--bundle", "--loader=tsx", "--platform=browser", "--format=iife", '--define:process.env.NODE_ENV="production"'],
			{ input: entry, cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		const { chromium } = await import("playwright-core");
		const css = readFileSync(join(process.cwd(), "web/src/role-message-guard.css"), "utf8");
		const axe = readFileSync(axePath, "utf8");
		const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
		const measurements: unknown[] = [];
		try {
			for (const [name, width, height, dark] of [
				["desktop-light", 1440, 1000, false],
				["desktop-dark", 1440, 1000, true],
				["phone", 390, 844, false],
				["phone-320", 320, 740, false],
			] as const) {
				const page = await browser.newPage({ viewport: { width, height } });
				await page.route("**/*", (route) => route.abort());
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.setContent(
					`<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic A approval proof</title><style>body{margin:0}${css}${dark ? ":root{--bg:#151b25;--text:#f4f5f7;--border:#8993a5}" : ""}</style><body><main id="root"></main><script>${bundle}</script></body></html>`,
				);
				await page.locator('[role="dialog"]').waitFor();
				const metrics = await page.evaluate(() => {
					const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
					const rect = dialog.getBoundingClientRect();
					return {
						width: innerWidth,
						dialogLeft: rect.left,
						dialogRight: rect.right,
						documentOverflow: document.documentElement.scrollWidth > innerWidth,
						dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
						sectionCount: dialog.querySelectorAll("h3").length,
						contextPresent: dialog.textContent!.includes("No authorised spend"),
						minimumButtonHeight: Math.min(
							...Array.from(dialog.querySelectorAll("button")).map((button) => button.getBoundingClientRect().height),
						),
					};
				});
				expect(metrics.documentOverflow).toBe(false);
				expect(metrics.dialogOverflow).toBe(false);
				expect(metrics.dialogLeft).toBeGreaterThanOrEqual(0);
				expect(metrics.dialogRight).toBeLessThanOrEqual(width);
				expect(metrics.sectionCount).toBe(12);
				expect(metrics.contextPresent).toBe(true);
				expect(metrics.minimumButtonHeight).toBeGreaterThanOrEqual(44);
				expect(errors).toEqual([]);
				await page.addScriptTag({ content: axe });
				const accessibility = await page.evaluate(async () => {
					const api = (
						window as unknown as {
							axe: {
								run: (
									selector: string,
									options: unknown,
								) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }>;
							};
						}
					).axe;
					const result = await api.run(".role-guard-dialog", {
						runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
					});
					return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
				});
				expect(accessibility).toEqual([]);
				await page.screenshot({ path: join(output, `${name}.png`) });
				await page.locator("form").scrollIntoViewIfNeeded();
				await page.screenshot({ path: join(output, `${name}-choices.png`) });
				await page.locator('input[value="deny"]').focus();
				await page.keyboard.press("ArrowRight");
				expect(await page.locator('input[value="one_send"]').isChecked()).toBe(true);
				await page.locator('button[type="submit"]').focus();
				await page.keyboard.press("Tab");
				expect(await page.locator(".role-guard-close").evaluate((element) => element === document.activeElement)).toBe(
					true,
				);
				await page.locator('button[type="submit"]').click();
				expect(
					await page.evaluate(() => (window as unknown as { syntheticIntents: unknown[] }).syntheticIntents.length),
				).toBe(1);
				measurements.push({ name, metrics, accessibility, pageErrors: errors, finiteKeyboardIntentCount: 1 });
				await page.close();
			}
			writeFileSync(
				join(output, "measurements.json"),
				`${JSON.stringify({ syntheticOnly: true, realAuthentication: false, installed: false, measurements }, null, 2)}\n`,
			);
		} finally {
			await browser.close();
		}
	},
	60000,
);
