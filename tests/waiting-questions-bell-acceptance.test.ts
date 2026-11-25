// waiting-questions bell (Ops #1089 Task 1 of 2; Shine 2026-11-25 m104486: "We need a way to see questions waiting
// for us tho", m104524: "Top bar maybe a notification icon ?"): the acceptance cases WQ-1..WQ-6, written before the
// build. RED on 8629275e (nothing pushes `owner_asks`, no bell slot, no "?" on saved chats); Task 2 wires
// ClientSession, the top bar and the chat list, moves this file into tests/unit/ and makes it GREEN without
// weakening an assertion. Questions come through the real ask_user_question tool, bridge, list of asks, per-owner
// split (#1051) and COO router (#685), in windows of Shine's and Wai's logins, as tests/unit/nonblocking-ask-question.
// The seam Task 2 adds to ClientSession (the projection is server/owner-asks-feed.ts, landed with this file):
// - every window of an owner gets `{ type: "owner_asks", asks }` (his list, projectOwnerAsksForViewer) whenever an ask
//   appears, is kept for later or brought back, ends (answered anywhere, cancelled, gone) or is let through by COO,
//   and after a restart puts cards back;
// - `ownerAskOpen(reqId, askId)` -> `{ type: "owner_ask", reqId, ok, ask | error }` (openOwnerAskForViewer);
// - `ownerAskAnswer(reqId, askId, revision, answers)` -> `{ type: "owner_ask_result", reqId, ok, error? }`
//   (answerOwnerAskForViewer, as the window's owner), with index.ts routing owner_ask_open / owner_ask_answer to them;
// - the saved-chat rows (`sessions`) each carry `hasQuestion` for the window's owner (sessionsWithQuestionsFor).
// No server, model or socket; temporary folders only.
// No server, model or socket; temporary folders only. The harness is tests/fixtures/owner-bell-windows.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession } from "../server/agent-service.js";
import { type Ask, type AskEvent, askHub } from "../server/asks.js";
import { answerRecord } from "../server/decision-records.js";
import { identityRegistry } from "../server/identities.js";
import { OWNER_QUESTION_HOLDS_FILE, OwnerQuestionHolds } from "../server/owner-question-holds.js";
import { OwnerQuestionRouter } from "../server/owner-question-router.js";
import { pluginAnswer } from "../server/owner-question-surfaces.js";
import type { OwnerViewer } from "../server/owner-requester.js";
import { PendingQuestionsStore, type QuestionWake } from "../server/pending-questions-store.js";
import type { SessionSummary } from "../server/protocol.js";
import { asAnswerer, PeopleBook, serveOwners, tailscaleSenderOf } from "../server/sent-by.js";
import { buildLeadBar } from "../web/src/lead-bar";
import { fitTopbar, LATE_TOPBAR_ITEM_IDS } from "../web/src/topbar-fit";
import type { UiIdentityInfo } from "../web/src/types";
import { BUILTIN_UI_ITEMS } from "../web/src/ui-slots";
import {
	asker,
	bell,
	bellAnswer,
	bellIds,
	bellItem,
	bellOpen,
	chat as chatAt,
	DNS,
	everListed,
	type FakeChat,
	NAME,
	ofType,
	PORT,
	SHINE_SENT,
	type SessionInfo,
	statics,
	turn,
	turns,
	WAI_SENT,
	type Win,
	win as winOf,
} from "./fixtures/owner-bell-windows.js";

let dir = "";
let dataDir = "";
let viewers: { shine: OwnerViewer; wai: OwnerViewer };
let events: AskEvent[] = [];
let wakes: QuestionWake[] = [];
const cleanups: Array<() => void> = [];
const identityEnv = process.env.PI_IDENTITY_DIR;

function wire(): void {
	statics.pendingQuestionsHost = {
		store: PendingQuestionsStore.inDataDir(dataDir),
		deliver: async (wake) => {
			wakes.push(structuredClone(wake));
			return { ok: true };
		},
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "waiting-questions-bell-"));
	dataDir = join(dir, "data");
	process.env.PI_IDENTITY_DIR = join(dir, "identities");
	identityRegistry(true);
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
	wire();
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	for (const [id, q] of [...statics.sharedQuestions]) {
		if (q.graceTimer) clearTimeout(q.graceTimer as ReturnType<typeof setTimeout>);
		statics.sharedQuestions.delete(id);
	}
	statics.sharedApprovals.clear();
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
	statics.pendingQuestionsHost = null;
	ClientSession.ownerQuestions = null;
	if (identityEnv === undefined) delete process.env.PI_IDENTITY_DIR;
	else process.env.PI_IDENTITY_DIR = identityEnv;
	identityRegistry(true);
	rmSync(dir, { recursive: true, force: true });
});

const chat = (name: string): FakeChat => chatAt(dir, name);
const win = (convs: Map<string, FakeChat>, viewer: OwnerViewer, extra?: PropertyDescriptorMap): Win =>
	winOf(convs, viewer, (undo) => cleanups.push(undo), extra);

/** A department whose lead home chat is `homeChat` (pi-identity's identity.json). */
function role(id: string, title: string, homeChat: string): void {
	mkdirSync(join(dir, "identities", id), { recursive: true });
	const def = { id, title, folder: null, homeChat, pastHomeChats: [] };
	writeFileSync(join(dir, "identities", id, "identity.json"), JSON.stringify(def));
	identityRegistry(true);
}

/** A new process: the same data folder, an empty list of asks; waiting cards come back from disk. */
async function restart(): Promise<void> {
	for (const a of askHub.list()) askHub.settle(a.id, { how: "gone", reason: "process ended" });
	statics.sharedQuestions.clear();
	wire();
}

const askOf = (questionId: string): Ask =>
	[...askHub.list(), ...askHub.heldList()].find((a) => a.fields.some((f) => f.id === questionId))!;
const answeredEvents = () => events.filter((e): e is Extract<AskEvent, { type: "answered" }> => e.type === "answered");

function cooRouter(): void {
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
}

describe("WQ-1: the bell lists every question waiting on its owner, from any chat", () => {
	it("a regular chat's and a role chat's questions, kept-for-later flagged, still listed after a restart", async () => {
		const plain = chat("plain");
		const lead = chat("ops-lead");
		role("ops", "ops/tooling", lead.session.sessionFile);
		const convs = new Map([
			[plain.id, plain],
			[lead.id, lead],
		]);
		const shine = win(convs, viewers.shine);
		turn(plain, SHINE_SENT);
		turn(lead, SHINE_SENT);
		await asker(shine, plain)("toolu_p", [PORT]);
		const p = askOf("port");
		expect(bell(shine)).toEqual([
			expect.objectContaining({
				askId: p.id,
				kind: "question",
				answerable: true,
				conversationId: plain.id,
				sessionFile: plain.session.sessionFile,
				summary: "Which port?",
			}),
		]);
		expect(bellItem(shine, p.id)).not.toHaveProperty("roleId");
		await asker(shine, lead)("toolu_l", [DNS]);
		const l = askOf("dns");
		expect(bellIds(shine)).toEqual([p.id, l.id].sort());
		expect(bellItem(shine, l.id)).toMatchObject({ roleId: "ops", roleTitle: "ops/tooling", answerable: true });

		shine.client.questionLater(p.id, true);
		await turns();
		expect(bellItem(shine, p.id)).toMatchObject({ later: true, answerable: true });
		expect(bellItem(shine, l.id)?.later).toBeUndefined();

		// The window closes, the server restarts; no chat is open anywhere when the cards come back.
		shine.client.cancelPendingQuestions();
		await restart();
		const fresh = win(new Map(), viewers.shine);
		await statics.restorePendingQuestions();
		await turns();
		const [p2, l2] = [askOf("port"), askOf("dns")];
		expect(bellIds(fresh)).toEqual([p2.id, l2.id].sort());
		expect(bellItem(fresh, p2.id)).toMatchObject({
			later: true,
			answerable: true,
			sessionFile: plain.session.sessionFile,
		});
		expect(bellItem(fresh, l2.id)).toMatchObject({ roleId: "ops", answerable: true });
	});
});

describe("WQ-2: each owner's bell holds only his own asks", () => {
	it("Shine's and Wai's windows list, open and answer only their own; COO-held asks wait until let through", async () => {
		cooRouter();
		const mine = chat("shine-chat");
		const hers = chat("wai-chat");
		const coo = chat("coo");
		const convs = new Map([
			[mine.id, mine],
			[hers.id, hers],
			[coo.id, coo],
		]);
		const shine = win(convs, viewers.shine);
		const wai = win(convs, viewers.wai);
		turn(mine, SHINE_SENT);
		turn(hers, WAI_SENT);
		await asker(shine, mine)("toolu_s", [PORT]);
		await asker(shine, hers)("toolu_w", [DNS]);
		const [forShine, forWai] = [askOf("port"), askOf("dns")];
		expect(forWai.requester).toBe("Wai");
		expect(bellIds(shine)).toEqual([forShine.id]);
		expect(bellIds(wai)).toEqual([forWai.id]);

		// Shine's window can't open or answer Wai's ask (refused as gone), nor Wai's his.
		const view = await bellOpen(wai, forWai.id);
		expect(view).toMatchObject({ ok: true, ask: { id: forWai.id } });
		expect(await bellOpen(shine, forWai.id)).toMatchObject({ ok: false, error: "no longer waiting" });
		expect(await bellOpen(wai, forShine.id)).toMatchObject({ ok: false, error: "no longer waiting" });
		const revision = view?.ok ? view.ask.revision : "";
		const answer = [{ id: "dns", selected: ["Yes"] }];
		expect(await bellAnswer(shine, forWai.id, revision, answer)).toMatchObject({ ok: false });
		expect(askHub.get(forWai.id)).toBeDefined();
		expect(wakes).toEqual([]);

		// COO's: held first (on no bell), then let through to Shine's bell only.
		turn(coo);
		await asker(shine, coo)("toolu_c", [NAME]);
		const held = askOf("name");
		expect(askHub.heldList().map((a) => a.id)).toEqual([held.id]);
		expect(bellIds(shine)).toEqual([forShine.id]);
		expect(await bellOpen(shine, held.id)).toMatchObject({ ok: false, error: "no longer waiting" });
		expect(askHub.release(held.id, "coo")).toEqual({ ok: true });
		await turns();
		expect(bellIds(shine)).toEqual([forShine.id, held.id].sort());
		expect(bellIds(wai)).toEqual([forWai.id]);

		// Wai answers her own from her bell: the chat wakes with her answer.
		expect(await bellAnswer(wai, forWai.id, revision, answer)).toMatchObject({ ok: true });
		expect(wakes.map((w) => [w.conversationId, w.sentBy?.name, w.requester.person])).toEqual([[hers.id, "Wai", "Wai"]]);
		expect(bellIds(wai)).toEqual([]);
		expect(everListed(shine).has(forWai.id)).toBe(false);
		expect(everListed(wai).has(forShine.id) || everListed(wai).has(held.id)).toBe(false);
	});
});

describe("WQ-3: a question is answered from the bell, without switching chats", () => {
	it("a regular chat's kept-for-later question and a role chat's question wake their chats as Shine's", async () => {
		const plain = chat("plain");
		const lead = chat("ops-lead");
		role("ops", "ops/tooling", lead.session.sessionFile);
		const convs = new Map([
			[plain.id, plain],
			[lead.id, lead],
		]);
		const shine = win(convs, viewers.shine);
		const tab2 = win(convs, viewers.shine);
		turn(plain, SHINE_SENT);
		turn(lead, SHINE_SENT);
		await asker(shine, plain)("toolu_p", [PORT]);
		await asker(shine, lead)("toolu_l", [DNS]);
		const [p, l] = [askOf("port"), askOf("dns")];
		shine.client.questionLater(p.id, true);
		await turns();

		const popupsBefore = ofType(shine, "question_pending").length;
		const opened = await bellOpen(shine, p.id);
		expect(opened).toMatchObject({ ok: true, ask: { id: p.id, kind: "question", fields: [{ id: "port" }] } });
		const revision = opened?.ok ? opened.ask.revision : "";
		expect(await bellAnswer(shine, p.id, "stale", [{ id: "port", selected: ["8080"] }])).toMatchObject({ ok: false });
		expect(wakes).toEqual([]);
		expect(await bellAnswer(shine, p.id, revision, [{ id: "port", selected: ["8080"] }])).toMatchObject({ ok: true });
		expect(wakes).toHaveLength(1);
		expect(wakes[0]).toMatchObject({
			conversationId: plain.id,
			sentBy: expect.objectContaining({ name: "Shine" }),
			requester: { kind: "owner", person: "Shine" },
		});
		expect(wakes[0]!.text).toContain("- Which port?: 8080");
		const [answered] = answeredEvents();
		expect(answerRecord(answered!.ask, answered!, Date.now())).toMatchObject({
			answeredBy: "Shine",
			answeredIn: "browser",
		});
		expect(bellIds(shine)).toEqual([l.id]);
		expect(bellIds(tab2)).toEqual([l.id]);

		const roleView = await bellOpen(tab2, l.id);
		const roleRevision = roleView?.ok ? roleView.ask.revision : "";
		expect(await bellAnswer(tab2, l.id, roleRevision, [{ id: "dns", selected: ["Yes"] }])).toMatchObject({ ok: true });
		expect(wakes.map((w) => [w.conversationId, w.sentBy?.name])).toEqual([
			[plain.id, "Shine"],
			[lead.id, "Shine"],
		]);
		expect(bellIds(shine)).toEqual([]);
		expect(bellIds(tab2)).toEqual([]);
		expect(ofType(shine, "question_pending").slice(popupsBefore)).toEqual([]); // nothing popped up over the chat
	});
});

describe("WQ-4: a question ended anywhere leaves every bell at once", () => {
	it("cancelled in the browser, answered on Telegram, answered in its chat", async () => {
		const asking = chat("plain");
		const convs = new Map([[asking.id, asking]]);
		const shine = win(convs, viewers.shine);
		const tab2 = win(convs, viewers.shine);
		const wai = win(convs, viewers.wai);
		turn(asking, SHINE_SENT);
		const run = asker(shine, asking);
		await run("toolu_1", [PORT]);
		await run("toolu_2", [DNS]);
		await run("toolu_3", [NAME]);
		const [a1, a2, a3] = [askOf("port"), askOf("dns"), askOf("name")];
		expect(bellIds(shine)).toEqual([a1.id, a2.id, a3.id].sort());
		expect(bellIds(tab2)).toEqual([a1.id, a2.id, a3.id].sort());

		await shine.client.answerQuestion(a1.id, [], true); // "Cancel question"
		await turns();
		expect(bellIds(shine)).toEqual([a2.id, a3.id].sort());
		expect(bellIds(tab2)).toEqual([a2.id, a3.id].sort());

		expect(await pluginAnswer(a2.id, [{ id: "dns", selected: ["Yes"] }], "telegram")).toEqual({ ok: true });
		await turns();
		expect(bellIds(shine)).toEqual([a3.id]);
		expect(bellIds(tab2)).toEqual([a3.id]);

		await asAnswerer("Shine", () => tab2.client.answerQuestion(a3.id, [{ id: "name", selected: ["bell"] }]));
		await turns();
		expect(bellIds(shine)).toEqual([]);
		expect(bellIds(tab2)).toEqual([]);
		expect(bell(wai) ?? []).toEqual([]);
		expect(wakes).toHaveLength(3);
	});
});

describe("WQ-5: the bell has its place on the top bar and stays on a small phone", () => {
	it("is a built-in end-of-bar item that folds into ⋯ last, after Terminal, Git, Search, Tasks and Settings", () => {
		const item = BUILTIN_UI_ITEMS.find((i) => i.id === "host:questions");
		expect(item).toMatchObject({ slot: "topbar.primary", align: "end", icon: "bell" });
		expect(item?.hidden).not.toBe(true);
		expect(LATE_TOPBAR_ITEM_IDS.has("host:questions")).toBe(true);
		const bar = ["host:terminal", "host:git", "host:search", "host:questions", "host:tasks", "host:settings"];
		const items = bar.map((id) => ({ id, width: 40 }));
		// Room for one entry beside the ⋯ button: the bell is the one left.
		const dropped = fitTopbar(items, 40 + 8 + 48, 8, 48, new Set(), LATE_TOPBAR_ITEM_IDS);
		expect([...dropped].sort()).toEqual(bar.filter((id) => id !== "host:questions").sort());
	});
});

describe("WQ-6: a saved chat with a question waiting shows '?' in the chat list", () => {
	it("the saved-chat rows carry hasQuestion for their window's owner only", async () => {
		const lead = chat("ops-lead");
		const hers = chat("wai-chat");
		const quiet = chat("quiet");
		const convs = new Map([
			[lead.id, lead],
			[hers.id, hers],
		]);
		const first = win(convs, viewers.shine);
		turn(lead, SHINE_SENT);
		turn(hers, WAI_SENT);
		await asker(first, lead)("toolu_s", [PORT]);
		await asker(first, hers)("toolu_w", [DNS]);
		first.client.cancelPendingQuestions();
		await restart();
		await statics.restorePendingQuestions(); // both chats closed: the cards come back from disk
		const infos: SessionInfo[] = [lead, hers, quiet].map((c, i) => ({
			path: c.session.sessionFile,
			firstMessage: c.title,
			messageCount: 2,
			modified: new Date(Date.UTC(2026, 10, 25, 12, i)),
			cwd: dir,
		}));
		const listing = { loadSessionInfos: { value: async () => infos } };
		const shine = win(new Map(), viewers.shine, listing);
		const wai = win(new Map(), viewers.wai, listing);
		const marks = async (w: Win) => {
			await w.client.refreshSessions();
			const rows = ofType(w, "sessions").at(-1)?.sessions ?? [];
			return Object.fromEntries(rows.map((r) => [r.firstMessage, r.hasQuestion]));
		};
		expect(await marks(shine)).toEqual({ "ops-lead": true, "wai-chat": false, quiet: false });
		expect(await marks(wai)).toEqual({ "ops-lead": false, "wai-chat": true, quiet: false });
		expect(await marks(shine)).toEqual({ "ops-lead": true, "wai-chat": false, quiet: false }); // shared rows untouched
	});

	it("the leads view shows a saved lead chat's '?' and counts saved chats waiting on the owner under All chats", () => {
		const row = (path: string, hasQuestion: boolean): SessionSummary => ({
			path,
			firstMessage: path,
			messageCount: 2,
			modified: 1,
			hasQuestion,
		});
		const leadFile = "/data/sessions/ops-lead.jsonl";
		const ops = { id: "ops", title: "ops/tooling", homeChat: leadFile } as UiIdentityInfo;
		const bar = buildLeadBar({
			identities: [ops],
			conversations: [],
			elsewhere: [],
			queueTasks: [],
			sessions: [
				row(leadFile, true),
				row("/data/sessions/plain.jsonl", true),
				row("/data/sessions/other.jsonl", false),
			],
			activeConversationId: "",
			sessionFile: null,
		});
		const chatOf = bar.leads[0]?.chat;
		expect(chatOf?.kind).toBe("saved");
		expect(chatOf?.kind === "saved" ? chatOf.session?.hasQuestion : undefined).toBe(true);
		expect(bar.others.asking).toBe(1);
	});
});
