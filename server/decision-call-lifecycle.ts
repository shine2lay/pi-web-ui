// Payload-free, bounded single-call lifecycle. Ported from Ops #98's qualified transport.
export interface ReaderIdentity {
	provider: string;
	id: string;
	thinking: string;
}
export interface CallDriver {
	identity(): ReaderIdentity;
	subscribe(refused: () => void): () => void;
	prompt(): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
}
export interface LifecycleRow {
	phase: string;
	at: number;
	elapsedMs: number;
	block?: string;
}
export interface CallClock {
	now(): number;
	after(ms: number, fire: () => void): () => void;
}
export interface CallOptions {
	open(): Promise<CallDriver>;
	beforePrompt(identity: ReaderIdentity): string | undefined;
	timeoutMs: number;
	trace(row: LifecycleRow): void;
	clock?: CallClock;
}
export interface CallOutcome {
	status:
		| "settled"
		| "refused"
		| "setup_timeout"
		| "prompt_timeout"
		| "open_rejected"
		| "observe_rejected"
		| "prompt_rejected"
		| "guard_rejected"
		| "blocked";
	block?: string;
}
const clockDefault: CallClock = {
	now: () => Date.now(),
	after(ms, fire) {
		const t = setTimeout(fire, ms);
		return () => clearTimeout(t);
	},
};
export async function runBoundedCall(o: CallOptions): Promise<CallOutcome> {
	if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs <= 0) throw new Error("invalid transport deadline");
	const clock = o.clock ?? clockDefault;
	const start = clock.now();
	let finished = false;
	let driver: CallDriver | undefined;
	let unsubscribe: (() => void) | undefined;
	const mark = (phase: string, block?: string, late = false) => {
		if (finished && !late) return;
		const at = clock.now();
		o.trace({ phase, at, elapsedMs: Math.max(0, at - start), ...(block ? { block } : {}) });
	};
	let fireTimeout!: () => void;
	const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
		fireTimeout = () => resolve({ kind: "timeout" });
	});
	const cancelTimer = clock.after(o.timeoutMs, fireTimeout);
	let refused = false;
	let fireRefusal!: () => void;
	const refusal = new Promise<CallOutcome>((resolve) => {
		fireRefusal = () => resolve({ status: "refused" });
	});
	const dispose = (d: CallDriver, late = false) => {
		try {
			d.dispose();
			mark(late ? "late_disposed" : "disposed", undefined, late);
		} catch {
			if (!late) mark("dispose_rejected");
		}
	};
	const abort = (d: CallDriver) => {
		mark("abort_started");
		try {
			void d.abort().catch(() => mark("abort_rejected"));
		} catch {
			mark("abort_rejected");
		}
	};
	try {
		mark("open_started");
		const opened = Promise.resolve()
			.then(o.open)
			.then(
				(d) => {
					if (finished) {
						dispose(d, true);
						return { kind: "late" as const };
					}
					driver = d;
					mark("open_ready");
					return { kind: "opened" as const };
				},
				() => ({ kind: "rejected" as const }),
			);
		const opening = await Promise.race([opened, deadline]);
		if (opening.kind === "timeout") {
			mark("setup_timeout");
			return { status: "setup_timeout" };
		}
		if (opening.kind !== "opened" || !driver) {
			mark("open_rejected");
			return { status: "open_rejected" };
		}
		try {
			unsubscribe = driver.subscribe(() => {
				if (!finished && !refused) {
					refused = true;
					mark("quota_refusal");
					fireRefusal();
				}
			});
		} catch {
			mark("observe_rejected");
			return { status: "observe_rejected" };
		}
		if (refused) {
			abort(driver);
			return { status: "refused" };
		}
		if (clock.now() - start >= o.timeoutMs) {
			mark("setup_timeout");
			return { status: "setup_timeout" };
		}
		let block: string | undefined;
		try {
			block = o.beforePrompt(driver.identity());
		} catch {
			mark("guard_rejected");
			return { status: "guard_rejected" };
		}
		if (block !== undefined) {
			mark("prompt_blocked", block);
			return { status: "blocked", block };
		}
		if (clock.now() - start >= o.timeoutMs) {
			mark("setup_timeout");
			return { status: "setup_timeout" };
		}
		const completed: Promise<CallOutcome> = Promise.resolve()
			.then(() => {
				if (refused) return;
				mark("prompt_started");
				return driver!.prompt();
			})
			.then(
				() => ({ status: "settled" }),
				() => ({ status: "prompt_rejected" }),
			);
		const result = await Promise.race([
			refusal,
			completed,
			deadline.then((): CallOutcome => ({ status: "prompt_timeout" })),
		]);
		if (result.status === "settled") mark("prompt_settled");
		else if (result.status === "prompt_rejected") mark("prompt_rejected");
		else if (result.status === "prompt_timeout") mark("prompt_timeout");
		if (result.status !== "settled") abort(driver);
		return result;
	} finally {
		cancelTimer();
		try {
			unsubscribe?.();
		} catch {
			/* never export SDK event/errors */
		}
		if (driver) dispose(driver);
		finished = true;
	}
}
