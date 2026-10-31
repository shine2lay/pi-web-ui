/**
 * stats-window (Ops #688): the command-line window and check mode the read-only stats scripts share
 * (turn-status-stats.mts, agent-text-stats.mts).
 *
 *   --since <ISO time>     start of the window (needed)
 *   --until <ISO time>     end of the window (default: now)
 *   --first <N>            only the first N items in the window
 *   --at-least <N>         check mode: exit 0 once the window holds N items, 1 while it doesn't
 *   --or-after <ISO time>  check mode: exit 0 anyway once this time has passed
 */
export interface StatsWindow {
	since: number;
	until: number;
	first?: number;
	atLeast?: number;
	orAfter?: number;
}

function value(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
	return v;
}

function time(argv: readonly string[], name: string): number | undefined {
	const v = value(argv, name);
	if (v === undefined) return undefined;
	const t = Date.parse(v);
	if (Number.isNaN(t)) throw new Error(`--${name} must be an ISO time, got ${v}`);
	return t;
}

function whole(argv: readonly string[], name: string): number | undefined {
	const v = value(argv, name);
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number, got ${v}`);
	return n;
}

export function statsWindowOf(argv: readonly string[], now = Date.now()): StatsWindow {
	const since = time(argv, "since");
	if (since === undefined) throw new Error("--since <ISO time> is needed");
	return {
		since,
		until: time(argv, "until") ?? now,
		first: whole(argv, "first"),
		atLeast: whole(argv, "at-least"),
		orAfter: time(argv, "or-after"),
	};
}

/** Check mode's exit code for `count` items, or undefined outside check mode. */
export function checkExitOf(w: StatsWindow, count: number, now = Date.now()): 0 | 1 | undefined {
	if (w.atLeast === undefined && w.orAfter === undefined) return undefined;
	if (w.atLeast !== undefined && count >= w.atLeast) return 0;
	if (w.orAfter !== undefined && now >= w.orAfter) return 0;
	return 1;
}

/** Runs a stats script's main: errors exit 2 with the message on stderr (check mode's "error", not "not yet"). */
export async function runStats(main: () => Promise<number | undefined>): Promise<void> {
	try {
		process.exitCode = (await main()) ?? 0;
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 2;
	}
}
