// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16). Real RoleMessages + real E core/store + real A adapters; only the chats and the clock are fake.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskHub } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import {
	chooseGrant,
	GUARD_FILE_MAX_BYTES,
	GUARD_RETENTION,
	RoleMessageGuardHost,
	type GuardHistoryLine,
	type RoleMessageGuardHostOptions,
} from "../../server/role-message-guard-host.js";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
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

async function world(prev?: World, extra: Partial<RoleMessageGuardHostOptions> = {}): Promise<World> {
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
		...extra,
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

// Ops cap decision rm-efd6df89, fixed cases (a)-(f) (hypothesis H-ROLE-LADDER-CAPS-1).
describe("ladder: storage caps", () => {
	const stateOf = (w: World) =>
		(w.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_().then((s) => s!);

	// Ops rm-fc4b9788 (option C): settled entries leave after 5 h whatever is open, so a store holds about 5 hours of
	// sends (about 4 transactions each, PRUNE-1). Measured peak: 1188 transactions and audit receipts (caps 3000),
	// 256 outbox entries, 724 tombstones, a 5.1 MB guard file (half of 16 MiB is the bar).
	it("(a) Ops rm-fc4b9788: the worst real 5 hours twice plus 100 runaway sends, with a request open throughout, stay under half", async () => {
		// tests/fixtures/role-message-worst-window.json: the busiest 5 hours of live role messages (metadata only).
		const fixture = JSON.parse(
			readFileSync(new URL("../fixtures/role-message-worst-window.json", import.meta.url), "utf8"),
		) as { rows: [number, number, number, string, number][] };
		const w = await world();
		const names = [...Array.from({ length: 10 }, (_, i) => `r${i}`), "runaway"];
		const home: Record<string, string> = {};
		for (const name of names) {
			home[name] = chat(name);
			w.roles.push(role(name, home[name]));
		}
		// One approval request stays open the whole time (no rotation can run): only the 5 h retention bounds the stores.
		const at = await chainTo(w, 7);
		expect(await ask(w, at.from, at.file, [at.to])).toMatchObject({ ok: true });
		const start = now;
		const second = 6 * 3_600_000; // the second copy starts an hour after the first ends (keeps every role within 20 an hour)
		const events: { at: number; from: string; to: string; kind: string; bytes: number }[] = [];
		for (const offset of [0, second])
			for (const [t, from, to, kind, bytes] of fixture.rows)
				if (from !== to) events.push({ at: offset + t, from: `r${from}`, to: `r${to}`, kind, bytes });
		for (let k = 0; k < 100; k++)
			events.push({ at: second + k * 180_000, from: "runaway", to: "r4", kind: "request", bytes: 4000 });
		events.sort((a, b) => a.at - b.at);
		const worst: Record<string, number> = {};
		let sent = 0;
		for (const e of events) {
			now = Math.max(now, start + e.at);
			// A reply wakes the asker like a request does; the words are as long as the real ones.
			const kind = e.kind === "reply" ? "request" : e.kind;
			const text = `${e.from} to ${e.to}, send ${sent + 1}: `.padEnd(Math.min(e.bytes, 4000), "x");
			const r = await send(w, e.from, home[e.from], e.to, { kind, text }, "");
			expect(r, `send ${sent + 1} (${e.from} at +${Math.round(e.at / 60_000)} min)`).toMatchObject({ ok: true });
			sent++;
			for (const f of w.host.fills(await stateOf(w))) worst[f.name] = Math.max(worst[f.name] ?? 0, f.used / f.max);
		}
		console.log(`(a) ${sent} sends; worst fill per store: ${JSON.stringify(worst)}`);
		expect(sent).toBe(2 * 164 + 100);
		const s = await stateOf(w);
		expect(s.requests.some((r) => r.state === "awaiting_approver")).toBe(true); // still open at the end
		for (const [name, ratio] of Object.entries(worst)) expect(ratio, name).toBeLessThanOrEqual(0.5);
		expect(w.logs.filter((l) => l.includes("guard store generation"))).toHaveLength(0);
	}, 3_600_000);

	it("(b) 15 roles with 20 open requests each fit the open-request cap at half", () => {
		// E refuses a 21st open request per role (request_capacity); the store cap counts only open ones.
		expect(15 * 20).toBeLessThanOrEqual(GUARD_RETENTION.maximumRequests / 2);
		expect(15 * 20).toBeLessThanOrEqual(GUARD_RETENTION.maximumGrants / 2);
		expect(GUARD_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
	});

	it("(c) usage older than an hour is pruned (never kept past 65 minutes)", async () => {
		const w = await world();
		for (let i = 0; i < 3; i++) expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		expect((await stateOf(w)).usage.length).toBeGreaterThanOrEqual(3);
		now += 65 * 60_000;
		expect(await send(w, "beta", B, "alpha", {}, "")).toMatchObject({ ok: true });
		const usage = (await stateOf(w)).usage;
		expect(usage.every((u) => now - u.committedAt < 65 * 60_000)).toBe(true);
		expect(usage.length).toBeLessThan(3);
	});

	it("(d) a full store refuses with the store's name, counts nothing, and warns once at 80%", async () => {
		// An open approval request stops rotation (it waits for quiescence), so the store can fill.
		const w = await world(undefined, { retention: { ...GUARD_RETENTION, maximumTransactions: 60 } });
		const at = await chainTo(w, 7);
		expect(await ask(w, at.from, at.file, [at.to])).toMatchObject({ ok: true });
		let full: Awaited<ReturnType<typeof send>> | null = null;
		let before = { records: 0, hour: 0 };
		let from = "";
		for (let i = 0; i < 30 && !full; i++) {
			from = i % 2 ? "gamma" : "beta";
			before = { records: w.rm.recent(0).length, hour: w.rm.hourlyCount(from) };
			const r = await send(w, from, homes()[from], "coo", {}, "");
			if (!r.ok) full = r;
		}
		expect(full).toMatchObject({ ok: false, reason: "retention_capacity" });
		const error = (full as { error: string }).error;
		expect(error).toMatch(/storage is full \(transactions: \d+ of 60\)/);
		expect(error).toContain("Tell Ops");
		expect({ records: w.rm.recent(0).length, hour: w.rm.hourlyCount(from) }).toEqual(before);
		const warnings = w.logs.filter((l) => l.includes("WARNING: transactions"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/at (8\d|9\d|100)% \(\d+ of 60\)/);
	});

	it("(e) a context over 16 KB is refused whole with its size; 16 KB passes the size check", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const sized = (bytes: number) => {
			const c = { ...context, goal: "" };
			c.goal = "g".repeat(bytes - Buffer.byteLength(JSON.stringify(c)));
			expect(Buffer.byteLength(JSON.stringify(c))).toBe(bytes);
			return c;
		};
		const over = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "request", recipients: [at.to], context: sized(16385) },
			tc(),
		);
		expect(over).toMatchObject({ ok: false, details: { reason: "context_too_large", bytes: 16385 } });
		expect(over.text).toContain("16385 bytes; at most 16384");
		expect((await stateOf(w)).requests).toHaveLength(0);
		const edge = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "request", recipients: [at.to], context: sized(16384) },
			tc(),
		);
		expect(edge.details?.reason).not.toBe("context_too_large");
	});

	it("(f) a reply to a message the store has pruned keeps its hop (and a restart keeps it)", async () => {
		const w = await world();
		await chainTo(w, 4); // alpha 1 -> beta 2 -> alpha 3 -> beta; beta's next is hop 4
		const real = w.rm.recent(0).map((m) => m.id);
		expect(real).toHaveLength(3);
		const betaLast = lastIn(w, B);
		w.rm.stop();
		const file = join(data, "role-messages.json");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { messages: Array<Record<string, unknown>> };
		const m0 = stored.messages[0];
		for (let i = 0; i < 1000; i++)
			stored.messages.push({
				...m0,
				id: `rm-f${i.toString(16).padStart(7, "0")}`,
				from: { ...(m0.from as object), role: "filler" },
				to: "filler",
				at: now - 2 * 86_400_000,
				state: "delivered",
			});
		writeFileSync(file, JSON.stringify(stored));
		const w2 = await world(w);
		// An unrelated send saves the store, which drops the oldest records: the whole real chain.
		expect(await send(w2, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		for (const id of real) expect(w2.rm.byId(id), id).toBeUndefined();
		for (const id of real) expect(w2.rm.chainFact(id), id).toBeDefined();
		expect(existsSync(join(data, "role-messages-chains.jsonl"))).toBe(true);
		// Before the chain memory this was "can't be proved" (the native code even reset it to hop 0).
		expect(await send(w2, "beta", B, "alpha", {}, betaLast)).toMatchObject({ ok: true }); // hop 4
		expect(w2.rm.handlingDepth(B, betaLast)).toBe(3);
		const w3 = await world(w2); // a restart reads the chain memory back
		for (const id of real) expect(w3.rm.chainFact(id), id).toBeDefined();
		let from = "alpha";
		let to = "beta";
		for (let h = 5; h <= 6; h++) {
			expect(await send(w3, from, homes()[from], to), `hop ${h}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await send(w3, from, homes()[from], to)).toMatchObject({
			ok: false,
			approvalRequired: { hop: 7, tier: "lower" },
		});
	});

	it("approval history: metadata only, one line per change, and a write failure never blocks", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		expect(await send(w, at.from, at.file, at.to)).toMatchObject({ ok: true });
		const path = join(data, "role-message-guard", "history.jsonl");
		const raw = readFileSync(path, "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as GuardHistoryLine).event);
		expect(events).toEqual(["request", "decision", "grant", "grant_use"]);
		expect(raw).not.toContain(context.goal);
		// The history file can't be written (a folder in its place): sends and approvals go on.
		rmSync(path);
		mkdirSync(path);
		expect(await send(w, at.to, homes()[at.to], at.from)).toMatchObject({ ok: true });
		expect(w.logs.some((l) => l.includes("history not written"))).toBe(true);
	});
});
