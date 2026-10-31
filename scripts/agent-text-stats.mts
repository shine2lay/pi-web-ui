#!/usr/bin/env -S node --import tsx
/**
 * agent-text-stats (Ops #688 part 2, hypothesis H-COMPACT-MSG): read-only lengths of the text roles write
 * for each other, from the host's own records (server/agent-text-stats.ts): role messages by kind and Board
 * posts by kind, characters per item (count, median, p90).
 *
 *   node --import tsx scripts/agent-text-stats.mts --since <ISO> [--until <ISO>] [--first N]
 *        [--data ~/.pi-web-ui] [--at-least N] [--or-after <ISO>]
 *
 * --first and check mode (scripts/stats-window.mts) count role messages. Prints one JSON line of lengths
 * and counts; no text is printed or stored (rule 11). role-messages.json keeps the newest 1,000 messages:
 * the output says when its oldest is newer than --since.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentTextSummary, boardPostSizes, roleMessageSizes, sizesInWindow } from "../server/agent-text-stats.ts";
import { checkExitOf, runStats, statsWindowOf } from "./stats-window.mts";

function listIn(file: string, key: string): unknown[] {
	const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const list = doc[key];
	if (!Array.isArray(list)) throw new Error(`${file} has no ${key} list`);
	return list;
}

await runStats(async () => {
	const w = statsWindowOf(process.argv.slice(2));
	const i = process.argv.indexOf("--data");
	const dir = i === -1 ? join(homedir(), ".pi-web-ui") : process.argv[i + 1]!;
	const allMessages = roleMessageSizes(listIn(join(dir, "role-messages.json"), "messages"));
	const messages = sizesInWindow(allMessages, w.since, w.until, w.first);
	const board = sizesInWindow(boardPostSizes(listIn(join(dir, "role-board.json"), "posts")), w.since, w.until);
	const oldest = allMessages[0]?.at;
	const last = messages.at(-1);
	process.stdout.write(
		`${JSON.stringify({
			script: "agent-text-stats",
			since: new Date(w.since).toISOString(),
			until: new Date(w.until).toISOString(),
			first: w.first ?? null,
			lastMessageAt: last ? new Date(last.at).toISOString() : null,
			storeCutsWindow: oldest !== undefined && oldest > w.since,
			...agentTextSummary(messages, board),
		})}\n`,
	);
	return checkExitOf(w, messages.length);
});
