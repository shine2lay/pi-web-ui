/**
 * telegram-coo: server/role-replies.ts. Which cause a run's answer gets, what a role's reply carries,
 * where a role's messages go, and how a send to a busy home chat waits for its turn to end.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityDef } from "../../server/identities.js";
import {
	mergeOwnerAnswer,
	newTurnRecord,
	oneLineOf,
	OWNER_IDS_MAX,
	ownerTurnOf,
	ROLE_REPLY_TEXT_MAX,
	roleHomeChat,
	roleReplyOf,
	sendWhenFree,
	topCause,
	type RoleDeliveryResult,
} from "../../server/role-replies.js";

let dir: string;
let home: string;

const role = (over: Partial<IdentityDef>): IdentityDef =>
	({ id: "coo", title: "COO", folder: join(dir, "coo"), homeChat: home, ...over }) as IdentityDef;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "role-replies-test-"));
	home = join(dir, "home.jsonl");
	writeFileSync(home, "");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("topCause", () => {
	it("telegram beats plugin beats role beats browser beats other", () => {
		expect(topCause(["browser", "telegram", "other"])).toBe("telegram");
		expect(topCause(["role", "plugin"])).toBe("plugin");
		expect(topCause(["browser", "role"])).toBe("role");
		expect(topCause(["other", "browser"])).toBe("browser");
		expect(topCause([])).toBe("other");
	});
});

describe("roleReplyOf", () => {
	it("a run in a role's home chat: its role, last text without markers, cause, the send ids", () => {
		const rec = newTurnRecord();
		rec.causes.add("browser");
		rec.causes.add("telegram");
		rec.ids.push("rs-1");
		rec.text = "All good. [[todo:new:Check the brief]]";
		const r = roleReplyOf(home, rec, [role({})], 123);
		expect(r).toEqual({ role: "coo", file: home, text: "All good.", cause: "telegram", at: 123, ids: ["rs-1"] });
	});

	it("a chat that is no role's home chat gives nothing", () => {
		const rec = newTurnRecord();
		rec.text = "hello";
		expect(roleReplyOf(join(dir, "other.jsonl"), rec, [role({})], 1)).toBeNull();
		expect(roleReplyOf(undefined, rec, [role({})], 1)).toBeNull();
	});

	it("carries the failure line, and cuts a long text at the cap", () => {
		const rec = newTurnRecord();
		rec.causes.add("plugin");
		rec.text = "x".repeat(ROLE_REPLY_TEXT_MAX + 50);
		rec.error = "the model call failed";
		const r = roleReplyOf(home, rec, [role({})], 1)!;
		expect(r.text.length).toBe(ROLE_REPLY_TEXT_MAX);
		expect(r.cut).toBe(true);
		expect(r.error).toBe("the model call failed");
		expect(r.cause).toBe("plugin");
	});

	it("hands over a copy of the ids", () => {
		const rec = newTurnRecord();
		rec.ids.push("rs-1");
		const r = roleReplyOf(home, rec, [role({})], 1)!;
		rec.ids.push("rs-2");
		expect(r.ids).toEqual(["rs-1"]);
	});

	it("a run a reply to a question asked for the owner started: forOwner, who answered, his send ids; cause stays role", () => {
		const rec = newTurnRecord();
		rec.causes.add("role");
		rec.text = "Temper says yes.";
		rec.forOwner = { answeredBy: ["temper"], ownerIds: ["rs-1"] };
		const r = roleReplyOf(home, rec, [role({})], 9)!;
		expect(r).toEqual({
			role: "coo",
			file: home,
			text: "Temper says yes.",
			cause: "role",
			at: 9,
			ids: [],
			forOwner: true,
			answeredBy: ["temper"],
			ownerIds: ["rs-1"],
		});
		rec.forOwner.answeredBy.push("qa");
		expect(r.answeredBy).toEqual(["temper"]);
		// Any other run has no forOwner fields at all.
		const plain = newTurnRecord();
		plain.causes.add("role");
		expect(roleReplyOf(home, plain, [role({})], 1)).not.toHaveProperty("forOwner");
	});
});

describe("forOwner: ownerTurnOf and mergeOwnerAnswer", () => {
	it("a run his Telegram message started (or joined) is his, with its send ids", () => {
		const rec = newTurnRecord();
		rec.causes.add("telegram");
		rec.ids.push("rs-1");
		expect(ownerTurnOf(rec)).toEqual({ answeredBy: [], ownerIds: ["rs-1"] });
		rec.causes.add("browser");
		rec.ids.push("rs-2");
		expect(ownerTurnOf(rec)?.ownerIds).toEqual(["rs-1", "rs-2"]);
	});

	it("a run a reply to a question asked for him started is his too (chains keep it)", () => {
		const rec = newTurnRecord();
		rec.causes.add("role");
		rec.forOwner = { answeredBy: ["temper"], ownerIds: ["rs-1"] };
		expect(ownerTurnOf(rec)?.ownerIds).toEqual(["rs-1"]);
	});

	it("any other run isn't: the browser, the brief, the app, another role's message", () => {
		for (const cause of ["browser", "plugin", "other", "role"] as const) {
			const rec = newTurnRecord();
			rec.causes.add(cause);
			rec.ids.push("rs-9");
			expect(ownerTurnOf(rec)).toBeNull();
		}
		expect(ownerTurnOf(undefined)).toBeNull();
	});

	it("mergeOwnerAnswer keeps each name and id once, and at most OWNER_IDS_MAX ids", () => {
		const a = mergeOwnerAnswer(undefined, { answeredBy: ["temper"], ownerIds: ["rs-1"] });
		const b = mergeOwnerAnswer(a, { answeredBy: ["temper", "qa"], ownerIds: ["rs-1", "rs-2"] });
		expect(b).toEqual({ answeredBy: ["temper", "qa"], ownerIds: ["rs-1", "rs-2"] });
		const many = mergeOwnerAnswer(b, { ownerIds: Array.from({ length: 20 }, (_, i) => `x${i}`) });
		expect(many.ownerIds).toHaveLength(OWNER_IDS_MAX);
		expect(many.ownerIds.slice(0, 2)).toEqual(["rs-1", "rs-2"]);
	});
});

describe("roleHomeChat", () => {
	it("finds the role's home chat", () => {
		expect(roleHomeChat("coo", [role({})])).toEqual({ ok: true, file: home, title: "COO" });
	});

	it("says plainly why there is nowhere to send", () => {
		expect(roleHomeChat("", [role({})])).toEqual({ ok: false, error: "no role given" });
		expect(roleHomeChat("ceo", [role({})])).toEqual({ ok: false, error: 'there is no role "ceo"' });
		expect(roleHomeChat("coo", [role({ homeChat: null })])).toEqual({
			ok: false,
			error: "the COO role has no home chat",
		});
		expect(roleHomeChat("coo", [role({ homeChat: join(dir, "gone.jsonl") })])).toEqual({
			ok: false,
			error: "the COO role's home chat file is gone",
		});
	});
});

describe("oneLineOf", () => {
	it("folds whitespace and cuts with an ellipsis", () => {
		expect(oneLineOf("a\n\n b\tc")).toBe("a b c");
		expect(oneLineOf("abcdef", 4)).toBe("abc\u2026");
		expect(oneLineOf(undefined)).toBe("");
	});
});

describe("sendWhenFree", () => {
	/** A fake clock: sleep moves time on. */
	function clock() {
		let t = 1_000;
		const slept: number[] = [];
		return {
			now: () => t,
			sleep: async (ms: number) => {
				slept.push(ms);
				t += ms;
			},
			slept,
		};
	}

	it("goes in at once when the chat is free", async () => {
		const c = clock();
		let queued = 0;
		const r = await sendWhenFree(async () => ({ ok: true }), { ...c, onQueued: () => queued++ });
		expect(r).toEqual({ ok: true });
		expect(queued).toBe(0);
		expect(c.slept).toEqual([]);
	});

	it("a busy chat: says so once, tries again until its turn is over", async () => {
		const c = clock();
		const answers: RoleDeliveryResult[] = [
			{ ok: false, busy: true, error: "the chat is working" },
			{ ok: false, busy: true, error: "the chat is working" },
			{ ok: true },
		];
		let queued = 0;
		const r = await sendWhenFree(async () => answers.shift()!, { ...c, retryMs: 500, onQueued: () => queued++ });
		expect(r).toEqual({ ok: true });
		expect(queued).toBe(1);
		expect(c.slept).toEqual([500, 500]);
	});

	it("another failure comes back at once", async () => {
		const c = clock();
		const r = await sendWhenFree(async () => ({ ok: false, error: "the chat's transcript is gone" }), c);
		expect(r).toEqual({ ok: false, error: "the chat's transcript is gone" });
		expect(c.slept).toEqual([]);
	});

	it("a delivery that throws is a failure, not a crash", async () => {
		const r = await sendWhenFree(async () => {
			throw new Error("boom");
		}, clock());
		expect(r).toEqual({ ok: false, error: "boom" });
	});

	it("gives up when the chat stays busy too long", async () => {
		const c = clock();
		const r = await sendWhenFree(async () => ({ ok: false, busy: true, error: "busy" }), {
			...c,
			retryMs: 1_000,
			maxWaitMs: 3_000,
		});
		expect(r).toEqual({ ok: false, error: "the chat stayed busy too long" });
		expect(c.slept.length).toBe(3);
	});

	it("stops waiting when the server goes away", async () => {
		const c = clock();
		let stop = false;
		const r = await sendWhenFree(
			async () => {
				stop = true;
				return { ok: false, busy: true, error: "busy" };
			},
			{ ...c, stopped: () => stop },
		);
		expect(r).toEqual({ ok: false, error: "the server is restarting" });
	});

	it("an onQueued that throws doesn't stop the send", async () => {
		const answers: RoleDeliveryResult[] = [{ ok: false, busy: true, error: "busy" }, { ok: true }];
		const r = await sendWhenFree(async () => answers.shift()!, {
			...clock(),
			onQueued: () => {
				throw new Error("boom");
			},
		});
		expect(r).toEqual({ ok: true });
	});
});
