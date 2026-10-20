// initiatives-page-tasks (docs/initiatives-page-tasks.md, Ops #227): step 1's fixed registry page with linked
// tasks, one initiative per status chip, for tests/unit/initiatives-page-tasks.test.ts and the sealed look
// (scripts/initiatives-exact-shot.mjs --tasks). The names are made up (none of the design's sample).
import type { InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import type { UiWorkPage, UiWorkPageRecord, UiWorkPageTask } from "../../web/src/types";
import { AT, PAGE, pageArgs as basePageArgs } from "./initiatives-page-fixture";

export { AT, NOW, PAGE, t } from "./initiatives-page-fixture";

const MIN = 60_000;

const rec = (id: string, name: string, lead: string, initiative?: string | null): UiWorkPageRecord => ({
	id,
	name,
	outcome: "",
	lead,
	status: "active",
	createdAt: AT - 86_400_000,
	createdBy: "owner",
	updatedAt: AT,
	doneWhen: [{ item: "item 1" }],
	...(initiative !== undefined ? { initiative } : {}),
});

/** A task of a role's home queue, added two hours before the page. */
const task = (
	queueName: string,
	n: number,
	title: string,
	parent: UiWorkPageTask["parent"],
	more: Partial<UiWorkPageTask> = {},
): UiWorkPageTask => ({
	queue: `/chats/${queueName}-home.jsonl`,
	queueName,
	task: n,
	added: AT - 120 * MIN,
	title,
	parent,
	...more,
});

const hold = { at: AT - 180 * MIN, why: "after the launch" };

/**
 * Alpha launch: Needs you (Design #3 asks). Delta rollout: Blocked (Ops #20 blocked). Epsilon pause:
 * Paused by you (both open tasks paused). Theta search: Moving. Zeta idea: no tasks yet. Eta notes: only an
 * ended task. Beta and Gamma: the registry's Done and Dropped. In no initiative, Docs sweep's Docs #2 asks.
 * Ops #40-#42 link to nothing on the page, so they show nowhere.
 */
export const TASKS: UiWorkPageTask[] = [
	task(
		"ops",
		12,
		"Wire the login API",
		{ project: "p-login" },
		{
			state: "working",
			stateAt: AT - 30 * MIN,
			chat: "/chats/ops-12.jsonl",
			nextAction: { kind: "unrecorded" },
		},
	),
	task(
		"design",
		3,
		"Pick the login copy",
		{ project: "p-login" },
		{
			state: "asking",
			stateAt: AT - 25 * MIN,
			chat: "/chats/design-3.jsonl",
			nextAction: { kind: "answer", who: "ops" },
			needsYou: { text: "Which sign-in wording ships?", since: AT - 25 * MIN },
		},
	),
	task(
		"qa",
		4,
		"Check the login form",
		{ project: "p-login" },
		{
			state: "blocked",
			stateAt: AT - 20 * MIN,
			block: { on: ["Ops #12"], lead: "ops", owes: "the login API", due: AT + 60 * MIN, since: AT - 20 * MIN },
		},
	),
	task("backend", 7, "Index the search box", { project: "p-search" }, { state: "done", stateAt: AT - 60 * MIN }),
	task(
		"ops",
		15,
		"Draft the launch note",
		{ initiative: "alpha" },
		{
			state: "ready",
			stateAt: AT - 10 * MIN,
			nextAction: { kind: "queue", after: ["#12"] },
		},
	),
	task("frontend", 9, "Old login spike", { project: "p-login" }, { state: "dropped", stateAt: AT - 90 * MIN }),
	task("frontend", 10, "Removed login idea", { project: "p-login" }, { state: "removed", stateAt: AT - 95 * MIN }),
	task(
		"ops",
		20,
		"Roll out to staging",
		{ project: "p-rollout" },
		{
			state: "blocked",
			stateAt: AT - 50 * MIN,
			block: { need: "staging credentials from Systems", since: AT - 50 * MIN },
		},
	),
	task(
		"systems",
		5,
		"Set up staging",
		{ project: "p-rollout" },
		{
			state: "waiting",
			stateAt: AT - 15 * MIN,
			chat: "/chats/systems-5.jsonl",
			nextAction: { kind: "check", what: "staging deploy", everyMs: 2 * MIN, until: AT + 180 * MIN },
		},
	),
	task(
		"design",
		8,
		"Redraw the icons",
		{ initiative: "epsilon" },
		{
			state: "ready",
			stateAt: AT - 200 * MIN,
			paused: hold,
		},
	),
	task(
		"design",
		11,
		"Audit the icons",
		{ initiative: "epsilon" },
		{
			state: "working",
			stateAt: AT - 190 * MIN,
			chat: "/chats/design-11.jsonl",
			paused: hold,
		},
	),
	task("design", 2, "Old icon set", { initiative: "epsilon" }, { state: "done", stateAt: AT - 300 * MIN }),
	task("docs", 6, "Write the notes", { initiative: "eta" }, { state: "done", stateAt: AT - 40 * MIN }),
	task(
		"backend",
		30,
		"Tune the ranking",
		{ initiative: "theta" },
		{
			state: "working",
			stateAt: AT - 5 * MIN,
			chat: "/chats/backend-30.jsonl",
		},
	),
	task("backend", 31, "Recorded before its queue spoke", { initiative: "theta" }),
	task(
		"docs",
		2,
		"Docs for the login form",
		{ project: "p-docs" },
		{
			state: "stuck",
			stateAt: AT - 120 * MIN,
			chat: "/chats/docs-2.jsonl",
			needsYou: { text: "Publish the docs now or after QA?", since: AT - 120 * MIN },
		},
	),
	task(
		"docs",
		3,
		"Index the docs",
		{ project: "p-docs" },
		{
			state: "working",
			stateAt: AT - 35 * MIN,
			chat: "/chats/docs-3.jsonl",
		},
	),
	task(
		"ops",
		40,
		"Tidy the scheduler",
		{ standalone: true },
		{
			state: "asking",
			needsYou: { text: "Standalone question" },
		},
	),
	task("ops", 41, "Linked to a deleted project", { project: "p-gone" }, { state: "working" }),
	task(
		"ops",
		42,
		"Linked to a deleted initiative",
		{ initiative: "gone" },
		{
			state: "stuck",
			needsYou: { text: "Question of a deleted initiative" },
		},
	),
];

/** Step 1's page with five more initiatives, one more project, and the tasks. */
export const TASKS_PAGE: UiWorkPage = {
	...PAGE,
	initiatives: [
		...PAGE.initiatives,
		rec("delta", "Delta rollout", "ops"),
		rec("epsilon", "Epsilon pause", "design"),
		rec("zeta", "Zeta idea", "product"),
		rec("eta", "Eta notes", "docs"),
		rec("theta", "Theta search", "backend"),
	],
	projects: [...PAGE.projects, rec("p-rollout", "Rollout plan", "ops", "delta")],
	tasks: TASKS,
};

/** The core model's arguments on this page; `over` replaces any of them. */
export function pageArgs(over: Partial<InitiativesPageArgs> = {}): InitiativesPageArgs {
	return basePageArgs({ work: { page: TASKS_PAGE, status: "ready" }, ...over });
}
