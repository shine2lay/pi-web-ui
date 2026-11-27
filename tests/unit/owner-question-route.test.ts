import { describe, expect, it } from "vitest";
import {
	OWNER_CHATTING_WINDOW_MS,
	OWNER_QUESTION_ROUTE_REASONS,
	OWNER_QUESTION_DIRECT_REASONS,
	OWNER_QUESTION_COO_REASONS,
	ownerQuestionRoute,
	directRouteLabel,
	cameThroughCooLabel,
	cooReasonWords,
	ownerChattingLabel,
} from "../../server/owner-question-route.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord } from "../../server/role-replies.js";

const now = 1_800_000_000_000;
const MIN = 60_000;
function turn(cause: "browser" | "role", channel?: "browser" | "telegram") {
	const record = newTurnRecord();
	const inputId = "ri-00000000-0000-4000-8000-000000000001";
	const requester = requesterForAdmission({ cause, inputId, ...(channel ? { ownerChannel: channel } : {}) });
	collectRoleInput(record, { cause, requester, ...(channel ? { ownerChannel: channel } : {}) });
	return record;
}

describe("ownerQuestionRoute: every question goes direct (#1144)", () => {
	for (const [name, record] of [
		["missing", undefined],
		["role", turn("role")],
		["owner browser", turn("browser", "browser")],
		["owner Telegram", turn("browser", "telegram")],
		["restarted owner", structuredClone(turn("browser", "browser"))],
		["restarted role", structuredClone(turn("role"))],
		["overflow", { requesterOverflow: true }],
	] as const) {
		it.each([undefined, now, now - 29 * MIN, now - 30 * MIN, now - 31 * MIN, Number.NaN])(
			`${name}, last owner input %s: direct regardless of origin or age`,
			(ownerLastWroteAt) => {
				const result = ownerQuestionRoute({ kind: "question", turn: record, ownerLastWroteAt, now });
				expect(result.to).toBe("direct");
				expect(["owner-chatting", "question-direct"]).toContain(result.reason);
			},
		);
	}
	it("keeps special direct labels before the default question reason", () => {
		expect(ownerQuestionRoute({ kind: "question", now })).toEqual({ to: "direct", reason: "question-direct" });
		expect(ownerQuestionRoute({ kind: "question", now, homeRole: "coo" }).reason).toBe("coo-chat");
		expect(ownerQuestionRoute({ kind: "question", now, askedAgainAfterReturn: true }).reason).toBe(
			"asked-again-after-return",
		);
		expect(ownerQuestionRoute({ kind: "question", now, grant: true }).reason).toBe("grant-not-routed");
		expect(directRouteLabel("question-direct")).toBeUndefined();
	});
});

describe("unchanged dialog, approval and stuck routing", () => {
	it.each(["dialog", "approval"] as const)("%s retains admission and 30-minute rules", (kind) => {
		const owner = turn("browser", "browser");
		expect(OWNER_CHATTING_WINDOW_MS).toBe(30 * MIN);
		expect(ownerQuestionRoute({ kind, now, turn: owner, ownerLastWroteAt: now - 30 * MIN + 1 }).reason).toBe(
			"owner-chatting",
		);
		for (const ownerLastWroteAt of [undefined, now - 30 * MIN, now - 31 * MIN, Number.NaN]) {
			expect(ownerQuestionRoute({ kind, now, turn: owner, ownerLastWroteAt })).toEqual({
				to: "coo",
				reason: "owner-away",
			});
		}
		for (const record of [undefined, turn("role"), { requesterOverflow: true as const }]) {
			expect(ownerQuestionRoute({ kind, now, turn: record, ownerLastWroteAt: now })).toEqual({
				to: "coo",
				reason: "not-started-by-owner",
			});
		}
		expect(ownerQuestionRoute({ kind, now, askedAgainAfterReturn: true }).to).toBe("coo");
		expect(ownerQuestionRoute({ kind, now, grant: true }).reason).toBe("grant-not-routed");
		expect(ownerQuestionRoute({ kind, now, homeRole: "coo" }).reason).toBe("coo-chat");
	});
	it("stuck cards remain queued work even during an owner turn, except COO's own chat", () => {
		for (const record of [undefined, turn("browser", "browser")]) {
			expect(ownerQuestionRoute({ kind: "stuck", now, turn: record, ownerLastWroteAt: now })).toEqual({
				to: "coo",
				reason: "queued-work",
			});
		}
		expect(ownerQuestionRoute({ kind: "stuck", now, homeRole: "coo" })).toEqual({ to: "direct", reason: "coo-chat" });
	});
	it("keeps a closed, disjoint reason list including legacy hold reasons", () => {
		const reasons = [...OWNER_QUESTION_DIRECT_REASONS, ...OWNER_QUESTION_COO_REASONS];
		expect(new Set(reasons).size).toBe(reasons.length);
		expect([...reasons].sort()).toEqual([...OWNER_QUESTION_ROUTE_REASONS].sort());
	});
});

describe("route labels, including legacy question holds", () => {
	it("keeps owner-chatting and COO labels", () => {
		expect(ownerChattingLabel()).toBe("You were chatting here");
		expect(ownerChattingLabel(0)).toBe("You were chatting here (you wrote just now)");
		expect(directRouteLabel("owner-chatting", MIN)).toBe("You were chatting here (you wrote 1 minute ago)");
		expect(directRouteLabel("coo-chat")).toBe("From COO's chat");
		expect(directRouteLabel("asked-again-after-return")).toBeUndefined();
		expect(directRouteLabel("grant-not-routed")).toBeUndefined();
		expect(cameThroughCooLabel(true, 0)).toBe("Came through COO");
		expect(cameThroughCooLabel(false, 12 * MIN)).toBe(
			"Came through COO; COO added nothing (it reached you after 12 minutes)",
		);
	});
	it("still describes persisted hold reasons", () => {
		expect(cooReasonWords("queued-work")).toBe("a queued task's card");
		expect(cooReasonWords("not-started-by-owner")).toBe("raised by work the owner didn't start");
		expect(cooReasonWords("owner-away", 31 * MIN)).toBe(
			"the owner started this but hasn't written there for 31 minutes",
		);
		expect(cooReasonWords("owner-away")).toContain("isn't known");
	});
});
