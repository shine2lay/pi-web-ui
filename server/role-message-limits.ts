/** Owner 2026-10-20, dr-c6daedfa9fef: no hourly limit for temper or ops, in any chat (Ops #318). */
export const ROLE_MESSAGES_HOURLY_EXEMPT_ROLES = ["temper", "ops"] as const;
/** Check only the server-derived sender role. Usage, chain approvals and every other guard still apply. */
export function roleMessagesHourlyExempt(role: string): boolean {
	return ROLE_MESSAGES_HOURLY_EXEMPT_ROLES.some((id) => id === role);
}
