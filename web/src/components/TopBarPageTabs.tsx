/**
 * The top bar's three page tabs: Roles, Initiatives and Memory (openviking-dashboard).
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

/** The three page tabs, keyed by slot id (`null` where the chat switched the tab off). */
export function buildPageTabs({ t, view, onViewChange, tabOn, rolesAsks }: PageTabsArgs): Record<string, ReactNode> {
	return {
		// roles-overview: the Roles page; the amber badge counts what waits on the owner (none: no badge).
		"host:roles": tabOn("roles") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "roles"}
				className={`tb-tab roles-tab${view === "roles" ? " active" : ""}`}
				data-tip={t("rolesTabTip")}
				{...(rolesAsks > 0 ? { "aria-label": t("rolesTabWaiting", { n: rolesAsks }) } : {})}
				onClick={() => onViewChange("roles")}
			>
				<FiUsers />
				<span>{t("rolesTab")}</span>
				{rolesAsks > 0 && (
					<span className="roles-badge" aria-hidden="true">
						{rolesAsks > 99 ? "99+" : rolesAsks}
					</span>
				)}
			</button>
		) : null,
		// initiatives-page: each initiative's decisions, who really made them, and what they cost the owner.
		"host:initiatives": tabOn("initiatives") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "initiatives"}
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
				role="tab"
				aria-selected={view === "openviking"}
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
