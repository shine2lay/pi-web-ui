// The stats scripts' transcript readers (scripts/session-transcripts.mts): a chat file that vanishes between
// listing and reading (a deploy check's throwaway chat) is skipped, not fatal (Ops #688 check crashed on it).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entriesOf, transcriptsIn, vanished } from "../../scripts/session-transcripts.mjs";

const dirs: string[] = [];
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), "session-transcripts-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("session transcripts", () => {
	it("reads a transcript's entries from the window on, keeping its identity line", async () => {
		const file = join(scratch(), "a.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"custom","customType":"identity","timestamp":"2026-10-01T00:00:00Z"}',
				'{"type":"message","timestamp":"2026-10-01T00:00:01Z"}',
				'{"type":"message","timestamp":"2026-11-01T00:00:00Z"}',
				'{"type":"message","timestamp":"2026-11-01T00:00:0', // torn last line
			].join("\n"),
		);
		const entries = await entriesOf(file, Date.parse("2026-10-31T00:00:00Z"));
		expect(entries).toHaveLength(2);
	});

	it("skips a transcript that vanished before it was read", async () => {
		const gone = join(scratch(), "gone.jsonl");
		expect(await entriesOf(gone, 0)).toEqual([]);
	});

	it("lists nothing under a folder that vanished, and lists the transcripts that remain", () => {
		const dir = scratch();
		writeFileSync(join(dir, "b.jsonl"), "");
		writeFileSync(join(dir, "a.jsonl"), "");
		writeFileSync(join(dir, "notes.txt"), "");
		expect(transcriptsIn(dir, 0)).toEqual([join(dir, "a.jsonl"), join(dir, "b.jsonl")]);
		expect(transcriptsIn(join(dir, "gone"), 0)).toEqual([]);
	});

	it("treats only a missing file as vanished", () => {
		expect(vanished(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
		expect(vanished(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
		expect(vanished(undefined)).toBe(false);
	});
});
