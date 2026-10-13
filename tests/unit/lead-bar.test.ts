/**
 * lead-bar: the left bar's leads view (web/src/lead-bar.ts). Fixed cases whose right answers are known:
 * which rows the bar shows (only the role leads, in the Roles page's order, each with its open task
 * chats, plus the chat on screen when it's neither), what each lead's row is drawn as, and what only
 * All chats shows (its running / asking count).
 */
import { describe, expect, it } from "vitest";
import type {
	ConversationSummary,
	ElsewhereRunning,
	SessionSummary,
	UiIdentityInfo,
	UiRoleWorkMode,
} from "../../server/protocol.js";
import {
	buildLeadBar,
	hasLeads,
	type LeadBar,
	type LeadBarInput,
	leadOrder,
	normPath,
} from "../../web/src/lead-bar.js";

const S = "/home/u/.pi/agent/sessions/--home-u--";
const f = (name: string) => `${S}/2026-10-01T00-00-00-000Z_${name}.jsonl`;

function ident(
	id: string,
	homeChat?: string,
	extra: { workMode?: UiRoleWorkMode; rulesMode?: UiRoleWorkMode; missing?: boolean } = {},
): UiIdentityInfo {
	return {
		id,
		title: `${id[0]?.toUpperCase()}${id.slice(1)} lead`,
		...(homeChat ? { homeChat } : {}),
		...(extra.missing ? { homeChatMissing: true } : {}),
		...(extra.workMode ? { workMode: extra.workMode } : {}),
		...(extra.rulesMode ? { rules: { workMode: extra.rulesMode, goals: [] } } : {}),
	} as unknown as UiIdentityInfo;
}

function row(id: string, file: string | undefined, extra: Partial<ConversationSummary> = {}): ConversationSummary {
	return {
		id,
		title: id,
		cwd: "/home/u",
		messageCount: 3,
		isStreaming: false,
		isSubagent: false,
		...(file ? { sessionPath: file } : {}),
		...extra,
	};
}

const away = (file: string | undefined, extra: Partial<ElsewhereRunning> = {}): ElsewhereRunning => ({
	title: `away ${file ?? "?"}`,
	cwd: "/home/u",
	isStreaming: false,
	...(file ? { sessionFile: file } : {}),
	...extra,
});

const saved = (file: string, name?: string): SessionSummary => ({
	path: file,
	...(name ? { name } : {}),
	firstMessage: "hello",
	messageCount: 12,
	modified: 1000,
});

// ── The fixed case ─────────────────────────────────────────────────────────────────────────────────────
// Leads: product (self-start, home only saved and not listed), data (saved, listed in History), ops (open
// here; its home chat written with a doubled slash), qa (running in another tab), temper (file gone).
// coo has no home chat: not a lead. Their task chats and every other kind of chat around them.

const identities = [
	ident("temper", f("temper"), { missing: true }),
	ident("qa", f("qa")),
	ident("ops", f("ops").replace("/sessions/", "/sessions//")),
	ident("coo"),
	ident("data", f("data")),
	ident("product", f("product"), { workMode: "self-start" }),
];

const conversations: ConversationSummary[] = [
	row("c-ops", f("ops"), { identity: { id: "ops", title: "Ops lead" }, createdAt: 10 }),
	// ops's task chats: working, asking (a question), and one more saved below (waiting).
	row("t1", f("t1"), { queueHomeFile: f("ops"), queueHomeId: "c-ops", isStreaming: true, createdAt: 300 }),
	row("t2", f("t2"), { queueHomeFile: f("ops"), queueHomeId: "c-ops", hasQuestion: true, createdAt: 200 }),
	// data's task chat (data's own chat is only saved).
	row("t5", f("t5"), { queueHomeFile: f("data"), createdAt: 150 }),
	// A task of a queue in a chat that isn't a lead's (coo's), running: All chats only.
	row("t6", f("t6"), { queueHomeFile: f("coo"), isStreaming: true, createdAt: 140 }),
	// A finished task's chat: no link any more.
	row("t-done", f("t-done"), { createdAt: 130 }),
	// Ad-hoc chats: running, asking (a pop-up), the one on screen; one in another folder; a DSH preset chat.
	row("c-run", f("adhoc-run"), { isStreaming: true, createdAt: 120 }),
	row("c-ask", f("adhoc-ask"), { dialogId: 1, createdAt: 110 }),
	row("c-open", f("adhoc-open"), { createdAt: 100 }),
	row("c-other", f("other-folder"), { cwd: "/srv/other", createdAt: 90 }),
	row("c-preset", f("preset"), { agentPreset: "reviewer", createdAt: 80 }),
	// Subagents: one running (not counted), one asking (counted).
	row("k1", undefined, { isSubagent: true, parentId: "c-ops", isStreaming: true }),
	row("k2", undefined, { isSubagent: true, parentId: "c-run", hasQuestion: true }),
];

const queueTasks: ConversationSummary[] = [
	// ops's third task chat: not a row (saved, not in Recent chats), finished its turn, waiting for him.
	row(`recent:${f("t3")}`, f("t3"), { queueHomeFile: f("ops"), live: false, waiting: true, createdAt: 100 }),
	// temper's task chat (temper's home chat file is gone).
	row(`recent:${f("t7")}`, f("t7"), { queueHomeFile: f("temper"), live: false, createdAt: 50 }),
	// A lead's own chat is never a task chat, even if a queue says so.
	row(`recent:${f("product")}`, f("product"), { queueHomeFile: f("ops"), live: false, createdAt: 400 }),
];

const elsewhere: ElsewhereRunning[] = [
	away(f("qa"), { isStreaming: true, owner: "tab2", convId: "q1" }),
	away(f("t4"), { queueHomeFile: f("qa"), isStreaming: true, owner: "tab2", convId: "q2" }),
	away(f("away-run"), { isStreaming: true }),
	away(f("away-ask"), { hasQuestion: true }),
];

const sessions: SessionSummary[] = [saved(f("data"), "Data home"), saved(f("adhoc-saved"), "Old notes")];

const input = (over: Partial<LeadBarInput> = {}): LeadBarInput => ({
	identities,
	conversations,
	elsewhere,
	queueTasks,
	sessions,
	activeConversationId: "c-open",
	sessionFile: f("adhoc-open"),
	...over,
});

/** Every transcript the bar shows, in order (leads' chats and their tasks; Open now first). */
function shownFiles(bar: LeadBar): string[] {
	const out: string[] = [];
	if (bar.openNow?.kind === "conv") out.push(`now:${bar.openNow.conv.sessionPath}`);
	if (bar.openNow?.kind === "saved") out.push(`now:${bar.openNow.file}`);
	if (bar.openNow?.kind === "new") out.push("now:new");
	for (const lead of bar.leads) {
		out.push(`lead:${lead.identity.id}`);
		for (const t of lead.tasks)
			out.push(t.kind === "conv" ? (t.conv.sessionPath ?? t.conv.id) : (t.entry.sessionFile ?? "?"));
	}
	return out;
}

describe("lead-bar: the leads view", () => {
	it("shows only the leads in the Roles page's order, each with its open task chats, and the open chat", () => {
		const bar = buildLeadBar(input());
		expect(shownFiles(bar)).toEqual([
			`now:${f("adhoc-open")}`,
			"lead:product",
			"lead:data",
			f("t5"),
			"lead:ops",
			f("t1"),
			f("t2"),
			f("t3"),
			"lead:qa",
			f("t4"),
			"lead:temper",
			f("t7"),
		]);
	});

	it("draws each lead's own chat as this window can show it", () => {
		const bar = buildLeadBar(input());
		const kinds = Object.fromEntries(bar.leads.map((l) => [l.identity.id, l.chat.kind]));
		expect(kinds).toEqual({ product: "saved", data: "saved", ops: "conv", qa: "elsewhere", temper: "missing" });
		const ops = bar.leads.find((l) => l.identity.id === "ops");
		expect(ops?.chat.kind === "conv" && ops.chat.conv.id).toBe("c-ops");
		const data = bar.leads.find((l) => l.identity.id === "data");
		expect(data?.chat.kind === "saved" && data.chat.session?.name).toBe("Data home");
		const product = bar.leads.find((l) => l.identity.id === "product");
		expect(product?.chat.kind === "saved" && product.chat.session).toBeUndefined();
		const qa = bar.leads.find((l) => l.identity.id === "qa");
		expect(qa?.chat.kind === "elsewhere" && qa.chat.entry.convId).toBe("q1");
		// Leads keep the identity's name and home chat as written (the click opens that file).
		expect(ops?.identity).toEqual({ id: "ops", title: "Ops lead" });
		expect(ops?.homeChat).toBe(f("ops").replace("/sessions/", "/sessions//"));
		expect(ops?.file).toBe(f("ops"));
	});

	it("keeps the marks of the task chats: a lead's fold count knows they work and wait for him", () => {
		const bar = buildLeadBar(input());
		const ops = bar.leads.find((l) => l.identity.id === "ops");
		expect(ops?.group).toEqual({ count: 3, folded: false, streaming: true, needsYou: true });
		const data = bar.leads.find((l) => l.identity.id === "data");
		expect(data?.group).toEqual({ count: 1, folded: false, streaming: false, needsYou: false });
		expect(bar.leads.find((l) => l.identity.id === "product")?.group).toBeUndefined();
		// The rows themselves are the list's own rows: lights, question mark and waiting light untouched.
		const t = ops?.tasks ?? [];
		expect(
			t.map((x) =>
				x.kind === "conv" ? [x.conv.isStreaming, x.conv.hasQuestion ?? false, x.conv.waiting ?? false] : [],
			),
		).toEqual([
			[true, false, false],
			[false, true, false],
			[false, false, true],
		]);
	});

	it("counts what only All chats shows: running, and waiting on an answer (subagents only when they ask)", () => {
		expect(buildLeadBar(input()).others).toEqual({ running: 3, asking: 3 });
		// The chat on screen isn't counted; with nothing on screen the ad-hoc running chat still is.
		expect(buildLeadBar(input({ activeConversationId: "c-run", sessionFile: f("adhoc-run") })).others).toEqual({
			running: 2,
			asking: 3,
		});
	});

	it("rows never move when a chat gets a message: the order doesn't follow activity or list order", () => {
		const busy = conversations.map((c) => ({ ...c, sortAt: Math.random() * 1e6, isStreaming: !c.isStreaming }));
		const a = buildLeadBar(input());
		const b = buildLeadBar(input({ conversations: [...busy].reverse(), queueTasks: [...queueTasks].reverse() }));
		expect(b.leads.map((l) => l.identity.id)).toEqual(a.leads.map((l) => l.identity.id));
		expect(shownFiles(b)).toEqual(shownFiles(a));
	});
});

describe("lead-bar: Open now", () => {
	it("a lead's chat or a task chat on screen gets no extra row", () => {
		expect(buildLeadBar(input({ activeConversationId: "c-ops", sessionFile: f("ops") })).openNow).toBeNull();
		expect(buildLeadBar(input({ activeConversationId: "t2", sessionFile: f("t2") })).openNow).toBeNull();
	});

	it("a new chat with nothing in it yet shows as one row; a saved chat being opened as its History row", () => {
		expect(buildLeadBar(input({ activeConversationId: "new-1", sessionFile: null })).openNow).toEqual({ kind: "new" });
		const open = buildLeadBar(input({ activeConversationId: "new-2", sessionFile: f("adhoc-saved") })).openNow;
		expect(open?.kind === "saved" && [open.file, open.session.name]).toEqual([f("adhoc-saved"), "Old notes"]);
		// No chat at all (connecting): nothing.
		expect(buildLeadBar(input({ activeConversationId: "", sessionFile: null })).openNow).toBeNull();
	});

	it("once he switches away the chat leaves the bar", () => {
		const before = shownFiles(buildLeadBar(input()));
		const after = shownFiles(buildLeadBar(input({ activeConversationId: "c-ops", sessionFile: f("ops") })));
		expect(before[0]).toBe(`now:${f("adhoc-open")}`);
		expect(after.some((x) => x.includes("adhoc"))).toBe(false);
	});
});

describe("lead-bar: folding a lead's task chats", () => {
	it("folds them away (the count stays), but the task chat on screen stays visible", () => {
		const folded = (key: string) => key === f("ops");
		const bar = buildLeadBar(input(), folded);
		const ops = bar.leads.find((l) => l.identity.id === "ops");
		expect(ops?.group).toEqual({ count: 3, folded: true, streaming: true, needsYou: true });
		expect(ops?.tasks).toEqual([]);
		const onScreen = buildLeadBar(input({ activeConversationId: "t2", sessionFile: f("t2") }), folded);
		const t = onScreen.leads.find((l) => l.identity.id === "ops")?.tasks ?? [];
		expect(t.map((x) => (x.kind === "conv" ? x.conv.id : "?"))).toEqual(["t2"]);
	});

	it("a lead running elsewhere is drawn as that row (no fold toggle), so it never folds", () => {
		const bar = buildLeadBar(input(), () => true);
		const qa = bar.leads.find((l) => l.identity.id === "qa");
		expect(qa?.group?.folded).toBe(false);
		expect(qa?.tasks.length).toBe(1);
	});
});

describe("lead-bar: leads and their order", () => {
	it("a lead is an identity with a home chat, found by identity, never by title", () => {
		expect(hasLeads([ident("coo"), ident("docs")])).toBe(false);
		expect(hasLeads([ident("coo"), ident("ops", f("ops"))])).toBe(true);
		// A chat titled like a lead isn't one.
		const bar = buildLeadBar(
			input({
				identities: [ident("ops", f("ops"))],
				conversations: [row("c-ops", f("ops")), row("fake", f("fake"), { title: "Ops lead" })],
				queueTasks: [],
				elsewhere: [],
				activeConversationId: "c-ops",
				sessionFile: f("ops"),
			}),
		);
		expect(shownFiles(bar)).toEqual(["lead:ops"]);
	});

	it("follows the Roles page: self-start roles first (the owner's word over the rules' default), each by id", () => {
		const list = [
			ident("temper", f("temper")),
			ident("design", f("design"), { rulesMode: "self-start" }),
			ident("qa", f("qa"), { workMode: "request-only", rulesMode: "self-start" }),
			ident("backend", f("backend")),
			ident("product", f("product"), { workMode: "self-start" }),
			ident("coo"),
		];
		expect(leadOrder(list).map((i) => i.id)).toEqual(["design", "product", "backend", "qa", "temper"]);
	});

	it("compares transcripts as the server writes them", () => {
		expect(normPath("/a//b/./c.jsonl")).toBe("/a/b/c.jsonl");
		expect(normPath("/a/x/../b/")).toBe("/a/b");
		expect(normPath("C:\\a\\b.jsonl")).toBe("C:/a/b.jsonl");
	});
});
