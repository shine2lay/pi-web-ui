import { statusToneForLifecycle, type UiRoleTask, type UiStatusTone, type UiTaskLifecycleStatus } from "./types";

export const STAGE_TITLES: readonly string[] = [
	"Stage 1 · Root & Foundations",
	"Stage 2 · Parallel Build & Rollout",
	"Stage 3 · Verify & Ship",
	"Stage 4 · Final Release",
];

const HOLD_STATES = new Set<UiTaskLifecycleStatus>(["stuck", "asking", "blocked", "waiting", "paused"]);

export interface TaskDagNode {
	task: UiRoleTask;
	id: number;
	ref: string;
	stageIndex: number;
	stepNumber: number;
	stageLabel: string;
	dependsOnRefs: string[];
	unlocksRefs: string[];
	inSetParentCount: number;
	inSetChildCount: number;
	isRootBlocker: boolean;
}

export interface TaskDagStage {
	stageIndex: number;
	stepNumber: number;
	stageLabel: string;
	nodes: TaskDagNode[];
}

export interface TaskDagEdge {
	from: number;
	to: number;
	fromRef: string;
	toRef: string;
	critical: boolean;
	statusTone: UiStatusTone;
}

export interface TaskDagResult {
	nodes: TaskDagNode[];
	byId: Map<number, TaskDagNode>;
	stages: TaskDagStage[];
	edges: TaskDagEdge[];
	rootBlockerRefs: string[];
}

export interface DagBoxRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

function canonicalTaskRef(task: Pick<UiRoleTask, "id" | "displayId" | "role">): string {
	return `${task.role ?? "workspace"} #${task.displayId ?? task.id}`;
}

function normalizeDepRef(raw: string | number, fallbackRole: string): string {
	if (typeof raw === "number") {
		return `${fallbackRole} #${raw}`;
	}
	const trimmed = String(raw).trim();
	if (/^#\d+$/.test(trimmed)) {
		return `${fallbackRole} ${trimmed}`;
	}
	return trimmed;
}

/**
 * Pure client-side topological stage & edge builder matching prototype.html v8 (`buildTaskDag`).
 * Reconstructs stage columns (`stageIndex = 0` for root tasks with no in-group dependencies,
 * `stageIndex = 1 + max(parent.stageIndex)` for downstream tasks), reverse `unlocksRefs`,
 * `isRootBlocker`, and `edges` from direct `dependsOnRefs` without storing precomputed steps in backend.
 */
export function buildTaskDag(
	tasks: ReadonlyArray<Partial<UiRoleTask> & { id: number }>,
	contextTasks?: ReadonlyArray<Partial<UiRoleTask> & { id: number }>,
): TaskDagResult {
	if (tasks !== undefined && !Array.isArray(tasks)) {
		throw new Error("buildTaskDag requires tasks to be an array.");
	}
	const list = (Array.isArray(tasks) ? tasks : []) as UiRoleTask[];
	const fullList = (Array.isArray(contextTasks) && contextTasks.length > 0 ? contextTasks : list) as UiRoleTask[];

	const visibleRefs = new Set(list.map((t) => canonicalTaskRef(t)));
	const byRef = new Map<string, UiRoleTask>();

	for (const t of fullList) {
		const ref = canonicalTaskRef(t);
		byRef.set(ref, t);
	}

	const directParentsByRef = new Map<string, string[]>();
	const unlocksByRef = new Map<string, Set<string>>();

	for (const t of fullList) {
		const role = t.role ?? "workspace";
		const ref = canonicalTaskRef(t);
		const rawDeps = new Set<string>();
		if (Array.isArray(t.dependsOnRefs)) {
			for (const dep of t.dependsOnRefs) {
				if (dep) rawDeps.add(normalizeDepRef(dep, role));
			}
		}
		if (t.blocked && Array.isArray(t.blocked.resolvedOn)) {
			for (const d of t.blocked.resolvedOn) {
				if (d?.ref) rawDeps.add(normalizeDepRef(d.ref, role));
			}
		} else if (t.blocked && Array.isArray(t.blocked.on)) {
			for (const d of t.blocked.on) {
				if (d) rawDeps.add(normalizeDepRef(d, role));
			}
		}
		if (t.queuedDetail && Array.isArray(t.queuedDetail.resolvedAfter)) {
			for (const d of t.queuedDetail.resolvedAfter) {
				if (d?.ref) rawDeps.add(normalizeDepRef(d.ref, role));
			}
		} else if (Array.isArray(t.after)) {
			for (const d of t.after) {
				if (d !== undefined && d !== null) rawDeps.add(normalizeDepRef(d, role));
			}
		}
		directParentsByRef.set(ref, [...rawDeps]);
		if (!unlocksByRef.has(ref)) {
			unlocksByRef.set(ref, new Set<string>());
		}
	}

	for (const t of fullList) {
		const childRef = canonicalTaskRef(t);
		const deps = directParentsByRef.get(childRef) ?? [];
		for (const parentRef of deps) {
			let set = unlocksByRef.get(parentRef);
			if (!set) {
				set = new Set<string>();
				unlocksByRef.set(parentRef, set);
			}
			set.add(childRef);
		}
	}

	const stageMemo = new Map<string, number>();
	const visiting = new Set<string>();

	function computeStageIndex(ref: string): number {
		const cached = stageMemo.get(ref);
		if (cached !== undefined) return cached;
		if (visiting.has(ref)) return 0;
		visiting.add(ref);
		const parents = (directParentsByRef.get(ref) ?? []).filter((pRef) => byRef.has(pRef));
		let idx = 0;
		for (const pRef of parents) {
			idx = Math.max(idx, computeStageIndex(pRef) + 1);
		}
		visiting.delete(ref);
		stageMemo.set(ref, idx);
		return idx;
	}

	const edges: TaskDagEdge[] = [];
	const byId = new Map<number, TaskDagNode>();

	const nodes: TaskDagNode[] = list.map((t) => {
		const ref = canonicalTaskRef(t);
		const stageIndex = computeStageIndex(ref);
		const stepNumber = stageIndex + 1;
		const stageLabel = STAGE_TITLES[stageIndex] ?? `Stage ${stepNumber} · Downstream`;
		const dependsOnRefs = directParentsByRef.get(ref) ?? [];
		const unlocksRefs = [...(unlocksByRef.get(ref) ?? [])];
		const inSetParents = dependsOnRefs.filter((pRef) => byRef.has(pRef));
		const visibleParents = dependsOnRefs.filter((pRef) => visibleRefs.has(pRef));
		const visibleChildren = unlocksRefs.filter((cRef) => visibleRefs.has(cRef));
		const isHold = HOLD_STATES.has(t.lifecycleStatus);
		const isRootBlocker = isHold && inSetParents.length === 0;

		for (const pRef of visibleParents) {
			const parentTask = byRef.get(pRef);
			if (parentTask) {
				const pHold = HOLD_STATES.has(parentTask.lifecycleStatus) || HOLD_STATES.has(t.lifecycleStatus);
				edges.push({
					from: parentTask.id,
					to: t.id,
					fromRef: pRef,
					toRef: ref,
					critical: pHold,
					statusTone: statusToneForLifecycle(parentTask.lifecycleStatus ?? "working"),
				});
			}
		}

		const node: TaskDagNode = {
			task: t,
			id: t.id,
			ref,
			stageIndex,
			stepNumber,
			stageLabel,
			dependsOnRefs,
			unlocksRefs,
			inSetParentCount: visibleParents.length,
			inSetChildCount: visibleChildren.length,
			isRootBlocker,
		};
		byId.set(t.id, node);
		return node;
	});

	const stageMap = new Map<number, TaskDagStage>();
	for (const n of nodes) {
		let st = stageMap.get(n.stageIndex);
		if (!st) {
			st = {
				stageIndex: n.stageIndex,
				stepNumber: n.stepNumber,
				stageLabel: n.stageLabel,
				nodes: [],
			};
			stageMap.set(n.stageIndex, st);
		}
		st.nodes.push(n);
	}

	const stages = [...stageMap.values()].sort((a, b) => a.stageIndex - b.stageIndex);
	const rootBlockerRefs = nodes.filter((n) => n.isRootBlocker).map((n) => n.ref);

	return {
		nodes,
		byId,
		stages,
		edges,
		rootBlockerRefs,
	};
}

/**
 * Computes an SVG cubic bezier path (`M x1 y1 C cx1 cy1, cx2 cy2, x2 y2`) linking a parent node
 * rect to a child node rect inside a `.dag-board` container.
 */
export function computeBezierPath(
	fromRect: Pick<DagBoxRect, "left" | "top" | "right" | "bottom">,
	toRect: Pick<DagBoxRect, "left" | "top" | "right" | "bottom">,
	boardRect: Pick<DagBoxRect, "left" | "top">,
): string {
	if (!fromRect || !toRect || !boardRect) {
		throw new Error("computeBezierPath requires fromRect, toRect, and boardRect.");
	}
	const horizontal = toRect.left > fromRect.right - 8;
	if (horizontal) {
		const x1 = Math.round(fromRect.right - boardRect.left);
		const y1 = Math.round(fromRect.top - boardRect.top + 26);
		const x2 = Math.round(toRect.left - boardRect.left);
		const y2 = Math.round(toRect.top - boardRect.top + 26);
		const dx = Math.max(16, (x2 - x1) * 0.5);
		return `M ${x1} ${y1} C ${Math.round(x1 + dx)} ${y1}, ${Math.round(x2 - dx)} ${y2}, ${x2} ${y2}`;
	}
	const x1 = Math.round(fromRect.left - boardRect.left + 26);
	const y1 = Math.round(fromRect.bottom - boardRect.top);
	const x2 = Math.round(toRect.left - boardRect.left + 26);
	const y2 = Math.round(toRect.top - boardRect.top);
	const dy = Math.max(12, (y2 - y1) * 0.5);
	return `M ${x1} ${y1} C ${x1} ${Math.round(y1 + dy)}, ${x2} ${Math.round(y2 - dy)}, ${x2} ${y2}`;
}

export function installGlobalBuildTaskDag(target?: { buildTaskDag?: typeof buildTaskDag } | null): void {
	const win =
		target ?? (typeof window !== "undefined" ? (window as unknown as { buildTaskDag?: typeof buildTaskDag }) : null);
	if (win) {
		win.buildTaskDag = buildTaskDag;
	}
}

installGlobalBuildTaskDag();
