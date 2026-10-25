import { parentPort, workerData } from "node:worker_threads";
import { newPassInventory, scanPassInventory, closePassInventory } from "../../server/usage-accounting-pass-scan.js";
const { root, temper, cap, stats } = workerData as { root: string; temper: string[]; cap: number; stats: number };
const s = newPassInventory("2026-10-19");
let units = 0,
	maxStats = 0;
try {
	for (; units < 10000; units++) {
		const r = scanPassInventory(s, {
			roots: [root],
			temperRoots: temper,
			asOf: "2026-10-23T21:00:00.000Z",
			files: cap,
			stats,
		});
		maxStats = Math.max(maxStats, r.stats);
		if (r.finished) break;
	}
	parentPort!.postMessage({
		units: units + 1,
		maxStats,
		count: s.files.size,
		complete: s.complete,
		through: s.through,
		cap: s.fileCap,
		faults: [...s.faults],
		names: [...s.files.values()].map((f) => f.file.slice(root.length + 1)).sort(),
	});
} finally {
	closePassInventory(s);
}
