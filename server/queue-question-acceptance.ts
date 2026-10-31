/** Conservative generic owner acceptance: metadata only, never an inferred queue answer. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { NativeQuestionWrite, supportsNativeQuestionWrite } from "./queue-question-durability.js";

export const UNBOUND_OWNER_ACCEPTANCE = "queue-unbound-owner-acceptance";
export interface QuestionAcceptanceSource {
	sessionId: string;
	file: string;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class UnboundOwnerAcceptance {
	private readonly coveredSince: number;
	private readonly failed = new Map<string, { at: number; reason: string }>();
	private unknownSourceFailure?: { at: number; reason: string };

	constructor(private readonly now: () => number = Date.now) {
		this.coveredSince = now();
	}

	/** A missing marker is never evidence of nonacceptance. Answers still resolve on any failure. */
	uncertain(file: string | undefined, error: unknown): void {
		const failure = { at: this.now(), reason: errorText(error) };
		if (file) this.failed.set(resolve(file), failure);
		else this.unknownSourceFailure = failure;
		console.error("[question-acceptance] answer preserved; recall fenced:", failure.reason);
	}

	/** Actual generic acceptance in an authenticated native queue root or current department home. */
	accepted(source: QuestionAcceptanceSource, manager: unknown): void {
		let proof: NativeQuestionWrite | undefined;
		try {
			if (
				!supportsNativeQuestionWrite(manager) ||
				manager.getSessionId() !== source.sessionId ||
				manager.getSessionFile() !== source.file
			)
				throw new Error("unbound owner acceptance has no synchronous native source writer");
			proof = new NativeQuestionWrite(manager);
			const marker = { v: 1, rid: randomUUID(), at: this.now(), sessionId: source.sessionId };
			manager.appendCustomEntry(UNBOUND_OWNER_ACCEPTANCE, marker);
			proof.acknowledgeMetadata(UNBOUND_OWNER_ACCEPTANCE, marker);
		} catch (error) {
			this.uncertain(source.file, error);
		} finally {
			try {
				proof?.close();
			} catch (error) {
				this.uncertain(source.file, error);
			}
		}
	}

	/** Synchronous final-send fence, after all host waits. Reads metadata, never tool/model payloads. */
	refusal(manager: unknown, questionAt: number): string | undefined {
		return this.refusalForSources([manager], questionAt);
	}

	/** Check every bound source's actual evidence before falling back to incomplete coverage. */
	refusalForSources(managers: unknown[], questionAt: number): string | undefined {
		try {
			for (const manager of managers) {
				if (!supportsNativeQuestionWrite(manager))
					return "Recall cannot verify unbound owner acceptance without the synchronous native queue/home writer.";
				const file = manager.getSessionFile();
				if (!file) return "Recall cannot verify the native queue/home transcript for owner acceptance.";
				for (const failure of [this.unknownSourceFailure, this.failed.get(resolve(file))]) {
					if (failure && failure.at >= questionAt)
						return `Recall cannot exclude an accepted owner answer: native acceptance persistence was uncertain (${failure.reason}).`;
				}
				// All native entries, not only the selected branch: changing a branch must not erase acceptance.
				for (const entry of manager.getEntries()) {
					if (entry.type !== "custom" || entry.customType !== UNBOUND_OWNER_ACCEPTANCE) continue;
					const data = entry.data as { v?: unknown; at?: unknown; rid?: unknown; sessionId?: unknown } | undefined;
					if (
						data?.v !== 1 ||
						typeof data.at !== "number" ||
						!Number.isSafeInteger(data.at) ||
						typeof data.rid !== "string" ||
						!data.rid ||
						typeof data.sessionId !== "string" ||
						!data.sessionId
					)
						return "Recall cannot verify malformed native owner-acceptance metadata in the queue/home transcript.";
					if (data.at >= questionAt)
						return "The owner already accepted an unbound dialog in the parent queue or department home since the question; its relation is unknown, so the answer is preserved.";
				}
			}
			// Legacy decisions are best-effort writes. Without a complete native coverage interval, even
			// a missing acceptance record cannot rule out an accepted-but-unrecorded answer before restart.
			if (questionAt <= this.coveredSince)
				return "Recall cannot exclude a legacy or unrecorded owner acceptance: this question is at or before the current native host's acceptance coverage (including restart).";
			return undefined;
		} catch (error) {
			return `Recall cannot verify native owner-acceptance history: ${errorText(error)}`;
		}
	}
}
