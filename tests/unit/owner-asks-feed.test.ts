// waiting-questions bell (Ops #1089 Task 1): the bell's canonical projection of the list of asks for one owner's
// window, and its open / answer, reusing the Roles page's form checks (roles-asks.ts). A private AskHub per test.
import { describe, expect, it } from "vitest";
import { type Ask, AskHub, type AskEvent, type AskFieldAnswer, NOT_WAITING } from "../../server/asks.js";
import {
	answerOwnerAskForViewer,
	OWNER_ASK_CHANGED,
	OWNER_ASK_IN_CHAT,
	type OwnerAskLookup,
	openOwnerAskForViewer,
	plainLine,
	projectOwnerAsksForViewer,
	sessionsWithQuestionsFor,
} from "../../server/owner-asks-feed.js";
import type { OwnerViewer } from "../../server/owner-requester.js";
import type { SessionSummary } from "../../server/protocol.js";
import { askViewOf } from "../../server/roles-asks.js";

const LISTED = new Set(["Wai"]);
const SHINE: OwnerViewer = { listed: LISTED };
const WAI: OwnerViewer = { person: "Wai", listed: LISTED };
const OPS_HOME = "/data/sessions/ops-lead.jsonl";

function question(id: string, createdAt: number, extra: Partial<Ask> = {}): Ask {
	return {
		id,
		kind: "question",
		createdAt,
		title: "Port",
		fields: [
			{
				id: "port",
				text: "Which port?",
				options: [
					{ value: "8080", label: "8080" },
					{ value: "9090", label: "9090" },
				],
				multi: false,
				allowText: true,
			},
		],
		...extra,
	};
}
const approval = (id: string, createdAt: number): Ask => ({
	id,
	kind: "approval",
	createdAt,
	title: "Allow bash?",
	body: "rm -rf build",
	fields: [
		{
			id: "decision",
			text: "Allow bash?",
			options: [{ value: "approve", label: "Approve" }],
			multi: false,
			allowText: false,
		},
	],
});

const lookup = (later: string[] = []): OwnerAskLookup => ({
	later: (ask) => later.includes(ask.id),
	roleOf: (file) => (file === OPS_HOME ? { id: "ops", title: "ops/tooling" } : undefined),
});

/** A hub whose asks record how they were answered (by whom, from where). */
function hubWith(...asks: Ask[]) {
	const hub = new AskHub(() => 1_000);
	const answered: Array<{ id: string; answers: AskFieldAnswer[]; from: string }> = [];
	const events: AskEvent[] = [];
	hub.on((ev) => events.push(ev));
	for (const ask of asks) {
		hub.add(ask, (answers, from) => {
			answered.push({ id: ask.id, answers, from });
			hub.settle(ask.id, { how: "answered", summary: answers[0]?.selected[0] ?? "", from, answers });
			return { ok: true };
		});
	}
	return { hub, answered, events };
}

describe("projectOwnerAsksForViewer", () => {
	it("lists the viewer's asks newest first (same moment by id), with later, role and answerable", () => {
		const { hub } = hubWith(
			question("q-old", 100, { sessionFile: OPS_HOME, conversationId: "conv-ops", conversationTitle: "Ops lead" }),
			question("q-b", 300, { sessionFile: "/data/sessions/plain.jsonl" }),
			question("q-a", 300),
			approval("ap-1", 200),
		);
		const items = projectOwnerAsksForViewer(hub.list(), SHINE, lookup(["q-b"]));
		expect(items.map((i) => i.askId)).toEqual(["q-a", "q-b", "ap-1", "q-old"]);
		expect(items[1]).toMatchObject({ later: true, answerable: true, sessionFile: "/data/sessions/plain.jsonl" });
		expect(items[0]).not.toHaveProperty("later");
		expect(items[0]).not.toHaveProperty("roleId");
		expect(items[2]).toMatchObject({ kind: "approval", answerable: false });
		expect(items[3]).toMatchObject({
			roleId: "ops",
			roleTitle: "ops/tooling",
			conversationId: "conv-ops",
			conversationTitle: "Ops lead",
			summary: "Which port?",
			answerable: true,
		});
	});

	it("never lists another owner's ask nor one held for COO (until it is let through)", () => {
		const { hub } = hubWith(question("q-shine", 1), question("q-wai", 2, { requester: "Wai" }));
		hub.add(question("q-held", 3), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		expect(projectOwnerAsksForViewer(hub.list(), SHINE, lookup()).map((i) => i.askId)).toEqual(["q-shine"]);
		expect(projectOwnerAsksForViewer(hub.list(), WAI, lookup()).map((i) => i.askId)).toEqual(["q-wai"]);
		// Even when handed every ask, including the held one, the held one stays out.
		const all = [...hub.list(), ...hub.heldList()];
		expect(projectOwnerAsksForViewer(all, SHINE, lookup()).map((i) => i.askId)).toEqual(["q-shine"]);
		hub.release("q-held", "coo");
		expect(projectOwnerAsksForViewer(hub.list(), SHINE, lookup()).map((i) => i.askId)).toEqual(["q-held", "q-shine"]);
	});

	it("shows plain words only: paths shortened, control characters and line breaks gone, long text cut", () => {
		const long = "x".repeat(400);
		const { hub } = hubWith(
			question("q-1", 1, {
				title: "Look at /home/shinelay/projects/pi-web-ui/server/asks.ts\u0007 now",
				conversationTitle: "ops ~/projects/agent-tools/bin/wt",
			}),
		);
		hub.get("q-1")!.fields[0]!.text = `Keep C:\\Users\\shine\\notes.md or\nhttps://example.com/a/b? ${long}`;
		const [item] = projectOwnerAsksForViewer(hub.list(), SHINE, lookup());
		expect(item!.title).toBe("Look at asks.ts now");
		expect(item!.conversationTitle).toBe("ops wt");
		expect(item!.summary!.startsWith("Keep notes.md or https://example.com/a/b? xxx")).toBe(true);
		expect(item!.summary!.length).toBe(200);
		expect(item!.summary!.endsWith("…")).toBe(true);
		expect(JSON.stringify(item)).not.toMatch(/\/home\/|C:\\\\/);
	});

	it("plainLine gives nothing for empty words", () => {
		expect(plainLine(undefined)).toBeUndefined();
		expect(plainLine(" \n\t ")).toBeUndefined();
	});
});

describe("openOwnerAskForViewer / answerOwnerAskForViewer", () => {
	it("opens the viewer's ask with the Roles page's form and answers it as him, from the browser", async () => {
		const { hub, answered, events } = hubWith(question("q-wai", 1, { requester: "Wai" }));
		const opened = openOwnerAskForViewer(hub, "q-wai", WAI);
		expect(opened).toEqual({ ok: true, ask: askViewOf(hub.get("q-wai")!) });
		if (!opened.ok) throw new Error("not opened");
		const r = await answerOwnerAskForViewer(
			hub,
			"q-wai",
			opened.ask.revision,
			[{ id: "port", selected: ["8080"] }],
			WAI,
		);
		expect(r).toEqual({ ok: true });
		expect(answered).toEqual([{ id: "q-wai", answers: [{ id: "port", selected: ["8080"] }], from: "browser" }]);
		expect(events.find((e) => e.type === "answered")).toMatchObject({ by: "Wai", from: "browser" });
		expect(hub.list()).toEqual([]);
	});

	it("the default owner's answer is recorded as Shine's", async () => {
		const { hub, events } = hubWith(question("q-1", 1));
		const opened = openOwnerAskForViewer(hub, "q-1", SHINE);
		if (!opened.ok) throw new Error("not opened");
		await answerOwnerAskForViewer(hub, "q-1", opened.ask.revision, [{ id: "port", selected: ["9090"] }], SHINE);
		expect(events.find((e) => e.type === "answered")).toMatchObject({ by: "Shine" });
	});

	it("refuses another owner's ask and a held one as 'no longer waiting', with nothing sent", async () => {
		const { hub, answered } = hubWith(question("q-wai", 1, { requester: "Wai" }));
		hub.add(question("q-held", 2), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		const revision = askViewOf(hub.get("q-wai")!)!.revision;
		expect(openOwnerAskForViewer(hub, "q-wai", SHINE)).toEqual({ ok: false, error: NOT_WAITING });
		expect(openOwnerAskForViewer(hub, "q-held", SHINE)).toEqual({ ok: false, error: NOT_WAITING });
		expect(openOwnerAskForViewer(hub, "q-gone", SHINE)).toEqual({ ok: false, error: NOT_WAITING });
		expect(openOwnerAskForViewer(hub, 42, SHINE)).toEqual({ ok: false, error: NOT_WAITING });
		const answer = [{ id: "port", selected: ["8080"] }];
		expect(await answerOwnerAskForViewer(hub, "q-wai", revision, answer, SHINE)).toEqual({
			ok: false,
			error: NOT_WAITING,
		});
		const heldRev = askViewOf(hub.get("q-held")!)!.revision;
		expect(await answerOwnerAskForViewer(hub, "q-held", heldRev, answer, SHINE)).toEqual({
			ok: false,
			error: NOT_WAITING,
		});
		expect(answered).toEqual([]);
		expect(hub.get("q-wai")).toBeDefined();
	});

	it("refuses a changed revision, answers that don't fit, and asks only their chat can answer", async () => {
		const { hub, answered } = hubWith(question("q-1", 1), approval("ap-1", 2));
		const view = askViewOf(hub.get("q-1")!)!;
		const fits = [{ id: "port", selected: ["8080"] }];
		expect(await answerOwnerAskForViewer(hub, "q-1", "stale", fits, SHINE)).toEqual({
			ok: false,
			error: OWNER_ASK_CHANGED,
		});
		expect(await answerOwnerAskForViewer(hub, "q-1", undefined, fits, SHINE)).toEqual({
			ok: false,
			error: OWNER_ASK_CHANGED,
		});
		const bad = await answerOwnerAskForViewer(hub, "q-1", view.revision, [{ id: "port", selected: ["7070"] }], SHINE);
		expect(bad.ok).toBe(false);
		expect(openOwnerAskForViewer(hub, "ap-1", SHINE)).toEqual({ ok: false, error: OWNER_ASK_IN_CHAT });
		const ap = await answerOwnerAskForViewer(hub, "ap-1", "x", [{ id: "decision", selected: ["approve"] }], SHINE);
		expect(ap).toEqual({ ok: false, error: OWNER_ASK_IN_CHAT });
		expect(answered).toEqual([]);
	});
});

describe("sessionsWithQuestionsFor", () => {
	it("marks the saved chats where a question waits on the viewer, in new rows, never the shared ones", () => {
		const row = (path: string): SessionSummary => ({ path, firstMessage: "", messageCount: 1, modified: 1 });
		const rows = [row(OPS_HOME), row("/data/sessions/wai.jsonl"), row("/data/sessions/quiet.jsonl")];
		const frozen = structuredClone(rows);
		const { hub } = hubWith(
			question("q-1", 1, { sessionFile: "/data/sessions/../sessions/ops-lead.jsonl" }),
			question("q-2", 2, { sessionFile: "/data/sessions/wai.jsonl", requester: "Wai" }),
		);
		const marks = (v: OwnerViewer) => sessionsWithQuestionsFor(rows, hub.list(), v).map((s) => s.hasQuestion);
		expect(marks(SHINE)).toEqual([true, false, false]);
		expect(marks(WAI)).toEqual([false, true, false]);
		expect(rows).toEqual(frozen);
	});
});
