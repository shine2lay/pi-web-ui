// owner-input-mark (Ops #945, OpenViking v2 V-8): each owner text the server admits gets one lasting
// `pi-web-ui/owner-input` entry naming its user message entry; nothing else gets one.
// The real ClientSession admission (promptInLine -> pi's preflight -> noteTurnCause) and the real
// onEvent hook, with a fake pi run that emits message_end and then persists the message the way
// AgentSession._handleAgentEvent does, into a real pi SessionManager in a temporary folder.
// No server, model or real chat.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import {
	OWNER_INPUT_MARK,
	ownerInputMarkOf,
	ownerInputMarksIn,
	ownerTextSha256,
	OwnerInputsWaiting,
} from "../../server/owner-input-mark.js";
import { AdmittedTexts, userMessageText } from "../../server/admitted-texts.js";
import { requesterForAdmission } from "../../server/queue-requester.js";

vi.mock("../../server/workspace-snapshot.js", () => ({
	createWorkspaceSnapshot: vi.fn(async () => null),
	restoreWorkspaceSnapshot: vi.fn(),
}));

const clientCall = <T>(target: object, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).apply(target, args);

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owner-input-mark-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistantMessage = () => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "anthropic-messages",
	provider: "fixture",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

type Opts = Parameters<typeof requesterForAdmission>[0];
const OWNER_BROWSER: Omit<Opts, "inputId"> = { cause: "browser", ownerChannel: "browser" };
const OWNER_TELEGRAM: Omit<Opts, "inputId"> = {
	source: "extension",
	cause: "telegram",
	ownerChannel: "telegram",
	sendId: "rs-0000aaaa-1111",
};
const NOT_OWNER: Record<string, Omit<Opts, "inputId">> = {
	"a role message": {
		source: "extension",
		cause: "role",
		requester: { kind: "role", role: "architecture", id: "rm-0000aaaa", message: "request" },
	},
	"a role's answer for the owner": {
		source: "extension",
		cause: "role",
		ownerChannel: "telegram",
		requester: { kind: "role", role: "ops", id: "rm-0000bbbb", message: "reply", forOwner: true },
	},
	"a queue or extension text": { source: "extension", cause: "plugin" },
	"a script notice": { source: "extension", cause: "role" },
	"a carry-on note": { cause: "other" },
	"an add-on claiming the browser without the owner's cause": {
		source: "extension",
		cause: "plugin",
		ownerChannel: "browser",
	},
};

/** One chat with a real SessionManager and a fake pi run (message_end, then persist, as pi does). */
function chatFixture() {
	const sm = SessionManager.create(dir, dir);
	const queued: string[] = [];
	const session = {
		isStreaming: false,
		isCompacting: false,
		sessionManager: sm,
		sessionId: sm.getSessionId(),
		agent: { state: { messages: [] as unknown[] } },
		sendCustomMessage: vi.fn(),
		getSteeringMessages: () => [...queued],
		getFollowUpMessages: () => [] as string[],
		prompt: vi.fn(async (text: string, options: { preflightResult(d: "started" | "queued" | "handled"): void }) => {
			if (session.isStreaming) {
				queued.push(text);
				options.preflightResult("queued");
				return;
			}
			options.preflightResult("started");
			deliver(text);
		}),
	};
	const conv: Record<string, unknown> = { id: "fixture", title: "Fixture", cwd: dir, session, isSubagent: false };
	const host = {
		convs: new Map([[conv.id, conv]]),
		activeId: conv.id,
		session,
		cwd: dir,
		clientId: "fixture-window",
		settingsSvc: { current: { parallelReminderEnabled: false } },
		drafts: { clear: () => {} },
		markRecentSeen: () => {},
		quiesceBlocked: () => false,
		activeSessionFileResolved: () => undefined,
		flushSnapshot: () => {},
		flushConvSnapshots: () => {},
		emit: () => {},
		getLang: () => "en",
		eventErrorLoggedAt: new Map(),
		onEventNow: () => {},
	};
	/** pi's AgentSession: listeners see message_end, then the message is appended to the transcript. */
	function deliver(text: string, message: Record<string, unknown> = userMessage(text)): void {
		clientCall(host, "onEvent", conv, { type: "message_end", message });
		sm.appendMessage(message as never);
	}
	/** A queued text reaches the run (pi's steering queue). */
	function deliverQueued(): void {
		const text = queued.shift();
		if (text !== undefined) deliver(text);
	}
	function endRun(): void {
		clientCall(host, "onEvent", conv, { type: "agent_end", messages: [] });
	}
	async function send(text: string, opts: Omit<Opts, "inputId">): Promise<void> {
		const flow = {
			requester: requesterForAdmission({ ...opts, inputId: "ri-00000000-0000-4000-8000-000000000001" }),
			...(opts.source ? { source: opts.source } : {}),
			cause: opts.cause ?? "other",
			deferred: false,
			handedOver: false,
			admission: { ready: Promise.resolve(), release: () => {} },
		};
		const receipt = { ok: vi.fn(), fail: vi.fn() };
		await clientCall<Promise<void>>(host, "promptInLine", conv, receipt, flow, text, undefined, false);
		expect(receipt.fail).not.toHaveBeenCalled();
		await settle();
	}
	const marks = () => ownerInputMarksIn(sm.getEntries());
	const userEntryId = (text: string) =>
		sm.getEntries().find((e) => e.type === "message" && userMessageText((e as { message: unknown }).message) === text)
			?.id;
	return { sm, session, conv, send, deliver, deliverQueued, endRun, marks, userEntryId };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("owner-input mark: admission writes it", () => {
	it("the owner's text from a browser page gets one mark naming its entry", async () => {
		const f = chatFixture();
		await f.send("always run the smoke test", OWNER_BROWSER);
		const id = f.userEntryId("always run the smoke test");
		expect(id).toBeTruthy();
		const marks = f.marks();
		expect([...marks.keys()]).toEqual([id]);
		expect(marks.get(id!)).toMatchObject({
			v: 1,
			entryId: id,
			channel: "browser",
			textSha256: ownerTextSha256("always run the smoke test"),
		});
		expect(marks.get(id!)!.at).toBeGreaterThan(0);
		const custom = f.sm.getEntries().filter((e) => e.type === "custom");
		expect(custom).toHaveLength(1);
		expect((custom[0] as { customType: string }).customType).toBe(OWNER_INPUT_MARK);
	});

	it("the owner's text from Telegram gets one mark with channel telegram", async () => {
		const f = chatFixture();
		await f.send("ship it tonight", OWNER_TELEGRAM);
		const id = f.userEntryId("ship it tonight");
		expect(f.marks().get(id!)).toMatchObject({ entryId: id, channel: "telegram" });
		expect(f.marks().size).toBe(1);
	});

	it.each(Object.entries(NOT_OWNER))("%s gets no mark", async (_name, opts) => {
		const f = chatFixture();
		await f.send("always run the smoke test", opts);
		expect(f.userEntryId("always run the smoke test")).toBeTruthy();
		expect(f.marks().size).toBe(0);
		expect(f.sm.getEntries().filter((e) => e.type === "custom")).toHaveLength(0);
	});

	it("a text joined to a running turn is marked on its own entry when it arrives, not on the one before", async () => {
		const f = chatFixture();
		await f.send("first, from a role", NOT_OWNER["a role message"]!);
		f.session.isStreaming = true;
		await f.send("and then stop the deploy", OWNER_BROWSER);
		expect(f.marks().size).toBe(0);
		// The run goes on: an add-on's own user message comes first, then his queued text.
		f.deliver("an add-on's own message");
		await settle();
		expect(f.marks().size).toBe(0);
		f.deliverQueued();
		await settle();
		const id = f.userEntryId("and then stop the deploy");
		expect([...f.marks().keys()]).toEqual([id]);
	});

	it("a text an add-on rewrote before it was stored is not marked (the stored words aren't his)", async () => {
		const f = chatFixture();
		f.session.isStreaming = true;
		await f.send("remove it", OWNER_BROWSER);
		f.session.isStreaming = false;
		f.deliver("remove it", userMessage("Task #7 was removed from the queue."));
		await settle();
		expect(f.marks().size).toBe(0);
	});

	it("a queued text that never arrives is forgotten when the run ends; a later same text from elsewhere isn't marked", async () => {
		const f = chatFixture();
		f.session.isStreaming = true;
		await f.send("yes", OWNER_BROWSER);
		f.session.getSteeringMessages = () => []; // he removed it from the queue
		f.endRun();
		f.session.isStreaming = false;
		await f.send("yes", NOT_OWNER["a queue or extension text"]!);
		expect(f.marks().size).toBe(0);
	});

	it("the mark survives reopening the session file, and is not in the model's context", async () => {
		const f = chatFixture();
		await f.send("keep the fold under a second", OWNER_BROWSER);
		f.sm.appendMessage(assistantMessage() as never); // pi writes the file once a reply exists
		const file = f.sm.getSessionFile()!;
		const reopened = SessionManager.open(file);
		const id = f.userEntryId("keep the fold under a second");
		expect(ownerInputMarksIn(reopened.getEntries()).get(id!)).toMatchObject({ entryId: id, channel: "browser" });
		const context = JSON.stringify(reopened.buildSessionContext().messages);
		expect(context).not.toContain(OWNER_INPUT_MARK);
		expect(context).not.toContain(ownerTextSha256("keep the fold under a second"));
	});

	it("two identical owner texts get one mark each, on their own entries", async () => {
		const f = chatFixture();
		await f.send("go", OWNER_BROWSER);
		await f.send("go", OWNER_BROWSER);
		const ids = f.sm
			.getEntries()
			.filter((e) => e.type === "message")
			.map((e) => e.id);
		expect(ids).toHaveLength(2);
		expect([...f.marks().keys()].sort()).toEqual([...ids].sort());
	});
});

describe("owner-input mark: shape", () => {
	it("text of a user message: string content or text parts joined by a newline; other roles have none", () => {
		expect(userMessageText({ role: "user", content: "hi" })).toBe("hi");
		expect(
			userMessageText({
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "x" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
		expect(userMessageText({ role: "assistant", content: "hi" })).toBeUndefined();
		expect(userMessageText({ role: "custom", content: "hi" })).toBeUndefined();
	});

	it("parity vector shared with pi-openviking owner-provenance tests: NFC before sha256", () => {
		// Same vector in pi-openviking tests/v2-owner-entry-source.test.ts: change both or neither.
		expect(ownerTextSha256("cafe\u0301 stays closed")).toBe(ownerTextSha256("caf\u00e9 stays closed"));
		expect(ownerTextSha256("caf\u00e9 stays closed")).toBe(
			"3b53967b42a8cd79ef88d02e12db22dd12568c236fc4275242ad842fb2e3d77c",
		);
	});

	it("a malformed mark is not a mark", () => {
		const good = { v: 1, entryId: "a1b2c3d4", at: 1, channel: "browser", textSha256: "0".repeat(64) };
		expect(ownerInputMarkOf(good)).toEqual(good);
		for (const bad of [
			{ ...good, v: 2 },
			{ ...good, channel: "role" },
			{ ...good, entryId: "../x" },
			{ ...good, textSha256: "abc" },
			{ ...good, at: 0 },
			null,
			[],
		])
			expect(ownerInputMarkOf(bad)).toBeUndefined();
	});

	it("waiting texts are capped and a run's end keeps only what is still queued (each once)", () => {
		const w = new OwnerInputsWaiting();
		for (let i = 0; i < 40; i++) w.admitted({ text: `t${i}`, channel: "browser", at: 1 });
		expect(w.size).toBe(32);
		w.keepOnly(["t39", "t38", "t38"]);
		expect(w.size).toBe(2);
		expect(w.take(userMessage("t0"))).toBeUndefined();
		expect(w.take(userMessage("t39"))).toMatchObject({ text: "t39" });
	});

	it("one queued copy keeps only one of several identical waiting texts", () => {
		// QA #183 F12: AdmittedTexts is shared by owner-input-mark and sent-by
		const w = new AdmittedTexts<{ text: string }>();
		w.admitted({ text: "ok" });
		w.admitted({ text: "ok" });
		w.keepOnly(["ok"]);
		expect(w.size).toBe(1);
	});
});
