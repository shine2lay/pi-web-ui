/**
 * effort-level-button (PATCHES.md; ops #876 seam, built by ops task 2b): the wire messages of the composer's
 * "Department effort level" button. Types only, like protocol.ts (which carries them in its unions). The menu's
 * contents come from pi-queue's route channel (`globalThis[Symbol.for("pi-queue.model-route")].api.effortLevels`,
 * pi-queue docs/model-table-format.md "Effort levels"); this file mirrors its shape.
 */

/** A department table's tiers, from most to least costly. */
export type EffortTier = "max" | "xhigh" | "high" | "medium" | "low";

/** One menu row: "Extra high · Opus 5.5 @ xhigh", with its notes. */
export interface UiEffortLevelRow {
	tier: EffortTier;
	/** The level's words: "Max", "Extra high", "High", "Medium", "Low". */
	label: string;
	/** "provider/id" the level runs on now; absent when no cell can run (problem says why). */
	model?: string;
	/** pi's menu name of `model` ("Claude Opus 5.5"). */
	name?: string;
	thinking?: string;
	/** The tier a floor or the low-job rule raises this level to for this chat ("raised to High for this task"). */
	raised?: EffortTier;
	/** The allowance F2 forcing spends on this level ("uses spare ChatGPT allowance"). */
	forced?: string;
	/** Why the level can't run now (every cell excluded, banned or limited). */
	problem?: string;
}

/** What the button shows for one chat. `role` absent: no department table, the button is hidden. */
export interface UiEffortLevels {
	/** The department (pi-identity id) whose table the chat runs on. */
	role?: string;
	/** The department's display title, from the shared identity registry (absent when no identity exists). */
	title?: string;
	/** A lead's home chat, or a queued task's chat. */
	kind?: "lead" | "task";
	/** The level without a pick: the table's lead tier, or the task's tier (else everyday). */
	defaultTier?: EffortTier;
	/** The owner's pick for this chat; absent: the department default applies. */
	pickedTier?: EffortTier;
	/** max..low, always five when `role` is set. */
	rows: UiEffortLevelRow[];
	/** A broken table, ban list or chat-levels.json (shown as a warning; a broken picks file counts as no picks). */
	problems?: string[];
}

export type EffortLevelClientMessage =
	/** The open chat's levels; answered with effort_levels. */
	| { type: "get_effort_levels"; conversationId: string }
	/** The owner's pick for this chat; null = "Back to department default". Answered with effort_levels. */
	| { type: "set_effort_level"; conversationId: string; tier: EffortTier | null };

export type EffortLevelServerMessage = {
	type: "effort_levels";
	conversationId: string;
	levels: UiEffortLevels;
	/** After a set: "now" = switched at once (idle chat); "next-turn" = the chat is busy, it switches at its next turn start. */
	applied?: "now" | "next-turn";
	/** Why a set was refused (unknown tier, no table, a broken chat-levels.json). */
	error?: string;
};
