/** lazy-files-visibility: geometry only; each window supplies its own view/drawer state. */
export function filesPanelVisible(
	view: string,
	isMobile: boolean,
	drawer: "left" | "right" | null,
	rightCollapsed: boolean,
): boolean {
	return view === "chat" && (isMobile ? drawer === "right" : !rightCollapsed);
}
