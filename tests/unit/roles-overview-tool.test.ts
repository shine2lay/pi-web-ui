/**
 * telegram-coo: roles_overview (server/roles-overview-tool.ts): the Roles page's snapshot as text for
 * a chat. All roles in short, one role in full, a plain error for a role that isn't there, a cap on
 * the whole answer; the tool itself only reads.
 */
import { describe, expect, it } from "vitest";
import type { UiBoardPost, UiRoleOverview, UiRolesOverview } from "../../server/protocol.js";
import {
	formatRolesOverview,
	makeRolesOverviewTool,
	ROLES_OVERVIEW_TEXT_MAX,
	ROLES_OVERVIEW_TOOL_NAME,
	whenText,
} from "../../server/roles-overview-tool.js";

const NOW = Date.UTC(2026, 9, 6, 15, 0); // 2026-10-06 08:00 in Los Angeles
const MIN = 60_000;
const TZ = "America/Los_Angeles";

function role(id: string, over: Partial<UiRoleOverview> = {}): UiRoleOverview {
	return {
		id,
		title: id.toUpperCase(),
		homeChat: { file: `/s/${id}.jsonl`, title: `${id} home` },
		workMode: "request-only",
		workModeFrom: "rules",
		goals: [],
		goalsFrom: "rules",
		status: "idle",
		lastActivity: NOW - 30 * MIN,
		asks: [],
		tldr: [],
		requests: { open: 0 },
		report: { state: "first" },
		...over,
	};
}

function view(roles: UiRoleOverview[], over: Partial<UiRolesOverview> = {}): UiRolesOverview {
	return { at: NOW, roles, asks: roles.flatMap((r) => r.asks), paused: false, reportTz: TZ, ...over };
}

const tldr = (n: number, chat: { file: string; where: "home" | number } = { file: "/s/a.jsonl", where: "home" }) =>
	Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `line ${i}`, ts: NOW - i * MIN, chat }));

const busy = role("temper", {
	status: "needs-you",
	homeBusy: true,
	tldr: [
		{
			id: "a",
			text: "Need your pick on the deploy",
			ts: NOW - 5 * MIN,
			needsYou: true,
			chat: { file: "/s/t.jsonl", where: 7 },
		},
		...tldr(5),
	],
	asks: [
		{
			key: "k1",
			role: "temper",
			kind: "question",
			text: "Which port?",
			since: NOW - 10 * MIN,
			chat: { file: "/s/t.jsonl", where: 7 },
			focus: "f",
		},
	],
	queue: {
		running: true,
		active: [
			{ id: 7, status: "asking", title: "Deploy the thing", busy: true, waitsOn: "the owner's pick" },
			{ id: 8, status: "working", title: "Fix the other thing" },
		],
		queued: [{ id: 9, status: "ready", title: "Later work" }],
		counts: { active: 2, queued: 1, done: 40 },
	},
	requests: {
		open: 2,
		newest: { id: "rm-1", from: "qa", kind: "request", firstLine: "Please check X", at: NOW - 2 * MIN },
	},
	report: {
		state: "report",
		date: "2026-10-06",
		sections: [
			{ heading: "Done", text: "Landed #50." },
			{ heading: "Next", text: "Rehearsal." },
		],
	},
});

describe("formatRolesOverview", () => {
	it("all roles in short: header, counts, each role's state, and how to see one in full", () => {
		const text = formatRolesOverview(view([busy, role("qa")]), { now: NOW });
		expect(text).toContain("Roles overview at 2026-10-06 08:00 (just now), times in America/Los_Angeles.");
		expect(text).toContain("2 roles; 1 things wait on the owner.");
		expect(text).toContain("By status: 1 needs the owner, 1 idle.");
		expect(text).toContain("## temper (TEMPER): needs the owner, home chat working now");
		expect(text).toContain('Home chat: /s/temper.jsonl ("temper home")');
		expect(text).toContain("Last activity: 2026-10-06 07:30 (30 min ago)");
		expect(text).toContain("- 2026-10-06 07:55 (5 min ago): Need your pick on the deploy [needs the owner, task #7]");
		// Short: 3 TL;DR lines, then a note about the rest.
		expect(text).toContain("- (3 older lines not shown)");
		expect(text).toContain("- question in task #7, since 2026-10-06 07:50 (10 min ago): Which port?");
		expect(text).toContain("Queue: running; 2 active, 1 waiting to start, 40 done");
		expect(text).toContain("- #7 asking (working now): Deploy the thing; waits on: the owner's pick");
		expect(text).not.toContain("Later work");
		expect(text).toContain("Open requests to it: 2 (newest: request from qa,");
		expect(text).toContain("6 am report (2026-10-06):\n  Done: Landed #50.\n  Next: Rehearsal.");
		expect(text).toContain("## qa (QA): idle");
		expect(text).toContain("6 am report: none yet");
		expect(text).toContain(`call ${ROLES_OVERVIEW_TOOL_NAME} with role "<id>"`);
	});

	it("one role in full: every TL;DR line and the tasks waiting to start, no other role", () => {
		const text = formatRolesOverview(view([busy, role("qa")]), { role: "temper", now: NOW });
		expect(text).toContain("line 4");
		expect(text).not.toContain("older lines not shown");
		expect(text).toContain("- #9 ready: Later work");
		expect(text).not.toContain("## qa");
		expect(text).not.toContain("By status");
	});

	// queue-paused: the owner's pause on a task or a whole queue.
	it("says 'Paused by you' with since when and why, for a task and for the whole queue", () => {
		const paused = role("frontend", {
			status: "paused",
			queue: {
				running: true,
				hold: { at: NOW - 60 * MIN, why: "pressed Pause in the Queue panel" },
				counts: { active: 1, queued: 1, done: 0 },
				active: [
					{
						id: 1,
						status: "blocked",
						title: "Grade the boards",
						paused: { at: NOW - 120 * MIN, why: "owner on Telegram: save Claude limits" },
					},
				],
				queued: [
					{
						id: 2,
						status: "ready",
						title: "Next one",
						paused: { at: NOW - 60 * MIN, why: "pressed Pause in the Queue panel" },
					},
				],
			},
		});
		const text = formatRolesOverview(view([paused]), { role: "frontend", now: NOW });
		expect(text).toContain(
			"Queue: running, the whole queue paused by you (since 2026-10-06 07:00 (1 h ago): pressed Pause in the Queue panel); 1 active, 1 waiting to start, 0 done",
		);
		expect(text).toContain(
			"- #1 blocked: Grade the boards; Paused by you (since 2026-10-06 06:00 (2 h ago): owner on Telegram: save Claude limits)",
		);
		expect(text).toContain(
			"- #2 ready: Next one; Paused by you (since 2026-10-06 07:00 (1 h ago): pressed Pause in the Queue panel)",
		);
	});

	it("a role that isn't there: a plain error naming the roles", () => {
		expect(() => formatRolesOverview(view([busy, role("qa")]), { role: "ceo", now: NOW })).toThrow(
			'There is no role "ceo". Roles: temper, qa.',
		);
	});

	it("says when role messages are paused, and each report state in words", () => {
		const roles = [
			role("a", { report: { state: "pending", date: "2026-10-06", askedAt: NOW - 60 * MIN } }),
			role("b", { report: { state: "failed", date: "2026-10-06", error: "the chat is gone" } }),
			role("c", { report: { state: "no-answer", date: "2026-10-05" } }),
			role("d", { report: { state: "not-active" } }),
			role("e", { report: { state: "not-in-job" }, homeChat: undefined }),
		];
		const text = formatRolesOverview(view(roles, { paused: true }), { now: NOW });
		expect(text).toContain("Role messages are paused by the owner.");
		expect(text).toContain("6 am report (2026-10-06): asked at 2026-10-06 07:00 (1 h ago), no answer yet");
		expect(text).toContain("6 am report (2026-10-06): failed: the chat is gone");
		expect(text).toContain("6 am report (2026-10-05): no answer");
		expect(text).toContain("6 am report: not asked (no activity that day)");
		expect(text).toContain("6 am report: not in the 6 am job");
		expect(text).toContain("Home chat: none");
	});

	it("a busy day still shows every one of the 15 roles in one call", () => {
		const long = "work ".repeat(400);
		const roles = Array.from({ length: 15 }, (_, i) =>
			role(`busy${i}`, {
				...busy,
				id: `busy${i}`,
				tldr: tldr(3).map((l) => ({ ...l, text: long })),
				queue: {
					running: true,
					counts: { active: 5, queued: 0, done: 40 },
					queued: [],
					active: Array.from({ length: 5 }, (_, j) => ({
						id: j,
						status: "working",
						title: long,
						waitsOn: long,
						latest: { id: "last", text: long, ts: NOW, chat: { file: "/s/task", where: j } },
					})),
				},
				report: {
					state: "report",
					date: "2026-10-06",
					sections: Array.from({ length: 4 }, (_, j) => ({ heading: `Part ${j}`, text: long })),
				},
			}),
		);
		const text = formatRolesOverview(view(roles), { now: NOW });
		for (const r of roles) expect(text).toContain(`## ${r.id} (`);
		expect(text.match(/6 am report \(2026-10-06\)/g)).toHaveLength(15);
		expect(text.length).toBeLessThanOrEqual(ROLES_OVERVIEW_TEXT_MAX);
	});

	it("stays under the cap however many roles there are", () => {
		const long = "word ".repeat(400);
		const roles = Array.from({ length: 80 }, (_, i) =>
			role(`r${i}`, {
				tldr: tldr(3).map((l) => ({ ...l, text: long })),
				report: { state: "report", date: "2026-10-06", text: long },
			}),
		);
		const text = formatRolesOverview(view(roles), { now: NOW });
		expect(text.length).toBeLessThanOrEqual(ROLES_OVERVIEW_TEXT_MAX);
		expect(text).toContain('(Cut here to stay short: ask for one role with role "<id>" to see the rest.)');
	});
});

// board (task #76): COO reads open orders and who hasn't done them here.
describe("the board in roles_overview", () => {
	const post = (o: Partial<UiBoardPost> & { id: string }): UiBoardPost => ({
		at: NOW - 20 * MIN,
		from: "owner",
		kind: "order",
		to: "all",
		title: "Pause new work",
		text: "x",
		...o,
	});
	const roles = [
		role("qa", {
			boardOrders: [{ id: "bp-0000000a", title: "Pause new work", at: NOW - 20 * MIN, from: "owner", via: "coo" }],
		}),
		role("coo"),
		role("ops"),
	];
	const board = {
		posts: [
			post({ id: "bp-0000000c", kind: "news", title: "New Roles page" }),
			post({ id: "bp-0000000b", title: "Old order", closed: { at: NOW - MIN, by: "owner" } }),
			post({
				id: "bp-0000000a",
				via: "coo",
				ownerWords: "Owner 10:30: pause",
				done: { ops: { at: NOW - 5 * MIN, note: "paused #12" } },
			}),
		],
	};

	it("all roles: the open orders, done n/m and who hasn't; recent news counted", () => {
		const text = formatRolesOverview(view(roles, { board }), { now: NOW });
		expect(text).toContain("Board: 1 open order; 1 news post in the last 3 days.");
		// From the owner via coo: coo relayed it, so it's for qa and ops; ops is done.
		expect(text).toContain(
			'- bp-0000000a "Pause new work" from owner via coo, 2026-10-06 07:40 (20 min ago): done 1/2; not done: qa',
		);
		expect(text).not.toContain("Old order");
		expect(text).toContain("Board orders it hasn't marked done (1):\n- bp-0000000a");
	});

	it("one role in full: its open orders; no board in the overview: no board line", () => {
		const qa = formatRolesOverview(view(roles, { board }), { role: "qa", now: NOW });
		expect(qa).toContain("Board orders it hasn't marked done (1):");
		expect(qa).not.toContain("Board: 1 open order");
		expect(formatRolesOverview(view([role("qa")]), { now: NOW })).not.toContain("Board");
		const none = formatRolesOverview(view([role("qa")], { board: { posts: [] } }), { now: NOW });
		expect(none).toContain("Board: no open orders.");
	});
});

describe("whenText", () => {
	it("a time in the zone, with how long ago", () => {
		expect(whenText(NOW - 3 * 60 * MIN, TZ, NOW)).toBe("2026-10-06 05:00 (3 h ago)");
		expect(whenText(NOW - 3 * 24 * 60 * MIN, TZ, NOW)).toBe("2026-10-03 08:00 (3 days ago)");
		expect(whenText(undefined, TZ, NOW)).toBe("unknown");
	});
});

describe("the tool", () => {
	it("reads the overview and answers with text; a role filter gives that role", async () => {
		let reads = 0;
		const tool = makeRolesOverviewTool({
			read: async () => {
				reads++;
				return view([busy, role("qa")]);
			},
		});
		expect(tool.name).toBe("roles_overview");
		const run = (p: Record<string, unknown>) =>
			(tool.execute as unknown as (...a: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }>)(
				"id",
				p,
				undefined,
				undefined,
				undefined,
			);
		const all = await run({});
		expect(all.content[0].text).toContain("## qa (QA)");
		expect(all.details).toMatchObject({ roles: 2, role: null });
		const one = await run({ role: "qa" });
		expect(one.content[0].text).not.toContain("## temper");
		await expect(run({ role: "nobody" })).rejects.toThrow('There is no role "nobody"');
		expect(reads).toBe(3);
	});
});
