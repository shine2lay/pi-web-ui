/** Passive, exact-session leases. No prompts, role assignment or execution authority. */
export interface ParticipantTarget {
	sessionId: string;
	role: string;
}
export interface ParticipantLease {
	refresh(): Promise<void>;
	dispose(): void;
}

export class ParticipantLifecycle {
	private sources = new Map<symbol, () => ParticipantTarget[]>();
	private pending: Promise<void> | undefined;
	private dirty = false;
	private requested = "";
	private stopped = false;

	constructor(private open: (target: ParticipantTarget, current: () => boolean) => Promise<void>) {}

	/** Read current owner bindings, never a stale snapshot captured at registration. */
	private targets(): ParticipantTarget[] {
		const wanted = new Map<string, ParticipantTarget>();
		const conflicts = new Set<string>();
		for (const source of this.sources.values()) {
			try {
				const rows = source();
				if (!Array.isArray(rows) || rows.length > 64) continue;
				for (const row of rows) {
					if (
						!row ||
						typeof row.sessionId !== "string" ||
						typeof row.role !== "string" ||
						!/^[a-zA-Z0-9-]{1,100}$/.test(row.sessionId) ||
						!/^[a-z][a-z0-9-]{0,31}$/.test(row.role)
					)
						continue;
					const old = wanted.get(row.sessionId);
					if (old && old.role !== row.role) conflicts.add(row.sessionId);
					wanted.set(row.sessionId, { sessionId: row.sessionId, role: row.role });
				}
			} catch {
				// A broken/unloaded plugin cannot retain the last known set indefinitely.
			}
		}
		return [...wanted.values()].filter((row) => !conflicts.has(row.sessionId));
	}

	has(sessionId: string, role: string): boolean {
		return !this.stopped && this.targets().some((row) => row.sessionId === sessionId && row.role === role);
	}

	register(source: () => ParticipantTarget[]): ParticipantLease {
		if (this.stopped) throw new Error("Participant lifecycle is stopped");
		const key = Symbol();
		this.sources.set(key, source);
		return {
			refresh: () => (this.sources.has(key) ? this.refresh() : Promise.resolve()),
			dispose: () => {
				this.sources.delete(key);
			},
		};
	}

	/** Coalesce callers, but repeat if bindings changed during an asynchronous open. */
	private refresh(): Promise<void> {
		const requested = JSON.stringify(this.targets());
		// Repeated reads/maintenance ticks must not keep a slow recovery pending forever.
		if (this.pending && this.requested === requested) return this.pending;
		this.requested = requested;
		this.dirty = true;
		if (!this.pending) {
			this.pending = Promise.resolve()
				.then(async () => {
					while (this.dirty && !this.stopped) {
						this.dirty = false;
						for (const target of this.targets()) {
							const current = () => this.has(target.sessionId, target.role);
							if (!current()) continue;
							try {
								await this.open(target, current);
							} catch {
								/* Missing/mismatched/capacity-limited targets remain disconnected. */
							}
						}
					}
				})
				.finally(() => {
					this.pending = undefined;
				});
		}
		return this.pending;
	}

	dispose(): void {
		this.stopped = true;
		this.sources.clear();
	}
}
