/**
 * The top bar's page tabs: their names and hover hints (frontend #258).
 *
 * Split out of `i18n.tsx` so a new page can be named without growing that file; the strings are
 * spread back into `en`, so `t("rolesTab")` and friends keep working unchanged.
 */
export const pageTabsEn = {
	// roles-overview: the Roles page (a top bar view) and the owner's fields in Settings -> Identities.
	rolesTab: "Roles",
	rolesTabWaiting: "Roles, {n} waiting on you",
	rolesTabTip: "Roles: what every role is doing and what waits on you",
	// initiatives-page: the Initiatives tab (decisions per initiative, who really decided, what they cost you).
	initiativesTab: "Initiatives",
	initiativesTabTip: "Initiatives: every decision behind each one, who really made it, and what it means for you",
	// openviking-dashboard: the Memory tab (what OpenViking injects and commits, and what the memory holds).
	openVikingTab: "Memory",
	openVikingTabTip:
		"OpenViking memory: what it is injecting and committing right now, and what Shared and Per-Role memory hold",
} as const;
