/**
 * effort-level-button (PATCHES.md): the composer's "Department effort level" button and its menu.
 *
 * Split out of `i18n.tsx` so the button can be named without growing that file; the strings are spread back into
 * `en`, so `t("effortLevelName")` and friends work like any other key.
 */
export const effortLevelEn = {
	effortLevelName: "Department effort level",
	// The chip's aria-label and tip: reads apart from the Thinking chip (ops #879, Design rm-866a7f1a).
	effortLevelTip: "Department effort level: {level}",
	// The menu's header, "Effort level · <Department>" (ops #879, Design rm-866a7f1a; was "<Department> table").
	effortLevelTable: "Effort level · {department}",
	effortLevelDefault: "(default)",
	effortLevelRaisedTask: "raised to {level} for this task",
	effortLevelRaisedLead: "raised to {level} for a lead chat",
	effortLevelForced: "uses spare {allowance} allowance",
	effortLevelCantRun: "can't run now: {why}",
	effortLevelBack: "Back to department default",
	effortLevelSaving: "Switching…",
	effortLevelNextTurn: "The chat is busy: it switches at its next turn.",
	effortLevelFailed: "Not changed: {why}",
} as const;
