/* fast-reopen：repairSessionTranscript 第 3 步（残余环截断）改成线性时间后，结果和以前一模一样，只是快。
 *
 * 以前每一行都从头走到根（每次新建 seen），会话基本是一条长链，所以是 O(n²)：1.8 万行的会话
 * 从历史打开要多等 17 秒。这里：
 *  - 随机父子图（环、自环、悬空 parent 都很多）上和旧算法逐字节对比：截的是同一条边、输出同一份文本；
 *  - 6 万行的长链几百毫秒内修完（旧算法要几十秒）。 */
import { describe, expect, it } from "vitest";
import { repairSessionTranscript } from "../../server/compaction-markers.js";

const HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "s1",
	timestamp: "2026-09-19T00:00:00.000Z",
	cwd: "/x",
});
const msg = (id: string, parentId: string | null) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-19T00:00:01.000Z",
		message: { role: "user", content: "hi" },
	});

/** 旧的第 3 步（upstream 0070c88），只针对 id 各不相同的普通条目（第 1、2 步此时什么都不做）。 */
function oldCycleCut(raw: string): { text: string; cyclesBroken: number; changed: boolean } {
	const lines = raw.split("\n");
	const slots = lines.map((line) => {
		let entry: Record<string, unknown> | null = null;
		if (line.trim()) {
			try {
				const p: unknown = JSON.parse(line);
				if (typeof p === "object" && p !== null) entry = p as Record<string, unknown>;
			} catch {
				/* 脏行原样保留 */
			}
		}
		const id = entry && typeof entry.id === "string" ? entry.id : null;
		return { raw: line, entry, dirty: false, id };
	});
	const parentOf = (e: Record<string, unknown>) => (typeof e.parentId === "string" ? e.parentId : null);
	const live = slots.filter((s) => s.entry && s.id !== null);
	const byId = new Map(live.map((s) => [s.id as string, s]));
	let cyclesBroken = 0;
	for (const s of live) {
		const seen = new Set<string>([s.id as string]);
		let prev = s;
		let cur = parentOf(s.entry!);
		while (cur !== null) {
			if (seen.has(cur)) {
				prev.entry!.parentId = null;
				prev.dirty = true;
				cyclesBroken += 1;
				break;
			}
			seen.add(cur);
			const next = byId.get(cur);
			if (!next?.entry) break;
			prev = next;
			cur = parentOf(next.entry);
		}
	}
	if (cyclesBroken === 0) return { text: raw, cyclesBroken, changed: false };
	const text = slots.map((s) => (s.dirty && s.entry ? JSON.stringify(s.entry) : s.raw)).join("\n");
	return { text, cyclesBroken, changed: true };
}

/** 可复现的伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("repairSessionTranscript 第 3 步（fast-reopen）", () => {
	it("随机父子图上和旧算法逐字节一致（截同一条边）", () => {
		const rand = rng(20260924);
		let withCycles = 0;
		for (let iter = 0; iter < 3000; iter++) {
			const n = 1 + Math.floor(rand() * 25);
			const ids = Array.from({ length: n }, (_, i) => `e${i}`);
			const lines = [HEADER];
			for (const id of ids) {
				const r = rand();
				const parent = r < 0.15 ? null : r < 0.25 ? "missing" : ids[Math.floor(rand() * n)];
				lines.push(msg(id, parent));
			}
			if (rand() < 0.1) lines.splice(1 + Math.floor(rand() * n), 0, "not json");
			const raw = lines.join("\n") + "\n";
			const want = oldCycleCut(raw);
			const got = repairSessionTranscript(raw);
			if (want.cyclesBroken > 0) withCycles++;
			expect({ text: got.text, cyclesBroken: got.cyclesBroken, changed: got.changed }, `iteration ${iter}`).toEqual(
				want,
			);
		}
		// 生成器确实造出了大量有环的图（否则这条测试什么都没证明）。
		expect(withCycles).toBeGreaterThan(1500);
	});

	it("6 万行长链：几百毫秒修完，健康文件原样返回", () => {
		const N = 60000;
		const lines = [HEADER, msg("m0", null)];
		for (let i = 1; i < N; i++) lines.push(msg(`m${i}`, `m${i - 1}`));
		const raw = lines.join("\n") + "\n";
		const t0 = performance.now();
		const r = repairSessionTranscript(raw);
		const ms = performance.now() - t0;
		expect(r.changed).toBe(false);
		expect(r.text).toBe(raw);
		// 旧算法这里是 18 亿次集合操作（几十秒）；线性版实测一两百毫秒，留足余量防慢机抖动。
		expect(ms).toBeLessThan(3000);
	});

	it("长链顶上有环：只截一刀，照样快", () => {
		const N = 60000;
		const lines = [HEADER, msg("m0", `m${N - 1}`)];
		for (let i = 1; i < N; i++) lines.push(msg(`m${i}`, `m${i - 1}`));
		const raw = lines.join("\n") + "\n";
		const t0 = performance.now();
		const r = repairSessionTranscript(raw);
		expect(performance.now() - t0).toBeLessThan(3000);
		expect(r.cyclesBroken).toBe(1);
		// 截的是旧算法会截的那条：从第一行 m0 出发，走回 m0 的那一步在 m1 上（m1 → m0 闭环）。
		const m1 = r.text.split("\n").find((l) => l.includes('"id":"m1"'));
		expect(JSON.parse(m1 as string).parentId).toBeNull();
	});
});
