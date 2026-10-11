/** roles-overview: read the department's own spend-format.md v1 tally, never count or stop work. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { UiRoleSpend } from "./protocol.js";

export const SPEND_FILE_MAX = 64 * 1024;
const DAY = 86_400_000;
const pacific = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string =>
	typeof v === "string" &&
	/^\d{4}-\d{2}-\d{2}$/.test(v) &&
	Number.isFinite(Date.parse(v)) &&
	new Date(v).toISOString().slice(0, 10) === v;

interface SpendV1 {
	v: 1;
	budgetUsd: number;
	budgetFrom: string;
	weekStart: string;
	weekEnd: string;
	spentUsd: number;
	updatedAt: string;
	stopped: boolean;
	byInitiative?: Record<string, number>;
}

/** Same v1 contract as Ops107's own-role write exception; first week is deliberately longer. */
export function parseSpend(value: unknown): SpendV1 | null {
	if (!object(value)) return null;
	const keys = [
		"v",
		"budgetUsd",
		"budgetFrom",
		"weekStart",
		"weekEnd",
		"spentUsd",
		"updatedAt",
		"stopped",
		"byInitiative",
	];
	if (Object.keys(value).some((k) => !keys.includes(k))) return null;
	if (
		value.v !== 1 ||
		!amount(value.budgetUsd) ||
		value.budgetUsd === 0 ||
		!amount(value.spentUsd) ||
		typeof value.stopped !== "boolean"
	)
		return null;
	if (typeof value.budgetFrom !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.budgetFrom))
		return null;
	if (!date(value.weekStart) || !date(value.weekEnd)) return null;
	const first = value.weekStart === "2026-10-10" && value.weekEnd === "2026-10-18";
	if (
		!first &&
		(new Date(value.weekStart).getUTCDay() !== 1 || Date.parse(value.weekEnd) - Date.parse(value.weekStart) !== 6 * DAY)
	)
		return null;
	if (typeof value.updatedAt !== "string") return null;
	const time = value.updatedAt.match(
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?([+-])(\d{2}):(\d{2})$/,
	);
	if (
		!time ||
		!date(time[1]) ||
		+time[2] > 23 ||
		+time[3] > 59 ||
		+time[4] > 59 ||
		+time[6] > 23 ||
		+time[7] > 59 ||
		!Number.isFinite(Date.parse(value.updatedAt))
	)
		return null;
	if (
		value.byInitiative !== undefined &&
		(!object(value.byInitiative) ||
			Object.entries(value.byInitiative).some(
				([id, usd]) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 60 || !amount(usd),
			))
	)
		return null;
	return value as unknown as SpendV1;
}

const usd = (n: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
		maximumFractionDigits: 2,
	}).format(n);
const unavailable = (state: "none" | "unreadable" | "old-week"): UiRoleSpend => ({
	state,
	line:
		state === "none"
			? "No own-work budget"
			: state === "unreadable"
				? "Spend figure unreadable"
				: "No figure for this week yet",
});
function ageOf(at: number, now: number): string {
	const elapsed = Math.max(0, now - at);
	if (elapsed < 60_000) return "just now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
	if (elapsed < DAY) return `${Math.floor(elapsed / 3_600_000)} h ago`;
	return `${Math.floor(elapsed / DAY)} d ago`;
}

/** Date bounds are inclusive Pacific calendar days, never UTC or a fixed 24 h week offset. */
export function spendFromText(text: string, now: number): UiRoleSpend {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return unavailable("unreadable");
	}
	const v = parseSpend(value);
	if (!v) return unavailable("unreadable");
	const today = pacific.format(now);
	if (today < v.weekStart || today > v.weekEnd) return unavailable("old-week");
	const state = v.stopped || v.spentUsd >= v.budgetUsd ? "over" : now - Date.parse(v.updatedAt) > DAY ? "stale" : "ok";
	const spent = usd(v.spentUsd);
	const budget = usd(v.budgetUsd);
	const age = state === "over" ? undefined : ageOf(Date.parse(v.updatedAt), now);
	const byInitiative = Object.entries(v.byInitiative ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, n]) => ({ id, amount: usd(n) }));
	return {
		state,
		spent,
		budget,
		line:
			state === "over"
				? "Budget used up: own work stopped until Mon"
				: `Own work this week: ${spent} of ${budget} · updated ${age}`,
		...(age ? { age } : {}),
		...(byInitiative.length ? { byInitiative } : {}),
	};
}

/** Bounded regular-file read, refusing links and special files; any bad role leaves the rest intact. */
export async function readRoleSpend(roleDir: string, now: number): Promise<UiRoleSpend> {
	const file = join(roleDir, "spend.json");
	try {
		const st = await lstat(file);
		if (!st.isFile() || st.nlink !== 1 || st.size > SPEND_FILE_MAX || (await realpath(file)) !== resolve(file))
			return unavailable("unreadable");
		const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const current = await h.stat();
			if (!current.isFile() || current.nlink !== 1 || current.size > SPEND_FILE_MAX) return unavailable("unreadable");
			const b = Buffer.alloc(SPEND_FILE_MAX + 1);
			const { bytesRead } = await h.read(b, 0, b.length, 0);
			return bytesRead > SPEND_FILE_MAX
				? unavailable("unreadable")
				: spendFromText(b.subarray(0, bytesRead).toString("utf8"), now);
		} finally {
			await h.close();
		}
	} catch (err) {
		return unavailable((err as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable");
	}
}
