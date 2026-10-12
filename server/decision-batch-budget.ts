// Deterministic pre-prompt accounting. No model content, SDK, credentials or I/O.
export const BATCH_TOKEN_LIMIT = 500_000;
export const REQUEST_FRAMING = 10_000;
export const QUOTA_FRESH_MS = 35 * 60_000;
export interface TokenBudget {
	v: 1;
	limit: number;
	actual: number;
	calls: number;
	pending?: { tokens: number; inputUpper: number; outputUpper: number; at: number };
}
export interface QuotaReading {
	at: number;
	week: number;
	five: number;
}
export const safeCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function newTokenBudget(): TokenBudget {
	return { v: 1, limit: BATCH_TOKEN_LIMIT, actual: 0, calls: 0 };
}
export function allocated(b: TokenBudget): number {
	return b.actual + (b.pending?.tokens ?? 0);
}
export function validBudget(b: TokenBudget): boolean {
	return (
		b?.v === 1 &&
		b.limit === BATCH_TOKEN_LIMIT &&
		safeCount(b.actual) &&
		safeCount(b.calls) &&
		(!b.pending ||
			(safeCount(b.pending.tokens) &&
				safeCount(b.pending.inputUpper) &&
				safeCount(b.pending.outputUpper) &&
				b.pending.outputUpper > 0 &&
				safeCount(b.pending.at) &&
				b.pending.tokens === b.pending.inputUpper + b.pending.outputUpper)) &&
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
export function reserveTokens(b: TokenBudget, inputUpper: number, outputUpper: number, now: number): void {
	const reason = reservationBlock(b, inputUpper, outputUpper, now);
	if (reason) throw new Error(reason);
	b.pending = { tokens: inputUpper + outputUpper, inputUpper, outputUpper, at: now };
}
export function settleTokens(b: TokenBudget, usage: { input: number; output: number }): void {
	if (!validBudget(b) || !b.pending) throw new Error("unresolved reservation unavailable");
	if (!safeCount(usage.input) || !safeCount(usage.output) || usage.input + usage.output <= 0)
		throw new Error("authoritative usage unavailable");
	if (usage.input > b.pending.inputUpper || usage.output > b.pending.outputUpper)
		throw new Error("usage exceeded reserved upper bound");
	b.actual += usage.input + usage.output;
	b.calls++;
	delete b.pending;
}
