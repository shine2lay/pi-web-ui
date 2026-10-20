// stall-wake #284: fixed, known verdict cases; temporary files only, no live chats or model.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOUR = 3_600_000;
const T = new Date(2020, 0, 1, 9).getTime();
const script = fileURLToPath(new URL("../../scripts/stall-verdict.mjs", import.meta.url));
const stretch = (id: string) => `project:${id}:empty:${T - 3 * HOUR}`;
const line = (id: string, extra: Record<string, unknown> = {}) => ({
	stretch: stretch(id),
	step: 1,
	to: "ops",
	at: T,
	id: `rm-${id}`,
	state: "sent",
	...extra,
});
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stall-verdict-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(ledger: object[], events: object[] = [], messages: object[] = []) {
	const ledgerFile = join(dir, "ledger.jsonl");
	const eventsFile = join(dir, "events.jsonl");
	const storeFile = join(dir, "messages.json");
	writeFileSync(ledgerFile, ledger.map((l) => JSON.stringify(l)).join("\n") + "\n");
	writeFileSync(eventsFile, events.map((l) => JSON.stringify(l)).join("\n") + "\n");
	writeFileSync(storeFile, JSON.stringify({ messages }));
	const r = spawnSync(
		process.execPath,
		[script, "--ledger", ledgerFile, "--events", eventsFile, "--store", storeFile, "--since", String(T), "--json"],
		{ encoding: "utf8" },
	);
	if (!r.stdout.trim()) throw new Error(`verdict script failed (${r.status}): ${r.stderr}`);
	return { status: r.status, ...JSON.parse(r.stdout) };
}

for (const pass of [1, 2])
	describe(`stall verdict (pass ${pass})`, () => {
		it("counts a batch once and requires half of all flagged stretches to get a lead action", () => {
			const r = run(
				[line("a", { id: "rm-batch" }), line("b", { id: "rm-batch" })],
				[{ op: "task.link", ts: T + HOUR, by: "ops", parent: { project: "a" } }],
			);
			expect(r).toMatchObject({ status: 0, flagged: 2, acted: 1, actedShare: 0.5, messagesSent: 1, verdict: "HIT" });
		});

		it("doesn't count a later action outside the 24 h window or an unrelated name edit", () => {
			const r = run(
				[line("a")],
				[
					{ op: "project.wait", id: "a", ts: T + 25 * HOUR, by: "ops" },
					{ op: "project.change", id: "a", name: "Renamed", ts: T + HOUR, by: "ops" },
				],
			);
			expect(r).toMatchObject({ status: 1, acted: 0, verdict: "MISS" });
		});

		it("includes held/capped stretches in the flagged count", () => {
			const r = run([line("a", { state: "held", id: undefined }), line("b", { state: "capped", id: undefined })]);
			expect(r).toMatchObject({ flagged: 2, messagesSent: 0, capHits: 1, verdict: "MISS" });
		});

		it("detects a duplicate store record and a creation receipt absent from the ledger", () => {
			const item = { kind: "project", id: "a", name: "A", rule: "empty", since: T - 3 * HOUR, step: 1 };
			const r = run(
				[line("a")],
				[{ op: "project.wait", id: "a", ts: T + HOUR }],
				[
					{ id: "rm-other", at: T, stall: { items: [item] } },
					{ id: "rm-missing", at: T, stall: { items: [{ ...item, id: "b" }] } },
				],
			);
			expect(r.verdict).toBe("MISS");
			expect(r.duplicates).toHaveLength(2);
		});

		it("detects duplicates, a daily cap breach and an early owner step", () => {
			const ledger = Array.from({ length: 7 }, (_, i) => line(`p${i}`, { at: T + i * 1000 }));
			ledger.push(line("p0", { id: "rm-duplicate" }));
			ledger.push(line("p0", { step: 2, at: T + HOUR, id: "rm-owner", to: "coo", owner: true }));
			const r = run(ledger);
			expect(r.verdict).toBe("MISS");
			expect(r.duplicates.length).toBeGreaterThan(0);
			expect(r.capBreaches.length).toBeGreaterThan(0);
			expect(r.earlyOwner.length).toBeGreaterThan(0);
		});

		it("catches an overall hourly cap breach even with no recipient above its daily cap", () => {
			const r = run(Array.from({ length: 21 }, (_, i) => line(`p${i}`, { to: `role${i}` })));
			expect(r.verdict).toBe("MISS");
			expect(r.capBreaches).toContainEqual(expect.stringContaining("21 messages in the hour"));
		});

		it("reports a valid owner chain without a false early-owner finding", () => {
			const r = run(
				[
					line("a"),
					line("a", { step: 2, to: "architecture", at: T + 2 * HOUR, id: "rm-next" }),
					line("a", { step: 3, to: "coo", owner: true, at: T + 4 * HOUR, id: "rm-owner" }),
				],
				[{ op: "project.change", id: "a", status: "done", ts: T + 5 * HOUR, by: "ops" }],
			);
			expect(r).toMatchObject({ verdict: "HIT", earlyOwner: [], messagesSent: 3, acted: 1 });
		});
	});
