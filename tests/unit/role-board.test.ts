/**
 * board (task #76): the roles' shared board (server/role-board.ts), with a fake host.
 *
 * The owner, 2026-10-06 (via COO rm-ef861b36): one board everyone can check instead of the same message
 * to each role; direct requests still go directly. His routing rule (rm-c4989975): "If the role has
 * something waiting then the message should go directly to them ... otherwise general info should be put
 * in the message board". So: news never pokes anyone; an order goes directly only to the listed roles that
 * have something waiting (a turn running, an open task, a request not yet answered); the rest see it at
 * their next turn, as one "[Board]" note.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import {
	BOARD_CUSTOM_TYPE,
	BOARD_NEWS_CUT,
	BOARD_NOTE_POSTS_MAX,
	BOARD_POSTS_PER_HOUR,
	BOARD_VIEW,
	RoleBoard as RoleBoardBase,
	audienceOf,
	boardChatState,
	boardNote,
	boardOrderIdOf,
	boardOrderText,
	boardRoleStateOf,
	cutText,
	openOrdersFor,
	postShownIn,
	routeOrder,
	transcriptSawPost,
	type BoardChat,
	type BoardHost,
	type BoardMark,
	type BoardNoteDetails,
	type BoardRoleState,
} from "../../server/role-board.js";
import { makeBoardTool } from "../../server/board-tool.js";
import { BOARD_TOOL_NAME } from "../../server/tool-manager.js";

let dir = "";
let now = Date.parse("2026-10-06T19:00:00Z");
const clock = () => now;
const MIN = 60_000;
const DAY = 24 * 3600_000;

/** Every board a test makes is stopped after it. */
const made: RoleBoardBase[] = [];
class RoleBoard extends RoleBoardBase {
	constructor(...args: ConstructorParameters<typeof RoleBoardBase>) {
		super(...args);
		made.push(this);
	}
}

/** A transcript with a header line (what the SDK writes first). */
function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
/** The chat took a user message (what the SDK appends when a turn starts, or when a steer is taken). */
function land(file: string, text: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
}
/** The chat's turn-start note, as the before_agent_start hook has it saved. */
function landNote(file: string, details: BoardNoteDetails, text = "[Board] 1 new post"): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "custom_message", customType: BOARD_CUSTOM_TYPE, content: [{ type: "text", text }], display: true, details })}\n`,
	);
}
const role = (id: string, homeChat?: string): IdentityDef =>
	({
		id,
		title: id.toUpperCase(),
		homeChat,
		pastHomeChats: [],
		folder: undefined,
		raw: {},
		role: undefined,
		dir: join(dir, id),
	}) as unknown as IdentityDef;

const st = (r: string, o: Partial<BoardRoleState> = {}): BoardRoleState => ({
	role: r,
	midTurn: [],
	homeMidTurn: false,
	openTasks: 0,
	openRequests: 0,
	...o,
});

interface Fake {
	host: BoardHost;
	roles: IdentityDef[];
	states: Map<string, BoardRoleState>;
	/** Chats whose turn runs now: a steer reaches them. */
	running: Set<string>;
	chatState: Map<string, "working" | "idle" | "closed">;
	steers: { file: string; text: string }[];
	delivered: { file: string; text: string }[];
	/** false: a send gets in but never lands (the run was stopped). */
	lands: boolean;
	busy: boolean;
	fail?: string;
	stateReads: number;
	changed: number;
}
function fake(roles: IdentityDef[]): Fake {
	const f: Fake = {
		roles,
		states: new Map(),
		running: new Set(),
		chatState: new Map(),
		steers: [],
		delivered: [],
		lands: true,
		busy: false,
		stateReads: 0,
		changed: 0,
		host: {
			roles: () => f.roles,
			roleStates: async (ids) => {
				f.stateReads++;
				return new Map(ids.flatMap((id) => (f.states.has(id) ? [[id, f.states.get(id)!] as const] : [])));
			},
			steer: async (file, text) => {
				if (!f.running.has(file)) return false;
				f.steers.push({ file, text });
				land(file, text);
				return true;
			},
			chatState: (file) => f.chatState.get(file) ?? "idle",
			deliver: async (file, text) => {
				if (f.busy) return { ok: false, busy: true, error: "busy" };
				if (f.fail) return { ok: false, error: f.fail };
				f.delivered.push({ file, text });
				if (f.lands) land(file, text);
				return { ok: true };
			},
			changed: () => {
				f.changed++;
			},
			log: () => {},
		},
	};
	return f;
}

let store = "";
let AH = "";
let BH = "";
let BT = "";
let CH = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "board-unit-"));
	now = Date.parse("2026-10-06T19:00:00Z");
	store = join(dir, "data", "role-board.json");
	AH = chat("alpha-home");
	BH = chat("beta-home");
	BT = chat("beta-task");
	CH = chat("gamma-home");
});
afterEach(() => {
	for (const b of made.splice(0)) b.stop();
	rmSync(dir, { recursive: true, force: true });
});

/** alpha, beta, gamma with home chats; delta has none. */
function three(): Fake {
	return fake([role("alpha", AH), role("beta", BH), role("gamma", CH), role("delta")]);
}

/** The text of every user message in a transcript. */
function userTexts(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; content?: { text?: string }[] } })
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) => e.message?.content?.[0]?.text ?? "");
}

const chatOf = (r: string, isHome: boolean, mark?: BoardMark, got: string[] = []): BoardChat => ({
	role: r,
	isHome,
	...(mark ? { mark } : {}),
	got,
});

// ---------------------------------------------------------------------------

describe("the owner's routing rule: directly only when something waits", () => {
	it("nothing waiting: no steer, no turn", () => {
		expect(routeOrder(st("gamma", { home: CH }))).toEqual({ waiting: false, steer: [], why: [] });
	});

	it("(a) a turn running: one steer into each mid-turn chat, no turn of its own", () => {
		const r = routeOrder(st("beta", { home: BH, midTurn: [BT] }));
		expect(r).toMatchObject({ waiting: true, steer: [BT], why: ["a turn running"] });
		expect(r.turn).toBeUndefined();
	});

	it("(b) an open task in its queue: one turn in its idle home chat", () => {
		expect(routeOrder(st("alpha", { home: AH, openTasks: 2 }))).toEqual({
			waiting: true,
			steer: [],
			turn: AH,
			why: ["2 open tasks in its queue"],
		});
	});

	it("(c) a request to it not yet answered: one turn in its idle home chat", () => {
		expect(routeOrder(st("alpha", { home: AH, openRequests: 1 }))).toEqual({
			waiting: true,
			steer: [],
			turn: AH,
			why: ["a request to it not yet answered"],
		});
	});

	it("a home chat mid-turn gets the steer, not a second turn; a task chat mid-turn and an idle home chat get both", () => {
		const homeBusy = routeOrder(st("alpha", { home: AH, midTurn: [AH], homeMidTurn: true, openTasks: 1 }));
		expect(homeBusy.steer).toEqual([AH]);
		expect(homeBusy.turn).toBeUndefined();
		const both = routeOrder(st("beta", { home: BH, midTurn: [BT], openRequests: 1 }));
		expect(both).toMatchObject({ steer: [BT], turn: BH });
	});

	it("reads 'something waiting' from the Roles page's data: (a) a chat mid-turn, (b) a task not done, (c) a request not answered", () => {
		const queue = (active: number, queued: number, done = 0) => ({
			queue: { running: true, active: [], queued: [], counts: { active, queued, done } },
			requests: { open: 0 },
		});
		// None: no queue, only done tasks, no requests, nothing running.
		for (const o of [undefined, { requests: { open: 0 } }, queue(0, 0, 4)]) {
			const s = boardRoleStateOf("gamma", o, CH, []);
			expect(s).toEqual({ role: "gamma", midTurn: [], home: CH, homeMidTurn: false, openTasks: 0, openRequests: 0 });
			expect(routeOrder(s).waiting).toBe(false);
		}
		// (a): its task chat runs (listed twice: one steer).
		const a = boardRoleStateOf("beta", undefined, BH, [BT, BT]);
		expect(a).toMatchObject({ midTurn: [BT], homeMidTurn: false });
		expect(routeOrder(a)).toMatchObject({ waiting: true, steer: [BT] });
		// (b): a ready task, or an active one (working, asking, stuck, waiting, blocked, or held by the owner's pause).
		for (const o of [queue(0, 1), queue(1, 0, 3)]) {
			const s = boardRoleStateOf("alpha", o, AH, []);
			expect(s.openTasks).toBe(1);
			expect(routeOrder(s)).toMatchObject({ waiting: true, steer: [], turn: AH });
		}
		// (c): a request or question not yet answered.
		const c = boardRoleStateOf("alpha", { requests: { open: 2 } }, AH, []);
		expect(c.openRequests).toBe(2);
		expect(routeOrder(c)).toMatchObject({ waiting: true, turn: AH });
		// Its home chat mid-turn: the steer reaches it there, no second turn.
		const busy = boardRoleStateOf("alpha", queue(1, 0), AH, [AH]);
		expect(busy.homeMidTurn).toBe(true);
		expect(routeOrder(busy)).toEqual({
			waiting: true,
			steer: [AH],
			why: ["a turn running", "an open task in its queue"],
		});
	});

	it("a role with no home chat gets no turn (it reads the order at its next turn)", () => {
		const r = routeOrder(st("delta", { openTasks: 1 }));
		expect(r).toMatchObject({ waiting: true, steer: [] });
		expect(r.turn).toBeUndefined();
	});
});

describe("posting an order", () => {
	it("A (open task, idle home) gets one turn, B (mid-turn) one steer and no turn, C (nothing) nothing", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH, openTasks: 1 }));
		f.states.set("beta", st("beta", { home: BH, midTurn: [BT] }));
		f.states.set("gamma", st("gamma", { home: CH }));
		f.running.add(BT);
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post(
			{ owner: true },
			{
				kind: "order",
				to: ["alpha", "beta", "gamma"],
				title: "Pause new work",
				text: "Finish what runs; start nothing new.",
			},
		);
		if (!res.ok) throw new Error(res.error);
		expect(res.direct).toEqual([
			{ role: "alpha", how: ["turn"], why: ["an open task in its queue"] },
			{ role: "beta", how: ["steer"], why: ["a turn running"] },
		]);
		expect(res.later).toEqual(["gamma"]);
		expect(f.steers).toEqual([
			{ file: BT, text: expect.stringMatching(/^\[Board order bp-[0-9a-f]{8} from owner · /) },
		]);
		expect(f.delivered).toEqual([]);
		// The direct turn goes through the delivery loop: exactly once, and the transcript proves it landed.
		await b.tick();
		await b.tick();
		expect(f.delivered.map((d) => d.file)).toEqual([AH]);
		expect(userTexts(AH)).toHaveLength(1);
		expect(userTexts(BH)).toHaveLength(0);
		expect(userTexts(CH)).toHaveLength(0);
		const p = b.byId(res.post.id)!;
		expect(p.pending).toBeUndefined();
		expect(Object.keys(p.sent ?? {}).sort()).toEqual(["alpha", "beta"]);
		expect(p.sent?.alpha.how).toBe("turn");
		expect(p.sent?.beta.how).toBe("steer");
		// Got directly = read; gamma hasn't seen it yet.
		expect(Object.keys(p.reads ?? {}).sort()).toEqual(["alpha", "beta"]);
		// The direct turn's text: header, title, text, no-reply hint, ack line.
		const t = f.delivered[0].text;
		expect(boardOrderIdOf(t)).toBe(res.post.id);
		expect(t).toContain("**Pause new work**");
		expect(t).toContain("It asks for no reply.");
		expect(t.endsWith(`When you have acted on it: board ack ${res.post.id} "<what you did>"`)).toBe(true);
	});

	it("news never pokes anyone, even roles with everything waiting", async () => {
		const f = three();
		for (const r of ["alpha", "beta", "gamma"]) {
			f.states.set(r, st(r, { home: join(dir, `${r}-home.jsonl`), midTurn: [BT], openTasks: 3, openRequests: 2 }));
		}
		f.running.add(BT);
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post(
			{ owner: true },
			{ kind: "news", to: "all", title: "New Roles page", text: "It has a Board view." },
		);
		if (!res.ok) throw new Error(res.error);
		await b.tick();
		expect(res.direct).toEqual([]);
		expect(res.later).toEqual(["alpha", "beta", "gamma", "delta"]);
		expect(f.stateReads).toBe(0);
		expect(f.steers).toEqual([]);
		expect(f.delivered).toEqual([]);
		expect(b.byId(res.post.id)?.sent).toBeUndefined();
	});

	it("waits while the home chat works or is busy, backs off after an error, and never sends twice", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH, openRequests: 1 }));
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "T", text: "X" });
		if (!res.ok) throw new Error(res.error);
		f.chatState.set(AH, "working");
		await b.tick();
		expect(f.delivered).toEqual([]);
		f.chatState.set(AH, "idle");
		f.busy = true;
		await b.tick();
		expect(f.delivered).toEqual([]);
		expect(b.byId(res.post.id)?.pending?.alpha.attempts).toBe(0);
		f.busy = false;
		f.fail = "the server is restarting";
		await b.tick();
		expect(b.byId(res.post.id)?.pending?.alpha).toMatchObject({ attempts: 1, error: "the server is restarting" });
		f.fail = undefined;
		await b.tick();
		expect(f.delivered).toEqual([]);
		now += 16_000;
		await b.tick();
		await b.tick();
		expect(f.delivered).toHaveLength(1);
		expect(b.byId(res.post.id)?.pending).toBeUndefined();
	});

	it("a send that never lands is sent again once the chat has been idle 30 s, at most 3 times", async () => {
		const f = three();
		f.lands = false;
		f.states.set("alpha", st("alpha", { home: AH, openTasks: 1 }));
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "T", text: "X" });
		if (!res.ok) throw new Error(res.error);
		await b.tick();
		expect(f.delivered).toHaveLength(1);
		await b.tick();
		now += 10_000;
		await b.tick();
		expect(f.delivered).toHaveLength(1);
		for (let i = 0; i < 6; i++) {
			now += 31_000;
			await b.tick();
			await b.tick();
		}
		expect(f.delivered).toHaveLength(3);
		expect(b.byId(res.post.id)?.pending).toBeUndefined();
	});

	it("no direct turn when the home chat saw the order at a turn of its own first, or the post was closed", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH, openTasks: 1 }));
		f.states.set("beta", st("beta", { home: BH, openTasks: 1 }));
		f.chatState.set(AH, "working");
		f.chatState.set(BH, "working");
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "T", text: "X" });
		const res2 = await b.post({ owner: true }, { kind: "order", to: ["beta"], title: "T2", text: "X2" });
		if (!res.ok || !res2.ok) throw new Error("not posted");
		landNote(AH, { v: 1, epoch: b.epoch, upTo: 1, open: [res.post.id], ids: [res.post.id] });
		expect(b.close({ owner: true }, res2.post.id, "pause lifted")).toMatchObject({ ok: true });
		f.chatState.set(AH, "idle");
		f.chatState.set(BH, "idle");
		await b.tick();
		expect(f.delivered).toEqual([]);
		expect(b.byId(res.post.id)?.pending).toBeUndefined();
		expect(b.byId(res.post.id)?.sent).toBeUndefined();
		expect(b.byId(res2.post.id)?.pending).toBeUndefined();
	});

	it("gives a direct turn up after 24 hours (the role still sees the order at its next turn)", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH, openTasks: 1 }));
		f.chatState.set(AH, "working");
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "T", text: "X" });
		if (!res.ok) throw new Error(res.error);
		now += DAY + MIN;
		f.chatState.set(AH, "idle");
		await b.tick();
		expect(f.delivered).toEqual([]);
		expect(b.byId(res.post.id)?.pending).toBeUndefined();
		expect(b.openOrdersOf("alpha").map((o) => o.id)).toEqual([res.post.id]);
	});

	it("a role whose state can't be read sees the order at its next turn (no poke)", async () => {
		const f = three();
		f.host.roleStates = async () => {
			throw new Error("overview failed");
		};
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "T", text: "X" });
		expect(res).toMatchObject({ ok: true, direct: [], later: ["alpha"] });
		await b.tick();
		expect(f.delivered).toEqual([]);
	});
});

describe("who posts what", () => {
	it("a role's order needs the owner's words; with them it is the owner's, via that role", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		expect(await b.post({ role: "alpha" }, { kind: "order", to: "all", title: "T", text: "X" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("ownerWords"),
		});
		const res = await b.post(
			{ role: "alpha" },
			{ kind: "order", to: "all", title: "T", text: "X", ownerWords: 'Owner on Telegram 12:25: "pause it"' },
		);
		if (!res.ok) throw new Error(res.error);
		expect(res.post).toMatchObject({ from: "owner", via: "alpha", ownerWords: 'Owner on Telegram 12:25: "pause it"' });
		// Its author doesn't get its own post.
		expect(b.audience(res.post)).toEqual(["beta", "gamma", "delta"]);
		const news = await b.post({ role: "alpha" }, { kind: "news", to: ["beta"], title: "N", text: "Y" });
		expect(news).toMatchObject({ ok: true, post: { from: "alpha", kind: "news", to: ["beta"] } });
		if (news.ok) expect(news.post.via).toBeUndefined();
	});

	it("checks kind, title, text, to, and the hourly cap for a role (the owner has none)", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const base = { kind: "news", to: ["beta"], title: "T", text: "X" };
		expect(await b.post({ owner: true }, { ...base, kind: "memo" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("kind"),
		});
		expect(await b.post({ owner: true }, { ...base, title: " " })).toMatchObject({ ok: false });
		expect(await b.post({ owner: true }, { ...base, title: "t".repeat(101) })).toMatchObject({
			ok: false,
			error: expect.stringContaining("100"),
		});
		expect(await b.post({ owner: true }, { ...base, text: "x".repeat(2001) })).toMatchObject({
			ok: false,
			error: expect.stringContaining("2000"),
		});
		expect(await b.post({ owner: true }, { ...base, to: ["nobody"] })).toMatchObject({
			ok: false,
			error: expect.stringContaining("no role nobody"),
		});
		expect(await b.post({ owner: true }, { ...base, to: [] })).toMatchObject({ ok: false });
		expect(await b.post({ role: "beta" }, { ...base, to: ["beta"] })).toMatchObject({
			ok: false,
			error: expect.stringContaining("nobody to post it to"),
		});
		for (let i = 0; i < BOARD_POSTS_PER_HOUR; i++) {
			expect(await b.post({ role: "alpha" }, base)).toMatchObject({ ok: true });
		}
		expect(await b.post({ role: "alpha" }, base)).toMatchObject({ ok: false, error: expect.stringContaining("cap") });
		expect(await b.post({ owner: true }, base)).toMatchObject({ ok: true });
		now += 61 * MIN;
		expect(await b.post({ role: "alpha" }, base)).toMatchObject({ ok: true });
	});
});

describe("what a chat sees at the start of a turn", () => {
	it("orders in every chat of a listed role, news only in its home chat (any chat of a role without one)", async () => {
		const order = { kind: "order" as const, to: ["beta"] as string[], from: "owner" };
		const news = { kind: "news" as const, to: "all" as const, from: "alpha" };
		expect(postShownIn(order, "beta", false)).toBe(true);
		expect(postShownIn(order, "beta", true)).toBe(true);
		expect(postShownIn(order, "gamma", true)).toBe(false);
		expect(postShownIn(news, "beta", true)).toBe(true);
		expect(postShownIn(news, "beta", false)).toBe(false);
		expect(postShownIn(news, "alpha", true)).toBe(false);
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		await b.post({ owner: true }, { kind: "order", to: ["beta"], title: "O", text: "do it" });
		await b.post({ owner: true }, { kind: "news", to: "all", title: "N", text: "know it" });
		const home = b.turnNote(chatOf("beta", true));
		const task = b.turnNote(chatOf("beta", false));
		expect(home?.fresh.map((p) => p.title)).toEqual(["O", "N"]);
		expect(task?.fresh.map((p) => p.title)).toEqual(["O"]);
		expect(task?.text.startsWith("[Board] 1 new post\n\nOrder bp-")).toBe(true);
		expect(home?.text.startsWith("[Board] 2 new posts\n\n")).toBe(true);
		expect(b.turnNote(chatOf("gamma", false))).toBeUndefined();
		// delta has no home chat: the caller passes isHome true for all its chats.
		expect(b.turnNote(chatOf("delta", true))?.fresh.map((p) => p.title)).toEqual(["N"]);
	});

	it("a chat's first turn sees open orders, plus in a home chat news from the last 3 days", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		await b.post({ owner: true }, { kind: "news", to: "all", title: "old news", text: "x" });
		await b.post({ owner: true }, { kind: "order", to: "all", title: "old order", text: "x" });
		const gone = await b.post({ owner: true }, { kind: "order", to: "all", title: "closed order", text: "x" });
		if (gone.ok) b.close({ owner: true }, gone.post.id, "done");
		now += 4 * DAY;
		await b.post({ owner: true }, { kind: "news", to: "all", title: "new news", text: "x" });
		const note = b.turnNote(chatOf("gamma", true));
		expect(note?.fresh.map((p) => p.title)).toEqual(["old order", "new news"]);
		expect(note?.ended).toEqual([]);
	});

	it("shows only what came after the chat's mark, and nothing at all when nothing is new", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		await b.post({ owner: true }, { kind: "order", to: "all", title: "first", text: "x" });
		const n1 = b.turnNote(chatOf("gamma", false))!;
		expect(n1.details).toMatchObject({ v: 1, epoch: b.epoch, upTo: 1, ids: [n1.fresh[0].id] });
		expect(b.turnNote(chatOf("gamma", false, n1.details))).toBeUndefined();
		await b.post({ owner: true }, { kind: "order", to: "all", title: "second", text: "x" });
		const n2 = b.turnNote(chatOf("gamma", false, n1.details))!;
		expect(n2.fresh.map((p) => p.title)).toEqual(["second"]);
		expect(n2.details.open.sort()).toEqual([n1.fresh[0].id, n2.fresh[0].id].sort());
		// A mark from another store (the file was lost) counts as none: open orders again.
		const foreign = { ...n2.details, epoch: "00000000" };
		expect(b.turnNote(chatOf("gamma", false, foreign))?.fresh.map((p) => p.title)).toEqual(["first", "second"]);
	});

	it("orders in full with the ack line; news cut at about 600 characters with board read for the rest", async () => {
		const long = `${"word ".repeat(200)}END`;
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const o = await b.post({ owner: true }, { kind: "order", to: ["gamma"], title: "Long order", text: long });
		const n = await b.post({ owner: true }, { kind: "news", to: ["gamma"], title: "Long news", text: long });
		if (!o.ok || !n.ok) throw new Error("not posted");
		const text = b.turnNote(chatOf("gamma", true))!.text;
		expect(text).toContain(long);
		expect(text).toContain(`When you have acted on it: board ack ${o.post.id} "<what you did>"`);
		const newsPart = text.slice(text.indexOf(`News ${n.post.id}`));
		expect(newsPart).not.toContain("END");
		expect(newsPart).toContain(`(the rest: board read ${n.post.id})`);
		expect(newsPart).not.toContain("board ack");
		const cut = cutText(long);
		expect(cut.cut).toBe(true);
		expect(cut.text.length).toBeLessThanOrEqual(BOARD_NEWS_CUT + 2);
		expect(cut.text.endsWith(" …")).toBe(true);
		expect(cutText("short")).toEqual({ text: "short", cut: false });
	});

	it("an order the chat got directly counts as seen there; once closed it is shown once as ended", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["gamma"], title: "Pause", text: "x" });
		if (!res.ok) throw new Error(res.error);
		const n1 = b.turnNote(chatOf("gamma", true, undefined, [res.post.id]));
		expect(n1).toBeUndefined();
		b.close({ owner: true }, res.post.id, "pause lifted");
		const n2 = b.turnNote(chatOf("gamma", true, undefined, [res.post.id]))!;
		expect(n2.text).toBe(
			`[Board] 1 post ended\n\nEnded: order ${res.post.id} "Pause", closed by owner ${n2.text.match(/closed by owner (.+): pause lifted$/)?.[1]}: pause lifted`,
		);
		expect(n2.details.open).toEqual([]);
		expect(n2.details.ended).toEqual([res.post.id]);
		expect(b.turnNote(chatOf("gamma", true, n2.details))).toBeUndefined();
	});

	it("a post closed after a chat saw it is shown there once as ended (and never in a chat that didn't)", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "news", to: ["gamma"], title: "Freeze", text: "x" });
		if (!res.ok) throw new Error(res.error);
		const seen = b.turnNote(chatOf("gamma", true))!;
		b.close({ owner: true }, res.post.id, "over");
		const ended = b.turnNote(chatOf("gamma", true, seen.details))!;
		expect(ended.text.startsWith("[Board] 1 post ended")).toBe(true);
		expect(ended.fresh).toEqual([]);
		expect(b.turnNote(chatOf("gamma", true, ended.details))).toBeUndefined();
		expect(b.turnNote(chatOf("beta", true))).toBeUndefined();
	});

	it("a role's read time is set the first time any of its chats sees the post", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "order", to: ["beta"], title: "O", text: "x" });
		if (!res.ok) throw new Error(res.error);
		expect(b.byId(res.post.id)?.reads).toBeUndefined();
		const first = now;
		b.turnNote(chatOf("beta", false));
		now += 5 * MIN;
		b.turnNote(chatOf("beta", true));
		expect(b.byId(res.post.id)?.reads).toEqual({ beta: first });
	});

	it("one note shows at most 20 posts and points to board read for the rest", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		for (let i = 0; i < BOARD_NOTE_POSTS_MAX + 2; i++) {
			await b.post({ owner: true }, { kind: "order", to: ["gamma"], title: `o${i}`, text: "x" });
		}
		const n = b.turnNote(chatOf("gamma", true))!;
		expect(n.fresh).toHaveLength(BOARD_NOTE_POSTS_MAX);
		expect(n.text.startsWith(`[Board] ${BOARD_NOTE_POSTS_MAX} new posts`)).toBe(true);
		expect(n.text).toContain("… and 2 more: board read");
	});

	it("boardNote is pure: it marks nothing; the empty board makes no note", () => {
		const n = boardNote({ epoch: "e", seq: 0, posts: [] }, chatOf("gamma", true), now);
		expect(n).toBeUndefined();
	});
});

describe("a chat's mark, from its transcript", () => {
	it("is its newest note's details, plus the orders it got directly after that note", () => {
		const mark1 = { v: 1, epoch: "e1", upTo: 1, open: ["bp-00000001"], ids: ["bp-00000001"] };
		const mark2 = { v: 1, epoch: "e1", upTo: 3, open: ["bp-00000003"], ids: ["bp-00000003"] };
		const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
		const entries = [
			{ type: "custom_message", customType: "board", details: mark1 },
			user("[Board order bp-00000002 from owner · 2026-10-06 12:00 PDT]\n\n**x**"),
			{ type: "custom_message", customType: "board", details: mark2 },
			user("hello"),
			user("[Board order bp-00000004 from owner (via coo) · 2026-10-06 12:30 PDT]\n\n**y**"),
			{ type: "custom_message", customType: "role-message", details: mark1 },
		];
		expect(boardChatState(entries)).toEqual({
			mark: { v: 1, epoch: "e1", upTo: 3, open: ["bp-00000003"] },
			got: ["bp-00000004"],
		});
		expect(boardChatState([user("[Board order bp-0000000z from owner · x]")])).toEqual({ got: [] });
		expect(boardOrderIdOf("[Board order bp-1234abcd from owner · x]")).toBe("bp-1234abcd");
		expect(boardOrderIdOf("[Board] 1 new post")).toBeUndefined();
	});

	it("transcriptSawPost finds the order's own turn, or a note that listed it, after the given byte", async () => {
		const file = chat("t");
		const from = readFileSync(file).length;
		expect(await transcriptSawPost(file, 0, "bp-0000000a")).toBeUndefined();
		landNote(file, { v: 1, epoch: "e", upTo: 1, open: ["bp-0000000a"], ids: ["bp-0000000a"] });
		expect(await transcriptSawPost(file, from, "bp-0000000a")).toBe("note");
		land(file, "[Board order bp-0000000b from owner · 2026-10-06 12:00 PDT]\n\nx");
		expect(await transcriptSawPost(file, from, "bp-0000000b")).toBe("turn");
		expect(await transcriptSawPost(file, readFileSync(file).length, "bp-0000000b")).toBeUndefined();
		// Only a user message counts as the turn (a quote in an assistant's text doesn't).
		appendFileSync(
			file,
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "[Board order bp-0000000c from owner · x]" }] } })}\n`,
		);
		expect(await transcriptSawPost(file, from, "bp-0000000c")).toBeUndefined();
	});
});

describe("acks and closing", () => {
	it("a role marks an order done once; a second ack replaces its note; nothing goes to the poster", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH }));
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post(
			{ role: "beta" },
			{ kind: "order", to: ["alpha", "gamma"], title: "Pause", text: "x", ownerWords: "Owner 10:30: pause" },
		);
		if (!res.ok) throw new Error(res.error);
		expect(openOrdersFor(b.view().posts, "alpha").map((o) => o.id)).toEqual([res.post.id]);
		expect(b.ack("alpha", res.post.id, " ")).toMatchObject({ ok: false, error: expect.stringContaining("note") });
		const first = b.ack("alpha", res.post.id, "paused two tasks");
		expect(first).toMatchObject({ ok: true });
		expect(first.ok && first.replaced).toBeFalsy();
		const again = b.ack("alpha", res.post.id, "paused three tasks");
		expect(again).toMatchObject({ ok: true, replaced: true });
		const p = b.byId(res.post.id)!;
		expect(p.done).toEqual({ alpha: { at: now, note: "paused three tasks" } });
		expect(p.reads?.alpha).toBe(now);
		expect(openOrdersFor(b.view().posts, "alpha")).toEqual([]);
		expect(b.openOrdersOf("gamma").map((o) => o.id)).toEqual([res.post.id]);
		expect(f.steers).toEqual([]);
		expect(f.delivered).toEqual([]);
		// Not listed, or its author: no ack.
		expect(b.ack("delta", res.post.id, "x")).toMatchObject({
			ok: false,
			error: expect.stringContaining("isn't for delta"),
		});
		expect(b.ack("beta", res.post.id, "x")).toMatchObject({ ok: false });
	});

	it("news is never acked; an unknown id is refused", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ owner: true }, { kind: "news", to: "all", title: "N", text: "x" });
		if (!res.ok) throw new Error(res.error);
		expect(b.ack("alpha", res.post.id, "read it")).toMatchObject({ ok: false, error: expect.stringContaining("news") });
		expect(b.ack("alpha", "bp-ffffffff", "x")).toMatchObject({ ok: false, error: expect.stringContaining("no post") });
	});

	it("only its author or the owner closes a post, once, with an optional note", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const res = await b.post({ role: "alpha" }, { kind: "news", to: ["beta"], title: "N", text: "x" });
		if (!res.ok) throw new Error(res.error);
		expect(b.close({ role: "beta" }, res.post.id, "")).toMatchObject({
			ok: false,
			error: expect.stringContaining("author"),
		});
		expect(b.close({ role: "alpha" }, res.post.id, "no longer true")).toMatchObject({
			ok: true,
			post: { closed: { at: now, by: "alpha", note: "no longer true" } },
		});
		expect(b.close({ owner: true }, res.post.id, "")).toMatchObject({
			ok: false,
			error: expect.stringContaining("already closed"),
		});
		// The owner closes an order a role posted for him (via it), and the role that relayed it may too.
		const order = await b.post(
			{ role: "alpha" },
			{ kind: "order", to: ["beta"], title: "O", text: "x", ownerWords: "Owner: do it" },
		);
		if (!order.ok) throw new Error(order.error);
		expect(b.close({ role: "alpha" }, order.post.id, "")).toMatchObject({
			ok: true,
			post: { closed: { by: "alpha" } },
		});
		expect(b.openOrdersOf("beta")).toEqual([]);
	});
});

describe("the store", () => {
	it("is written atomically, survives a reload, and the page gets the newest first without its bookkeeping", async () => {
		const f = three();
		f.states.set("alpha", st("alpha", { home: AH, openTasks: 1 }));
		f.chatState.set(AH, "working");
		const b = new RoleBoard(store, f.host, clock);
		const one = await b.post({ owner: true }, { kind: "order", to: ["alpha"], title: "one", text: "x" });
		now += MIN;
		await b.post({ owner: true }, { kind: "news", to: "all", title: "two", text: "y" });
		if (!one.ok) throw new Error("not posted");
		expect(readdirSync(dirname(store))).toEqual(["role-board.json"]);
		const raw = JSON.parse(readFileSync(store, "utf8"));
		expect(raw).toMatchObject({ v: 1, epoch: b.epoch, seq: 2 });
		expect(raw.posts[0].pending.alpha).toMatchObject({ file: AH, sends: 0 });
		// One board per server: the old one stops before the new one reads the file.
		b.stop();
		const again = new RoleBoard(store, f.host, clock);
		expect(again.epoch).toBe(b.epoch);
		const view = again.view().posts;
		expect(view.map((p) => p.title)).toEqual(["two", "one"]);
		expect(view[1]).not.toHaveProperty("seq");
		expect(view[1]).not.toHaveProperty("pending");
		// The direct turn still to deliver carries on after the reload.
		f.chatState.set(AH, "idle");
		await again.tick();
		expect(f.delivered.map((d) => d.file)).toEqual([AH]);
		expect(BOARD_VIEW).toBe(200);
	});

	it("moves a file it can't read aside and starts an empty board", () => {
		const f = three();
		mkdirSync(dirname(store), { recursive: true });
		writeFileSync(store, "{ not json");
		const b = new RoleBoard(store, f.host, clock);
		expect(b.empty).toBe(true);
		expect(existsSync(`${store}.bad-${now}`)).toBe(true);
	});

	it("tells the page when it changes", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		await b.post({ owner: true }, { kind: "news", to: "all", title: "N", text: "x" });
		await new Promise((r) => setTimeout(r, 350));
		expect(f.changed).toBe(1);
	});

	it("audienceOf: all roles or the listed ones, its author left out", () => {
		const ids = ["alpha", "beta", "gamma"];
		expect(audienceOf({ to: "all", from: "owner" }, ids)).toEqual(ids);
		expect(audienceOf({ to: "all", from: "owner", via: "beta" }, ids)).toEqual(["alpha", "gamma"]);
		expect(audienceOf({ to: ["gamma", "gamma", "alpha"], from: "alpha" }, ids)).toEqual(["gamma"]);
	});

	it("an order's direct text names the poster and the relaying role", () => {
		const t = boardOrderText(
			{
				id: "bp-0000abcd",
				at: Date.parse("2026-10-06T19:10:00Z"),
				from: "owner",
				via: "coo",
				kind: "order",
				to: "all",
				title: "T",
				text: "X",
				ownerWords: "Owner 12:25: x",
			},
			"America/Los_Angeles",
		);
		expect(t.split("\n")[0]).toBe("[Board order bp-0000abcd from owner (via coo) · 2026-10-06 12:10 PDT]");
		expect(t).toContain("Owner's words: Owner 12:25: x");
	});
});

describe("the board tool", () => {
	type Exec = (
		id: string,
		p: Record<string, unknown>,
		s?: unknown,
		u?: unknown,
		c?: unknown,
	) => Promise<{ content: { text: string }[] }>;
	function tool(b: RoleBoard | undefined, who: string | { role: string }) {
		const t = makeBoardTool({
			service: () => b,
			sender: () =>
				typeof who === "string" ? who : { role: who.role, title: who.role, chat: "home chat", handling: 0, file: AH },
		});
		return {
			def: t,
			run: (p: Record<string, unknown>) => (t.execute as unknown as Exec)("call", p, undefined, undefined, {}),
		};
	}

	it("is named board, gives the owner's routing rule, and refuses a chat without a role", async () => {
		const f = three();
		const b = new RoleBoard(store, f.host, clock);
		const t = tool(b, "Only a chat with a role can use the board.");
		expect(t.def.name).toBe(BOARD_TOOL_NAME);
		expect(t.def.description).toContain("if a role has something waiting");
		expect(t.def.description).toContain("general info goes on the board");
		await expect(t.run({ action: "read" })).rejects.toThrow("Only a chat with a role");
		await expect(tool(undefined, { role: "alpha" }).run({ action: "read" })).rejects.toThrow("isn't available");
	});

	it("posts, reads, acks and closes for the calling chat's role", async () => {
		const f = three();
		f.states.set("beta", st("beta", { home: BH }));
		const b = new RoleBoard(store, f.host, clock);
		const alpha = tool(b, { role: "alpha" });
		const beta = tool(b, { role: "beta" });
		await expect(alpha.run({ action: "post", kind: "order", to: ["beta"], title: "T", text: "X" })).rejects.toThrow(
			"ownerWords",
		);
		const posted = await alpha.run({
			action: "post",
			kind: "order",
			to: ["beta"],
			title: "Pause",
			text: "Start nothing new.",
			ownerWords: 'Owner on Telegram 10:30, via COO: "pause"',
		});
		const id = posted.content[0].text.match(/bp-[0-9a-f]{8}/)![0];
		expect(posted.content[0].text).toContain("No listed role has something waiting, so none was poked.");
		const list = await beta.run({ action: "read" });
		expect(list.content[0].text).toContain(`order ${id} · from owner (via alpha)`);
		expect(list.content[0].text).toContain("you: not done yet");
		expect(b.byId(id)?.reads?.beta).toBe(now);
		expect((await beta.run({ action: "ack", id, note: "paused" })).content[0].text).toBe(
			`Marked ${id} done for beta. Nothing is sent to the poster; the board shows it.`,
		);
		const full = await alpha.run({ action: "read", id });
		expect(full.content[0].text).toContain("Done 1/1:");
		expect(full.content[0].text).toContain("- beta (");
		await expect(beta.run({ action: "close", id })).rejects.toThrow("author");
		expect((await alpha.run({ action: "close", id, note: "pause lifted" })).content[0].text).toContain(`Closed ${id}.`);
		const news = await alpha.run({ action: "post", kind: "news", to: ["all"], title: "N", text: "x" });
		expect(news.content[0].text).toContain("It wakes nobody");
		await expect(alpha.run({ action: "shout" })).rejects.toThrow("action must be");
	});
});
