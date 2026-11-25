// nonblocking-ask (Ops #1088, QA #243 rm-49dc1076): the owner's answer to ask_user_question reaches its chat once,
// as his message.
// D1: a card stays "delivering" in pending-questions.json until its wake is in the chat's transcript (not just in pi's
//     in-memory queue behind a busy turn), and a start-up replay sends no wake the transcript already holds.
// D2: answered and cancelled cards keep who answered (`sentBy`, rule 37: `[From: <name>]`) for the wake, also after a
//     restart; COO's hand-back is no owner's message.
// The sealed end-to-end proof (restart, crash, Wai, cancel) is tests/question-busy-restart-test.mjs.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PendingQuestionEntry } from "../../server/ask-delivery.js";
import { askHub } from "../../server/asks.js";
import {
	type PendingQuestionDelivering,
	type PendingQuestionsHost,
	PendingQuestionsStore,
	type QuestionResolution,
	type QuestionWake,
	questionWakeOf,
} from "../../server/pending-questions-store.js";
import {
	type QuestionRuntimeHost,
	type RestoreHooks,
	restoreCards,
	settleCard,
} from "../../server/pending-questions-runtime.js";
import { expectWake, questionWakeOnEvent, wakeInTranscript } from "../../server/question-wake-admission.js";
import { asAnswerer, PeopleBook, personSentBy, type SentBy, serveOwners } from "../../server/sent-by.js";

const SHINE: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };
const WAI: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const ANSWERED = (sentBy?: SentBy): QuestionResolution => ({
	kind: "answered",
	answers: [{ id: "port", selected: ["8080"] }],
	summary: "port: 8080",
	from: "browser",
	...(sentBy ? { sentBy } : {}),
});

let dir = "";
let n = 0;
let store: PendingQuestionsStore;
let sent: QuestionWake[] = [];
let admitNow: (() => void) | null = null;
let deliverHow: "admitted" | "later" = "admitted";

const host: PendingQuestionsHost = {
	get store() {
		return store;
	},
	deliver: async (wake) => {
		sent.push(structuredClone(wake));
		if (deliverHow === "admitted") return { ok: true };
		return { ok: true, admitted: new Promise<void>((r) => (admitNow = r)) };
	},
};
const shared = new Map<string, PendingQuestionEntry>();
const runtime: QuestionRuntimeHost = {
	shared,
	store: () => host,
	broadcast: () => {},
	conversationsChanged: () => {},
	snapshotsChanged: () => {},
};
const hooks: RestoreHooks = {
	nextId: () => `ask-${++n}`,
	conversationIdOf: () => undefined,
	onAnswer: () => () => ({ ok: true }),
};
const turns = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** One owner's card, posted and waiting, as ClientSession keeps it. */
function post(owner = "Shine"): { id: string; sessionFile: string } {
	const id = `call-${++n}`;
	const sessionFile = join(dir, `${id}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id })}\n`);
	const questions = [{ id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] }];
	store.post({ id, askId: id, toolCallId: id, sessionFile, owner, questions, createdAt: Date.now() });
	shared.set(id, { questions, askId: id, recordId: id, sessionFile });
	return { id, sessionFile };
}
const delivering = (id: string) => store.get(id) as PendingQuestionDelivering;
/** pi's line for a user message, as it writes it to a transcript. */
const userLine = (text: string, at = new Date()) =>
	`${JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, timestamp: at.toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: at.getTime() } })}\n`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "question-wake-"));
	store = PendingQuestionsStore.inDataDir(join(dir, "data"));
	sent = [];
	admitNow = null;
	deliverHow = "admitted";
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	serveOwners(new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console));
});
afterEach(() => {
	shared.clear();
	for (const a of askHub.list()) askHub.settle(a.id, { how: "gone", reason: "test over" });
	rmSync(dir, { recursive: true, force: true });
});

describe("D1: the card leaves the file only once its wake is in the transcript", () => {
	it("a wake queued behind a busy turn keeps the card delivering on disk until it is admitted", async () => {
		deliverHow = "later";
		const { id } = post();
		expect(
			settleCard(runtime, id, { kind: "answered", answers: [{ id: "port", selected: ["8080"] }], from: "browser" }),
		).toBe(true);
		await turns();
		expect(sent).toHaveLength(1);
		// A restart now reads this file: the answer must still be there.
		expect(PendingQuestionsStore.inDataDir(join(dir, "data")).get(id)?.state).toBe("delivering");
		admitNow!();
		await turns();
		expect(PendingQuestionsStore.inDataDir(join(dir, "data")).get(id)).toBeUndefined();
	});

	it("a delivery already in the transcript (an idle chat, no admitted promise) ends the card at once", async () => {
		const { id } = post();
		settleCard(runtime, id, { kind: "cancelled", from: "browser" });
		await turns();
		expect(store.get(id)).toBeUndefined();
	});

	it("start-up replays a wake the transcript lacks, once", async () => {
		const { id } = post();
		store.settle(id, ANSWERED(SHINE));
		shared.clear();
		const wake = questionWakeOf(delivering(id));
		await restoreCards(runtime, hooks);
		await restoreCards(runtime, hooks); // a second start-up pass in the same process replays nothing
		expect(sent).toEqual([wake]);
		expect(sent[0]!.sentBy).toEqual(SHINE);
		expect(store.get(id)).toBeUndefined();
	});

	it("start-up sends nothing when the last run stopped after writing the wake (0 duplicates)", async () => {
		const { id, sessionFile } = post();
		store.settle(id, ANSWERED(SHINE));
		appendFileSync(sessionFile, userLine(`[From: Shine]\n${questionWakeOf(delivering(id)).text}`));
		shared.clear();
		await restoreCards(runtime, hooks);
		expect(sent).toEqual([]);
		expect(store.get(id)).toBeUndefined();
	});

	it("an older identical wake (a cancel's words repeat) before the card ended does not count", () => {
		const { id, sessionFile } = post();
		appendFileSync(sessionFile, userLine("earlier", new Date(Date.now() - 60_000)));
		store.settle(id, { kind: "cancelled", from: "browser", sentBy: SHINE });
		const text = questionWakeOf(delivering(id)).text;
		appendFileSync(sessionFile, userLine(text, new Date(Date.now() - 60_000)));
		expect(wakeInTranscript(sessionFile, text, delivering(id).settledAt)).toBe(false);
		appendFileSync(sessionFile, userLine(text));
		expect(wakeInTranscript(sessionFile, text, delivering(id).settledAt)).toBe(true);
	});

	it("a torn last line or a missing transcript holds no wake", () => {
		const f = join(dir, "torn.jsonl");
		writeFileSync(f, `${userLine("x").slice(0, 40)}`);
		expect(wakeInTranscript(f, "x", 0)).toBe(false);
		expect(wakeInTranscript(join(dir, "none.jsonl"), "x", 0)).toBe(false);
	});

	it("expectWake ends on the wake's user message_end only (not an assistant's, not another text)", async () => {
		const chat = {};
		const w = expectWake(chat, "WAKE-1");
		let done = false;
		void w.admitted.then(() => (done = true));
		questionWakeOnEvent(chat, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "WAKE-1" }] },
		});
		questionWakeOnEvent(chat, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "other" }] },
		});
		questionWakeOnEvent(chat, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "WAKE-1" }] },
		});
		await turns();
		expect(done).toBe(false);
		questionWakeOnEvent(chat, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "[From: Shine]\nWAKE-1" }] },
		});
		await turns();
		expect(done).toBe(true);
	});

	it("a cancelled expectWake never ends", async () => {
		const chat = {};
		const w = expectWake(chat, "WAKE-2");
		w.cancel();
		let done = false;
		void w.admitted.then(() => (done = true));
		questionWakeOnEvent(chat, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "WAKE-2" }] },
		});
		await turns();
		expect(done).toBe(false);
	});
});

describe("D2: the wake is the answerer's message (rule 37)", () => {
	it("a web answer by Wai carries Wai as sender, kept on disk for a replay", async () => {
		const { id } = post("Wai");
		deliverHow = "later";
		asAnswerer("Wai", () =>
			settleCard(runtime, id, { kind: "answered", answers: [{ id: "port", selected: ["9090"] }], from: "browser" }),
		);
		await turns();
		expect(sent[0]!.sentBy).toEqual(WAI);
		const kept = PendingQuestionsStore.inDataDir(join(dir, "data")).get(id) as PendingQuestionDelivering;
		expect(kept.resolution.kind === "answered" && kept.resolution.sentBy).toEqual(WAI);
		expect(questionWakeOf(kept).sentBy).toEqual(WAI);
	});

	it("with no known answerer (Telegram, the Roles page) the card's owner is the sender", async () => {
		const { id } = post("Shine");
		settleCard(runtime, id, { kind: "cancelled", from: "telegram" });
		await turns();
		expect(sent[0]!.sentBy).toEqual(SHINE);
	});

	it("COO's hand-back carries no owner sender, even if one is passed", () => {
		const { id } = post();
		store.settle(id, { kind: "returned", note: "COO answered", sentBy: SHINE } as unknown as QuestionResolution);
		expect(questionWakeOf(delivering(id)).sentBy).toBeUndefined();
	});

	it("a malformed sentBy in the file is refused, not trusted", () => {
		const { id } = post();
		store.settle(id, ANSWERED(SHINE));
		const file = join(dir, "data", "pending-questions.json");
		writeFileSync(file, readFileSync(file, "utf8").replace('"login": "aungshine@gmail.com",', ""));
		expect(() => PendingQuestionsStore.inDataDir(join(dir, "data")).list()).toThrow(/sentBy is malformed/);
	});

	it("personSentBy: a people.json name gets its login; an unknown one a person: login", () => {
		expect(personSentBy("Wai")).toEqual(WAI);
		expect(personSentBy("Shine")).toEqual(SHINE);
		expect(personSentBy("Mo")).toEqual({ login: "person:mo", name: "Mo", owner: false });
	});
});
