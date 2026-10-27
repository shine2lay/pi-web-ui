/** Target semantics only. This does NOT classify a payload as safe to journal,
 * grant a permission, authorize an action, or allow replay. A global resource's
 * original recovery-source session is an archive namespace, not its target. */
export function recoveryUsesSessionTarget(type: string): boolean {
	switch (type) {
		case "identity_file_save":
		case "identity_note_save":
		case "board_post":
		case "board_close":
		case "schedule_save":
			return false;
		default:
			return true;
	}
}
