/** Idempotent recall-card delivery in the lead's native transcript, without a worker/model turn. */
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { NativeQuestionWrite } from "./queue-question-durability.js";
import { isKnownNoTurnMessagePath } from "./prompt-start-guard.js";
import {
	isQuestionBinding,
	questionEndpoint,
	type QuestionActor,
	type QuestionBinding,
} from "./queue-question-port.js";

export type QuestionCardResult =
	{ status: "delivered" | "already" } | { status: "pending" | "refused" | "uncertain"; reason: string };
export interface QuestionCardHost {
	/** Registered source must still be its department's current home; no caller-selected destination. */
	source(sessionId: string): AgentSession | undefined;
	actor(sourceSessionId: string, binding: QuestionBinding): QuestionActor | undefined;
	prepare(file: string): Promise<void>;
}

export class QuestionCardDelivery {
	private readonly lanes = new Map<string, Promise<QuestionCardResult>>();
	constructor(private readonly host: QuestionCardHost) {}

	deliverQuestionCard = (
		sourceSessionId: string,
		tag: string,
		card: string,
		binding?: QuestionBinding,
	): Promise<QuestionCardResult> => {
		if (
			typeof sourceSessionId !== "string" ||
			!sourceSessionId ||
			typeof tag !== "string" ||
			!tag ||
			typeof card !== "string" ||
			!card.trim() ||
			!isQuestionBinding(binding)
		)
			return Promise.resolve({ status: "refused", reason: "question card needs a native occurrence binding" });
		const bound = Object.freeze({ ...binding });
		const previous = this.lanes.get(sourceSessionId) ?? Promise.resolve();
		const run = previous.then(() => this.deliver(sourceSessionId, tag, card, bound));
		this.lanes.set(sourceSessionId, run);
		void run.then(() => {
			if (this.lanes.get(sourceSessionId) === run) this.lanes.delete(sourceSessionId);
		});
		return run;
	};

	private async deliver(
		sourceSessionId: string,
		tag: string,
		card: string,
		binding: QuestionBinding,
	): Promise<QuestionCardResult> {
		let proof: NativeQuestionWrite | undefined;
		let attempted = false;
		let result: QuestionCardResult;
		try {
			if (!questionEndpoint(sourceSessionId) || !this.host.source(sourceSessionId))
				return { status: "refused", reason: "question card caller is not a registered current home" };
			await this.host.prepare(binding.queue);
			await this.host.prepare(binding.worker);
			// Re-resolve AFTER the lane and every opening await. No await may separate the native guard
			// from the synchronous idle append; parent holds/source restrictions share this JS writer.
			const source = this.host.source(sourceSessionId);
			const endpoint = questionEndpoint(sourceSessionId);
			const worker = questionEndpoint(binding.workerId);
			const actor = this.host.actor(sourceSessionId, binding);
			if (
				!source ||
				!endpoint ||
				!actor ||
				actor.file !== endpoint.file ||
				endpoint.file !== source.sessionManager.getSessionFile() ||
				!worker?.checkCard ||
				worker.file !== binding.worker ||
				!isKnownNoTurnMessagePath(source, AgentSession.prototype.sendCustomMessage)
			)
				return { status: "refused", reason: "question card needs the current native home and occurrence guard" };
			proof = new NativeQuestionWrite(source.sessionManager);
			const checked = worker.checkCard({ binding, actor, tag, card });
			if (checked?.allowed !== true) {
				proof.close();
				return {
					status: "refused",
					reason: checked?.reason ?? "native question card guard did not authorize delivery",
				};
			}
			const existing = source.sessionManager
				.getBranch()
				.find(
					(e) =>
						e.type === "custom_message" &&
						e.customType === "queue-question-card" &&
						(e.details as { tag?: unknown } | undefined)?.tag === tag,
				);
			if (existing) {
				proof.acknowledgeExisting(existing);
				result = { status: "already" };
			} else if (source.isStreaming || source.isCompacting) {
				// These SDK branches are memory buffers. They are not a durable delivery acknowledgement.
				result = { status: "pending", reason: "lead session is busy; retry the same occurrence tag when idle" };
			} else {
				attempted = true;
				// In the native idle SDK branch this appends synchronously; no triggerTurn, no queue/wake call.
				const sent = source
					.sendCustomMessage(
						{
							customType: "queue-question-card",
							content: card,
							display: true,
							details: { tag },
						},
						{ triggerTurn: false },
					)
					.then(
						() => ({ ok: true as const }),
						(error: unknown) => ({ ok: false as const, error }),
					);
				proof.acknowledgeCard(tag);
				const settled = await sent;
				if (!settled.ok) throw settled.error;
				result = { status: "delivered" };
			}
		} catch (error) {
			result = {
				status: attempted ? "uncertain" : "refused",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			proof?.close();
		} catch (error) {
			return { status: "uncertain", reason: error instanceof Error ? error.message : String(error) };
		}
		return result;
	}
}
