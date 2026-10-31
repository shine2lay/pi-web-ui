/** One parent-queue writer lane shared by recall and every supported owner admission. */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { NativeQuestionWrite } from "./queue-question-durability.js";
import {
	isQuestionBinding,
	questionBindingKey,
	questionEndpoint,
	type QuestionActor,
	type QuestionBinding,
	type QuestionChange,
	type QuestionCommit,
	type QuestionCommitCapability,
	type QuestionCommitResult,
} from "./queue-question-port.js";

export interface QuestionSession {
	sessionId: string;
	file: string;
	manager: unknown;
}
export interface QuestionCommitHost {
	/** Only native registered sessions and current role/home records. Never request fields. */
	actor(sourceSessionId: string, binding: QuestionBinding): QuestionActor | undefined;
	session(file: string): QuestionSession | undefined;
	/** Opens without prompting a model. All awaits happen before the final native command. */
	prepare(file: string): Promise<void>;
	dispatch(file: string, command: string): Promise<boolean>;
	/** Metadata-only generic owner acceptance, checked in the final synchronous writer turn. */
	recallRefusal(request: QuestionCommit): string | undefined;
}
interface Ticket {
	request: QuestionCommit;
	complete(result: QuestionCommitResult): void;
	consumed: boolean;
	finished: boolean;
	proof?: NativeQuestionWrite;
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const refused = (reason: string): QuestionCommitResult => ({ status: "refused", reason });
const occurrenceKey = (b: QuestionBinding) =>
	JSON.stringify([b.queue, b.queueId, b.worker, b.workerId, b.id, b.n, b.at]);

export class QuestionCommitCoordinator {
	private readonly lanes = new Map<string, Promise<unknown>>();
	private readonly tickets = new Map<string, Ticket>();
	private readonly poisoned = new Map<string, string>();

	constructor(private readonly host: QuestionCommitHost) {}

	commitQuestion = (
		sourceSessionId: string,
		binding: QuestionBinding,
		change: QuestionChange,
	): Promise<QuestionCommitResult> => {
		if (
			!isQuestionBinding(binding) ||
			!change ||
			typeof sourceSessionId !== "string" ||
			!sourceSessionId ||
			typeof change.rid !== "string" ||
			!change.rid ||
			(change.kind !== "recall" && change.kind !== "owner") ||
			(change.kind === "recall" &&
				(typeof change.reason !== "string" ||
					!change.reason.trim() ||
					typeof change.tag !== "string" ||
					!change.tag)) ||
			(change.kind === "owner" &&
				(typeof change.answer !== "string" || !change.answer.trim() || typeof change.from !== "string" || !change.from))
		)
			return Promise.resolve(refused("invalid question commit request"));
		const b = Object.freeze({ ...binding });
		const c = Object.freeze({ ...change });
		const key = resolve(b.queue);
		const previous = this.lanes.get(key) ?? Promise.resolve();
		const run = previous.then(() => this.commit(sourceSessionId, b, c));
		// commit converts every error into a result, so this lane cannot become a rejected tail.
		this.lanes.set(key, run);
		void run.then((result) => {
			if (this.lanes.get(key) === run) this.lanes.delete(key);
			// The canonical ACK releases this writer lane. Notification is a separate native command;
			// neither its latency nor its failure may reopen/undo the committed question transition.
			if (c.kind === "recall" && (result.status === "committed" || result.status === "already"))
				void this.afterRecall(b.worker, result.rid);
		});
		return run;
	};

	private async afterRecall(worker: string, rid: string): Promise<void> {
		try {
			if (!(await this.host.dispatch(worker, `/queue question-after ${rid}`)))
				console.error("[question-commit] recall aftermath command is unavailable; persisted recall waits for retry");
		} catch (error) {
			console.error("[question-commit] recall aftermath failed; persisted recall waits for retry:", errorText(error));
		}
	}

	private async commit(
		source: string,
		binding: QuestionBinding,
		change: QuestionChange,
	): Promise<QuestionCommitResult> {
		const poison = this.poisoned.get(occurrenceKey(binding));
		if (poison) return { status: "uncertain", reason: poison };
		try {
			// The caller must already exist. Opening by a caller-supplied source id would authenticate nothing.
			const sourcePort = questionEndpoint(source);
			if (!sourcePort) return refused("source question endpoint is absent or ambiguous");
			await this.host.prepare(binding.queue);
			await this.host.prepare(binding.worker);
			const actor = this.host.actor(source, binding);
			if (!actor || actor.sessionId !== source || actor.file !== sourcePort.file)
				return refused("source session or accountable department home is no longer current");
			return await this.dispatch({ binding, change, actor: Object.freeze({ ...actor }) });
		} catch (error) {
			return refused(errorText(error));
		}
	}

	private dispatch(request: QuestionCommit): Promise<QuestionCommitResult> {
		return new Promise((resolveResult) => {
			const token = randomBytes(32).toString("hex");
			const ticket: Ticket = {
				request: Object.freeze(request),
				consumed: false,
				finished: false,
				complete: (result) => {
					if (ticket.finished) return;
					ticket.finished = true;
					this.tickets.delete(token);
					try {
						ticket.proof?.close();
					} catch (error) {
						result = { status: "uncertain", reason: errorText(error) };
					}
					if (result.status === "uncertain") this.poisoned.set(occurrenceKey(request.binding), result.reason);
					resolveResult(result);
				},
			};
			this.tickets.set(token, ticket);
			const failure = (error: unknown) => {
				if (ticket.finished) {
					console.error("[question-commit] command failed after acknowledgement:", errorText(error));
					return;
				}
				ticket.complete({ status: ticket.consumed ? "uncertain" : "refused", reason: errorText(error) });
			};
			try {
				void this.host.dispatch(request.binding.worker, `/queue question-commit ${token}`).then(() => {
					if (!ticket.finished) failure(new Error("question command returned without its synchronous acknowledgement"));
				}, failure);
			} catch (error) {
				failure(error);
			}
		});
	}

	consumeQuestionCommit = (token: string, workerSessionId: string): QuestionCommitCapability | undefined => {
		const ticket = this.tickets.get(token);
		this.tickets.delete(token);
		if (!ticket || ticket.finished || ticket.consumed) return undefined;
		const { binding: b, actor } = ticket.request;
		try {
			const worker = this.host.session(b.worker);
			const queue = this.host.session(b.queue);
			const currentActor = this.host.actor(actor.sessionId, b);
			const sourcePort = questionEndpoint(actor.sessionId);
			const workerPort = questionEndpoint(b.workerId);
			const queuePort = questionEndpoint(b.queueId);
			if (
				workerSessionId !== b.workerId ||
				worker?.sessionId !== b.workerId ||
				worker.file !== b.worker ||
				queue?.sessionId !== b.queueId ||
				queue.file !== b.queue ||
				!sourcePort ||
				sourcePort.file !== actor.file ||
				!workerPort ||
				workerPort.file !== b.worker ||
				!queuePort ||
				queuePort.file !== b.queue ||
				!currentActor ||
				currentActor.sessionId !== actor.sessionId ||
				currentActor.file !== actor.file ||
				currentActor.department !== actor.department ||
				currentActor.home !== actor.home
			) {
				ticket.complete(refused("question source, writer or department home changed before commit"));
				return undefined;
			}
			if (ticket.request.change.kind === "recall") {
				const current = workerPort.binding(b.id);
				// The fixed native author can only return already/refused for this exact prior revision.
				// Let it own duplicate receipt eligibility, including after a host restart.
				const duplicateOnly =
					current?.revision === b.revision + 1 &&
					questionBindingKey({ ...current, revision: b.revision }) === questionBindingKey(b);
				const reason = duplicateOnly ? undefined : this.host.recallRefusal(ticket.request);
				if (reason) {
					ticket.complete(refused(reason));
					return undefined;
				}
			}
			// Both the controls and the endpoint append must be native synchronous writers in this JS turn.
			const parentProof = new NativeQuestionWrite(queue.manager);
			parentProof.close();
			ticket.proof = new NativeQuestionWrite(worker.manager);
			ticket.consumed = true;
			// The worker must commit and finish in this same synchronous turn, not after an await.
			queueMicrotask(() => {
				if (!ticket.finished) ticket.complete({ status: "uncertain", reason: "question commit yielded before finish" });
			});
			return {
				request: ticket.request,
				finish: (result) => {
					if (ticket.finished) throw new Error("question commit capability has already finished or expired");
					try {
						if (!result || !["committed", "already", "refused", "uncertain"].includes(result.status))
							throw new Error("invalid question commit acknowledgement");
						ticket.proof!.acknowledge(ticket.request, result);
						ticket.complete(result);
					} catch (error) {
						ticket.complete({ status: "uncertain", reason: errorText(error) });
						throw error;
					}
				},
			};
		} catch (error) {
			ticket.complete(refused(errorText(error)));
			return undefined;
		}
	};
}
