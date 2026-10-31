/** Structural mirror of pi-queue/question-commit-port.ts v1; no model-facing API. */
export interface QuestionBinding {
	queue: string;
	queueId: string;
	worker: string;
	workerId: string;
	id: number;
	n: number;
	at: number;
	revision: number;
	escalation: string;
}
export type QuestionChange =
	| { kind: "recall"; rid: string; tag: string; reason: string }
	| { kind: "owner"; rid: string; answer: string; from: string; record?: string };
export interface QuestionActor {
	sessionId: string;
	file: string;
	department: string;
	home: string;
}
export type QuestionCommitResult =
	| { status: "committed" | "already"; rid: string; revision: number }
	| { status: "refused" | "uncertain"; reason: string };
export interface QuestionCommit {
	binding: QuestionBinding;
	change: QuestionChange;
	actor: QuestionActor;
}
export interface QuestionCardRequest {
	binding: QuestionBinding;
	actor: QuestionActor;
	tag: string;
	card: string;
}
export type QuestionCardCheck = { allowed: true } | { allowed: false; reason: string };
export interface QuestionCommitEndpoint {
	version: 1;
	sessionId: string;
	file: string;
	binding(id: number): QuestionBinding | undefined;
	/** Active owner admission only; a historical retraction/card binding is not an owner question. */
	ownerBinding?(id: number): QuestionBinding | undefined;
	commit(request: QuestionCommit): QuestionCommitResult;
	/** Optional native occurrence/content guard for recall-card delivery, called just before append. */
	checkCard?(request: QuestionCardRequest): QuestionCardCheck;
}
export interface QuestionCommitCapability {
	request: QuestionCommit;
	finish(result: QuestionCommitResult): void;
}
export const QUESTION_COMMIT_KEY = Symbol.for("pi-queue.question-commits.v1");

/** Duplicate registration is ambiguous, even if both ports claim the same file. */
export function questionEndpoint(sessionId: string): QuestionCommitEndpoint | undefined {
	const registry = (globalThis as Record<symbol, unknown>)[QUESTION_COMMIT_KEY];
	if (!(registry instanceof Map)) return undefined;
	const set: unknown = registry.get(sessionId);
	if (!(set instanceof Set) || set.size !== 1) return undefined;
	const endpoint: QuestionCommitEndpoint = [...set][0];
	return endpoint?.version === 1 &&
		endpoint.sessionId === sessionId &&
		typeof endpoint.binding === "function" &&
		typeof endpoint.commit === "function"
		? endpoint
		: undefined;
}

export function isQuestionBinding(value: unknown): value is QuestionBinding {
	if (!value || typeof value !== "object") return false;
	const b = value as Record<string, unknown>;
	return (
		[b.queue, b.worker].every((s) => typeof s === "string" && s.startsWith("/")) &&
		[b.queueId, b.workerId, b.escalation].every((s) => typeof s === "string" && !!s) &&
		[b.id, b.n, b.at].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0) &&
		typeof b.revision === "number" &&
		Number.isSafeInteger(b.revision) &&
		b.revision >= 0
	);
}

/** Stable occurrence fence; text equality is not routing equality. */
export function questionBindingKey(b: QuestionBinding): string {
	return JSON.stringify([b.queue, b.queueId, b.worker, b.workerId, b.id, b.n, b.at, b.revision, b.escalation]);
}
