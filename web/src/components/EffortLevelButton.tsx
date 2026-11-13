/**
 * effort-level-button (PATCHES.md): the composer's "Department effort level" button, beside the model and Effort
 * menus. Owner (Ops home chat 2026-11-13, m93253): "I need a button to change the effort per chat based on that
 * department's table . So I can choose effort for the leads without going to the actual model selector".
 *
 * Shown only in a chat with a department table (a lead's home chat or a queued task's chat); its menu lists the
 * table's five levels as "<level> · <model> @ <thinking>", ✓ on the chat's level, "(default)" on the department
 * default, the raised/forced notes, and "Back to department default". The pick holds until changed (pi-queue keeps
 * it); the server switches an idle chat at once and a busy one at its next turn.
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FiSliders } from "react-icons/fi";
import type { UiEffortLevelRow, UiEffortLevels } from "../../../server/effort-level-protocol";
import { pickEffortLevel, useEffortLevels } from "../effort-level-state";
import { useT } from "../i18n";
import { Dropdown } from "./Dropdown";
import "../effort-level.css";

type T = ReturnType<typeof useT>;

/** "ops" -> "Ops": the table's name in the menu header. */
const departmentName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

/** The model part of a row: "Claude Opus 5.5 @ high", or why the level can't run. */
function rowModel(row: UiEffortLevelRow, t: T): string {
	if (!row.model) return t("effortLevelCantRun", { why: row.problem ?? "no usable model" });
	return `${row.name ?? row.model}${row.thinking ? ` @ ${row.thinking}` : ""}`;
}

/** The row's notes: raised by a floor or the low-job rule, F2 forcing, a problem beside a usable model. */
function rowNotes(row: UiEffortLevelRow, levels: UiEffortLevels, t: T): string[] {
	const label = (tier: string) => levels.rows.find((r) => r.tier === tier)?.label ?? tier;
	const notes: string[] = [];
	if (row.raised)
		notes.push(
			t(levels.kind === "task" ? "effortLevelRaisedTask" : "effortLevelRaisedLead", { level: label(row.raised) }),
		);
	if (row.forced) notes.push(t("effortLevelForced", { allowance: row.forced }));
	if (row.model && row.problem) notes.push(row.problem);
	return notes;
}

/** Arrow keys move between the menu's items (role="menu"). */
function moveFocus(e: KeyboardEvent<HTMLDivElement>): void {
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
	const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)")];
	if (items.length === 0) return;
	e.preventDefault();
	const at = items.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		e.key === "Home"
			? 0
			: e.key === "End"
				? items.length - 1
				: (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
	items[next]?.focus();
}

export const EffortLevelButton = memo(function EffortLevelButton({
	conversationId,
	connected,
}: {
	conversationId?: string;
	connected: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const view = useEffortLevels(conversationId);
	useEffect(() => setOpen(false), [conversationId, connected]);
	useEffect(() => {
		if (open) menu.current?.querySelector<HTMLButtonElement>("[aria-checked='true'], [role^='menuitem']")?.focus();
	}, [open]);
	const levels = view?.levels;
	if (!conversationId || !view || !levels?.role || levels.rows.length === 0) return null;
	const current = levels.pickedTier ?? levels.defaultTier;
	const currentLabel = levels.rows.find((r) => r.tier === current)?.label ?? "—";
	const table = t("effortLevelTable", { department: departmentName(levels.role) });
	const pick = (tier: UiEffortLevelRow["tier"] | null) => {
		if (pickEffortLevel(conversationId, tier)) setOpen(false);
	};
	const status = view.pending
		? t("effortLevelSaving")
		: view.error
			? t("effortLevelFailed", { why: view.error })
			: view.applied === "next-turn"
				? t("effortLevelNextTurn")
				: "";
	return (
		<Dropdown
			trigger={
				<>
					<FiSliders aria-hidden="true" />
					<span className="effort-level-name">{currentLabel}</span>
				</>
			}
			triggerClassName={`chip effort-level-chip${levels.pickedTier ? " picked" : ""}`}
			ariaLabel={t("effortLevelName")}
			tip={t("effortLevelTip", { level: currentLabel, table })}
			open={open}
			onOpenChange={setOpen}
			align="left"
			direction="up"
			menuClassName="effort-menu"
			menuRef={menu}
			menuRole="menu"
			menuLabel={t("effortLevelName")}
		>
			<div onKeyDown={moveFocus}>
				<div className="dd-header effort-menu-head">{table}</div>
				{(levels.problems ?? []).map((p) => (
					<div key={p} className="effort-menu-problem" role="note">
						{p}
					</div>
				))}
				{levels.rows.map((row) => {
					const checked = row.tier === current;
					const notes = rowNotes(row, levels, t);
					return (
						<button
							key={row.tier}
							type="button"
							role="menuitemradio"
							aria-checked={checked}
							className={`dd-item effort-row${checked ? " active" : ""}`}
							disabled={!row.model || view.pending}
							onClick={() => pick(row.tier)}
						>
							<span className="effort-row-main">
								<span className="effort-row-level">{row.label}</span>
								{" · "}
								<span className="effort-row-model">{rowModel(row, t)}</span>
								{row.tier === levels.defaultTier && (
									<span className="effort-row-default"> {t("effortLevelDefault")}</span>
								)}
							</span>
							<span className="effort-row-check" aria-hidden="true">
								{checked ? "✓" : ""}
							</span>
							{notes.length > 0 && <span className="effort-row-note">{notes.join(" · ")}</span>}
						</button>
					);
				})}
				{status && (
					<div className={`effort-menu-status${view.error ? " error" : ""}`} role="status">
						{status}
					</div>
				)}
				<div className="dd-footer">
					<button
						type="button"
						role="menuitem"
						className="dd-item effort-menu-back"
						disabled={view.pending}
						onClick={() => pick(null)}
					>
						{t("effortLevelBack")}
					</button>
				</div>
			</div>
		</Dropdown>
	);
});
