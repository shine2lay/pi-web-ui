/**
 * Main-thread side of design B's pass (Ops #423): starts the pass Worker with METER_WORKER_RESOURCE_LIMITS and
 * forwards ticks, one at a time. No timer here (B4 adds the 30 s timer and the meter-cache hand-off), and no engine
 * import: only node:worker_threads and the meter contract, so the main thread never reaches the pass's I/O.
 */
import { Worker } from "node:worker_threads";
import { METER_WORKER_RESOURCE_LIMITS } from "./usage-accounting-meter-contract.js";

export interface UsagePassHost {
	/** Posts a tick unless one is outstanding; returns false when this tick was dropped (single flight). */
	tick(): boolean;
	close(): Promise<void>;
	readonly worker: Worker;
}
export function startUsagePassWorker(
	entry: string | URL,
	usagePass: unknown,
	onMessage: (message: unknown) => void,
	options: { eval?: boolean } = {},
): UsagePassHost {
	const worker = new Worker(entry, {
		eval: options.eval ?? false,
		workerData: { usagePass },
		resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
	});
	let outstanding = false;
	worker.on("message", (m: { kind?: string }) => {
		if (m?.kind === "pass") outstanding = false;
		onMessage(m);
	});
	const lost = () => {
		outstanding = false;
		onMessage({ kind: "worker-unavailable" });
	};
	worker.on("error", lost);
	worker.on("exit", (code) => {
		if (code) lost();
	});
	return {
		worker,
		tick() {
			if (outstanding) return false;
			outstanding = true;
			worker.postMessage({ kind: "tick" });
			return true;
		},
		async close() {
			worker.postMessage({ kind: "close" });
			await new Promise<void>((done) => {
				const t = setTimeout(() => void worker.terminate().then(() => done()), 5000);
				worker.once("exit", () => {
					clearTimeout(t);
					done();
				});
			});
		},
	};
}
