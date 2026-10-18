import { describe, expect, it } from "vitest";
import {
	collectRequesterInput,
	mergeRequesterTurn,
	requesterForAdmission,
	requesterOf,
	requesterOfTurn,
	requesterText,
	type RequesterTurn,
} from "../../server/queue-requester.js";
import { browserRoleInput, collectRoleInput, newTurnRecord, ownerTurnOf } from "../../server/role-replies.js";
import { installQueueHost, QUEUE_HOST_KEY, type QueueHost, type QueueHostImpl } from "../../server/queue-host.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";
import { projectRolePanel } from "../../web/src/roles-panel-model.js";
import type { UiTaskRequester } from "../../server/protocol.js";

const owner: UiTaskRequester = { v: 1, inputs: [{ kind: "owner", channel: "browser", id: "ri-12345678" }] };
const peer: UiTaskRequester = {
	v: 1,
	inputs: [{ kind: "role", role: "security", id: "rm-12345678", message: "request" }],
};
const plan = {
	title: "Work",
	goal: "The owner asked (untrusted prose)",
	doneWhen: "Done",
	decided: "Decided",
	steps: "Steps",
	verify: "Verify",
	mustNot: "No guesses",
};
const add = (origin?: unknown) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, op: "add", id: 1, plan, ts: 1234, ...(origin ? { origin } : {}) },
});

function displayed(requester?: unknown) {
	const task = { id: 1, title: "Work", status: "ready", ...(requester ? { requester } : {}) };
	const queue = { active: [task], queued: [], counts: { active: 1, queued: 0, done: 0 } };
	const roles = [
		{ id: "ops", title: "Ops", queue },
		{ id: "security", title: "Security" },
	];
	return projectRolePanel({ overview: { roles } }, "ops")?.unrecorded[0]?.requester;
}

describe("requester admission is host-derived input provenance, not work authority", () => {
	it("accepts only admitted owner channels, and preserves Telegram's contact id", () => {
		const browser = { ...browserRoleInput(true, false), inputId: "ri-12345678" };
		expect(requesterForAdmission(browser)).toEqual(owner.inputs[0]);
		const telegram = {
			cause: "telegram",
			source: "extension",
			ownerChannel: "telegram",
			sendId: "rs-12345678",
			inputId: "ri-87654321",
		};
		expect(requesterForAdmission(telegram)).toEqual({ kind: "owner", channel: "telegram", id: "rs-12345678" });
	});
	it("pseudo clients, schedules, missing identity and contradictory channels do not become the owner", () => {
		const cases = [
			browserRoleInput(true, true),
			browserRoleInput(false, false),
			{ cause: "plugin" },
			{ cause: "other" },
			{ cause: "browser", ownerChannel: "telegram" },
		];
		for (const admission of cases) {
			expect(requesterForAdmission({ ...admission, inputId: "ri-12345678" })).toEqual({ kind: "unknown" });
		}
		const untrusted = { cause: "browser", requester: peer.inputs[0], inputId: "ri-12345678" };
		expect(requesterForAdmission(untrusted)).toEqual({ kind: "unknown" });
		const trusted = { ...untrusted, cause: "role", source: "extension" };
		expect(requesterForAdmission(trusted)).toEqual(peer.inputs[0]);
	});
	it("merges all accepted inputs and keeps unknown without changing owner-turn routing", () => {
		const pending = newTurnRecord();
		collectRoleInput(pending, { ...browserRoleInput(true, false), requester: owner.inputs[0] });
		collectRoleInput(pending, { cause: "role", requester: peer.inputs[0] });
		collectRoleInput(pending, { cause: "other" });
		const live = newTurnRecord();
		mergeRequesterTurn(live, pending);
		expect(requesterOfTurn(live)?.inputs).toEqual([...owner.inputs, ...peer.inputs, { kind: "unknown" }]);
		expect(ownerTurnOf(pending)?.ownerChannel).toBe("browser");
		expect(ownerTurnOf(live)).toBeNull(); // Provenance alone cannot grant owner authority.
		const snapshot = requesterOfTurn(live)!;
		snapshot.inputs.length = 0;
		expect(requesterOfTurn(live)?.inputs).toHaveLength(3);
	});
	it("overflow never returns a misleading prefix; absent/restarted turns stay unknown", () => {
		const turn: RequesterTurn = {};
		for (let i = 0; i < 33; i++) {
			collectRequesterInput(turn, { ...owner.inputs[0], id: `ri-${i.toString(16).padStart(8, "0")}` });
		}
		expect(requesterOfTurn(turn)).toBeUndefined();
		const other: RequesterTurn = {};
		collectRequesterInput(other, peer.inputs[0]);
		mergeRequesterTurn(other, turn);
		expect(requesterOfTurn(other)).toBeUndefined();
		expect(requesterOfTurn(undefined)).toBeUndefined();
		expect(requesterOfTurn(newTurnRecord())).toBeUndefined();
	});
});

describe("optional queue provenance wire and display", () => {
	it("rejects malformed, oversized, partial and free-text records without guessing", () => {
		const bad = [
			null,
			{},
			{ ...owner, v: 2 },
			{ ...owner, text: "asked by owner" },
			{ v: 1, inputs: [] },
			{ v: 1, inputs: Array(33).fill(owner.inputs[0]) },
			{ v: 1, inputs: [...owner.inputs, { kind: "made-up" }] },
			{ v: 1, inputs: [{ ...owner.inputs[0], id: "ri-12345678\n" }] },
			{ v: 1, inputs: [{ ...peer.inputs[0], role: "security\u202e" }] },
			{ v: 1, inputs: [{ ...peer.inputs[0], ownerIds: ["rs-12345678"] }] },
		];
		for (const value of bad) expect(requesterOf(value)).toBeUndefined();
	});
	it("mirrors queue replay and does not backfill or replace an original on edit", () => {
		const update = {
			type: "custom",
			customType: "queue",
			data: { v: 1, op: "update", id: 1, plan, origin: peer, ts: 2345 },
		};
		expect(taskQueueFromEntries([add(owner), update], true).tasks[0].origin).toEqual(owner);
		expect(taskQueueFromEntries([add(), update], true).tasks[0].origin).toBeUndefined();
		const consent = { ...add(), data: { ...add().data, approval: "dialog" } };
		expect(taskQueueFromEntries([consent], true).tasks[0].origin).toBeUndefined();
	});
	it("shows source labels, not opaque identifiers or asserted prose", () => {
		expect(displayed(owner)).toBe("You (browser)");
		expect(displayed(peer)).toBe("Security");
		const relayed = {
			v: 1,
			inputs: [{ ...peer.inputs[0], forOwner: true, ownerIds: ["rs-12345678"] }, { kind: "unknown" }],
		};
		expect(displayed(relayed)).toBe("You via Security · Not recorded");
		expect(requesterText(relayed)).not.toMatch(/rm-|rs-|12345678/);
		expect(displayed()).toBeUndefined();
		expect(displayed({ v: 1, inputs: [{ kind: "unknown" }] })).toBeUndefined();
	});
	it("host wrapper is optional, fresh, fail-closed and read-only", () => {
		const base: QueueHostImpl = {
			startChat: async () => ({ sessionFile: "/fixture" }),
			runCommand: async () => true,
			closeChat: async () => true,
			chatState: async () => ({ state: "idle" }),
			wakeChat: async () => true,
		};
		let calls = 0;
		const uninstall = installQueueHost({
			...base,
			turnOrigin: () => {
				calls++;
				return owner;
			},
		});
		try {
			const host = (globalThis as Record<symbol, unknown>)[QUEUE_HOST_KEY] as QueueHost;
			expect(host.turnOrigin?.("relative")).toBeUndefined();
			expect(calls).toBe(0);
			const read = host.turnOrigin!("/fixture")!;
			expect(read).toEqual(owner);
			read.inputs.length = 0;
			expect(host.turnOrigin!("/fixture")).toEqual(owner);
		} finally {
			uninstall();
		}
		const remove = installQueueHost(base);
		try {
			expect(((globalThis as Record<symbol, unknown>)[QUEUE_HOST_KEY] as QueueHost).turnOrigin).toBeUndefined();
		} finally {
			remove();
		}
	});
});
