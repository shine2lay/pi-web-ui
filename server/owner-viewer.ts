// ---------------------------------------------------------------------------
// owner-viewer.ts — what one owner's window is shown of the other owner's asks (Ops #1051)
// ---------------------------------------------------------------------------
// Shine, 2026-11-20: "this is Shine, why are you showing it to me? this question should only show up for Wai".
// A browser connection is a person (sent-by.ts PeopleBook.viewerOf); an ask is for its owner (owner-requester.ts
// askIsForViewer, the one rule). These projections apply it to the shared views a window gets: its Queue tab and
// the Roles page (with the top bar's count). Another owner's queued-task card loses its question, choices, owner
// context and answer form and says only "Waiting on <name>"; his items leave Needs you and the counts.
// The pop-ups, the chat list marks and the snapshots apply the same rule in agent-service.ts. docs/owner-question-routing.md.
// ---------------------------------------------------------------------------

import { askIsForViewer, askOwnerName, type OwnerViewer, requesterPersonOf, waitingOnLine } from "./owner-requester.js";
import type { UiRoleAsk, UiRoleOverview, UiRoleTask, UiTaskQueue, UiTaskQueueTask, UiTaskRequester } from "./protocol.js";
import type { UiBoardGroup, UiBoardTask, UiRolesOverview, UiTaskBoard } from "./roles-board-protocol.js";

/** A cache key for a viewer (the same person with the same people.json gets the same view object). */
export function viewerKey(viewer: OwnerViewer): string {
	return JSON.stringify([viewer.person ?? "", [...viewer.listed].sort()]);
}

/** The "Waiting on <name>" line when an owner card for `origin`'s person isn't this viewer's, else undefined. */
export function waitingOnFor(origin: UiTaskRequester | undefined, viewer: OwnerViewer): string | undefined {
	const person = requesterPersonOf(origin);
	return askIsForViewer(person, viewer) ? undefined : waitingOnLine(askOwnerName(person, viewer));
}

function cached<T extends object>(cache: WeakMap<T, Map<string, T>>, from: T, viewer: OwnerViewer, make: () => T): T {
	const key = viewerKey(viewer);
	let views = cache.get(from);
	const had = views?.get(key);
	if (had) return had;
	const view = make();
	if (!views) cache.set(from, (views = new Map()));
	views.set(key, view);
	return view;
}

// ---------------------------------------------------------------------------
// The Queue tab
// ---------------------------------------------------------------------------

const queueViews = new WeakMap<UiTaskQueue, Map<string, UiTaskQueue>>();

/** A stuck task as the other owner's Queue tab shows it: "Waiting on <name>", nothing of the question. */
function taskWaitingOn(task: UiTaskQueueTask, waitingOn: string): UiTaskQueueTask {
	const { question: _q, choices: _c, detail: _d, card: _k, inShort: _s, ...rest } = task;
	return { ...rest, waitingOn };
}

/** A queue as this viewer's Queue tab gets it: the same object when nothing in it is another owner's card. */
export function queueForViewer(queue: UiTaskQueue, viewer: OwnerViewer): UiTaskQueue {
	const hidden = new Map<number, string>();
	for (const t of queue.tasks) {
		if (t.status !== "stuck") continue;
		const line = waitingOnFor(t.origin, viewer);
		if (line) hidden.set(t.id, line);
	}
	if (hidden.size === 0) return queue;
	return cached(queueViews, queue, viewer, () => {
		const bindings = queue.answerBindings?.filter((b) => !hidden.has(b.taskId));
		const { answerBindings: _b, ...rest } = queue;
		return {
			...rest,
			tasks: queue.tasks.map((t) => {
				const line = hidden.get(t.id);
				return line ? taskWaitingOn(t, line) : t;
			}),
			...(bindings?.length ? { answerBindings: bindings } : {}),
		};
	});
}

// ---------------------------------------------------------------------------
// The Roles page and the top bar's count
// ---------------------------------------------------------------------------

const rolesViews = new WeakMap<UiRolesOverview, Map<string, UiRolesOverview>>();

/** The owner of a Roles page item: its ask's (route), a queued task's card's (the task's origin), else the default. */
function askPersonOf(a: UiRoleAsk, tasks: ReadonlyMap<string, UiRoleTask>): string | undefined {
	if (a.route?.requester !== undefined) return a.route.requester;
	const m = a.kind === "task" ? /^task:(\d+)$/u.exec(a.focus) : null;
	return m ? requesterPersonOf(tasks.get(`${a.role} #${m[1]}`)?.origin) : undefined;
}

/** A role's stuck task that is another owner's card: no question, not a decision for this viewer. */
function roleTaskWaitingOn(task: UiRoleTask, waitingOn: string): UiRoleTask {
	const { stuck: _s, next: _n, ...rest } = task;
	return { ...rest, waitingOn };
}

function boardForViewer(board: UiTaskBoard, hidden: ReadonlyMap<string, string>): UiTaskBoard {
	const moved = new Map<string, number>();
	const tasks = board.tasks.map((t): UiBoardTask => {
		const line = hidden.get(t.ref);
		if (!line || t.state !== "needs-you") return t;
		const roleKey = `role:${t.ref.slice(0, t.ref.lastIndexOf(" #"))}`;
		moved.set(t.groupKey, (moved.get(t.groupKey) ?? 0) + 1);
		moved.set(roleKey, (moved.get(roleKey) ?? 0) + 1);
		const { stuck: _s, ...rest } = t;
		return { ...rest, state: "waiting", howToUnblock: line };
	});
	if (moved.size === 0) return board;
	const regroup = (g: UiBoardGroup): UiBoardGroup => {
		const n = moved.get(g.key) ?? 0;
		return n ? { ...g, counts: { ...g.counts, "needs-you": g.counts["needs-you"] - n, waiting: g.counts.waiting + n } } : g;
	};
	return { ...board, tasks, groups: board.groups.map(regroup), roleGroups: board.roleGroups.map(regroup) };
}

/** The overview as this viewer's Roles page (and top bar) gets it: the same object when nothing is another owner's. */
export function rolesOverviewForViewer(overview: UiRolesOverview, viewer: OwnerViewer): UiRolesOverview {
	const tasks = new Map<string, UiRoleTask>();
	for (const r of overview.roles) for (const t of r.queue?.active ?? []) tasks.set(`${r.id} #${t.id}`, t);
	const hiddenTasks = new Map<string, string>();
	for (const [ref, t] of tasks) {
		if (t.status !== "stuck") continue;
		const line = waitingOnFor(t.origin, viewer);
		if (line) hiddenTasks.set(ref, line);
	}
	const mine = (a: UiRoleAsk) => askIsForViewer(askPersonOf(a, tasks), viewer);
	const anyAsk = (list: readonly UiRoleAsk[] | undefined) => list?.some((a) => !mine(a)) ?? false;
	const changes =
		hiddenTasks.size > 0 || anyAsk(overview.asks) || overview.roles.some((r) => anyAsk(r.asks) || anyAsk(r.withCoo));
	if (!changes) return overview;
	return cached(rolesViews, overview, viewer, () => ({
		...overview,
		asks: overview.asks.filter(mine),
		roles: overview.roles.map((r) => roleForViewer(r, mine, hiddenTasks)),
		...(overview.taskBoard ? { taskBoard: boardForViewer(overview.taskBoard, hiddenTasks) } : {}),
	}));
}

function roleForViewer(
	r: UiRoleOverview,
	mine: (a: UiRoleAsk) => boolean,
	hiddenTasks: ReadonlyMap<string, string>,
): UiRoleOverview {
	const withCoo = r.withCoo?.filter(mine);
	const { withCoo: _w, ...rest } = r;
	return {
		...rest,
		asks: r.asks.filter(mine),
		...(withCoo?.length ? { withCoo } : {}),
		...(r.queue
			? {
					queue: {
						...r.queue,
						active: r.queue.active.map((t) => {
							const line = hiddenTasks.get(`${r.id} #${t.id}`);
							return line ? roleTaskWaitingOn(t, line) : t;
						}),
					},
				}
			: {}),
	};
}
