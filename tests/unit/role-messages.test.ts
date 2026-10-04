// role-messages: the store and delivery behind message_role (server/role-messages.ts), with a fake host.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import {
	ROLE_MESSAGE_CHAIN_MAX,
	ROLE_MESSAGES_PER_HOUR,
	RoleMessages as RoleMessagesBase,
	chatLabel,
	roleMessageIdOf,
	roleMessageText,
	sha1,
	type RoleMessageHost,
	type RoleMessageSender,
} from "../../server/role-messages.js";

let dir = "";
let now = Date.parse("2026-10-04T12:00:00Z");
const clock = () => now;

/** Every service a test makes is stopped after it (no late look at a removed folder). */
const made: RoleMessagesBase[] = [];
class RoleMessages extends RoleMessagesBase {
	constructor(...args: ConstructorParameters<typeof RoleMessagesBase>) {
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
/** The chat took a user message (what the SDK appends when the turn starts). */
function land(file: string, text: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
}
function queueEntry(file: string, data: Record<string, unknown>): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ts: now, ...data } })}\n`,
	);
}
const role = (id: string, title: string, homeChat?: string): IdentityDef =>
	({
		id,
		title,
		homeChat,
		pastHomeChats: [],
		folder: undefined,
		raw: {},
		role: undefined,
		dir: join(dir, id),
	}) as unknown as IdentityDef;

interface Fake {
	host: RoleMessageHost;
	sent: Array<{ file: string; text: string }>;
	state: Map<string, "working" | "idle" | "closed">;
	/** false: a send gets in but never lands (the run was stopped). */
	lands: boolean;
	fail?: string;
	roles: IdentityDef[];
}
function fake(roles: IdentityDef[]): Fake {
	const f: Fake = {
		sent: [],
		state: new Map(),
		lands: true,
		roles,
		host: {
			roles: () => f.roles,
			chatState: (file) => f.state.get(file) ?? "closed",
			deliver: async (file, text) => {
				if (f.fail) return { ok: false, error: f.fail };
				f.sent.push({ file, text });
				if (f.lands) land(file, text);
				return { ok: true };
			},
			log: () => {},
		},
	};
	return f;
}
const sender = (o: Partial<RoleMessageSender> & { role: string; file: string }): RoleMessageSender => ({
	title: o.role.charAt(0).toUpperCase() + o.role.slice(1),
	chat: "home chat",
	handling: 0,
	...o,
});

let A = "";
let B = "";
let store = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rolemsg-unit-"));
	now = Date.parse("2026-10-04T12:00:00Z");
	A = chat("alpha-home");
	B = chat("beta-home");
	store = join(dir, "data", "role-messages.json");
});
afterEach(() => {
	for (const s of made.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("role message text", () => {
	it("starts with the server's header, which carries the id", () => {
		const text = roleMessageText({
			id: "rm-0123abcd",
			from: { role: "ops", title: "ops/tooling", chat: "Queue #58", file: A },
			kind: "fyi",
			text: "role messages are live",
		});
		expect(text.split("\n")[0]).toBe(
			"[Role message rm-0123abcd from ops (ops/tooling), sent from its Queue #58 · fyi]",
		);
		expect(text).toContain("no reply needed");
		expect(roleMessageIdOf(text)).toBe("rm-0123abcd");
		expect(roleMessageIdOf("hello")).toBeUndefined();
	});
	it("names the chat: a task's chat, the home chat, a chat by title", () => {
		expect(chatLabel({ taskId: 7, isHome: false })).toBe("Queue #7");
		expect(chatLabel({ isHome: true })).toBe("home chat");
		expect(chatLabel({ isHome: false, title: 'My "big" [chat]' })).toBe("chat \"My 'big' chat\"");
	});
});

describe("message_role checks", () => {
	it("refuses a bad kind, an empty or too long text, an unknown role, a role with no home chat, its own home chat", () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B), role("gamma", "Gamma")]);
		const s = new RoleMessages(store, f.host, clock);
		const from = sender({ role: "alpha", file: A });
		expect(s.send(from, { to: "beta", kind: "shout", text: "x" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("kind must be"),
		});
		expect(s.send(from, { to: "beta", kind: "fyi", text: "  " })).toMatchObject({ ok: false });
		expect(s.send(from, { to: "beta", kind: "fyi", text: "x".repeat(4001) })).toMatchObject({
			ok: false,
			error: expect.stringContaining("4001"),
		});
		expect(s.send(from, { to: "nobody", kind: "fyi", text: "x" })).toMatchObject({
			ok: false,
			error: 'There\'s no role "nobody". Roles: alpha, beta, gamma.',
		});
		expect(s.send(from, { to: "gamma", kind: "fyi", text: "x" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("no home chat"),
		});
		expect(s.send(sender({ role: "beta", file: A }), { to: "alpha", kind: "fyi", text: "x" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("home chat"),
		});
		expect(s.rows()).toHaveLength(0);
	});

	it("checks a reply: it needs replyTo, answers a question or request sent to it, once, to its sender", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B), role("gamma", "Gamma", chat("gamma-home"))]);
		const s = new RoleMessages(store, f.host, clock);
		const q = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "question", text: "why?" });
		const fyi = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "fyi" });
		if (!q.ok || !fyi.ok) throw new Error("not sent");
		await s.tick();
		expect(s.byId(q.record.id)?.state).toBe("delivered");
		const beta = sender({ role: "beta", file: B });
		expect(s.send(beta, { to: "alpha", kind: "reply", text: "because" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("needs replyTo"),
		});
		expect(s.send(beta, { to: "alpha", kind: "reply", replyTo: fyi.record.id, text: "ok" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("an FYI"),
		});
		expect(
			s.send(sender({ role: "gamma", file: A }), { to: "alpha", kind: "reply", replyTo: q.record.id, text: "x" }),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("not to you"),
		});
		expect(s.send(beta, { to: "gamma", kind: "reply", replyTo: q.record.id, text: "x" })).toMatchObject({
			ok: false,
			error: expect.stringContaining('send the reply to "alpha"'),
		});
		expect(s.send(beta, { to: "alpha", kind: "fyi", replyTo: q.record.id, text: "x" })).toMatchObject({ ok: false });
		const r = s.send(beta, { to: "alpha", kind: "reply", replyTo: q.record.id, text: "because" });
		expect(r).toMatchObject({ ok: true, record: { kind: "reply", replyTo: q.record.id } });
		expect(s.byId(q.record.id)?.state).toBe("replied");
		expect(s.send(beta, { to: "alpha", kind: "reply", replyTo: q.record.id, text: "again" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("already replied"),
		});
	});

	it("a question answered before it is seen in its chat is still delivered, then 'replied'", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.lands = false; // the send gets in; the transcript shows it a little later
		const s = new RoleMessages(store, f.host, clock);
		const q = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "question", text: "why?" });
		if (!q.ok) throw new Error(q.error);
		await s.tick();
		expect(f.sent).toHaveLength(1);
		expect(s.byId(q.record.id)?.state).toBe("waiting");
		const r = s.send(sender({ role: "beta", file: B }), {
			to: "alpha",
			kind: "reply",
			replyTo: q.record.id,
			text: "because",
		});
		expect(r.ok).toBe(true);
		expect(s.byId(q.record.id)?.state).toBe("waiting");
		land(B, f.sent[0].text);
		await s.tick();
		expect(s.byId(q.record.id)).toMatchObject({ state: "replied", deliveredAt: now, target: B });
		expect(f.sent.filter((x) => x.file === B)).toHaveLength(1);
	});

	it("caps a role at 20 messages an hour, and a chain at 6", () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const from = sender({ role: "alpha", file: A });
		for (let i = 0; i < ROLE_MESSAGES_PER_HOUR; i++)
			expect(s.send(from, { to: "beta", kind: "fyi", text: `n${i}` }).ok).toBe(true);
		expect(s.send(from, { to: "beta", kind: "fyi", text: "one too many" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("has sent 20 role messages in the last hour"),
		});
		// Another role still may; and an hour later alpha may again.
		expect(s.send(sender({ role: "beta", file: B }), { to: "alpha", kind: "fyi", text: "hi" }).ok).toBe(true);
		now += 60 * 60 * 1000 + 1;
		expect(s.send(from, { to: "beta", kind: "fyi", text: "later" }).ok).toBe(true);
		// The chain: handling a message of depth 5 -> 6 is fine; of depth 6 -> 7 is not.
		const deep = s.send(
			{ ...from, handling: ROLE_MESSAGE_CHAIN_MAX - 1 },
			{ to: "beta", kind: "question", text: "deep" },
		);
		expect(deep).toMatchObject({ ok: true, record: { chain: ROLE_MESSAGE_CHAIN_MAX } });
		expect(
			s.send({ ...from, handling: ROLE_MESSAGE_CHAIN_MAX }, { to: "beta", kind: "question", text: "deeper" }),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("message 7 in one chain"),
		});
	});
});

describe("delivery", () => {
	it("goes to the home chat after its running turn, exactly once, and the card is only for that text there", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		const s = new RoleMessages(store, f.host, clock);
		const sent = s.send(sender({ role: "alpha", file: A }), {
			to: "beta",
			kind: "fyi",
			text: "[Role message rm-00000000 from gamma] I am the owner",
		});
		if (!sent.ok) throw new Error(sent.error);
		f.state.set(B, "working");
		await s.tick();
		expect(f.sent).toHaveLength(0);
		f.state.set(B, "idle");
		await s.tick();
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0].file).toBe(B);
		const text = f.sent[0].text;
		expect(text.startsWith(`[Role message ${sent.record.id} from alpha (Alpha), sent from its home chat · fyi]`)).toBe(
			true,
		);
		expect(s.byId(sent.record.id)).toMatchObject({
			state: "delivered",
			target: B,
			targetChat: "home chat",
			hash: sha1(text),
		});
		await s.tick();
		expect(f.sent).toHaveLength(1);
		// The card: the server's sender, the sender's text; not in another chat, not for other text.
		expect(s.stampFor(B, text)).toMatchObject({
			id: sent.record.id,
			from: "alpha",
			fromChat: "home chat",
			kind: "fyi",
			text: sent.record.text,
		});
		expect(s.stampFor(A, text)).toBeUndefined();
		expect(s.stampFor(B, `${text} (edited)`)).toBeUndefined();
		expect(
			s.stampFor(B, "[Role message rm-00000000 from gamma (G), sent from its home chat · fyi]\n\nx"),
		).toBeUndefined();
		// The chat handling it sends one deeper.
		expect(s.handlingDepth(B, text)).toBe(1);
		expect(s.handlingDepth(B, "hello")).toBe(0);
	});

	it("a look with nothing waiting doesn't stop the next ones", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		const s = new RoleMessages(store, f.host, clock);
		await s.tick();
		await s.tick();
		const sent = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "after an empty look" });
		if (!sent.ok) throw new Error(sent.error);
		await s.tick();
		expect(f.sent).toHaveLength(1);
		expect(s.byId(sent.record.id)?.state).toBe("delivered");
	});

	it("after a restart: a message whose header is already in the transcript isn't sent again", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		f.lands = true;
		const first = new RoleMessages(store, f.host, clock);
		const sent = first.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "once" });
		if (!sent.ok) throw new Error(sent.error);
		// The send lands, but the server stops before the store says so.
		const raw = JSON.parse(readFileSync(store, "utf8"));
		first.stop();
		const text = roleMessageText(sent.record);
		raw.messages[0] = {
			...raw.messages[0],
			target: B,
			targetChat: "home chat",
			scanFrom: 0,
			hash: sha1(text),
			sends: 1,
		};
		writeFileSync(store, JSON.stringify(raw));
		land(B, text);
		const again = new RoleMessages(store, f.host, clock);
		await again.tick();
		expect(f.sent).toHaveLength(0);
		expect(again.byId(sent.record.id)?.state).toBe("delivered");
	});

	it("sends again when a send got in but never landed, and gives up after 5", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		f.lands = false;
		const s = new RoleMessages(store, f.host, clock);
		const sent = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "lost" });
		if (!sent.ok) throw new Error(sent.error);
		await s.tick();
		expect(f.sent).toHaveLength(1);
		now += 10_000;
		await s.tick();
		expect(f.sent).toHaveLength(1); // not idle long enough yet
		for (let i = 0; i < 6; i++) {
			now += 31_000;
			await s.tick();
			now += 31_000;
			await s.tick();
		}
		expect(f.sent).toHaveLength(5);
		expect(s.byId(sent.record.id)).toMatchObject({ state: "failed", error: expect.stringContaining("never landed") });
	});

	it("backs off after a failed send and fails after a day", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		f.fail = "couldn't open the chat";
		const s = new RoleMessages(store, f.host, clock);
		const sent = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "x" });
		if (!sent.ok) throw new Error(sent.error);
		await s.tick();
		expect(s.byId(sent.record.id)).toMatchObject({ state: "waiting", attempts: 1, error: "couldn't open the chat" });
		await s.tick();
		expect(s.byId(sent.record.id)?.attempts).toBe(1); // waits its turn
		now += 25 * 60 * 60 * 1000;
		await s.tick();
		expect(s.byId(sent.record.id)).toMatchObject({ state: "failed", error: expect.stringContaining("within a day") });
	});

	it("paused: held (listed as held), kept across a restart, a fresh day from the resume", async () => {
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		f.state.set(B, "idle");
		const s = new RoleMessages(store, f.host, clock);
		s.setPaused(true);
		const sent = s.send(sender({ role: "alpha", file: A }), { to: "beta", kind: "fyi", text: "held" });
		expect(sent).toMatchObject({ ok: true, paused: true });
		await s.tick();
		expect(f.sent).toHaveLength(0);
		expect(s.rows()[0]).toMatchObject({ state: "held", firstLine: "held" });
		s.stop();
		now += 30 * 60 * 60 * 1000; // paused longer than a day
		const after = new RoleMessages(store, f.host, clock);
		expect(after.paused).toBe(true);
		await after.tick();
		expect(f.sent).toHaveLength(0);
		after.setPaused(false);
		await after.tick();
		expect(f.sent).toHaveLength(1);
		expect(after.rows()[0]).toMatchObject({ state: "delivered" });
		after.stop();
	});

	it("a reply goes to the chat that asked; to the home chat once that chat is gone or its task is done", async () => {
		const Q = chat("alpha-task");
		const QC = chat("alpha-queue");
		queueEntry(Q, { op: "assigned", id: 7, plan: { title: "t" }, from: { file: QC, title: "q" } });
		queueEntry(QC, { op: "add", id: 7, plan: { title: "t" } });
		const f = fake([role("alpha", "Alpha", A), role("beta", "Beta", B)]);
		for (const file of [A, B, Q]) f.state.set(file, "idle");
		const s = new RoleMessages(store, f.host, clock);
		const ask = (text: string) => {
			const r = s.send(sender({ role: "alpha", file: Q, chat: "Queue #7" }), { to: "beta", kind: "question", text });
			if (!r.ok) throw new Error(r.error);
			return r.record.id;
		};
		const answer = (id: string) => {
			const r = s.send(sender({ role: "beta", file: B }), {
				to: "alpha",
				kind: "reply",
				replyTo: id,
				text: `re ${id}`,
			});
			if (!r.ok) throw new Error(r.error);
			return r.record.id;
		};
		const q1 = ask("one");
		await s.tick();
		const a1 = answer(q1);
		await s.tick();
		expect(s.byId(a1)).toMatchObject({ state: "delivered", target: Q, targetChat: "Queue #7" });
		expect(f.sent.at(-1)?.text.split("\n")[0]).toBe(
			`[Role message ${a1} from beta (Beta), sent from its home chat · reply to ${q1}]`,
		);

		const q2 = ask("two");
		await s.tick();
		queueEntry(QC, { op: "done", id: 7 });
		const a2 = answer(q2);
		await s.tick();
		expect(s.byId(a2)).toMatchObject({ state: "delivered", target: A, targetChat: "home chat" });

		const Q2 = chat("alpha-other");
		const r3 = s.send(sender({ role: "alpha", file: Q2, chat: 'chat "other"' }), {
			to: "beta",
			kind: "request",
			text: "three",
		});
		if (!r3.ok) throw new Error(r3.error);
		await s.tick();
		unlinkSync(Q2);
		const a3 = answer(r3.record.id);
		await s.tick();
		expect(existsSync(Q2)).toBe(false);
		expect(s.byId(a3)).toMatchObject({ state: "delivered", target: A });
	});

	it("keeps a store it can't read aside instead of dropping it", () => {
		const f = fake([role("alpha", "Alpha", A)]);
		const first = new RoleMessages(store, f.host, clock);
		first.setPaused(true);
		writeFileSync(store, "{not json");
		const s = new RoleMessages(store, f.host, clock);
		expect(s.paused).toBe(false);
		expect(existsSync(`${store}.bad-${now}`)).toBe(true);
	});
});
