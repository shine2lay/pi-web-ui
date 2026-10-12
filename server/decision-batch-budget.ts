// Deterministic pre-prompt accounting. No model content, SDK, credentials or I/O.
export const BATCH_TOKEN_LIMIT = 500_000;
export const REQUEST_FRAMING = 10_000;
export const QUOTA_FRESH_MS = 35 * 60_000;
export interface LocalCall {
	ref: string;
	invocation: string;
	pid: number;
	start: string;
	boot: string;
	day: string;
}
export interface Reservation {
	tokens: number;
	inputUpper: number;
	outputUpper: number;
	at: number;
	local?: LocalCall;
}
export interface UnknownCharge extends Reservation {
	id: string;
	day: string;
	chunk: number;
	receipt: string;
}
export interface TokenBudget {
	v: 1 | 2;
	limit: number;
	actual: number;
	calls: number;
	pending?: Reservation;
	/** v2 only: immutable charges, NOT occupied local call slots. */
	unknowns?: UnknownCharge[];
}
export interface QuotaReading {
	at: number;
	week: number;
	five: number;
}
export const safeCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export const validDay = (day: unknown): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day);
export function validLocalCall(c: LocalCall): boolean {
	return (
		!!c &&
		typeof c.ref === "string" &&
		/^[a-f0-9-]{36}$/.test(c.ref) &&
		typeof c.invocation === "string" &&
		/^(?:[a-f0-9]{32}|foreground)$/.test(c.invocation) &&
		safeCount(c.pid) &&
		c.pid > 0 &&
		typeof c.start === "string" &&
		/^\d+$/.test(c.start) &&
		typeof c.boot === "string" &&
		/^[a-f0-9-]{36}$/.test(c.boot) &&
		validDay(c.day)
	);
}
export function validReservation(r: Reservation): boolean {
	return (
		!!r &&
		[r.tokens, r.inputUpper, r.outputUpper, r.at].every(safeCount) &&
		r.outputUpper > 0 &&
		r.tokens === r.inputUpper + r.outputUpper &&
		(!r.local || validLocalCall(r.local))
	);
}
export function newTokenBudget(v: 1 | 2 = 1): TokenBudget {
	return { v, limit: BATCH_TOKEN_LIMIT, actual: 0, calls: 0, ...(v === 2 ? { unknowns: [] } : {}) };
}
export function heldTokens(b: TokenBudget): number {
	return (b.unknowns ?? []).reduce((n, r) => n + r.tokens, 0);
}
export function allocated(b: TokenBudget): number {
	return b.actual + heldTokens(b) + (b.pending?.tokens ?? 0);
}
export function validBudget(b: TokenBudget): boolean {
	return (
		!!b &&
		(b.v === 1 || b.v === 2) &&
		b.limit === BATCH_TOKEN_LIMIT &&
		safeCount(b.actual) &&
		safeCount(b.calls) &&
		(!b.pending || (validReservation(b.pending) && (b.v === 1 || !!b.pending.local))) &&
		(b.v === 1
			? b.unknowns === undefined
			: Array.isArray(b.unknowns) &&
				b.unknowns.every(
					(r) =>
						validReservation(r) &&
						validDay(r.day) &&
						safeCount(r.chunk) &&
						r.chunk > 0 &&
						typeof r.id === "string" &&
						/^[a-f0-9]{64}$/.test(r.id) &&
						typeof r.receipt === "string" &&
						/^[a-f0-9]{64}$/.test(r.receipt),
				) &&
				new Set(b.unknowns.map((r) => r.id)).size === b.unknowns.length) &&
		safeCount(allocated(b)) &&
		allocated(b) <= b.limit
	);
}
export function quotaBlock(r: QuotaReading | undefined, now: number): string | undefined {
	if (!r || ![r.at, r.week, r.five, now].every(Number.isFinite)) return "quota unavailable";
	if (r.at > now + 60_000 || now - r.at > QUOTA_FRESH_MS) return "quota stale";
	if (r.week < 0 || r.five < 0) return "quota invalid";
	if (r.week >= 60) return "weekly usage stop";
	if (r.five >= 75) return "five-hour usage stop";
	return undefined;
}
export function reservationBlock(
	b: TokenBudget,
	inputUpper: number,
	outputUpper: number,
	now: number,
): string | undefined {
	if (!validBudget(b)) return "invalid persisted batch budget";
	if (b.pending) return "unresolved call cost";
	if (
		![inputUpper, outputUpper, now].every(safeCount) ||
		outputUpper === 0 ||
		!Number.isSafeInteger(inputUpper + outputUpper)
	)
		return "invalid call upper bound";
	if (allocated(b) + inputUpper + outputUpper > b.limit) return "batch boundary";
	return undefined;
}
export function reserveTokens(
	b: TokenBudget,
	inputUpper: number,
	outputUpper: number,
	now: number,
	local?: LocalCall,
): void {
	const reason = reservationBlock(b, inputUpper, outputUpper, now);
	if (reason) throw new Error(reason);
	if ((local && !validLocalCall(local)) || (b.v === 2 && !local)) throw new Error("local call identity unavailable");
	b.pending = { tokens: inputUpper + outputUpper, inputUpper, outputUpper, at: now, ...(local ? { local } : {}) };
}
export function settleTokens(b: TokenBudget, usage: { input: number; output: number }, ref?: string): void {
	if (!validBudget(b) || !b.pending) throw new Error("unresolved reservation unavailable");
	if (b.pending.local && b.pending.local.ref !== ref) throw new Error("stale local call");
	if (!safeCount(usage.input) || !safeCount(usage.output) || usage.input + usage.output <= 0)
		throw new Error("authoritative usage unavailable");
	if (usage.input > b.pending.inputUpper || usage.output > b.pending.outputUpper)
		throw new Error("usage exceeded reserved upper bound");
	b.actual += usage.input + usage.output;
	b.calls++;
	delete b.pending;
}
