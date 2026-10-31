/** Bound native owner input. A deterministic receipt also survives delivery failure/restart. */
import { createHash } from "node:crypto";
import { questionBindingKey, type QuestionBinding, type QuestionChange } from "./queue-question-port.js";

export function ownerQuestionChange(binding: QuestionBinding, answer: string, from: string): QuestionChange {
	return {
		kind: "owner",
		rid: `r${createHash("sha256")
			.update(JSON.stringify([questionBindingKey(binding), answer]))
			.digest("hex")
			.slice(0, 12)}`,
		answer,
		from,
	};
}
