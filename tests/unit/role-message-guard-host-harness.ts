// role-message-ladder (#122): the shared world of the role-message guard host tests
// (tests/unit/role-message-guard-host-*.test.ts). Real RoleMessages + real E core/store + real A adapters;
// only the chats and the clock are fake. The tests were one file; Ops #230 (docs/test-speed.md) split them
// so vitest runs them side by side. Each test file calls useGuardWorld() once at its top.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { AskHub } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import { RoleMessageGuardHost, type RoleMessageGuardHostOptions } from "../../server/role-message-guard-host.js";
import {
	RoleMessages,
	type RoleMessageHost,
	type RoleMessagePersistence,
	type RoleMessageSender,
} from "../../server/role-messages.js";
import { GUARD_POLICY_V1 } from "../../server/role-message-limits.js";

export let dir = "";
export let now = Date.parse("2026-10-12T12:00:00Z");
/** Tests move the fake clock with this (an imported `now` can be read, not assigned). */
export function setNow(at: number): void {
	now = at;
}
export const clock = () => now;
const made: Array<{ stop(): void }> = [];

export function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
export function land(file: string, text: string): void {
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
}
export const role = (id: string, homeChat?: string): IdentityDef =>
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

export interface World {
	rm: RoleMessages;
	host: RoleMessageGuardHost;
	hub: AskHub;
	/** Every text that landed in a chat, in order (deliver = a turn; note = an FYI without one). */
	got: Array<{ file: string; text: string; via: "deliver" | "note" }>;
	roles: IdentityDef[];
	changed: number;
	logs: string[];
}
export let A = "";
export let B = "";
export let C = "";
export let G = "";
export let data = "";

export async function world(
	prev?: World,
	extra: Partial<RoleMessageGuardHostOptions> = {},
	/** Explicit M cases only; omitted everywhere a persisted copy matters. */
	persistence?: RoleMessagePersistence,
): Promise<World> {
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
	// Existing frozen ladder vectors replay V1 explicitly; expanded tests select V2.
	w.rm = new RoleMessages(join(data, "role-messages.json"), host, clock, extra.policy ?? GUARD_POLICY_V1, persistence);
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
		policy: GUARD_POLICY_V1,
		...extra,
	});
	made.push(w.rm, w.host);
	await w.host.start();
	expect(w.host.state).toEqual({ status: "ready", reason: "" });
	return w;
}

/** The last thing that started a turn in this chat (where the chat stands in its chain). */
export function lastIn(w: World, file: string): string {
	return [...w.got].reverse().find((g) => g.file === file && g.via === "deliver")?.text ?? "";
}
export function who(w: World, roleId: string, file: string, lastUserText = lastIn(w, file)): RoleMessageSender {
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
export const tc = () => `tc-${++call}`;
export async function send(
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
export const homes = () => ({ alpha: A, beta: B, coo: C, gamma: G }) as Record<string, string>;
/** Alpha and beta talk back and forth until the next send would be message `hop` (each lands before the next). */
export async function chainTo(w: World, hop: number): Promise<{ from: string; file: string; to: string }> {
	let from = "alpha";
	let to = "beta";
	for (let h = 1; h < hop; h++) {
		const r = await send(w, from, homes()[from], to);
		expect(r, `hop ${h}`).toMatchObject({ ok: true });
		[from, to] = [to, from];
	}
	return { from, file: homes()[from], to };
}
export const context = {
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
export async function ask(
	w: World,
	from: string,
	file: string,
	recipients: string[],
	quantity?: number,
	last?: string,
) {
	const r = await w.host.approval(
		who(w, from, file, last),
		{ action: "request", recipients, context, ...(quantity ? { quantity } : {}) },
		tc(),
	);
	await w.rm.tick();
	return r;
}
export async function cooDecides(w: World, requestId: string, choice: string) {
	const r = await w.host.approval(
		who(w, "coo", C),
		{ action: "decide", requestId, generation: "1", choice, reason: "fine" },
		tc(),
	);
	await w.rm.tick();
	return r;
}
/** Once at the top of each test file: a fresh folder, chats and clock per test, cleanup after. (Its own 60 s
 *  timeout is gone, Ops #639: vitest.config.ts's hang guard is the only time limit, never a verdict.) */
export function useGuardWorld(): void {
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
}
