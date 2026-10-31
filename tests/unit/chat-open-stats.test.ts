/**
 * scripts/chat-open-stats.mjs (Ops #690): median and p95 of real chat opens from fixture "chatopen"
 * rows, per device x loadedBefore and per chat, over a window that spans a rolled day file. The numbers
 * are checked by hand against the fixture.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as stats from "../../scripts/chat-open-stats.mjs";

interface Stat {
	n: number;
	median: number | null;
	p95: number | null;
}
interface Group {
	device: string;
	loadedBefore: string;
	n: number;
	paint: Stat;
	server: Stat;
	chats: { chat: string; paint: Stat }[];
}
interface Summary {
	rows: number;
	counted: number;
	excluded: Record<string, number>;
	groups: Group[];
}
// biome-ignore lint/suspicious/noExplicitAny: plain .mjs script, rows are loose JSON
type Row = Record<string, any>;
const { exclusion, parseArgs, percentile } = stats as unknown as {
	exclusion(r: Row): string | null;
	parseArgs(argv: string[]): Record<string, unknown>;
	percentile(v: number[], p: number): number | null;
};
const readRows = stats.readRows as (dir: string) => Row[];
const summarize = stats.summarize as unknown as (rows: Row[], w?: { since?: number; until?: number }) => Summary;

const SCRIPT = join(__dirname, "../../scripts/chat-open-stats.mjs");
const T = Date.parse("2026-10-31T20:00:00Z");

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chat-open-stats-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (over: Record<string, unknown>) => ({
	t: T,
	kind: "chatopen",
	at: T,
	browser: true,
	outcome: "done",
	device: "desktop",
	loadedBefore: false,
	chat: "aaaaaaaaaaaa",
	visible: true,
	automated: false,
	toPaintMs: 1000,
	toDoneMs: 1200,
	toFirstFrameMs: 800,
	serverMs: 900,
	loadMs: 700,
	...over,
});
const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function fixture() {
	// Yesterday's rolled file: two desktop not-loaded opens of chat a.
	writeFileSync(
		join(dir, "conn-events-2026-10-30.jsonl"),
		jsonl([
			{ t: T - 86_400_000, kind: "loop", maxMs: 3 },
			row({ at: T - 86_400_000, toPaintMs: 15_000 }),
			row({ at: T - 86_000_000, toPaintMs: 9_000 }),
		]),
	);
	// Today's file: more opens, plus ones that must be left out, plus a torn line.
	writeFileSync(
		join(dir, "conn-events.jsonl"),
		`${jsonl([
			row({ at: T + 1, toPaintMs: 3_000 }),
			row({ at: T + 2, chat: "bbbbbbbbbbbb", toPaintMs: 600 }),
			row({ at: T + 3, device: "phone", toPaintMs: 4_000 }),
			row({ at: T + 4, device: "phone", toPaintMs: 2_000 }),
			row({ at: T + 5, device: "desktop", loadedBefore: true, toPaintMs: 200 }),
			row({ at: T + 6, automated: true, toPaintMs: 1 }),
			row({ at: T + 7, visible: false, toPaintMs: 1 }),
			row({ at: T + 8, outcome: "noreport", toPaintMs: null }),
			row({ at: T + 9, outcome: "left", toPaintMs: null }),
			{ t: T, kind: "banner", reason: "x" },
		])}{"t":1,"kind":"chatop`,
	);
}

describe("chat-open-stats", () => {
	it("nearest-rank percentiles", () => {
		expect(percentile([], 50)).toBeNull();
		expect(percentile([5], 95)).toBe(5);
		expect(percentile([1, 2, 3, 4], 50)).toBe(2);
		expect(percentile([3, 1, 2], 50)).toBe(2);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95)).toBe(19);
	});

	it("reads rolled and current files, only chatopen rows, torn lines skipped", () => {
		fixture();
		const rows = readRows(dir);
		expect(rows).toHaveLength(11);
		expect(rows[0].toPaintMs).toBe(15_000); // the rolled file comes first
	});

	it("leaves out test browsers, hidden tabs and opens without a full page report, and counts them", () => {
		expect(exclusion(row({}))).toBeNull();
		expect(exclusion(row({ automated: true }))).toBe("test browser");
		expect(exclusion(row({ visible: false }))).toBe("hidden tab");
		expect(exclusion(row({ outcome: "noreport" }))).toBe("no page report");
		expect(exclusion(row({ outcome: "failed" }))).toBe("failed");
		expect(exclusion(row({ browser: false }))).toBe("not a browser");
		fixture();
		const s = summarize(readRows(dir));
		expect(s.rows).toBe(11);
		expect(s.counted).toBe(7);
		expect(s.excluded).toEqual({ "test browser": 1, "hidden tab": 1, "no page report": 1, left: 1 });
	});

	it("medians and p95s per device x loadedBefore and per chat match a hand count", () => {
		fixture();
		const s = summarize(readRows(dir));
		const g = Object.fromEntries(s.groups.map((x) => [`${x.device} ${x.loadedBefore}`, x])) as Record<string, Group>;
		expect(Object.keys(g)).toEqual(["desktop loaded", "desktop notLoaded", "phone notLoaded"]);
		// desktop not loaded: 15000, 9000, 3000, 600 -> sorted 600,3000,9000,15000; median rank 2 = 3000; p95 rank 4 = 15000
		expect(g["desktop notLoaded"].n).toBe(4);
		expect(g["desktop notLoaded"].paint).toEqual({ n: 4, median: 3000, p95: 15_000 });
		// per chat: a has 15000, 9000, 3000 -> median 9000; b has 600
		expect(g["desktop notLoaded"]!.chats.map((c) => [c.chat, c.paint.median])).toEqual([
			["aaaaaaaaaaaa", 9000],
			["bbbbbbbbbbbb", 600],
		]);
		// phone: 4000, 2000 -> median 2000, p95 4000
		expect(g["phone notLoaded"].paint).toEqual({ n: 2, median: 2000, p95: 4000 });
		expect(g["desktop loaded"].paint).toEqual({ n: 1, median: 200, p95: 200 });
		expect(g["desktop loaded"].server).toEqual({ n: 1, median: 900, p95: 900 });
	});

	it("--since/--until filter by the request's arrival", () => {
		fixture();
		const s = summarize(readRows(dir), { since: T, until: T + 3 });
		expect(s.rows).toBe(2);
		expect(s.groups[0]!.paint.median).toBe(600);
		expect(parseArgs(["--since", "2026-10-31T20:00:00Z", "--until", String(T + 3), "--json"])).toMatchObject({
			since: T,
			until: T + 3,
			json: true,
		});
		expect(() => parseArgs(["--since", "yesterday-ish"])).toThrow(/not a time/);
	});

	it("runs as a command and changes nothing", () => {
		fixture();
		const run = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--json"], { encoding: "utf8" });
		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout).counted).toBe(7);
		const text = spawnSync(process.execPath, [SCRIPT, "--dir", dir], { encoding: "utf8" });
		expect(text.stdout).toContain("desktop notLoaded");
		expect(text.stdout).toContain("paint 3.00s/15.00s");
		const bad = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("unknown argument");
	});
});
