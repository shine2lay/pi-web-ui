// nonblocking-ask (Ops #1086; Shine 2026-11-24, dr-36efc6499afe): the durable list of waiting ask_user_question cards
// and the texts the asking chat gets. Real files in a temporary folder; no ClientSession, socket or model.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { turnOwnersOf } from "../../server/ask-question-owners.js";
import { questionReturnedText } from "../../server/owner-question-router.js";
import {
	formatPostedQuestionsResult,
	formatQuestionWakeMessage,
	type NewPendingQuestion,
	PENDING_QUESTIONS_FILE,
	PendingQuestionConflictError,
	type PendingQuestionDelivering,
	PendingQuestionsFileError,
	PendingQuestionsStore,
	pendingQuestionHash,
	questionWakeOf,
	wakeInputId,
} from "../../server/pending-questions-store.js";
import type { UiQuestion } from "../../server/protocol.js";
import { requesterInputOf } from "../../server/queue-requester.js";

const T0 = Date.parse("2026-11-24T18:00:00Z");
const PORT: UiQuestion = {
	id: "port",
	header: "Port",
	question: "Which port?",
	options: [{ label: "8080" }, { label: "9090" }],
};
const DNS: UiQuestion = { id: "dns", question: "Create the address?", options: [{ label: "Yes" }, { label: "No" }] };

let dir = "";
let file = "";
let clock = T0;
const store = () => new PendingQuestionsStore(file, () => clock);
const card = (over: Partial<NewPendingQuestion> = {}): NewPendingQuestion => ({
	id: "toolu_1",
	askId: "q-1",
	toolCallId: "toolu_1",
	conversationId: "conv-coo",
	sessionFile: join(dir, "coo.jsonl"),
	conversationTitle: "COO lead",
	owner: "Shine",
	questions: [PORT],
	createdAt: T0,
	...over,
});
const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { v: number; records: { id: string; state: string }[] };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pending-questions-"));
	file = join(dir, "data", PENDING_QUESTIONS_FILE);
	clock = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PendingQuestionsStore: keeping cards (rule 30)", () => {
	it("a posted card is kept as waiting in a 0600 file, written whole, with no temp file left", () => {
		const s = store();
		const out = s.post(card());
		expect(out.created).toBe(true);
		expect(out.record).toMatchObject({ id: "toolu_1", askId: "q-1", state: "waiting", owner: "Shine" });
		expect(out.record.contentHash).toBe(pendingQuestionHash(card()));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(onDisk()).toMatchObject({ v: 1, records: [{ id: "toolu_1", state: "waiting" }] });
		expect(readdirSync(join(dir, "data"))).toEqual([PENDING_QUESTIONS_FILE]);
	});

	it("the same card again changes nothing and hands back the kept one, even with a new ask id, title or time", () => {
		const s = store();
		s.post(card());
		const before = readFileSync(file, "utf8");
		const again = s.post(card({ askId: "q-9", conversationTitle: "renamed", createdAt: T0 + 5 }));
		expect(again).toEqual({ created: false, record: expect.objectContaining({ askId: "q-1", createdAt: T0 }) });
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(s.list()).toHaveLength(1);
	});

	it("the same id with other content is refused loudly and nothing is written", () => {
		const s = store();
		s.post(card());
		const before = readFileSync(file, "utf8");
		expect(() => s.post(card({ questions: [DNS] }))).toThrow(PendingQuestionConflictError);
		expect(() => s.post(card({ owner: "Wai", requester: "Wai" }))).toThrow(/already kept with other content/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("a malformed card is refused before anything is written", () => {
		const s = store();
		expect(() => s.post(card({ id: "" }))).toThrow(/id missing/);
		expect(() => s.post(card({ questions: [] }))).toThrow(/no questions/);
		expect(() => s.post(card({ createdAt: Number.NaN }))).toThrow(/createdAt/);
		expect(existsSync(file)).toBe(false);
	});

	it("waiting -> delivering (recorded with the resolution) -> admitted (gone); the first settle wins", () => {
		const s = store();
		s.post(card());
		clock = T0 + 60_000;
		const answered = {
			kind: "answered" as const,
			answers: [{ id: "port", selected: ["8080"] }],
			summary: "8080",
			from: "browser",
		};
		const settled = s.settle("toolu_1", answered);
		expect(settled).toMatchObject({
			ok: true,
			record: { state: "delivering", resolution: answered, settledAt: T0 + 60_000 },
		});
		expect(onDisk().records).toMatchObject([{ id: "toolu_1", state: "delivering" }]);
		expect(s.settle("toolu_1", { kind: "cancelled", from: "browser" })).toMatchObject({
			ok: false,
			reason: "already settled",
			record: { resolution: answered },
		});
		expect(s.drop("toolu_1")).toBe(false); // its answer still reaches the chat
		expect(s.admitted("toolu_1")).toBe(true);
		expect(s.admitted("toolu_1")).toBe(false);
		expect(onDisk().records).toEqual([]);
		expect(s.settle("toolu_1", answered)).toEqual({ ok: false, reason: "not kept" });
	});

	it("drop ends a waiting card with no delivery; admitted refuses a card nobody settled", () => {
		const s = store();
		s.post(card());
		expect(s.admitted("toolu_1")).toBe(false);
		expect(s.drop("toolu_1")).toBe(true);
		expect(s.list()).toEqual([]);
		expect(s.drop("toolu_1")).toBe(false);
	});

	it("a malformed resolution is refused and the card stays waiting", () => {
		const s = store();
		s.post(card());
		expect(() => s.settle("toolu_1", { kind: "returned", note: "  " })).toThrow(/note missing/);
		expect(() => s.settle("toolu_1", { kind: "answered", answers: [], summary: "", from: "" })).toThrow(/from missing/);
		expect(s.get("toolu_1")?.state).toBe("waiting");
	});

	it("a restart reads the same cards back: waiting and delivering, oldest first, found by ask id", () => {
		const s = store();
		s.post(
			card({
				id: "toolu_2#Wai",
				toolCallId: "toolu_2#Wai",
				askId: "q-2",
				owner: "Wai",
				requester: "Wai",
				createdAt: T0 + 1,
			}),
		);
		s.post(card());
		s.settle("toolu_1", { kind: "returned", note: "Use the plan's port" });
		const after = store();
		expect(after.list().map((r) => [r.id, r.state])).toEqual([
			["toolu_1", "delivering"],
			["toolu_2#Wai", "waiting"],
		]);
		expect(after.waiting().map((r) => r.id)).toEqual(["toolu_2#Wai"]);
		expect(after.delivering().map((r) => r.id)).toEqual(["toolu_1"]);
		expect(after.byAskId("q-2")?.owner).toBe("Wai");
	});

	it("a crash's leftover temp file is ignored; a file that isn't the list is refused, never overwritten", () => {
		store().post(card());
		writeFileSync(`${file}.12345.tmp`, "{half");
		expect(store().list()).toHaveLength(1);
		writeFileSync(file, "{not json");
		expect(() => store().list()).toThrow(PendingQuestionsFileError);
		expect(() => store().post(card({ id: "toolu_3", toolCallId: "toolu_3" }))).toThrow(/not JSON/);
		expect(readFileSync(file, "utf8")).toBe("{not json");
		writeFileSync(file, JSON.stringify({ v: 1, records: [{ id: "x" }] }));
		expect(() => store().list()).toThrow(/record 0: askId missing/);
		const twice = { ...card(), state: "waiting", contentHash: "h" };
		writeFileSync(file, JSON.stringify({ v: 1, records: [twice, twice] }));
		expect(() => store().list()).toThrow(/id toolu_1 twice/);
		expect(store().file).toBe(PendingQuestionsStore.inDataDir(join(dir, "data")).file);
	});
});

describe("what the model reads", () => {
	it("the tool's result says the cards are up, not to ask again or wait, and carries no answers", () => {
		const r = formatPostedQuestionsResult([
			{ owner: "Shine", toolCallId: "toolu_1#Shine", questions: [PORT] },
			{ owner: "Wai", toolCallId: "toolu_1#Wai", questions: [DNS] },
		]);
		const text = r.content[0]!.text;
		expect(text).toContain("Posted 2 question cards without waiting (non-blocking); nothing is answered yet.");
		expect(text).toContain("For Shine (decision ref ask:toolu_1#Shine):\n- Port");
		expect(text).toContain("For Wai (decision ref ask:toolu_1#Wai):\n- Create the address?");
		expect(text).toMatch(/Do NOT ask these again and do NOT wait for them\..*end your turn now\./su);
		expect(text).toContain("Each owner's answer will arrive later as a new message in this chat.");
		expect(r.details).not.toHaveProperty("answers");
		expect(r.details.posted).toEqual([
			{ owner: "Shine", toolCallId: "toolu_1#Shine", questionIds: ["port"] },
			{ owner: "Wai", toolCallId: "toolu_1#Wai", questionIds: ["dns"] },
		]);
		expect(() => formatPostedQuestionsResult([])).toThrow();
	});

	const delivering = (resolution: PendingQuestionDelivering["resolution"], over: Partial<NewPendingQuestion> = {}) => {
		const s = store();
		s.post(card({ questions: [PORT, DNS], ...over }));
		const out = s.settle(over.id ?? "toolu_1", resolution);
		if (!out.ok) throw new Error(out.reason);
		return out.record;
	};

	it("an answer: who, where, its decision ref, and each question's picks and typed text", () => {
		const rec = delivering({
			kind: "answered",
			answers: [
				{ id: "port", selected: ["8080"], custom: " behind the proxy " },
				{ id: "dns", selected: [] },
			],
			summary: "8080; (none)",
			from: "browser",
		});
		expect(formatQuestionWakeMessage(rec)).toBe(
			[
				'Shine answered your question "Port" in the browser (decision ref ask:toolu_1):',
				"- Port: 8080 (wrote: behind the proxy)",
				"- Create the address?: (no selection)",
			].join("\n"),
		);
		const tg = delivering(
			{
				kind: "answered",
				answers: [{ id: "port", selected: ["9090"] }],
				summary: "9090",
				from: "telegram",
				decisionRef: "ask:x",
			},
			{ id: "toolu_2", toolCallId: "toolu_2" },
		);
		expect(formatQuestionWakeMessage(tg)).toContain(
			'Shine answered your question "Port" on telegram (decision ref ask:x):',
		);
	});

	it("a cancel and COO's hand-back", () => {
		const cancelled = delivering({ kind: "cancelled", from: "browser" });
		expect(formatQuestionWakeMessage(cancelled)).toBe(
			'Cancelled prompt "Port" — continue without re-asking immediately (Shine cancelled it in the browser).',
		);
		const returned = delivering(
			{ kind: "returned", note: "Use the port the plan names" },
			{ id: "t3", toolCallId: "t3" },
		);
		expect(formatQuestionWakeMessage(returned)).toContain(questionReturnedText("Use the port the plan names"));
	});

	it("the wake comes from the card's owner on the channel he answered on, with a stable valid input id", () => {
		const wai = delivering(
			{ kind: "answered", answers: [{ id: "port", selected: ["8080"] }], summary: "8080", from: "browser", by: "Wai" },
			{ id: "toolu_1#Wai", toolCallId: "toolu_1#Wai", owner: "Wai", requester: "Wai" },
		);
		const wake = questionWakeOf(wai);
		expect(wake).toMatchObject({
			id: "toolu_1#Wai",
			conversationId: "conv-coo",
			sessionFile: join(dir, "coo.jsonl"),
			cause: "browser",
			ownerChannel: "browser",
			requester: { kind: "owner", channel: "browser", person: "Wai" },
		});
		expect(wake.text).toContain("(decision ref ask:toolu_1#Wai)");
		expect(requesterInputOf(wake.requester)).toEqual(wake.requester);
		expect(turnOwnersOf({ v: 1, inputs: [wake.requester] }, undefined)).toEqual(["Wai"]);
		expect(questionWakeOf(wai).requester.id).toBe(wake.requester.id); // a replay carries the same id
		const tg = questionWakeOf(
			delivering(
				{ kind: "answered", answers: [{ id: "port", selected: ["8080"] }], summary: "8080", from: "telegram" },
				{ id: "t9", toolCallId: "t9" },
			),
		);
		expect(tg).toMatchObject({ cause: "telegram", requester: { channel: "telegram", person: "Shine" } });
		expect(tg.requester.id).toBe(wakeInputId("t9", "telegram"));
		expect(tg.requester.id).toMatch(/^rs-[a-f0-9]{32}$/u);
		expect(requesterInputOf(tg.requester)).toEqual(tg.requester);
	});
});
