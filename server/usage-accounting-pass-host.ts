/**
 * Main-thread side of design B's pass (Ops #423): starts the pass Worker with METER_WORKER_RESOURCE_LIMITS and
 * forwards ticks, one at a time. No timer here (B4's usage-accounting-host.ts owns the 30 s timer and the meter-cache
 * hand-off), and no engine import: only node:worker_threads and the meter contract, so the main thread never reaches
 * the pass's I/O.
 */
import { Worker } from "node:worker_threads";
import { METER_WORKER_RESOURCE_LIMITS } from "./usage-accounting-meter-contract.js";

export interface UsagePassHost {
	/**
	 * Posts a tick unless one is outstanding or the worker is lost; returns false when this tick was dropped. B4's payload
	 * (whether to build W5, the role witness) travels with it; the Worker checks it.
	 */
	tick(payload?: Record<string, unknown>): boolean;
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
	// The error's code travels on (Architecture #289 note 2: a wrong root says usage-pass-inventory-input), never its text.
	const lost = (error?: unknown) => {
		outstanding = false;
		if (gone) return;
		gone = true;
		const code = (error as { code?: unknown } | undefined)?.code;
		onMessage(
			typeof code === "string" && /^[a-z0-9-]{1,64}$/.test(code)
				? { kind: "worker-unavailable", code }
				: { kind: "worker-unavailable" },
		);
	};
	worker.on("error", lost);
	// Any exit that close() did not ask for is a lost worker, exit code 0 included (Architecture #277 S4).
	worker.on("exit", (code) => {
		if (code || !closing) lost(undefined);
	});
	return {
		worker,
		tick(payload) {
			if (outstanding || gone) return false;
			outstanding = true;
			worker.postMessage({ ...payload, kind: "tick" });
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
