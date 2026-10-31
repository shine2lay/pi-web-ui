/**
 * Ops #676: the host half of relaying an owner's dialog answer from one department's home chat to another's queue.
 * The full native path (real pi-queue, SDK commands) is tests/coupled/queue-owner-relay-native.test.ts; this file
 * pins the coordinator's own guarantees: request shape, home authentication, one-use tickets, honest outcomes, lanes.
 */
import { describe, expect, it } from "vitest";
import {
	OwnerRelayCoordinator,
	ownerRelayRequest,
	type OwnerRelayCapability,
	type OwnerRelayHost,
	type OwnerRelayResult,
} from "../../server/queue-owner-relay.js";

const RECORD = "dr-0123456789ab";
const REQUEST = { role: "rollcall", id: 36, record: RECORD };
const OK: OwnerRelayResult = { status: "relayed", task: { id: 36 }, detail: "sent" };

interface World {
	host: OwnerRelayHost;
	coordinator: OwnerRelayCoordinator;
	/** session id -> its chat: role and file (a role's home when homes[role] is that file). */
	chats: Map<string, { role: string; file: string }>;
	homes: Map<string, string>;
	commands: Array<{ file: string; line: string }>;
	/** What the target home does with its command (default: consume the ticket and finish relayed). */
	onCommand: (file: string, line: string) => Promise<boolean>;
}

function world(): World {
	const chats = new Map([
		["coo-sid", { role: "coo", file: "/chats/coo.jsonl" }],
		["rollcall-sid", { role: "rollcall", file: "/chats/rollcall.jsonl" }],
		["temper-sid", { role: "temper", file: "/chats/temper.jsonl" }],
		["worker-sid", { role: "rollcall", file: "/chats/worker.jsonl" }],
	]);
	const homes = new Map([
		["coo", "/chats/coo.jsonl"],
		["rollcall", "/chats/rollcall.jsonl"],
		["temper", "/chats/temper.jsonl"],
	]);
	const w = {} as World;
	w.chats = chats;
	w.homes = homes;
	w.commands = [];
	w.host = {
		roleHome: (sid) => {
			const chat = chats.get(sid);
			return chat && homes.get(chat.role) === chat.file ? { ...chat } : undefined;
		},
		homeOf: (role) => homes.get(role),
		sessionIdOf: (file) => [...chats].find(([, chat]) => chat.file === file)?.[0],
		prepare: async () => {},
		dispatch: (file, line) => {
			w.commands.push({ file, line });
			return w.onCommand(file, line);
		},
	};
	w.coordinator = new OwnerRelayCoordinator(w.host);
	w.onCommand = async (file, line) => {
		const sid = w.host.sessionIdOf(file)!;
		const capability = w.coordinator.consumeOwnerRelay(line.split(" ")[2], sid);
		capability?.finish(OK);
		return true;
	};
	return w;
}
const tokenOf = (w: World, i = 0) => w.commands[i].line.split(" ")[2];

describe("ownerRelayRequest", () => {
	it("keeps a well-formed request exactly and rejects everything else", () => {
		expect(ownerRelayRequest({ ...REQUEST, note: "From COO." })).toEqual({ ...REQUEST, note: "From COO." });
		expect(ownerRelayRequest({ ...REQUEST, note: "" })).toEqual(REQUEST);
		for (const bad of [
			undefined,
			"rollcall",
			{ ...REQUEST, role: "RollCall" },
			{ ...REQUEST, role: " rollcall" },
			{ ...REQUEST, role: "../rollcall" },
			{ ...REQUEST, role: "a".repeat(41) },
			{ ...REQUEST, id: 0 },
			{ ...REQUEST, id: 1.5 },
			{ ...REQUEST, id: "36" },
			{ ...REQUEST, record: "dr-0123" },
			{ ...REQUEST, record: ` ${RECORD}` },
			{ ...REQUEST, note: 7 },
			{ ...REQUEST, note: "x".repeat(8_001) },
			{ ...REQUEST, file: "/chats/rollcall.jsonl" },
			{ ...REQUEST, sessionId: "rollcall-sid" },
		]) {
			expect(ownerRelayRequest(bad)).toBeUndefined();
		}
	});
});

describe("OwnerRelayCoordinator", () => {
	it("relays from a registered home to another role's one home through a one-use ticket", async () => {
		const w = world();
		let grant: OwnerRelayCapability["request"] | undefined;
		w.onCommand = async (file, line) => {
			const capability = w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid");
			grant = capability?.request;
			capability?.finish(OK);
			// Used once: neither the same session nor another one can take it again.
			expect(w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid")).toBeUndefined();
			return true;
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", { ...REQUEST, note: "From COO." })).toEqual(OK);
		expect(w.commands).toHaveLength(1);
		expect(w.commands[0].file).toBe("/chats/rollcall.jsonl");
		expect(w.commands[0].line).toMatch(/^\/queue owner-relay [0-9a-f]{64}$/);
		expect(grant).toEqual({
			...REQUEST,
			note: "From COO.",
			source: { role: "coo", sessionId: "coo-sid", file: "/chats/coo.jsonl" },
			target: { role: "rollcall", sessionId: "rollcall-sid", file: "/chats/rollcall.jsonl" },
		});
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant!.source)).toBe(true);
		// After its reply, the ticket is gone.
		expect(w.coordinator.consumeOwnerRelay(tokenOf(w), "rollcall-sid")).toBeUndefined();
	});

	it("refuses without sending a command when the source, target or request doesn't hold", async () => {
		const w = world();
		const cases: Array<[string, Record<string, unknown>, RegExp]> = [
			["worker-sid", REQUEST, /isn't its department's registered home chat/],
			["unknown-sid", REQUEST, /isn't its department's registered home chat/],
			["rollcall-sid", REQUEST, /same department/],
			["coo-sid", { ...REQUEST, role: "frontend" }, /no single home chat for role frontend/],
			["coo-sid", { ...REQUEST, role: "RollCall" }, /invalid owner-relay request/],
			["coo-sid", { ...REQUEST, target: "/chats/rollcall.jsonl" }, /invalid owner-relay request/],
			["", REQUEST, /invalid owner-relay request/],
		];
		for (const [sid, request, why] of cases) {
			const result = await w.coordinator.relayOwnerAnswer(sid, request as typeof REQUEST);
			expect(result.status).toBe("refused");
			expect("reason" in result && result.reason).toMatch(why);
		}
		// The target's home isn't open (no session for its file).
		w.chats.delete("rollcall-sid");
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "refused",
			reason: "the rollcall home chat isn't open with its queue",
		});
		// The registered home file is another role's chat: not that role's home.
		w.chats.set("rollcall-sid", { role: "temper", file: "/chats/rollcall.jsonl" });
		expect((await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).status).toBe("refused");
		expect(w.commands).toEqual([]);
	});

	it("a ticket the target home didn't take dies; a late or foreign use gets nothing", async () => {
		const w = world();
		w.onCommand = async () => true;
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "refused",
			reason: "the target home didn't take the relay",
		});
		expect(w.coordinator.consumeOwnerRelay(tokenOf(w), "rollcall-sid")).toBeUndefined();

		w.onCommand = async () => false;
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "refused",
			reason: "the target home has no queue command",
		});

		w.onCommand = async () => {
			throw new Error("chat closed");
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "refused",
			reason: "chat closed",
		});

		// Another session presenting the ticket kills it; the real target can't use it afterwards.
		w.onCommand = async (_file, line) => {
			const token = line.split(" ")[2];
			expect(w.coordinator.consumeOwnerRelay(token, "temper-sid")).toBeUndefined();
			expect(w.coordinator.consumeOwnerRelay(token, "rollcall-sid")).toBeUndefined();
			return true;
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "refused",
			reason: "the source or target home changed before delivery",
		});
		expect(w.coordinator.consumeOwnerRelay("not-a-ticket", "rollcall-sid")).toBeUndefined();
	});

	it("a home that changed before delivery refuses; taken but unanswered is unknown, never success", async () => {
		const w = world();
		w.onCommand = async (_file, line) => {
			// The source chat stops being COO's home between dispatch and delivery.
			w.homes.set("coo", "/chats/other-coo.jsonl");
			expect(w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid")).toBeUndefined();
			return true;
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toMatchObject({ status: "refused" });
		w.homes.set("coo", "/chats/coo.jsonl");

		w.onCommand = async (_file, line) => {
			expect(w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid")).toBeDefined();
			return true;
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "uncertain",
			reason: "the target home returned without its reply",
		});

		w.onCommand = async (_file, line) => {
			expect(w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid")).toBeDefined();
			throw new Error("command crashed");
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "uncertain",
			reason: "command crashed",
		});

		// A reply of an unknown shape is unknown; a second reply changes nothing.
		w.onCommand = async (_file, line) => {
			const capability = w.coordinator.consumeOwnerRelay(line.split(" ")[2], "rollcall-sid")!;
			capability.finish({ status: "relayed" } as unknown as OwnerRelayResult);
			capability.finish(OK);
			return true;
		};
		expect(await w.coordinator.relayOwnerAnswer("coo-sid", REQUEST)).toEqual({
			status: "uncertain",
			reason: "the target home's reply had an unknown shape",
		});
	});

	it("one relay at a time per target home; other homes don't wait", async () => {
		const w = world();
		const order: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		w.onCommand = async (file, line) => {
			const sid = w.host.sessionIdOf(file)!;
			order.push(`start ${file}`);
			const capability = w.coordinator.consumeOwnerRelay(line.split(" ")[2], sid)!;
			if (file === "/chats/rollcall.jsonl" && order.filter((o) => o === `start ${file}`).length === 1) await held;
			order.push(`end ${file}`);
			capability.finish({ status: "relayed", task: { id: 36 }, detail: file });
			return true;
		};
		const first = w.coordinator.relayOwnerAnswer("coo-sid", REQUEST);
		const second = w.coordinator.relayOwnerAnswer("coo-sid", REQUEST);
		const elsewhere = w.coordinator.relayOwnerAnswer("coo-sid", { ...REQUEST, role: "temper" });
		expect(await elsewhere).toMatchObject({ status: "relayed" });
		expect(order).toEqual(["start /chats/rollcall.jsonl", "start /chats/temper.jsonl", "end /chats/temper.jsonl"]);
		release();
		expect(await first).toMatchObject({ status: "relayed" });
		expect(await second).toMatchObject({ status: "relayed" });
		expect(order.slice(3)).toEqual([
			"end /chats/rollcall.jsonl",
			"start /chats/rollcall.jsonl",
			"end /chats/rollcall.jsonl",
		]);
	});
});
