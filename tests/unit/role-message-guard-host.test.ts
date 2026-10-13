// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16). Real RoleMessages + real E core/store + real A adapters; only the chats and the clock are fake.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskHub } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import { chooseGrant, RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import {
	ROLE_MESSAGE_CHAIN_MAX,
	RoleMessages,
	type RoleMessageHost,
	type RoleMessageSender,
} from "../../server/role-messages.js";

// Long chains with real files and a real journal: allow more than the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

let dir = "";
let now = Date.parse("2026-10-12T12:00:00Z");
const clock = () => now;
const made: Array<{ stop(): void }> = [];

function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
function land(file: string, text: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
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

interface World {
	rm: RoleMessages;
	host: RoleMessageGuardHost;
	hub: AskHub;
	/** Every text that landed in a chat, in order (deliver = a turn; note = an FYI without one). */
	got: Array<{ file: string; text: string; via: "deliver" | "note" }>;
	roles: IdentityDef[];
	changed: number;
	logs: string[];
}
let A = "";
let B = "";
let C = "";
let G = "";
let data = "";

async function world(prev?: World): Promise<World> {
	const w: World = prev
		? { ...prev, changed: 0 }
		: ({
				got: [],
				roles: [role("alpha", A), role("beta", B), role("coo", C), role("gamma", G)],
				hub: new AskHub(),
				changed: 0,
				logs: [],
			} as unknown as World);
	const host: RoleMessageHost = {
		roles: () => w.roles,
		chatState: () => "idle",
		deliver: async (file, text) => {
			w.got.push({ file, text, via: "deliver" });
			land(file, text);
			return { ok: true };
		},
		note: async (file, text) => {
			w.got.push({ file, text, via: "note" });
			appendFileSync(
				file,
				`${JSON.stringify({ type: "custom_message", customType: "role-message", content: [{ type: "text", text }], display: true })}\n`,
			);
			return { ok: true };
		},
		log: (l) => w.logs.push(l),
	};
	w.rm = new RoleMessages(join(data, "role-messages.json"), host, clock);
	w.host = new RoleMessageGuardHost({
		dir: join(data, "role-message-guard"),
		roleMessages: () => w.rm,
		identities: () => w.roles,
		askHub: w.hub,
		questionsChanged: () => {
			w.changed++;
		},
		log: (l) => w.logs.push(l),
		now: clock,
	});
	made.push(w.rm, w.host);
	await w.host.start();
	expect(w.host.state).toEqual({ status: "ready", reason: "" });
	return w;
}

/** The last thing that started a turn in this chat (where the chat stands in its chain). */
function lastIn(w: World, file: string): string {
	return [...w.got].reverse().find((g) => g.file === file && g.via === "deliver")?.text ?? "";
}
function who(w: World, roleId: string, file: string, lastUserText = lastIn(w, file)): RoleMessageSender {
	const isHome = w.roles.find((r) => r.id === roleId)?.homeChat === file;
	return {
		role: roleId,
		title: roleId.toUpperCase(),
		chat: isHome ? "home chat" : "a chat",
		file,
		handling: 0,
		guard: { bindingId: file, isHome, lastUserText },
	};
}
let call = 0;
const tc = () => `tc-${++call}`;
async function send(
	w: World,
	from: string,
	file: string,
	to: string,
	extra: Record<string, unknown> = {},
	last?: string,
) {
	const r = await w.host.send(
		who(w, from, file, last),
		{ to, kind: "request", text: `hello from ${from}`, ...extra },
		tc(),
	);
	await w.rm.tick();
	return r;
}
const homes = () => ({ alpha: A, beta: B, coo: C, gamma: G }) as Record<string, string>;
/** Alpha and beta talk back and forth until the next send would be message `hop` (each lands before the next). */
async function chainTo(w: World, hop: number): Promise<{ from: string; file: string; to: string }> {
	let from = "alpha";
	let to = "beta";
	for (let h = 1; h < hop; h++) {
		const r = await send(w, from, homes()[from], to);
		expect(r, `hop ${h}`).toMatchObject({ ok: true });
		[from, to] = [to, from];
	}
	return { from, file: homes()[from], to };
}
const context = {
	goal: "finish the hand-off",
	progressAndChanges: "two of three parts done",
	priorDecisions: ["owner chose the ladder"],
	whyNeeded: "the last part needs one more exchange",
	nextStepAndOutcome: "send the result and stop",
	outstandingQuestions: ["is the result accepted?"],
	optionsAndTradeoffs: ["grant: finish now", "deny: owner picks it up"],
	timeCostRisk: "minutes; no spend",
	exactCommunicationAuthority: "messages to the named roles only",
	declaredClaims: [],
	safetyScopeAndHolds: ["no pause or hold changes"],
};
async function ask(w: World, from: string, file: string, recipients: string[], quantity?: number, last?: string) {
	const r = await w.host.approval(
		who(w, from, file, last),
		{ action: "request", recipients, context, ...(quantity ? { quantity } : {}) },
		tc(),
	);
	await w.rm.tick();
	return r;
}
async function cooDecides(w: World, requestId: string, choice: string) {
	const r = await w.host.approval(
		who(w, "coo", C),
		{ action: "decide", requestId, generation: "1", choice, reason: "fine" },
		tc(),
	);
	await w.rm.tick();
	return r;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rmguard-host-"));
	now = Date.parse("2026-10-12T12:00:00Z");
	A = chat("alpha-home");
	B = chat("beta-home");
	C = chat("coo-home");
	G = chat("gamma-home");
	data = join(dir, "data");
});
afterEach(() => {
	for (const s of made.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("ladder: ordinary hops and the 7th", () => {
	it("hops 1-6 go as today; hop 7 becomes an approval request (not a refusal)", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const seventh = await send(w, at.from, at.file, at.to);
		expect(seventh).toMatchObject({ ok: false, approvalRequired: { hop: 7, tier: "lower", approver: "the COO" } });
		expect((seventh as { error: string }).error).toContain("Approval needed");
		expect(w.rm.recent(0).filter((m) => !m.guard)).toHaveLength(6);
	});

	it("FE32/H7 counterfactual: the old rule refuses the 7th hop, the ladder asks for approval", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		// Old code: the native send (still the degraded path) with its hard limit of 6.
		const old = w.rm.send(
			{ ...who(w, at.from, at.file, last), handling: w.rm.handlingDepth(at.file, last) },
			{ to: at.to, kind: "fyi", text: "done" },
		);
		expect(ROLE_MESSAGE_CHAIN_MAX).toBe(6);
		expect(old).toMatchObject({ ok: false });
		expect((old as { error: string }).error).not.toContain("Approval needed");
		const ladder = await send(w, at.from, at.file, at.to, { text: "done" });
		expect(ladder).toMatchObject({ ok: false, approvalRequired: { hop: 7, tier: "lower" } });
	});

	it("a COO grant for 7-11 is finite: 5 sends at most, never past 11; hop 12 needs the owner", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		expect(req).toMatchObject({ ok: true, details: { tier: "lower", quantity: 5, upperHop: 11 } });
		// The COO's home got the request as a typed control message (it starts a turn there).
		expect(lastIn(w, C)).toContain(at.from);
		const requestId = (req.details as { requestId: string }).requestId;
		expect(await cooDecides(w, requestId, "requested_quantity")).toMatchObject({ ok: true });
		// The requester heard the decision; its place in the chain is unchanged (control messages don't add a hop).
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			const r = await send(w, from, homes()[from], to);
			expect(r, `hop ${h}: ${JSON.stringify(r).slice(0, 300)}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		const twelfth = await send(w, from, homes()[from], to);
		expect(twelfth).toMatchObject({ ok: false, approvalRequired: { hop: 12, tier: "owner", approver: "the owner" } });
	});

	it("the five-send cap counts every accepted send, fan-out on one hop included", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to, "gamma"]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w, at.file);
		for (let i = 0; i < 5; i++) {
			const r = await send(w, at.from, at.file, i % 2 ? "gamma" : at.to, {}, last);
			expect(r, `use ${i + 1}`).toMatchObject({ ok: true });
		}
		const sixth = await send(w, at.from, at.file, at.to, {}, last);
		expect(sixth).toMatchObject({ ok: false });
		expect((sixth as { error: string }).error).toContain("used up; ask again");
	});

	it("a grant expires after 60 minutes (no sliding, no renewal)", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w, at.file);
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		now += 60 * 60 * 1000;
		const late = await send(w, at.from, at.file, at.to, {}, last);
		expect(late).toMatchObject({ ok: false });
		expect((late as { error: string }).error).toContain("expired; ask again");
	});

	it("deny leaves the chain stopped; one_send allows exactly one", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		const r1 = await ask(w, at.from, at.file, [at.to], undefined, last);
		await cooDecides(w, (r1.details as { requestId: string }).requestId, "deny");
		expect(lastIn(w, at.file)).not.toBe(last); // the requester heard the answer
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
		const r2 = await w.host.approval(
			who(w, at.from, at.file, last),
			{ action: "request", recipients: [at.to], context },
			"tc-second",
		);
		await w.rm.tick();
		await cooDecides(w, (r2.details as { requestId: string }).requestId, "one_send");
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const again = await send(w, at.from, at.file, at.to, {}, last);
		expect(again).toMatchObject({ ok: false });
		expect((again as { error: string }).error).toContain("used up; ask again");
	});

	it("a send outside the grant's recipients is refused and charges nothing", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		const req = await ask(w, at.from, at.file, [at.to], undefined, last);
		const requestId = (req.details as { requestId: string }).requestId;
		await cooDecides(w, requestId, "requested_quantity");
		const stray = await send(w, at.from, at.file, "gamma", {}, last);
		expect(stray).toMatchObject({ ok: false });
		expect((stray as { error: string }).error).toContain("gamma isn't a recipient");
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const status = await w.host.approval(
			who(w, at.from, at.file, last),
			{ action: "status", requestId, generation: "1" },
			tc(),
		);
		expect(status.text).toContain("1 of 5 used");
	});
});

describe("ladder: which grant a send uses", () => {
	const actor = { role: "alpha", sessionFile: "/a", task: null } as never;
	const grant = (id: string, over: Record<string, unknown> = {}) =>
		({
			id,
			state: "approved",
			expiresAt: 2_000,
			acceptedUses: 0,
			maximumUses: 5,
			binding: {
				causal: {
					kind: "rooted",
					rootId: "root-1",
					parentId: "m6",
					incomingRecordId: "m6",
					nextHop: 7,
					sourceRevision: "",
					incomingHash: "",
				},
				upperHop: 11,
				scope: { scopeId: "s", operation: "o", participants: ["alpha", "beta"], recipients: ["beta"], task: null },
			},
			...over,
		}) as never;
	const at = (hop: number, incoming: string) =>
		({
			kind: "rooted",
			rootId: "root-1",
			parentId: incoming,
			incomingRecordId: incoming,
			nextHop: hop,
			sourceRevision: "",
			incomingHash: "",
		}) as never;
	// Line: m6 <- m7 <- m8 (granted line); x5 <- x6 is a branch made before the grant's anchor.
	const line: Record<string, { hop: number; parent?: string }> = {
		m6: { hop: 6 },
		m7: { hop: 7, parent: "m6" },
		m8: { hop: 8, parent: "m7" },
		x6: { hop: 6, parent: "x5" },
		x5: { hop: 5 },
	};
	const ancestorAt = (id: string, hop: number) => {
		let r: string | undefined = id;
		while (r && line[r] && line[r].hop > hop) r = line[r].parent;
		return r && line[r]?.hop === hop ? r : undefined;
	};
	const base = { actor, to: "beta", now: 1_000, wanted: null, ancestorAt };

	it("uses the grant on its own line, later hops included", () => {
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(7, "m6") })).toMatchObject({ kind: "use" });
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(9, "m8") })).toMatchObject({ kind: "use" });
	});
	it("a branch made before the grant's anchor can't use it", () => {
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(7, "x6") })).toEqual({ kind: "none" });
	});
	it("a lower grant never covers hop 12; nothing below hop 7 uses a grant", () => {
		line.m11 = { hop: 11, parent: "m8" };
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(12, "m11") })).toEqual({ kind: "none" });
		expect(chooseGrant({ ...base, grants: [grant("g1")], causal: at(6, "m6") })).toEqual({ kind: "none" });
	});
	it("of two live grants, uses the one whose recipients fit", () => {
		const both = [
			grant("g1"),
			grant("g2", {
				expiresAt: 3_000,
				binding: {
					...(grant("g1") as { binding: object }).binding,
					scope: { scopeId: "s", operation: "o", participants: ["alpha"], recipients: ["gamma"], task: null },
				},
			}),
		];
		expect(chooseGrant({ ...base, to: "gamma", grants: both, causal: at(7, "m6") })).toMatchObject({
			kind: "use",
			grant: { id: "g2" },
		});
	});
	it("a spent grant is still handed on, so the sender hears why", () => {
		expect(
			chooseGrant({ ...base, grants: [grant("g1", { acceptedUses: 5, state: "exhausted" })], causal: at(8, "m7") }),
		).toMatchObject({ kind: "use", grant: { id: "g1" } });
	});
});

describe("ladder: who approves", () => {
	it("no self-approval: the requester can't decide its own request", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		const self = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "decide", requestId: (req.details as { requestId: string }).requestId, choice: "requested_quantity" },
			tc(),
		);
		expect(self.ok).toBe(false);
		expect(await send(w, at.from, at.file, at.to)).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("the COO asking for itself goes to the owner", async () => {
		const w = await world();
		// coo and beta talk; the 7th falls to the coo.
		let from = "coo";
		let to = "beta";
		for (let h = 1; h < 7; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(from).toBe("coo");
		const seventhCoo = await send(w, "coo", C, "beta");
		expect(seventhCoo).toMatchObject({ ok: false, approvalRequired: { hop: 7, approver: "the owner" } });
		const req = await ask(w, "coo", C, ["beta"]);
		expect(req).toMatchObject({ ok: true, details: { tier: "owner" } });
		expect((await w.host.openQuestions()).map((q) => q.requesterRole)).toEqual(["coo"]);
	});

	it("owner tier: question only (no agent message, no charge); browser answer grants 12-16 at most", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (r.details as { requestId: string }).requestId, "requested_quantity");
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		const before = w.rm.recent(0).length;
		const cooTurns = w.got.filter((g) => g.file === C).length;
		const req = await ask(w, from, homes()[from], [to]);
		expect(req).toMatchObject({ ok: true, details: { tier: "owner", quantity: 5, upperHop: 16 } });
		expect(w.rm.recent(0).length).toBe(before); // nothing sent to an agent for the owner's question
		expect(w.got.filter((g) => g.file === C).length).toBe(cooTurns);
		expect(w.changed).toBeGreaterThan(0);
		const [q] = await w.host.openQuestions();
		expect(q.ownerQuestion.choices).toEqual(["deny", "one_send", "requested_quantity"]);
		// A plugin pretending to be the browser is refused; only the page's own command (source "browser") counts.
		expect(
			await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["requested_quantity"] }], "browser"),
		).toMatchObject({ ok: false });
		expect(await w.host.ownerAnswer(q.questionId, q.generation, "requested_quantity", "browser")).toEqual({ ok: true });
		await w.rm.tick();
		expect(await w.host.ownerAnswer(q.questionId, q.generation, "deny", "telegram")).toMatchObject({ ok: false });
		expect(await w.host.openQuestions()).toEqual([]);
		for (let h = 12; h <= 16; h++) {
			expect(await send(w, from, homes()[from], to), `hop ${h}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: false });
	});

	it("Telegram: only the authorised plugin's answer counts", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (r.details as { requestId: string }).requestId, "requested_quantity");
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			await send(w, from, homes()[from], to);
			[from, to] = [to, from];
		}
		await ask(w, from, homes()[from], [to]);
		const [q] = await w.host.openQuestions();
		expect(w.hub.get(q.questionId)).toBeTruthy();
		expect(await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["one_send"] }], "company")).toMatchObject({
			ok: false,
		});
		expect(await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["one_send"] }], "telegram")).toMatchObject({
			ok: true,
		});
		await w.rm.tick();
		expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
		expect(await send(w, from, homes()[from], to, {}, lastIn(w, homes()[from]))).toMatchObject({ ok: false });
	});

	it("the COO's one explicit escalation goes to the owner as a question", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		const esc = await cooDecides(w, (req.details as { requestId: string }).requestId, "escalate_owner");
		expect(esc).toMatchObject({ ok: true });
		const qs = await w.host.openQuestions();
		expect(qs).toHaveLength(1);
		expect(qs[0].request.binding.generation.startsWith("owner-escalation-")).toBe(true);
		expect(await w.host.ownerAnswer(qs[0].questionId, qs[0].generation, "one_send", "browser")).toEqual({ ok: true });
		await w.rm.tick();
		expect(await send(w, at.from, at.file, at.to, {}, lastIn(w, at.file))).toMatchObject({ ok: true });
	});
});

describe("ladder: chain identity", () => {
	it("an omitted replyTo, an FYI or a reply keep the hop (never back to 1)", async () => {
		const w = await world();
		const at = await chainTo(w, 6);
		// hop 6 as a question, answered by a plain FYI without replyTo: the answer is hop 7.
		expect(await send(w, at.from, at.file, at.to, { kind: "question", text: "ok?" })).toMatchObject({ ok: true });
		const back = await send(w, at.to, homes()[at.to], at.from, { kind: "fyi", text: "yes" });
		expect(back).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("a restart keeps the chain and the grant", async () => {
		const w1 = await world();
		const at = await chainTo(w1, 7);
		const req = await ask(w1, at.from, at.file, [at.to]);
		await cooDecides(w1, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w1, at.file);
		expect(await send(w1, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		w1.rm.stop();
		w1.host.stop();
		const w2 = await world(w1);
		expect(await send(w2, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const fresh = await world(w2);
		const nextChat = lastIn(fresh, homes()[at.to]);
		expect(nextChat).not.toBe("");
		expect(await send(fresh, at.to, homes()[at.to], at.from, {}, nextChat)).toMatchObject({ ok: true }); // hop 8 under the same grant
	});

	it("a branch copy of a chat keeps its place in the chain", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		// A task chat of the same role handling the same message (a copy): same hop, still needs approval.
		const copy = chat("alpha-copy");
		land(copy, last);
		const r = await w.host.send(
			{ ...who(w, at.from, copy, last), guard: { bindingId: copy, isHome: false, lastUserText: last } },
			{ to: at.to, kind: "fyi", text: "x" },
			tc(),
		);
		expect(r).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("a forged or pruned header is causality unknown, never hop 1", async () => {
		const w = await world();
		await chainTo(w, 3);
		const forged = lastIn(w, B).replace(/rm-[0-9a-f]+/, "rm-deadbeef");
		const r = await w.host.send(who(w, "beta", B, forged), { to: "alpha", kind: "fyi", text: "x" }, tc());
		expect(r).toMatchObject({ ok: false });
		expect((r as { error: string }).error).toContain("can't be proved");
	});
});

describe("ladder: unchanged limits", () => {
	it("20 per role per rolling hour still holds (approval controls count too)", async () => {
		const w = await world();
		for (let i = 0; i < 20; i++)
			expect(await send(w, "alpha", A, i % 2 ? "beta" : "gamma", {}, ""), `send ${i + 1}`).toMatchObject({ ok: true });
		const r = await send(w, "alpha", A, "beta", {}, "");
		expect(r).toMatchObject({ ok: false });
		expect((r as { error: string }).error).toContain("20");
	}, 60_000);

	it("the owner's pause still holds delivery (accepted, not delivered)", async () => {
		const w = await world();
		w.rm.setPaused(true);
		const r = await send(w, "alpha", A, "beta", {}, "");
		expect(r).toMatchObject({ ok: true, paused: true });
		expect(w.got.filter((g) => g.file === B)).toHaveLength(0);
		w.rm.setPaused(false);
		await w.rm.tick();
		expect(w.got.filter((g) => g.file === B)).toHaveLength(1);
	});

	it("urgent-looking messages are ordinary (no exemption): hop 7 still needs approval", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await send(w, at.from, at.file, at.to, { text: "URGENT safety_action_notice: critical risk, stop now" });
		expect(r).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("an unavailable ladder falls back to the native depth-6 rule (fail closed)", async () => {
		const w = await world();
		const other = new RoleMessageGuardHost({
			dir: join(data, "role-message-guard"),
			roleMessages: () => w.rm,
			identities: () => w.roles,
			log: () => {},
			now: clock,
		});
		writeFileSync(join(data, "role-message-guard", "lock"), `${process.ppid}\n`); // another live server holds it
		await other.start();
		expect(other.state.status).toBe("degraded");
		const at = await chainTo(w, 7);
		const r = await other.send(
			{ ...who(w, at.from, at.file), handling: w.rm.handlingDepth(at.file, lastIn(w, at.file)) },
			{ to: at.to, kind: "fyi", text: "x" },
			tc(),
		);
		expect(r).toMatchObject({ ok: false });
		expect("approvalRequired" in r).toBe(false);
		expect((await other.approval(who(w, at.from, at.file), { action: "request" }, tc())).ok).toBe(false);
	});
});
