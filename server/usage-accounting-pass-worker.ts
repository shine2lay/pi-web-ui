/**
 * Worker entry for design B's pass (Ops #423). The host (usage-accounting-pass-host.ts) starts it with
 * METER_WORKER_RESOURCE_LIMITS and posts {kind:"tick"} every 30 s (B4 wires the timer). A tick that arrives while a
 * pass runs is dropped, never queued (Architecture C3). All I/O, hashing, folding and the W5 build happen here (C5);
 * the host only receives the bounded W5 snapshot.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { closePassState, openPassState, runPass, type PassOptions } from "./usage-accounting-pass.js";
import { buildUsageMeterSnapshot } from "./usage-accounting-snapshot.js";

export type UsagePassWorkerData = Omit<PassOptions, "roleOf" | "now" | "clock" | "slow" | "readOrder">;
export type UsagePassMessage =
	| {
			kind: "pass";
			status: string;
			sequence: number;
			snapshot: unknown;
			w5Ms: number;
			workMs: number;
			bytesRead: number;
	  }
	| { kind: "dropped" };

if (!isMainThread && parentPort && (workerData as { usagePass?: UsagePassWorkerData } | null)?.usagePass) {
	const port = parentPort;
	const state = openPassState((workerData as { usagePass: UsagePassWorkerData }).usagePass);
	let running = false,
		closing = false;
	const close = () => {
		closePassState(state);
		port.close();
	};
	port.on("message", (m: { kind?: string }) => {
		if (closing) return;
		if (m?.kind === "close") {
			// Never close the store under a running pass: the pass finishes (bounded by its budget), then the store closes.
			closing = true;
			if (!running) close();
			return;
		}
		if (m?.kind !== "tick") return;
		// The middle of three overlap guards (the host's outstanding tick, this one, runPass's own s.running). It is the
		// one that also covers the W5 build after runPass returns, which runPass's guard does not; tested on its own.
		if (running) {
			port.postMessage({ kind: "dropped" } satisfies UsagePassMessage);
			return;
		}
		running = true;
		void (async () => {
			try {
				const r = await runPass(state);
				const t0 = performance.now();
				const snapshot = r.input ? buildUsageMeterSnapshot(r.input) : null;
				port.postMessage({
					kind: "pass",
					status: r.status,
					sequence: r.sequence,
					snapshot,
					w5Ms: performance.now() - t0,
					workMs: r.stats.workMs,
					bytesRead: r.stats.bytesRead,
				} satisfies UsagePassMessage);
			} catch {
				port.postMessage({
					kind: "pass",
					status: "unavailable",
					sequence: state.sequence,
					snapshot: null,
					w5Ms: 0,
					workMs: 0,
					bytesRead: 0,
				} satisfies UsagePassMessage);
			} finally {
				running = false;
				if (closing) close();
			}
		})();
	});
}
