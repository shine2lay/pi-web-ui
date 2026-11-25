// QA #244 F1 (Ops #1091): a window may answer, cancel or keep for later only a question it was shown. The bell's own
// commands were guarded (WQ-2); the older `question_answer` (answer or cancel, here or for another window with
// `owner`) and `question_later` were not: from Wai's window, Shine's or a COO-held ask id went through (QA's
// qa_bell_ws.mjs T1.9-T1.11b). Each forged command here must change nothing: the card stays, untucked, 0 wakes, 0
// answered events (so 0 decision records). RED on a7a716b6. Harness: tests/fixtures/owner-bell-windows.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { type Ask, type AskEvent, askHub } from "../../server/asks.js";
import { OWNER_QUESTION_HOLDS_FILE, OwnerQuestionHolds } from "../../server/owner-question-holds.js";
import { OwnerQuestionRouter } from "../../server/owner-question-router.js";
import type { OwnerViewer } from "../../server/owner-requester.js";
import { PendingQuestionsStore, type QuestionWake } from "../../server/pending-questions-store.js";
import { asAnswerer, PeopleBook, serveOwners, tailscaleSenderOf } from "../../server/sent-by.js";
import {
	asker,
	chat,
	DNS,
	type FakeChat,
	NAME,
	PORT,
	SHINE_SENT,
	statics,
	turn,
	turns,
	WAI_SENT,
	type Win,
	win as winOf,
} from "../fixtures/owner-bell-windows.js";

let dir = "";
let viewers: { shine: OwnerViewer; wai: OwnerViewer };
let events: AskEvent[] = [];
let wakes: QuestionWake[] = [];
let store: PendingQuestionsStore;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "waiting-questions-bell-guard-"));
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	const book = serveOwners(new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console));
	const login = (l: string) => tailscaleSenderOf({ "tailscale-user-login": l, "tailscale-user-name": l });
	viewers = { shine: book.viewerOf(login("aungshine@gmail.com")), wai: book.viewerOf(login("sayswai@gmail.com")) };
	events = [];
	wakes = [];
	cleanups.push(askHub.observe((ev) => events.push(ev)));
	store = PendingQuestionsStore.inDataDir(join(dir, "data"));
	statics.pendingQuestionsHost = {
		store,
		deliver: async (wake) => {
			wakes.push(structuredClone(wake));
			return { ok: true };
		},
	};
	const router = new OwnerQuestionRouter({
		enabled: () => true,
		hub: askHub,
		holds: () => new OwnerQuestionHolds(join(dir, OWNER_QUESTION_HOLDS_FILE)),
	});
	ClientSession.ownerQuestions = router;
	cleanups.push(
		askHub.observe((ev) => ClientSession.ownerAskRouted(ev)),
		() => router.dispose(),
	);
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	statics.sharedQuestions.clear();
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
	statics.pendingQuestionsHost = null;
	ClientSession.ownerQuestions = null;
	rmSync(dir, { recursive: true, force: true });
});

const askOf = (questionId: string): Ask =>
	[...askHub.list(), ...askHub.heldList()].find((a) => a.fields.some((f) => f.id === questionId))!;
const ended = () => events.filter((e) => e.type === "answered" || e.type === "gone").map((e) => e.ask.id);
const tucked = (id: string) => (statics.sharedQuestions.get(id) as { later?: boolean } | undefined)?.later === true;

/** Shine's chat with Shine's question, Wai's chat with hers, COO's chat with a question held for COO; one window of
 *  each owner, each showing its owner's chat (a held card shows only in its own chat's window, #685). */
async function world() {
	const [mine, hers, coo] = [chat(dir, "shine-chat"), chat(dir, "wai-chat"), chat(dir, "coo")];
	const convs = new Map<string, FakeChat>([mine, hers, coo].map((c) => [c.id, c]));
	const at = (convId: string) => ({ activeId: { value: convId, writable: true } });
	const shine = winOf(convs, viewers.shine, (undo) => cleanups.push(undo), at(mine.id));
	const wai = winOf(convs, viewers.wai, (undo) => cleanups.push(undo), at(hers.id));
	turn(mine, SHINE_SENT);
	turn(hers, WAI_SENT);
	turn(coo);
	await asker(shine, mine)("toolu_s", [PORT]);
	await asker(shine, hers)("toolu_w", [DNS]);
	await asker(shine, coo)("toolu_c", [NAME]);
	const ids = { shine: askOf("port").id, wai: askOf("dns").id, held: askOf("name").id };
	expect(askOf("dns").requester).toBe("Wai");
	expect(askHub.heldList().map((a) => a.id)).toEqual([ids.held]);
	return { shine, wai, coo, ids };
}

/** `question_answer` with `owner`: AgentService hands it from window `from` to window `holder`. */
function answerElsewhere(from: Win, holder: Win, id: string, answers: unknown[], cancelled?: boolean) {
	const clients = new Map([
		["from", from.client],
		["holder", holder.client],
	]);
	return AgentService.prototype.answerElsewhereQuestion.call(
		{ clients } as unknown as AgentService,
		"from",
		"holder",
		id,
		answers as never,
		cancelled,
	);
}

/** Nothing changed: every card still waits, none tucked away, 0 wakes, 0 answered or gone events. */
function untouched(ids: Record<string, string>) {
	for (const id of Object.values(ids)) expect(statics.sharedQuestions.has(id), id).toBe(true);
	expect(Object.values(ids).filter(tucked)).toEqual([]);
	expect(store.waiting().filter((r) => r.later)).toEqual([]);
	expect(wakes).toEqual([]);
	expect(ended()).toEqual([]);
}

describe("QA #244 F1: forged question_answer / question_later from a window never shown the question", () => {
	it("T1.9: question_later from Wai's window on Shine's ask (and Shine's on Wai's): refused", async () => {
		const { shine, wai, ids } = await world();
		expect(asAnswerer("Wai", () => wai.client.questionLater(ids.shine, true))).toBe(false);
		expect(asAnswerer("Shine", () => shine.client.questionLater(ids.wai, true))).toBe(false);
		expect(wai.client.questionLater(ids.held, true)).toBe(false);
		await turns();
		untouched(ids);
	});

	it("T1.10: Cancel from Wai's window on the COO-held ask, and from Shine's window not showing COO's chat: refused", async () => {
		const { shine, wai, ids } = await world();
		await asAnswerer("Wai", () => wai.client.answerQuestion(ids.held, [], true));
		await asAnswerer("Shine", () => shine.client.answerQuestion(ids.held, [], true));
		await asAnswerer("Wai", () => answerElsewhere(wai, shine, ids.held, [], true));
		await turns();
		untouched(ids);
	});

	it("T1.11: Cancel from Wai's window on Shine's ask, here or handed to Shine's window: refused, with a notice", async () => {
		const { shine, wai, ids } = await world();
		await asAnswerer("Wai", () => wai.client.answerQuestion(ids.shine, [], true));
		await asAnswerer("Wai", () => answerElsewhere(wai, shine, ids.shine, [], true));
		await asAnswerer("Shine", () => answerElsewhere(shine, wai, ids.wai, [], true));
		await turns();
		untouched(ids);
		expect(wai.sent.some((m) => m.type === "notice" && /question is gone/.test(m.text))).toBe(true);
	});

	it("T1.11b: an answer (not a cancel) from Wai's window on Shine's ask, here or handed on: refused, 0 decisions", async () => {
		const { shine, wai, ids } = await world();
		const pick = [{ id: "port", selected: ["8080"] }];
		await asAnswerer("Wai", () => wai.client.answerQuestion(ids.shine, pick as never));
		await asAnswerer("Wai", () => answerElsewhere(wai, shine, ids.shine, pick, false));
		await asAnswerer("Shine", () => shine.client.answerQuestion(ids.wai, [{ id: "dns", selected: ["Yes"] }] as never));
		await turns();
		untouched(ids);
	});

	it("each owner's own window still answers, cancels and keeps for later its own; the held one in COO's chat window", async () => {
		const { shine, wai, coo, ids } = await world();
		expect(shine.client.questionLater(ids.shine, true)).toBe(true);
		expect(tucked(ids.shine)).toBe(true);
		await asAnswerer("Wai", () => answerElsewhere(wai, shine, ids.wai, [{ id: "dns", selected: ["Yes"] }]));
		await turns();
		expect(wakes.map((w) => [w.conversationId, w.sentBy?.name])).toEqual([["conv-wai-chat", "Wai"]]);
		await asAnswerer("Shine", () => shine.client.answerQuestion(ids.shine, [], true));
		const cooWin = winOf(new Map([[coo.id, coo]]), viewers.shine, (undo) => cleanups.push(undo), {
			activeId: { value: coo.id },
		});
		await asAnswerer("Shine", () =>
			cooWin.client.answerQuestion(ids.held, [{ id: "name", selected: ["bell"] }] as never),
		);
		await turns();
		expect(wakes.map((w) => w.conversationId)).toEqual(["conv-wai-chat", "conv-shine-chat", "conv-coo"]);
		expect(statics.sharedQuestions.size).toBe(0);
	});
});
