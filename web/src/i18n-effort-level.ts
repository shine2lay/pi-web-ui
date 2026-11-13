/**
 * effort-level-button (PATCHES.md): the composer's "Department effort level" button and its menu.
 *
 * Split out of `i18n.tsx` so the button can be named without growing that file; the strings are spread back into
 * `en`, so `t("effortLevelName")` and friends work like any other key.
 */
export const effortLevelEn = {
	effortLevelName: "Department effort level",
	effortLevelTip: "Department effort level: {level} ({table})",
	effortLevelTable: "{department} table",
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
