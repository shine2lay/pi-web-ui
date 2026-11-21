/**
 * silence-watch (Ops #1059, F3): the Roles page's one reader of role chats (roles-transcripts.ts TranscriptScans)
 * keeps each chat's last turn: the newest assistant message's time, read from the line's first bytes, the rest of
 * the line skipped. Synthetic chat files only.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assistantTime, lineKind, TranscriptScans } from "../../server/roles-transcripts.js";

const dir = mkdtempSync(join(tmpdir(), "pi-web-last-turn-"));
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-21T05:00:00.000Z");
const MIN = 60_000;

const header = {
	type: "session",
	version: 3,
	id: "01a0c000-0000-7000-8000-00000000c0de",
	timestamp: iso(T0),
	cwd: "/tmp/w",
};
const msg = (id: string, role: "user" | "assistant", at: number) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: iso(at),
	message: { role, content: [{ type: "text", text: "x" }] },
});
const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

describe("F3: a role chat's last turn", () => {
	it("an assistant line is a turn, with its own time from the line's head", () => {
		const head = JSON.stringify(msg("a1", "assistant", T0 + 5 * MIN));
		expect(lineKind(head)).toBe("assistant");
		expect(assistantTime(head)).toBe(T0 + 5 * MIN);
		expect(lineKind(JSON.stringify(msg("u1", "user", T0)))).not.toBe("assistant");
		expect(assistantTime('{"type":"message","id":"x","message":{"role":"assistant"}}')).toBeUndefined();
	});

	it("lastTurnAt is the newest assistant line; user lines don't count; appended lines are read incrementally", async () => {
		const file = join(dir, "home.jsonl");
		writeFileSync(
			file,
			jsonl([header, msg("u1", "user", T0), msg("a1", "assistant", T0 + MIN), msg("a2", "assistant", T0 + 3 * MIN)]),
		);
		const scans = new TranscriptScans();
		expect((await scans.read(file)).lastTurnAt).toBe(T0 + 3 * MIN);
		const before = scans.bytesRead;
		appendFileSync(file, jsonl([msg("u2", "user", T0 + 50 * MIN)]));
		expect((await scans.read(file)).lastTurnAt).toBe(T0 + 3 * MIN);
		appendFileSync(file, jsonl([msg("a3", "assistant", T0 + 70 * MIN)]));
		const s = await scans.read(file);
		expect(s.lastTurnAt).toBe(T0 + 70 * MIN);
		// Only the appended bytes were read the second and third time.
		expect(scans.bytesRead - before).toBeLessThan(1_000);
	});

	it("a chat with no assistant line yet has no last turn", async () => {
		const file = join(dir, "new.jsonl");
		writeFileSync(file, jsonl([header, msg("u1", "user", T0)]));
		expect((await new TranscriptScans().read(file)).lastTurnAt).toBeUndefined();
	});
});
