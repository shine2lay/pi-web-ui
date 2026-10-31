/**
 * telegram-answers: which queued tasks wait on the user right now, as asks (see asks.ts).
 *
 * pi-queue keeps a queue per chat (task-queue.ts mirrors it). A task that needs the user ("stuck")
 * is answered in the chat it runs in: the queue's own chat for a task that runs there, or the task's
 * own chat for a lane task, whose queue chat keeps a copy that follows it. So every open chat's queue
 * is read, and each stuck task becomes one ask, keyed by the chat its answer goes into and the task's
 * number: both copies of a lane task give the same key. The task's own chat speaks for it while it's
 * open; the queue chat's copy only when it isn't (its copy can lag behind for a moment).
 *
 * queue-main-chat: a task asking its main chat ("asking") isn't an ask: the main chat has the question,
 * and only a question it passes on (or one that goes on by itself) makes the task stuck. An ask whose
 * question the main chat answered after all goes away saying so.
 *
 * task-question decisions (rule 21): a question Ops passes on to the owner comes with its whole package
 * (`detail`); it is the question field's detail, and a changed package is a new ask.
 */
import { createHash } from "node:crypto";
import type { AskMeta } from "./asks.js";
import type { UiTaskQueue, UiTaskQueueTask } from "./protocol.js";
import { questionBindingKey, type QuestionBinding } from "./queue-question-port.js";

/** One open chat and its queue. */
export interface StuckSource {
	/** The chat's transcript file. */
	file: string;
	queue: UiTaskQueue;
	meta: AskMeta;
	/** From the native endpoint, not a UI echo or question text. */
	questionBinding?(id: number): QuestionBinding | undefined;
}

/** A stuck task that should be asked about. */
export interface StuckWanted {
	key: string;
	/** The transcript of the chat the answer goes into. */
	target: string;
	taskId: number;
	taskTitle: string;
	question: string;
	choices: string[];
	/** task-question decisions: the package the question came with (task-queue.ts detailOf). */
	detail?: string;
	meta: AskMeta;
	binding?: QuestionBinding;
}

export const stuckKey = (target: string, taskId: number): string => `${target}#${taskId}`;

/** The chat a task's answer goes into: a lane task's own chat (once known), else the chat whose queue it is. */
export function stuckTarget(sourceFile: string, task: UiTaskQueueTask): string | undefined {
	return task.lane ? task.chat?.file : sourceFile;
}

/** Same wording AND native routing occurrence; legacy questions keep their old signature. */
export const stuckSig = (w: Pick<StuckWanted, "question" | "choices" | "detail" | "binding">): string =>
	w.binding
		? JSON.stringify([w.question, w.choices, w.detail ?? "", questionBindingKey(w.binding)])
		: w.detail
			? JSON.stringify([w.question, w.choices, w.detail])
			: JSON.stringify([w.question, w.choices]);

/** Native old-card fences must survive a restarted server's counter starting over. */
export const stuckAskId = (w: StuckWanted, sequence: number): string =>
	w.binding ? `stuck-${createHash("sha256").update(stuckSig(w)).digest("hex").slice(0, 24)}` : `stuck-${sequence}`;

/**
 * The stuck tasks across these open chats (`wanted`, by key), and every task's status as its
 * speaking chat sees it (`seen`, by key), so a caller can tell why an ask went away. queue-main-chat:
 * `mainAnswered`: the keys of tasks back at work with their main chat's answer; `asking`: the chats
 * (transcripts) whose task asks its main chat now, so nothing there says the user is needed.
 */
export function wantedStuckAsks(sources: StuckSource[]): {
	wanted: Map<string, StuckWanted>;
	seen: Map<string, UiTaskQueueTask["status"]>;
	mainAnswered: Set<string>;
	asking: Set<string>;
} {
	const open = new Set(sources.map((s) => s.file));
	const wanted = new Map<string, StuckWanted>();
	const seen = new Map<string, UiTaskQueueTask["status"]>();
	const mainAnswered = new Set<string>();
	const asking = new Set<string>();
	for (const s of sources) {
		for (const t of s.queue.tasks) {
			const target = stuckTarget(s.file, t);
			if (!target) continue;
			// A lane task's own chat speaks for it while it's open.
			if (target !== s.file && open.has(target)) continue;
			const key = stuckKey(target, t.id);
			if (!seen.has(key)) {
				seen.set(key, t.status);
				if (t.status === "working" && t.mainAnswered) mainAnswered.add(key);
				// queue-blocked: a blocked task's chat doesn't need the user either (the queue pokes it).
				if (t.status === "asking" || t.status === "blocked") asking.add(target);
			}
			if (t.status !== "stuck" || wanted.has(key)) continue;
			const meta: AskMeta =
				target === s.file
					? s.meta
					: {
							conversationTitle: t.chat?.title || `Queue #${t.id}: ${t.plan.title}`,
							...(s.meta.cwd ? { cwd: s.meta.cwd } : {}),
							sessionFile: target,
						};
			wanted.set(key, {
				key,
				target,
				taskId: t.id,
				taskTitle: t.plan.title,
				question: t.question ?? "",
				choices: t.choices ?? [],
				...(t.detail ? { detail: t.detail } : {}),
				...(s.questionBinding ? { binding: s.questionBinding(t.id) } : {}),
				meta,
			});
		}
	}
	return { wanted, seen, mainAnswered, asking };
}

/**
 * Why a stuck ask went away, from how its task looks now (undefined = its chat isn't open any more).
 * queue-main-chat: `mainAnswered`: the task is back at work with its main chat's answer.
 */
export function stuckGoneReason(
	status: UiTaskQueueTask["status"] | undefined,
	mainAnswered = false,
): { answered: boolean; reason: string } {
	switch (status) {
		case undefined:
			return { answered: false, reason: "the chat was closed" };
		case "working":
			return mainAnswered
				? { answered: false, reason: "its main chat answered it" }
				: { answered: true, reason: "answered in the chat" };
		case "waiting":
			return { answered: true, reason: "answered in the chat" };
		case "done":
			return { answered: false, reason: "the task is done" };
		case "dropped":
			return { answered: false, reason: "its lead dropped the task" };
		case "stuck":
		case "asking":
			return { answered: false, reason: "it asks something else now" };
		default:
			return { answered: false, reason: "the task moved on" };
	}
}
