/**
 * Main-thread side of design B's pass (Ops #423): starts the pass Worker with METER_WORKER_RESOURCE_LIMITS and
 * forwards ticks, one at a time. No timer here (B4 adds the 30 s timer and the meter-cache hand-off), and no engine
 * import: only node:worker_threads and the meter contract, so the main thread never reaches the pass's I/O.
 */
import { Worker } from "node:worker_threads";
import { METER_WORKER_RESOURCE_LIMITS } from "./usage-accounting-meter-contract.js";

export interface UsagePassHost {
	/** Posts a tick unless one is outstanding or the worker is lost; returns false when this tick was dropped. */
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
	let closing = false;
	let gone = false;
	worker.on("message", (m: { kind?: string }) => {
		if (m?.kind === "pass") outstanding = false;
		onMessage(m);
	});
	const lost = () => {
		outstanding = false;
		if (gone) return;
		gone = true;
		onMessage({ kind: "worker-unavailable" });
	};
	worker.on("error", lost);
	// Any exit that close() did not ask for is a lost worker, exit code 0 included (Architecture #277 S4).
	worker.on("exit", (code) => {
		if (code || !closing) lost();
	});
	return {
		worker,
		tick() {
			if (outstanding || gone) return false;
			outstanding = true;
			worker.postMessage({ kind: "tick" });
			return true;
		},
		async close() {
			closing = true;
			if (gone) return;
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
