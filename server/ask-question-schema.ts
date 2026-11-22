/**
 * The ask_user_question tool's parameters (moved unchanged out of agent-service.ts makeAskUserQuestionTool by
 * ask-question-owners, Ops #1079, which adds the optional per-question `owner`; the checks on it are in
 * ask-question-owners.ts). Keep it in step with protocol.ts UiQuestion.
 */
import { Type } from "typebox";

const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option (1-5 words)" }),
	description: Type.Optional(
		Type.String({
			description: "One short sentence explaining the impact or tradeoff if selected.",
		}),
	),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview rendered below when this option is selected (markdown or HTML — use for mockups/code/config).",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question (snake_case)" }),
	question: Type.String({ description: "The full question text to display (markdown/HTML ok)" }),
	detail: Type.Optional(Type.String({ description: "Optional detail/context shown under the question" })),
	header: Type.Optional(Type.String({ description: "Optional short header for this question" })),
	owner: Type.Optional(
		Type.String({
			description:
				'Which owner this question is for, by name (e.g. "Shine" or "Wai"). Required on every question when this ' +
				"turn carries work for more than one owner; set it too when asking an owner other than the one this turn " +
				"is for. Questions for different owners in one call become separate dialogs, one per owner. Omit it to ask " +
				"this turn's owner.",
		}),
	),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description: "2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
			minItems: 2,
			maxItems: 4,
		}),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	dependsOn: Type.Optional(
		Type.Object({
			questionId: Type.String({ description: "ID of the prior question this question depends on" }),
			value: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description:
						"Show only when the prior answer equals this value (or is in the array). Omit to show whenever answered.",
				}),
			),
		}),
	),
	optionsMap: Type.Optional(
		Type.Record(Type.String(), Type.Array(QuestionOptionSchema), {
			description:
				"Dynamic options based on prior question's chosen value: e.g. { 'React': [opts...], 'Vue': [opts...] }",
		}),
	),
});

/** The tool's `parameters`. */
export const askUserQuestionParameters = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask the user (strictly 1 to 3 questions; prefer 1).",
		minItems: 1,
		maxItems: 3,
	}),
});
