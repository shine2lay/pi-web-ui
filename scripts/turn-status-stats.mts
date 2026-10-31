#!/usr/bin/env -S node --import tsx
/**
 * turn-status-stats (Ops #688, hypothesis H-STATUS-LINE): read-only counts of the turns another role
 * started in the chats' transcripts, and how many end with only valid status lines as text
 * (server/turn-status-stats.ts).
 *
 *   node --import tsx scripts/turn-status-stats.mts --since <ISO> [--until <ISO>] [--first N]
 *        [--sessions ~/.pi/agent/sessions] [--at-least N] [--or-after <ISO>]
 *
 * Prints one JSON line: the window, files read, role-started turns, the share with only status lines, the
 * median and p90 assistant-text characters per turn, split by role and by model. Counts only: no message
 * text is printed or stored (rule 11). Check mode (scripts/stats-window.mts): exit 0 once the window holds
 * --at-least turns or --or-after has passed, 1 while not, 2 on an error.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type RoleTurn, roleTurnsOf, turnStatusSummary, turnsInWindow } from "../server/turn-status-stats.ts";
import { checkExitOf, runStats, statsWindowOf } from "./stats-window.mts";

/** Lines older than this before --since are skipped unread: no role-started turn runs this long. */
const LOOKBACK_MS = 6 * 3_600_000;
const HEAD_TIME = /"timestamp":"([^"]+)"/;

function transcriptsIn(dir: string, since: number): string[] {
	const out: string[] = [];
	for (const d of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, d.name);
		if (d.isDirectory()) out.push(...transcriptsIn(p, since));
		else if (d.isFile() && d.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) out.push(p);
	}
	return out.sort();
}

async function entriesOf(file: string, from: number): Promise<unknown[]> {
	const entries: unknown[] = [];
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line) continue;
		const head = HEAD_TIME.exec(line.slice(0, 200));
		const old = head && Date.parse(head[1]!) < from;
		// the chat's identity is near its start: keep it even when the lines around it are skipped
		if (old && !line.slice(0, 200).includes('"customType":"identity"')) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// a torn last line of a chat being written: not a turn yet
		}
	}
	return entries;
}

await runStats(async () => {
	const w = statsWindowOf(process.argv.slice(2));
	const i = process.argv.indexOf("--sessions");
	const dir = i === -1 ? join(homedir(), ".pi", "agent", "sessions") : process.argv[i + 1]!;
	const files = transcriptsIn(dir, w.since);
	const turns: RoleTurn[] = [];
	for (const f of files) turns.push(...roleTurnsOf(await entriesOf(f, w.since - LOOKBACK_MS)));
	const inside = turnsInWindow(turns, w.since, w.until, w.first);
	const summary = turnStatusSummary(inside);
	const last = inside.at(-1);
	process.stdout.write(
		`${JSON.stringify({
			script: "turn-status-stats",
			since: new Date(w.since).toISOString(),
			until: new Date(w.until).toISOString(),
			first: w.first ?? null,
			lastTurnAt: last ? new Date(last.at).toISOString() : null,
			files: files.length,
			...summary,
		})}\n`,
	);
	return checkExitOf(w, summary.turns);
});
