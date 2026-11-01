// Native host seams only: synthetic chats, no SDK run/model, no real transcript or provider payload.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { newTurnRecord } from "../../server/role-replies.js";
import { installPromptStartGuard } from "../../server/prompt-start-guard.js";
import { ONLY_IN_COO_HOME, ROUTING_OFF } from "../../server/owner-question-tool.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const fixtures = vi.hoisted(() => ({
	home: "/fixture/coo-home.jsonl",
	snapshot: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../../server/workspace-snapshot.js", () => ({
	createWorkspaceSnapshot: fixtures.snapshot,
	restoreWorkspaceSnapshot: vi.fn(),
}));
vi.mock("../../server/identities.js", async (original) => ({
	...(await original<typeof import("../../server/identities.js")>()),
	identityRegistry: () => ({ identities: [{ id: "coo", title: "COO", homeChat: fixtures.home, pastHomeChats: [] }] }),
}));

const call = <T>(prototype: object, target: object, name: string, ...args: unknown[]): T =>
	Reflect.get(prototype, name).apply(target, args) as T;
const clientCall = <T>(target: object, name: string, ...args: unknown[]) =>
	call<T>(ClientSession.prototype, target, name, ...args);
const serviceCall = <T>(target: object, name: string, ...args: unknown[]) =>
	call<T>(AgentService.prototype, target, name, ...args);
function gate() {
	let open!: () => void;
	const ready = new Promise<void>((r) => {
		open = r;
	});
	return { ready, open };
}
afterEach(() => {
	fixtures.home = "/fixture/coo-home.jsonl";
	fixtures.snapshot.mockReset().mockResolvedValue(null);
	vi.useRealTimers();
});

function promptFixture(lateText: () => string | undefined, textCurrent?: () => boolean) {
	const sdk = vi.fn(async (_text: string, options: { preflightResult(d: string): void }) => {
		options.preflightResult("handled");
	});
	const session = {
		isStreaming: false,
		isCompacting: false,
		agent: { state: { messages: [] } },
		prompt: sdk,
		sendCustomMessage: vi.fn(),
		_pendingNextTurnMessages: [] as unknown[],
		_preparePromptAndToolLoadout: vi.fn(),
	};
	const conv = { id: "fixture", title: "COO", cwd: "/fixture", session, isSubagent: false };
	const host = {
		convs: new Map([[conv.id, conv]]),
		activeId: conv.id,
		session,
		settingsSvc: { current: { parallelReminderEnabled: false } },
		quiesceBlocked: () => false,
		activeSessionFileResolved: () => undefined,
		flushSnapshot: vi.fn(),
		emit: vi.fn(),
		getLang: () => "en",
	};
	const receipt = { ok: vi.fn(), fail: vi.fn() };
	const admission = gate();
	const flow = { source: "extension", lateText, textCurrent, admission: { ready: admission.ready, release: vi.fn() } };
	const run = () =>
		clientCall<Promise<void>>(host, "promptInLine", conv, receipt, flow, "[Owner question]", undefined, true);
	return { host, conv, session, sdk, receipt, admission, run };
}

describe("COO lazy prompt admission", () => {
	it("composes after admission and snapshot prework; gone asks start no SDK call", async () => {
		const snapshotEntered = gate();
		const snapshotDone = gate();
		fixtures.snapshot.mockImplementation(async () => {
			snapshotEntered.open();
			await snapshotDone.ready;
			return null;
		});
		let held = true;
		const compose = vi.fn(() => (held ? "[Owner question] fixed fixture" : undefined));
		const f = promptFixture(compose);
		const run = f.run();
		expect(compose).not.toHaveBeenCalled();
		f.admission.open();
		await snapshotEntered.ready;
		expect(compose).not.toHaveBeenCalled();
		held = false;
		snapshotDone.open();
		await run;
		expect(compose).toHaveBeenCalledTimes(1);
		expect(f.sdk).not.toHaveBeenCalled();
		expect(f.receipt.ok).toHaveBeenCalledTimes(1);
		expect(f.receipt.fail).not.toHaveBeenCalled();
	});

	it("newly held asks are included at the final admission, not the earlier opening", async () => {
		let held = 1;
		let composedCount = 0;
		const f = promptFixture(() => {
			composedCount = held;
			return "[Owner question] fixed fixture";
		});
		const run = f.run();
		held = 2;
		f.admission.open();
		await run;
		expect(composedCount).toBe(2);
		expect(f.sdk).toHaveBeenCalledTimes(1);
		expect(f.receipt.fail).not.toHaveBeenCalled();
	});

	it("a run starting during prework refuses without composing a stale card", async () => {
		const compose = vi.fn(() => "[Owner question] fixed fixture");
		const f = promptFixture(compose);
		fixtures.snapshot.mockImplementation(async () => {
			f.session.isStreaming = true;
			return null;
		});
		const run = f.run();
		f.admission.open();
		await run;
		expect(compose).not.toHaveBeenCalled();
		expect(f.sdk).not.toHaveBeenCalled();
		expect(f.receipt.fail).toHaveBeenCalledWith("the chat became busy before the card could go");
	});
});

describe("COO SDK start boundary", () => {
	it("a native start still in preflight cannot freeze the card into its follow-up", async () => {
		const entering = gate();
		const finish = gate();
		const compose = vi.fn(() => "[Owner question] fixed fixture");
		const f = promptFixture(compose);
		f.sdk.mockImplementation(async (_text, opts) => {
			entering.open();
			await finish.ready;
			opts.preflightResult("handled");
		});
		installPromptStartGuard(f.session as never);
		const native = f.session.prompt("native", { preflightResult: () => {} });
		await entering.ready;
		const run = f.run();
		f.admission.open();
		await run;
		expect(compose).not.toHaveBeenCalled();
		expect(f.sdk).toHaveBeenCalledTimes(1);
		expect(f.receipt.fail).toHaveBeenCalledWith("the chat became busy before the card could go");
		finish.open();
		await native;
	});

	it.each(["ask removed", "routing off", "new ask held"])("%s during SDK prework starts no card turn", async () => {
		const entering = gate();
		const finish = gate();
		let current = true;
		let runs = 0;
		const f = promptFixture(
			() => "[Owner question] fixed fixture",
			() => current,
		);
		f.sdk.mockImplementation(async (_text, opts) => {
			entering.open();
			await finish.ready;
			f.session._pendingNextTurnMessages = [];
			f.session._preparePromptAndToolLoadout();
			opts.preflightResult("started");
			runs++;
		});
		installPromptStartGuard(f.session as never);
		const run = f.run();
		f.admission.open();
		await entering.ready;
		current = false;
		finish.open();
		await run;
		expect(runs).toBe(0);
		expect(f.receipt.fail).toHaveBeenCalledWith("the card changed before the chat took it");
		expect(f.host.emit).not.toHaveBeenCalled();
	});
});

describe("COO delivery reuses the native role adapter", () => {
	it("a busy chat is retried outside the adapter without attachment or composition", async () => {
		const compose = vi.fn(() => "fixed fixture");
		const attach = vi.fn();
		const host = {
			roleMessagesChain: (f: () => unknown) => f(),
			quiesced: false,
			queueChatState: () => ({ state: "working" }),
			attach,
		};
		const result = await serviceCall<Promise<{ ok: boolean; busy?: boolean }>>(host, "sendRoleMessage", fixtures.home, {
			compose,
			current: () => true,
		});
		expect(result).toMatchObject({ ok: false, busy: true });
		expect(compose).not.toHaveBeenCalled();
		expect(attach).not.toHaveBeenCalled();
	});

	it("a closed chat opens first; it receives extension attribution, never owner attribution", async () => {
		const opening = gate();
		const entered = gate();
		let ack!: (r: { ok: boolean }) => void;
		const receipt = new Promise<{ ok: boolean }>((r) => {
			ack = r;
		});
		const compose = vi.fn(() => undefined);
		let how: Record<string, unknown> | undefined;
		const host = {
			switchSession: async () => {
				entered.open();
				await opening.ready;
			},
			conversationIdBySessionFile: () => "fixture",
			convs: new Map([["fixture", { session: {}, listed: false }]]),
			activeId: "fixture",
			prompt: async (
				_text: string,
				_images: unknown,
				_queue: boolean,
				_ack: string,
				input: Record<string, unknown>,
			) => {
				how = input;
				(input.lateText as () => string | undefined)();
				ack({ ok: true });
			},
		};
		const result = clientCall<Promise<{ ok: boolean }>>(
			host,
			"deliverRoleMessage",
			fixtures.home,
			{ compose, current: () => true },
			"fixture-ack",
			receipt,
			{ cause: "role", sendId: "oqc-fixture" },
		);
		await entered.ready;
		expect(compose).not.toHaveBeenCalled();
		opening.open();
		expect(await result).toEqual({ ok: true });
		expect(how).toMatchObject({ source: "extension", cause: "role", sendId: "oqc-fixture" });
		expect(how).not.toHaveProperty("ownerChannel");
		expect(how).not.toHaveProperty("forOwner");
	});

	it("a lazy admission beyond the ordinary timeout remains one outstanding delivery", async () => {
		vi.useFakeTimers();
		const entered = gate();
		const finish = gate();
		let ack!: (result: { ok: boolean }) => void;
		const receipt = new Promise<{ ok: boolean }>((resolve) => {
			ack = resolve;
		});
		const compose = vi.fn(() => undefined);
		const host = {
			switchSession: async () => {},
			conversationIdBySessionFile: () => "fixture",
			convs: new Map([["fixture", { session: {}, listed: false }]]),
			activeId: "fixture",
			prompt: async (_t: string, _a: unknown, _q: boolean, _id: string, input: { lateText(): unknown }) => {
				entered.open();
				await finish.ready;
				input.lateText();
				ack({ ok: true });
			},
		};
		let completed = false;
		const run = clientCall<Promise<{ ok: boolean }>>(
			host,
			"deliverRoleMessage",
			fixtures.home,
			{ compose, current: () => true },
			"fixture",
			receipt,
			{},
		).then((result) => {
			completed = true;
			return result;
		});
		await entered.ready;
		await vi.advanceTimersByTimeAsync(180_000);
		expect(completed).toBe(false);
		expect(compose).not.toHaveBeenCalled();
		finish.open();
		expect(await run).toEqual({ ok: true });
		expect(compose).toHaveBeenCalledTimes(1);
	});

	it("turn-end release works without any plugin reply listener; another home does not settle it", () => {
		const settle = vi.fn();
		const service = { cooDesk: { turnSettled: settle }, onRoleReply: undefined };
		const rec = newTurnRecord();
		rec.ids.push("oqc-fixture");
		serviceCall(service, "roleTurnSettled", "/fixture/other.jsonl", rec);
		expect(settle).not.toHaveBeenCalled();
		serviceCall(service, "roleTurnSettled", fixtures.home, rec);
		expect(settle).toHaveBeenCalledWith(["oqc-fixture"]);
	});
});

describe("COO tool native registration and authority", () => {
	it("only registered for the home file; stale ownership, another file and subagents are refused", async () => {
		const session = { sessionFile: fixtures.home };
		const conv = { session, isSubagent: false };
		let owned = true;
		const host = {
			findConversationHome: () =>
				owned ? { session: { convs: new Map([["fixture", conv]]) }, convId: "fixture" } : undefined,
		};
		const anchor = { session };
		const tools = clientCall<ToolDefinition[]>(host, "ownerQuestionTools", fixtures.home, anchor);
		expect(tools.map((t) => t.name)).toEqual(["owner_question"]);
		expect(clientCall(host, "ownerQuestionTools", "/fixture/other.jsonl", anchor)).toEqual([]);
		const result = async () =>
			(await tools[0]!.execute("fixture", { action: "list" }, undefined, undefined, {} as never)).content;
		expect(await result()).toEqual([{ type: "text", text: ROUTING_OFF }]);
		session.sessionFile = "/fixture/other.jsonl";
		expect(await result()).toEqual([{ type: "text", text: ONLY_IN_COO_HOME }]);
		session.sessionFile = fixtures.home;
		conv.isSubagent = true;
		expect(await result()).toEqual([{ type: "text", text: ONLY_IN_COO_HOME }]);
		conv.isSubagent = false;
		owned = false;
		expect(await result()).toEqual([{ type: "text", text: ONLY_IN_COO_HOME }]);
	});
});
