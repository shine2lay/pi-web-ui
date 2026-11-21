#!/usr/bin/env -S node --import tsx
/**
 * Q-STALL-1 real case (Ops #1055, docs/stall-watch-whole-list.md): reads a work registry file with the watches'
 * one reader (server/work-registry-reader.ts) and prints whether the read is complete, the linked tasks read and
 * the time it took, as JSON. Read only. Run it on a COPY of the live registry, never the live file:
 *
 *   cp ~/.pi/agent/work/events.jsonl /tmp/registry-copy.jsonl
 *   node --import tsx scripts/registry-read.mts /tmp/registry-copy.jsonl
 */
import { WorkRegistryReader } from "../server/work-registry-reader.ts";

const file = process.argv[2];
if (!file) {
	console.error("usage: node --import tsx scripts/registry-read.mts <copy of events.jsonl>");
	process.exit(2);
}
const read = await new WorkRegistryReader(() => file).read();
console.log(
	JSON.stringify(
		read.complete
			? { complete: true, tasksRead: read.tasksRead, bytes: read.bytes, tookMs: read.tookMs }
			: { complete: false, reason: read.reason, detail: read.detail, tasksRead: read.tasksRead },
	),
);
