// #423 H-304-RECOVERY: fixed synthetic files only; no SDK or model requests. Run with the final sealed gate.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PI_SESSION_LIMITS,
	PiSessionUsageReader,
	encodePiSessionRecovery,
	decodePiSessionRecovery,
	type PiSessionReadRequest,
	type PiSessionReadResult,
} from "../../server/usage-accounting-pi-sessions.js";
const FROM = "2026-10-19T07:00:00.000Z",
	THROUGH = "2026-10-23T20:00:00.000Z";
const header = JSON.stringify({ type: "session", version: 3, id: "recovery-fixture", timestamp: FROM }) + "\n";
const entry = (id: string, timestamp = FROM) =>
	JSON.stringify({
		type: "message",
		id,
		timestamp,
		message: {
			role: "assistant",
			provider: "p",
			model: "m",
			responseId: id,
			timestamp,
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
		},
	}) + "\n";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-numeric-recovery-"));
	dirs.push(dir);
	const file = join(dir, "case.jsonl");
	writeFileSync(file, contents);
	return file;
}
const request = (file: string, extra: Partial<PiSessionReadRequest> = {}): PiSessionReadRequest => ({
	file,
	producer: "pi",
	from: FROM,
	through: THROUGH,
	observedAt: THROUGH,
	recoverOversized: true,
	...extra,
});
const ids = (r: PiSessionReadResult) => r.batch?.rows.facts.map((f) => f.source.event) ?? [];
function continuation(r: PiSessionReadResult): Partial<PiSessionReadRequest> {
	if (r.recovery) {
		const saved = encodePiSessionRecovery(r.recovery);
		expect(saved.token.length).toBeLessThanOrEqual(256);
		return { recovery: decodePiSessionRecovery(JSON.parse(JSON.stringify(saved)))! };
	}
	return { cursor: r.cursor };
}

describe("#304 bounded, separately typed oversized-line recovery", () => {
	it("finishes a 5-MiB line across restarts, resumes both charges once, and never changes pi1", async () => {
		const file = fixture(header + entry("before") + "x".repeat(5 * 1024 * 1024) + "\n" + entry("after"));
		let r = await new PiSessionUsageReader().read(request(file));
		expect(ids(r)).toEqual(["before"]);
		expect(r.cursor!.token.startsWith("pi1:")).toBe(true);
		expect(r.recovery?.complete).toBe(false);
		expect(r.faults).toContainEqual({ code: "line-limit", line: 3 });
		const seen = [...ids(r)];
		let steps = 0;
		while (!r.endOfFile && steps++ < 40) {
			const previous = r.recovery;
			r = await new PiSessionUsageReader().read(request(file, continuation(r)));
			seen.push(...ids(r));
			if (previous && !previous.complete) {
				expect(r.skipped!.bytes).toBeLessThanOrEqual(PI_SESSION_LIMITS.readBytes);
				expect(r.bytesRead).toBeGreaterThanOrEqual(4096 + 1 + previous.anchor.bytes + r.skipped!.bytes);
				expect(r.bytesRead).toBeLessThanOrEqual(4096 + 1 + previous.anchor.bytes + PI_SESSION_LIMITS.readBytes);
				expect(r.recovery!.offset - previous.offset).toBe(r.skipped!.bytes);
				expect(r.recovery!.offset).toBeGreaterThan(previous.offset);
			}
			expect(r.bytesRead).toBeLessThanOrEqual(
				3 * PI_SESSION_LIMITS.lineBytes + 2 * PI_SESSION_LIMITS.readBytes + 65_536,
			);
		}
		expect(steps).toBeGreaterThan(10);
		expect(seen).toEqual(["before", "after"]);
		expect(r.endOfFile).toBe(true);
		const repeated = await new PiSessionUsageReader().read(request(file, { cursor: r.cursor }));
		expect(ids(repeated)).toEqual([]);
		expect(repeated.endOfFile).toBe(true);
		expect(repeated.bytesRead).toBe(4096 + entry("after").length);
	});
	it("does not accept a forged recovery, changed anchor, changed header, truncated file or pis1 as pi1", async () => {
		for (const mutation of ["anchor", "header", "truncate", "offset", "pi1"] as const) {
			const file = fixture(header + "x".repeat(5 * 1024 * 1024) + "\n" + entry("after"));
			const first = await new PiSessionUsageReader().read(request(file));
			const recovery = structuredClone(first.recovery!);
			if (mutation === "anchor" || mutation === "header") {
				const fd = openSync(file, "r+");
				try {
					writeSync(fd, Buffer.from("y"), 0, 1, mutation === "anchor" ? recovery.anchor.start : 10);
				} finally {
					closeSync(fd);
				}
			} else if (mutation === "truncate") writeFileSync(file, header);
			else if (mutation === "offset") recovery.offset++;
			const r = await new PiSessionUsageReader().read(
				request(file, mutation === "pi1" ? { cursor: encodePiSessionRecovery(recovery) } : { recovery }),
			);
			expect(ids(r)).toEqual([]);
			expect(r.endOfFile).toBe(false);
			expect(r.faults.some((f) => ["cursor-invalid", "cursor-changed", "header-invalid"].includes(f.code))).toBe(true);
			expect(r.bytesRead).toBeGreaterThan(0);
		}
	});
	it("accounts for read-ahead and anchor bytes on success and on failed validation", async () => {
		const text = header + entry("one");
		const file = fixture(text);
		const first = await new PiSessionUsageReader().read(request(file));
		expect(first.bytesRead).toBe(Buffer.byteLength(text));
		const again = await new PiSessionUsageReader().read(request(file, { cursor: first.cursor }));
		expect(again.bytesRead).toBe(Buffer.byteLength(text) + Buffer.byteLength(entry("one")));
		const data = readFileSync(file);
		data[data.length - 3] = 120;
		writeFileSync(file, data);
		const changed = await new PiSessionUsageReader().read(request(file, { cursor: first.cursor }));
		expect(changed.faults[0].code).toBe("cursor-changed");
		expect(changed.bytesRead).toBe(Buffer.byteLength(text) + Buffer.byteLength(entry("one")));
		const missing = await new PiSessionUsageReader().read(request(join(file, "absent")));
		expect(missing.bytesRead).toBe(0);
	});
	it("returns timestamp-only hints for forward AND backward occurrence windows without advancement", async () => {
		const earlier = "2026-10-12T07:00:00.000Z";
		const file = fixture(header + entry("now") + entry("earlier", earlier) + entry("now-again"));
		const first = await new PiSessionUsageReader().read(request(file));
		expect(ids(first)).toEqual(["now"]);
		expect(first.nextWindowAt).toBe(earlier);
		const old = await new PiSessionUsageReader().read(
			request(file, { cursor: first.cursor, from: earlier, through: "2026-10-19T06:59:59.999Z" }),
		);
		expect(ids(old)).toEqual(["earlier"]);
		expect(old.nextWindowAt).toBe(FROM);
		const last = await new PiSessionUsageReader().read(request(file, { cursor: old.cursor }));
		expect(ids(last)).toEqual(["now-again"]);
		expect(last.endOfFile).toBe(true);
	});
	it("keeps the parse ceiling and permits only one read at a time", async () => {
		expect(() => new PiSessionUsageReader({ lineBytes: PI_SESSION_LIMITS.lineBytes + 1 })).toThrow();
		const file = fixture(header + "x".repeat(5 * 1024 * 1024) + "\n");
		const reader = new PiSessionUsageReader();
		const running = reader.read(request(file));
		await expect(reader.read(request(file))).rejects.toThrow("pi-session-request");
		const r = await running;
		expect(r.status).toBe("partial");
		expect(r.recovery).not.toBeNull();
		expect(r.recovery!.anchor.bytes).toBeLessThanOrEqual(65_536);
	});
});
