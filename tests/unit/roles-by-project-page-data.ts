/**
 * roles-by-project P-cases' payloads (spec-acceptance.md §P): a hand-made server board, as the producer would send
 * it (the page shows the server's counts; it never recounts). Shared by the jsdom page test only.
 */
import type { UiRoleAsk, UiRoleOverview, UiRoleTask, UiWorkRecords } from "../../server/protocol.js";
import type {
	UiBoardGroup,
	UiBoardState,
	UiBoardTask,
	UiRolesOverview,
	UiTaskBoard,
} from "../../server/roles-board-protocol.js";

export const AT = Date.UTC(2026, 10, 16, 18, 0, 0);
const STATUS: Record<UiBoardState, UiRoleTask["status"]> = {
	"needs-you": "stuck",
	blocked: "blocked",
	waiting: "waiting",
	working: "working",
	queued: "ready",
	done: "done",
};
export const ROLE_TITLES: Record<string, string> = {
	architecture: "Architecture",
	backend: "Backend engineering",
	design: "Design",
	frontend: "Frontend engineering",
	ops: "Ops tooling",
	qa: "Quality assurance",
};

export function boardTask(
	ref: string,
	groupKey: string,
	state: UiBoardState,
	title: string,
	over: Partial<UiBoardTask> = {},
): UiBoardTask {
	const [role, id] = ref.split(" #");
	return {
		id: Number(id),
		role,
		title,
		status: STATUS[state],
		ref,
		groupKey,
		state,
		queueIndex: state === "done" ? null : Number(id) % 100,
		...(state === "done" ? { finishedAt: AT - 3_600_000 } : {}),
		...(state === "needs-you" ? { stuck: { question: `${title}?`, choices: ["Yes", "No"], sinceAt: AT - 60_000, tier: "owner" as const } } : {}),
		...over,
	};
}

function groupOf(key: string, label: string, rows: readonly UiBoardTask[], extra: Partial<UiBoardGroup> = {}): UiBoardGroup {
	const mine = rows.filter((t) => t.groupKey === key);
	const counts = { "needs-you": 0, blocked: 0, waiting: 0, working: 0, queued: 0 };
	for (const t of mine) if (t.state !== "done") counts[t.state] += 1;
	const open = mine.filter((t) => t.state !== "done").length;
	const roleOpen = new Map<string, number>();
	for (const t of mine) roleOpen.set(t.role ?? "", (roleOpen.get(t.role ?? "") ?? 0) + (t.state === "done" ? 0 : 1));
	const kind = key.startsWith("project:") ? "project" : key.startsWith("tag:") ? "tag" : key.startsWith("role:") ? "role" : "none";
	return {
		key,
		kind,
		label,
		open,
		counts,
		done14d: mine.length - open,
		doneShown: mine.length - open,
		roles: [...roleOpen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r),
		lastFinishedAt: mine.reduce<number | null>((m, t) => (t.finishedAt && (m === null || t.finishedAt > m) ? t.finishedAt : m), null),
		...(kind === "project" ? { projectId: key.slice(8), projectStatus: "active" as const } : {}),
		...extra,
	};
}

export const WORK: UiWorkRecords = {
	initiatives: [{ id: "team-in-temper", name: "Team in Temper", lead: "ops", status: "active", items: 1, met: 0 }],
	projects: [
		{ id: "roles-by-project", name: "Roles by project", lead: "frontend", status: "active", initiative: "team-in-temper", items: 2, met: 1, doneWhen: [{ item: "Spec landed", met: true }, { item: "Page live", met: false }] },
		{ id: "inkflow-onboarding", name: "Inkflow onboarding", lead: "design", status: "active", initiative: null, items: 0, met: 0, doneWhen: [] },
		{ id: "quiet-project", name: "Quiet project", lead: "ops", status: "active", initiative: null, items: 0, met: 0, doneWhen: [] },
	],
};

const ROLES_P = "project:roles-by-project";
const INK = "project:inkflow-onboarding";
const SMOKE = "tag:release-smoke";
/** Group label -> the refs searching for it must show (spec-page.md §Controls). */
export const LABELS = { roles: "Roles by project", ink: "Inkflow onboarding", smoke: "release-smoke", none: "No project or tag" };

/** The live board: 4 groups with open work (5 asks among them), one quiet project. */
export function liveTasks(): UiBoardTask[] {
	return [
		boardTask("frontend #294", ROLES_P, "needs-you", "Pick the tile density", { initiative: "team-in-temper", project: "roles-by-project" }),
		boardTask("architecture #546", ROLES_P, "working", "Roles by project spec", { initiative: "team-in-temper", project: "roles-by-project" }),
		boardTask("frontend #293", ROLES_P, "queued", "Seam and failing acceptance", { initiative: "team-in-temper", project: "roles-by-project", dependsOnRefs: ["architecture #546"] }),
		boardTask("backend #174", ROLES_P, "blocked", "Board producer", { project: "roles-by-project", dependsOnRefs: ["frontend #293"], howToUnblock: "Unblocks when Frontend #293 finishes" }),
		boardTask("design #62", INK, "needs-you", "Approve onboarding copy", { project: "inkflow-onboarding" }),
		boardTask("backend #81", INK, "needs-you", "Choose invite expiry", { project: "inkflow-onboarding" }),
		boardTask("backend #80", INK, "working", "Invite API", { project: "inkflow-onboarding", tags: ["inkflow", "invites"] }),
		boardTask("design #61", INK, "blocked", "Onboarding screens", { project: "inkflow-onboarding", dependsOnRefs: ["backend #80"] }),
		boardTask("qa #13", SMOKE, "needs-you", "Accept the flaky smoke", { tags: ["release-smoke"] }),
		boardTask("qa #12", SMOKE, "queued", "Smoke tests", { tags: ["release-smoke"] }),
		boardTask("ops #901", "none", "needs-you", "Free the disk", {}),
		boardTask("ops #900", "none", "queued", "Disk cleanup", {}),
		boardTask("ops #899", "none", "done", "Rotate the logs", { doneSummary: "Logs rotated" }),
	];
}

/** The live board plus `extra` open tasks in `areas` tag groups ("area-01"...), chained inside each group: the
 *  design's 200-260 task scale for the browser cases. */
export function scaleTasks(extra = 220, areas = 20): UiBoardTask[] {
	const roles = Object.keys(ROLE_TITLES);
	const states: UiBoardState[] = ["queued", "working", "blocked", "queued", "waiting", "done"];
	const out = liveTasks();
	for (let i = 0; i < extra; i++) {
		const area = `area-${String((i % areas) + 1).padStart(2, "0")}`;
		const ref = `${roles[i % roles.length]} #${1000 + i}`;
		const before = i >= areas ? [`${roles[(i - areas) % roles.length]} #${1000 + i - areas}`] : [];
		out.push(boardTask(ref, `tag:${area}`, states[i % states.length], `Area task ${1000 + i}`, { tags: [area], dependsOnRefs: before, queueIndex: i }));
	}
	return out;
}

export function boardOf(tasks: readonly UiBoardTask[], problem?: string): UiTaskBoard {
	const known = new Set([ROLES_P, INK, SMOKE, "none", "project:quiet-project"]);
	const extra = [...new Set(tasks.map((t) => t.groupKey).filter((k) => !known.has(k)))].sort();
	const groups = [
		groupOf(ROLES_P, LABELS.roles, tasks),
		groupOf(INK, LABELS.ink, tasks),
		groupOf(SMOKE, LABELS.smoke, tasks),
		...extra.map((k) => groupOf(k, k.replace(/^tag:/, ""), tasks)),
		groupOf("none", LABELS.none, tasks),
		groupOf("project:quiet-project", "Quiet project", tasks),
	];
	const roles = [...new Set(tasks.map((t) => t.role ?? ""))].sort();
	return {
		asOf: AT,
		groups,
		roleGroups: roles.map((r) => groupOf(`role:${r}`, ROLE_TITLES[r] ?? r, tasks.map((t) => ({ ...t, groupKey: `role:${t.role}` })))),
		tasks: [...tasks],
		...(problem ? { problem } : {}),
	};
}

function roleOf(id: string): UiRoleOverview {
	return {
		id,
		title: ROLE_TITLES[id] ?? id,
		focus: `${id} work`,
		workMode: "request-only",
		workModeFrom: "rules",
		goals: [],
		goalsFrom: "rules",
		status: "busy",
		homeChat: { file: `/tmp/${id}-home.jsonl` },
		asks: [],
		tldr: [],
		spend: { state: "none", line: "No budget" },
		queue: { running: true, counts: { active: 0, queued: 0, done: 0 }, lanes: { inUse: 0, atOnce: 2 }, active: [], queued: [] },
		requests: { open: 0 },
		report: { state: "not-in-job" },
		problems: [],
	};
}

/** One answerable ask per needs-you task, oldest first (the order the server sends). */
export function asksOf(tasks: readonly UiBoardTask[]): UiRoleAsk[] {
	return tasks
		.filter((t) => t.state === "needs-you")
		.map((t, i) => ({
			key: `${t.role}:task:${t.id}`,
			role: t.role ?? "",
			kind: "task" as const,
			text: t.stuck?.question ?? t.title,
			since: AT - (10 - i) * 60_000,
			focus: `task:${t.id}`,
			askId: `ask-${t.role}-${t.id}`,
			chat: { file: `/tmp/${t.role}-${t.id}.jsonl`, where: t.id },
		}));
}

export function overviewOf(board: UiTaskBoard | undefined, at = AT): UiRolesOverview {
	const tasks = board?.tasks ?? [];
	return {
		at,
		roles: Object.keys(ROLE_TITLES).map(roleOf),
		asks: asksOf(tasks),
		paused: false,
		reportTz: "America/Los_Angeles",
		work: WORK,
		...(board ? { taskBoard: board } : {}),
	};
}
