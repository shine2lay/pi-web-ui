// H-304-DURABILITY: the reader emits candidates only. Certify a numeric unknown marker AND typed progress through
// the unchanged B2 checkpoint before using it, restart both store and reader at every skip unit. This is NOT the B3
// production W5 replay seam (held pending a separately admitted all-observations schema).
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
	PiSessionUsageReader,
	encodePiSessionRecovery,
	decodePiSessionRecovery,
} from "../../server/usage-accounting-pi-sessions.js";
import { UsageWeekStore, UsageWeekStoreError, type UsageWeekRecord } from "../../server/usage-accounting-week-store.js";
const { dir, file, lease, crash } = workerData as {
	dir: string;
	file: string;
	lease: SharedArrayBuffer;
	crash: boolean;
};
const week = "2026-10-19",
	at = "2026-10-23T21:00:00.000Z",
	from = "2026-10-19T07:00:00.000Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex"),
	src = sha(file).slice(0, 16);
const sub = { role: null, project: null, initiative: null, task: null };
let inject = crash,
	done = false,
	iterations = 0;
(async () => {
	for (; iterations < 50; iterations++) {
		const store = UsageWeekStore.open({
			dataDir: dir,
			lease,
			now: () => Date.parse(at),
			fault: (point) => {
				if (inject && point === "after-log-sync") {
					inject = false;
					throw new Error("synthetic-crash");
				}
			},
		});
		try {
			const loaded = store.reload(week);
			if (loaded.state !== "empty" && loaded.state !== "open") throw new Error("fixture-store-unavailable");
			const saved = loaded.state === "open" ? loaded.checkpoint?.files[src]?.cursor : null;
			const recovery = saved?.token.startsWith("pis1:") ? decodePiSessionRecovery(saved) : null;
			if (saved?.token.startsWith("pis1:") && !recovery) throw new Error("fixture-bad-recovery");
			const r = await new PiSessionUsageReader().read({
				file,
				producer: "pi",
				from,
				through: at,
				observedAt: at,
				recoverOversized: true,
				...(recovery ? { recovery } : { cursor: saved }),
			});
			const records: UsageWeekRecord[] = [];
			for (const o of r.observations) {
				const f = r.batch?.rows.facts.find((f) => f.id === o.factId);
				if (!f || !o.responseId) throw new Error("fixture-fact-missing");
				records.push({
					k: sha(JSON.stringify([f.provider, o.responseId])),
					d: "original",
					at: f.occurredAt,
					src,
					off: o.offset,
					len: o.bytes,
					sub,
					usd: f.prices[0].amount,
					rate: f.prices[0].rateVersion,
					tok: [f.tokens.input, f.tokens.output, f.tokens.cacheRead, f.tokens.cacheWrite],
				});
			}
			if (r.skipped && r.skipped.bytes > 0)
				records.push({
					k: sha(JSON.stringify(["oversized", src, r.skipped.start])),
					d: "gap",
					at: from,
					src,
					off: r.skipped.start,
					len: r.skipped.bytes,
					sub,
					usd: null,
					tok: [null, null, null, null],
					rate: null,
				});
			const st = statSync(file);
			try {
				store.append(week, records);
			} catch {
				if (!crash || inject) throw new Error("fixture-unexpected-write-error");
				else continue;
			}
			store.checkpoint(week, {
				files: {
					[src]: {
						cursor: r.recovery ? encodePiSessionRecovery(r.recovery) : r.cursor,
						size: st.size,
						mtimeMs: Math.floor(st.mtimeMs),
					},
				},
				ledger: null,
			});
			if (r.endOfFile) {
				done = true;
				break;
			}
		} finally {
			store.close();
		}
	}
	if (!done) throw new Error("fixture-recovery-stuck");
	const store = UsageWeekStore.open({ dataDir: dir, lease, now: () => Date.parse(at) });
	try {
		const rows: UsageWeekRecord[] = [];
		const loaded = store.reload(week, (r) => rows.push(r));
		if (loaded.state !== "open") throw new Error("fixture-reload-unavailable");
		const repeated = await new PiSessionUsageReader().read({
			file,
			producer: "pi",
			from,
			through: at,
			observedAt: at,
			cursor: loaded.checkpoint!.files[src].cursor,
		});
		parentPort!.postMessage({
			iterations: iterations + 1,
			records: rows.length,
			gaps: rows.filter((r) => r.d === "gap").length,
			originals: rows.filter((r) => r.d === "original").length,
			prices: rows.filter((r) => r.d === "original").map((r) => r.usd),
			gapRemainsUnknown: rows
				.filter((r) => r.d === "gap")
				.every((r) => r.usd === null && r.tok.every((n) => n === null)),
			repeated: repeated.observations.length,
			repeatedEof: repeated.endOfFile,
			cursorKind: loaded.checkpoint!.files[src].cursor!.token.split(":")[0],
		});
	} finally {
		store.close();
	}
})().catch((e: unknown) => {
	const fixtureCodes = [
		"fixture-store-unavailable",
		"fixture-bad-recovery",
		"fixture-fact-missing",
		"fixture-unexpected-write-error",
		"fixture-recovery-stuck",
		"fixture-reload-unavailable",
		"pi-session-request",
	];
	const code =
		e instanceof UsageWeekStoreError
			? e.code
			: e instanceof Error && fixtureCodes.includes(e.message)
				? e.message
				: "reader-store-fixture-failed";
	parentPort!.postMessage({ error: code, iteration: iterations });
	process.exitCode = 1;
});
