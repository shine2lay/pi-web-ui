/**
 * restart-requester (H-ROLES-TRACKER-2): a chat a restart cuts off is carried on for the same
 * messages. The live list (running-chats.json) keeps the running turn's requester inputs, ids and
 * kinds only; the carry-on note brings them into the turn it starts instead of its own unknown input,
 * so the owner's messages get their "settled" and the tasks the turn queues name who asked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerInputIds } from "../../server/owner-contacts.js";
import type { UiTaskRequesterInput } from "../../server/protocol.js";
import {
	collectRequesterInput,
	mergeRequesterTurn,
	requesterForAdmission,
	requesterOfTurn,
} from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord } from "../../server/role-replies.js";
import {
	planCarryOn,
	readRunningChatsFile,
	requesterTurnOf,
	RunningChats,
	savedRequesterOf,
} from "../../server/running-chats.js";

const OWNER: UiTaskRequesterInput = { kind: "owner", channel: "browser", id: "rs-0123abcd-4567" };
const TELEGRAM: UiTaskRequesterInput = { kind: "owner", channel: "telegram", id: "ri-89abcdef-0123" };
const ROLE: UiTaskRequesterInput = { kind: "role", role: "temper", id: "rm-0badc0de-1234", message: "request" };
const ROLE_FOR_OWNER: UiTaskRequesterInput = {
	kind: "role",
	role: "coo",
	id: "rm-1234abcd-5678",
	message: "reply",
	forOwner: true,
	ownerIds: ["rs-feedbeef-0001"],
};
const UNKNOWN: UiTaskRequesterInput = { kind: "unknown" };

/**
 * The turn the carry-on note starts, as the app builds it: carryOnAfterRestart checks the saved
 * record, the note is admitted from the carry-on pseudo client (noteTurnCause), then agent_start
 * merges the pending record (startTurnRecord).
 */
function carryOnTurn(saved: unknown) {
	const checked = savedRequesterOf(saved);
	const pending = newTurnRecord();
	collectRoleInput(pending, {
		requester: requesterForAdmission({ inputId: "ri-00000000-0000" }),
		cause: "other",
		...(checked ? { carried: requesterTurnOf(checked) } : {}),
	});
	const rec = newTurnRecord();
	mergeRequesterTurn(rec, pending);
	return rec;
}

describe("running-chats keeps the running turn's requester inputs", () => {
	let dir: string;
	let file: string;
	const now = Date.parse("2026-10-18T16:46:00Z");
	const A = "/tmp/chats/ops-lead.jsonl";
	const ref = { sessionFile: A, title: "Ops lead", cwd: "/tmp" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "carry-on-requester-test-"));
		file = join(dir, "running-chats.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes them with the turn, reads them back at startup and carries them into the new list", () => {
		const list = new RunningChats(file, () => now);
		list.start(ref);
		const turn = newTurnRecord();
		collectRequesterInput(turn, OWNER);
		collectRequesterInput(turn, ROLE);
		list.setRequester(A, turn);
		// A message joins the busy turn.
		collectRequesterInput(turn, TELEGRAM);
		list.setRequester(A, turn);
		list.freeze("SIGTERM");

		// Ids and kinds only: no message text in the file.
		expect(readFileSync(file, "utf8")).not.toContain('"text"');
		const prev = readRunningChatsFile(file);
		expect(prev?.chats[0]?.requester).toEqual({ inputs: [OWNER, ROLE, TELEGRAM] });

		const plan = planCarryOn(prev, null, now + 60_000);
		expect(plan.carry).toHaveLength(1);
		expect(plan.carry[0]!.chat.requester).toEqual({ inputs: [OWNER, ROLE, TELEGRAM] });

		const next = new RunningChats(file, () => now + 60_000);
		next.seed(plan.carry.map((item) => ({ ...item.chat, awaiting: true })));
		// Kept through another restart before the carry-on turn starts…
		expect(readRunningChatsFile(file)?.chats[0]?.requester).toEqual({ inputs: [OWNER, ROLE, TELEGRAM] });
		// …and not overwritten while it waits for that turn.
		next.setRequester(A, newTurnRecord());
		expect(next.get(A)?.requester).toEqual({ inputs: [OWNER, ROLE, TELEGRAM] });

		// The carry-on turn starts with the saved inputs and keeps them for the next restart.
		next.start(ref);
		next.setRequester(A, carryOnTurn(plan.carry[0]!.chat.requester));
		expect(readRunningChatsFile(file)?.chats[0]?.requester).toEqual({ inputs: [OWNER, ROLE, TELEGRAM] });

		// The turn ends: nothing is left behind.
		next.finish(A);
		expect(readRunningChatsFile(file)?.chats).toEqual([]);
	});

	it("drops a bad or edited saved record, so the carried-on turn stays unknown", () => {
		const chat = (n: number, requester: unknown) => ({
			sessionFile: `/tmp/chats/${n}.jsonl`,
			title: `chat ${n}`,
			cwd: "/tmp",
			startedAt: now,
			cutoffs: 0,
			tools: [],
			requester,
		});
		const bad = [
			{ inputs: [{ ...OWNER, id: "not-an-id" }] },
			{ inputs: [{ ...OWNER, text: "words" }] },
			{ inputs: [{ kind: "owner", channel: "slack", id: OWNER.id }] },
			{ inputs: [OWNER], who: "owner" },
			{ inputs: [] },
			{ inputs: [ROLE], overflow: true },
			{ inputs: "owner" },
			"owner",
			[OWNER],
		];
		writeFileSync(
			file,
			JSON.stringify({
				v: 1,
				pid: 1,
				shutdown: { at: now, signal: "SIGTERM" },
				chats: [
					...bad.map((r, i) => chat(i, r)),
					chat(90, { inputs: [], overflow: true }),
					chat(91, { inputs: [OWNER, OWNER, UNKNOWN] }),
				],
			}),
		);
		const read = readRunningChatsFile(file)!;
		for (let i = 0; i < bad.length; i++) {
			expect(read.chats[i]).not.toHaveProperty("requester");
			const rec = carryOnTurn(read.chats[i]!.requester);
			expect(ownerInputIds(rec)).toEqual([]);
			expect(requesterOfTurn(rec)).toEqual({ v: 1, inputs: [UNKNOWN] });
		}
		expect(read.chats[bad.length]!.requester).toEqual({ inputs: [], overflow: true });
		expect(read.chats[bad.length + 1]!.requester).toEqual({ inputs: [OWNER, UNKNOWN] });
		// The same check where the carry-on reads it, for a record that never went through the file.
		for (const r of bad) expect(savedRequesterOf(r)).toBeUndefined();
	});
});

describe("the carry-on turn answers the cut-off turn's messages", () => {
	it("starts with the saved owner ids and requester, without the note's own unknown input", () => {
		const rec = carryOnTurn({ inputs: [OWNER, ROLE_FOR_OWNER, TELEGRAM] });
		expect(ownerInputIds(rec)).toEqual([OWNER.id, TELEGRAM.id]);
		expect(requesterOfTurn(rec)).toEqual({ v: 1, inputs: [OWNER, ROLE_FOR_OWNER, TELEGRAM] });
	});

	it("stays unknown, as before, when nothing was saved", () => {
		const rec = carryOnTurn(undefined);
		expect(ownerInputIds(rec)).toEqual([]);
		expect(requesterOfTurn(rec)).toEqual({ v: 1, inputs: [UNKNOWN] });
	});

	it("never gives the note, a queue card or a role message the owner's id", () => {
		// Saved inputs without the owner's own message: the role's ownerIds stay the role's.
		const roleOnly = carryOnTurn({ inputs: [ROLE_FOR_OWNER, UNKNOWN] });
		expect(ownerInputIds(roleOnly)).toEqual([]);
		expect(requesterOfTurn(roleOnly)).toEqual({ v: 1, inputs: [ROLE_FOR_OWNER, UNKNOWN] });
		// An overflowed turn carries on as it was: no list, so no owner ids either.
		const overflow = carryOnTurn({ inputs: [], overflow: true });
		expect(ownerInputIds(overflow)).toEqual([]);
		expect(requesterOfTurn(overflow)).toBeUndefined();
		// Texts that join the carried-on turn add only their own inputs.
		const rec = carryOnTurn({ inputs: [OWNER] });
		collectRoleInput(rec, { requester: UNKNOWN, cause: "other" });
		collectRoleInput(rec, { requester: ROLE, cause: "role", sendId: "rs-0a0b0c0d-0e0f" });
		expect(ownerInputIds(rec)).toEqual([OWNER.id]);
		expect(requesterOfTurn(rec)).toEqual({ v: 1, inputs: [OWNER, UNKNOWN, ROLE] });
	});
});
