/**
 * The top bar's three page tabs: Roles, Initiatives and Memory (openviking-dashboard). Like every view button in
 * the top bar's toolbar they are plain buttons, the one shown marked aria-current="page" (a role=tab needs a
 * tablist around it, and the toolbar holds other buttons too: frontend #295).
 *
 * Split out of `TopBar.tsx` so adding a page does not grow that file (Rule 23's 500-line cap and
 * `wt check`'s legacy ratchet). It returns the same slot-id -> node map `TopBar` used to build
 * inline, so ordering, folding and user preferences behave exactly as before.
 */
import type { ReactNode } from "react";
import { FiDatabase, FiFlag, FiUsers } from "react-icons/fi";
import type { Translate } from "../i18n";

export type PageTabView = "roles" | "initiatives" | "openviking";

export interface PageTabsArgs {
	readonly t: Translate;
	/** The view shown right now (any view; only the three page tabs read it). */
	readonly view: string;
	readonly onViewChange: (view: PageTabView) => void;
	/** A tab the chat switched off is left out (same rule as every other host tab). */
	readonly tabOn: (tab: string) => boolean;
	/** roles-overview: how many answers wait on the owner (0: no badge). */
	readonly rolesAsks: number;
}

/** The Roles tab's description ("5 waiting on you"); the top bar draws each tab once. */
const ROLES_WAITING_ID = "roles-tab-waiting";

/** The three page tabs, keyed by slot id (`null` where the chat switched the tab off). */
export function buildPageTabs({ t, view, onViewChange, tabOn, rolesAsks }: PageTabsArgs): Record<string, ReactNode> {
	return {
		// roles-overview: the Roles page; the amber badge counts what waits on the owner (none: no badge).
		// Its name is its visible label, "Roles" (WCAG 2.5.3: a voice user says what they see); the count is
		// its description, "5 waiting on you" (frontend #295).
		"host:roles": tabOn("roles") ? (
			<button
				type="button"
				aria-current={view === "roles" ? "page" : undefined}
				className={`tb-tab roles-tab${view === "roles" ? " active" : ""}`}
				data-tip={t("rolesTabTip")}
				aria-describedby={rolesAsks > 0 ? ROLES_WAITING_ID : undefined}
				onClick={() => onViewChange("roles")}
			>
				<FiUsers />
				<span>{t("rolesTab")}</span>
				{rolesAsks > 0 && (
					<span className="roles-badge" aria-hidden="true">
						{rolesAsks > 99 ? "99+" : rolesAsks}
					</span>
				)}
				{rolesAsks > 0 && (
					<span id={ROLES_WAITING_ID} hidden>
						{t("rolesTabWaiting", { n: rolesAsks })}
					</span>
				)}
			</button>
		) : null,
		// initiatives-page: each initiative's decisions, who really made them, and what they cost the owner.
		"host:initiatives": tabOn("initiatives") ? (
			<button
				type="button"
				aria-current={view === "initiatives" ? "page" : undefined}
				className={`tb-tab initiatives-tab${view === "initiatives" ? " active" : ""}`}
				data-tip={t("initiativesTabTip")}
				onClick={() => onViewChange("initiatives")}
			>
				<FiFlag />
				<span>{t("initiativesTab")}</span>
			</button>
		) : null,
		// openviking-dashboard: what OpenViking is injecting and committing, and what the memory holds.
		"host:openviking": tabOn("openviking") ? (
			<button
				type="button"
				aria-current={view === "openviking" ? "page" : undefined}
				className={`tb-tab openviking-tab${view === "openviking" ? " active" : ""}`}
				data-tip={t("openVikingTabTip")}
				onClick={() => onViewChange("openviking")}
			>
				<FiDatabase />
				<span>{t("openVikingTab")}</span>
			</button>
		) : null,
	};
}
