// initiatives-page-gaps (docs/initiatives-page-gaps.md, Ops #228): a fixed work registry page with linked tasks,
// registry changes and hand-offs, plus the lead's updates, for step 4's gaps, all activity and hand-offs. Shared
// by tests/unit/initiatives-page-gaps.test.ts and the sealed look (scripts/initiatives-exact-shot.mjs --gaps). It
// takes only the clock, the decision log and the other arguments from step 1's fixture. The names are made up
// (none of the design's sample).
import type { InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import type {
	UiProgress,
	UiTaskParent,
	UiWorkActivity,
	UiWorkDoneItem,
	UiWorkHandoff,
	UiWorkPage,
	UiWorkPageRecord,
	UiWorkPageTask,
	UiWorkTaskState,
} from "../../web/src/types";
import { AT, DECISIONS, NOW, pageArgs as coreArgs } from "./initiatives-page-fixture";

export { AT, NOW };
const MIN = 60_000;

const met = (item: string): UiWorkDoneItem => ({ item, met: { proof: "seen live", by: "ops", at: AT - 60 * MIN } });
const open = (item: string): UiWorkDoneItem => ({ item });
const rec = (
	id: string,
	name: string,
	lead: string,
	status: UiWorkPageRecord["status"],
	doneWhen: UiWorkDoneItem[],
	initiative?: string | null,
): UiWorkPageRecord => ({
	id,
	name,
	outcome: "",
	lead,
	status,
	createdAt: AT - 86_400_000,
	createdBy: "owner",
	updatedAt: AT,
	doneWhen,
	...(initiative !== undefined ? { initiative } : {}),
});
const task = (
	queueName: string | undefined,
	n: number,
	title: string,
	parent: UiTaskParent,
	state?: UiWorkTaskState,
	more: Partial<UiWorkPageTask> = {},
): UiWorkPageTask => ({
	queue: `/queues/${queueName ?? "unnamed"}.jsonl`,
	...(queueName ? { queueName } : {}),
	task: n,
	added: AT - 300 * MIN + n,
	title,
	parent,
	...(state ? { state } : {}),
	...more,
});

const T = {
	wire: task("ops", 12, "Wire the form", { project: "p-login" }, "blocked", {
		block: {
			on: ["#11", "temper #38"],
			need: "a test account",
			lead: "backend",
			owes: "the API shape",
			due: AT + 60 * MIN,
			since: AT - 60 * MIN,
		},
	}),
	style: task("ops", 13, "Style the form", { project: "p-login" }, "working"),
	draw: task("ops", 14, "Draw the signup", { project: "p-signup" }, "done"),
	copy: task("ops", 15, "Check the copy", { project: "p-login" }, "blocked"),
	colours: task("frontend", 3, "Pick the colours", { initiative: "alpha" }, "asking", {
		nextAction: { kind: "answer", who: "design" },
	}),
	font: task("design", 4, "Choose the font", { initiative: "alpha" }, "stuck", {
		nextAction: { kind: "answer", who: "owner" },
		paused: { at: AT - 10 * MIN, why: "later" },
	}),
	sweep: task("docs", 7, "Sweep the guides", { project: "p-docs" }, "stuck", {
		needsYou: { text: "Which guides go?", since: AT - 30 * MIN },
	}),
	other: task("qa", 9, "Unrelated check", { standalone: true }, "blocked"),
	unnamed: task(undefined, 5, "No queue name", { project: "p-login" }, "waiting"),
	old: task("ops", 16, "Old step", { project: "p-signup" }, "dropped"),
	quiet: task("ops", 17, "Unknown state", { project: "p-quiet" }),
};
const ref = (t: UiWorkPageTask) => ({
	queue: t.queue,
	...(t.queueName ? { queueName: t.queueName } : {}),
	task: t.task,
	added: t.added,
});

/** The registry's changes, oldest first as logged; the page gets them newest first. */
const LOG: UiWorkActivity[] = [
	{ at: AT - 300 * MIN, by: "owner", op: "initiative.create", id: "alpha" },
	{ at: AT - 290 * MIN, by: "architecture", op: "project.create", id: "p-login" },
	{ at: AT - 280 * MIN, by: "ops", op: "task.link", task: ref(T.wire), parent: { project: "p-login" } },
	{ at: AT - 270 * MIN, by: "frontend", op: "project.met", id: "p-login", item: "Fields drawn", proof: "seen live" },
	{ at: AT - 260 * MIN, by: "owner", op: "initiative.create", id: "beta" },
	{ at: AT - 250 * MIN, by: "qa", op: "project.unmet", id: "p-login", item: "Errors shown", reason: "came back" },
	{ at: AT - 240 * MIN, by: "ops", op: "task.state", task: ref(T.wire), status: "blocked" },
	{ at: AT - 230 * MIN, by: "qa", op: "task.state", task: ref(T.other), status: "blocked" },
	{
		at: AT - 220 * MIN,
		by: "owner",
		op: "project.change",
		id: "p-docs",
		changed: ["lead", "status"],
		status: "active",
	},
	{ at: AT - 215 * MIN, by: "ops", op: "project.met", id: "p-lane", item: "Lane drawn" },
	{ at: AT - 210 * MIN, by: "architecture", op: "initiative.change", id: "alpha", changed: ["doneWhen"] },
	{ at: AT - 60 * MIN, by: "ops", op: "task.state", task: ref(T.unnamed), status: "waiting" },
	{ at: AT - 60 * MIN, by: "frontend", op: "task.link", task: ref(T.colours), parent: { initiative: "alpha" } },
	{ at: AT - 30 * MIN, by: "architecture", op: "initiative.met", id: "alpha", item: "Form ships", proof: "seen live" },
];

/** Open hand-offs, oldest first as the role-message store keeps them. */
const HANDOFFS: UiWorkHandoff[] = [
	{
		id: "rm-1",
		initiative: "alpha",
		at: AT - 90 * MIN,
		from: "ops",
		fromChat: "Queue #12",
		to: "backend",
		toChat: "home chat",
		kind: "request",
		firstLine: "Please send the API shape",
		state: "delivered",
		deliveredAt: AT - 89 * MIN,
	},
	{
		id: "rm-2",
		initiative: "alpha",
		at: AT - 20 * MIN,
		from: "design",
		fromChat: "home chat",
		to: "frontend",
		kind: "question",
		firstLine: "Which colours are allowed?",
		state: "waiting",
	},
	{
		id: "rm-3",
		initiative: "beta",
		at: AT - 10 * MIN,
		from: "qa",
		fromChat: 'chat "Beta checks"',
		to: "docs",
		toChat: "Queue #7",
		kind: "request",
		firstLine: "Add the guide link",
		state: "held",
	},
	{
		id: "rm-4",
		initiative: "zeta",
		at: AT - 5 * MIN,
		from: "ops",
		fromChat: "home chat",
		to: "qa",
		kind: "question",
		firstLine: "Is zeta still on?",
		state: "waiting",
	},
];

/** Registry order: the page shows active first. */
export const GAPS_PAGE: UiWorkPage = {
	at: AT,
	initiatives: [
		rec("alpha", "Alpha launch", "architecture", "active", [
			met("Form ships"),
			open("Search ships"),
			open("First user signs in"),
		]),
		rec("beta", "Beta rollout", "qa", "active", [open("Guide published"), open("Two teams use it")]),
		rec("gamma", "Gamma archive", "ops", "dropped", [open("Old pages moved")]),
	],
	projects: [
		rec("p-login", "Login form", "frontend", "active", [met("Fields drawn"), open("Errors shown")], "alpha"),
		rec("p-signup", "Signup form", "design", "active", [open("Mock-up approved"), open("Copy written")], "alpha"),
		rec("p-search", "Search box", "backend", "done", [met("Results show")], "alpha"),
		rec("p-idea", "Old idea", "ops", "dropped", [open("Never started")], "alpha"),
		rec("p-notes", "Beta notes", "docs", "done", [met("Notes written")], "beta"),
		rec("p-docs", "Docs sweep", "docs", "active", [open("Guides listed"), open("Old guides gone")], null),
		rec("p-lane", "Old lane", "ops", "active", [met("Lane drawn"), open("Lane used")], "no-such-initiative"),
		rec("p-full", "Full lane", "ops", "active", [met("All set")], null),
		rec("p-quiet", "Quiet lane", "ops", "active", [open("Lane checked")], null),
	],
	tasks: [T.wire, T.style, T.draw, T.copy, T.colours, T.font, T.sweep, T.other, T.unnamed, T.old, T.quiet],
	activity: [...LOG].reverse(),
	handoffs: HANDOFFS,
};

/** Alpha's lead updates, newest first as the progress feed sends them. */
export const GAPS_PROGRESS: UiProgress = {
	...DECISIONS.progress!,
	initiative: "alpha",
	updates: [
		{
			...DECISIONS.progress!.updates[0]!,
			id: "u2",
			at: AT - 30 * MIN,
			fields: { changed: "Signup next.", next: "Draw the signup.", needsYou: "" },
		},
		{
			...DECISIONS.progress!.updates[0]!,
			id: "u1",
			at: AT - 120 * MIN,
			fields: { changed: "Form landed.", next: "Wire the search box.", needsYou: "" },
		},
	],
	updatesTotal: 2,
};

/** The core model's arguments on this fixture; `over` replaces any of them. */
export function pageArgs(over: Partial<InitiativesPageArgs> = {}): InitiativesPageArgs {
	return coreArgs({
		work: { page: GAPS_PAGE, status: "ready" },
		decisions: { ...DECISIONS, progress: GAPS_PROGRESS },
		...over,
	});
}
