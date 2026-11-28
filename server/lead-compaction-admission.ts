import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isAbsolute, normalize, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

export interface FileAdmission {
	readonly source: string;
	generation: number;
	revision: number;
	bindingEpoch: number;
	session?: AgentSession;
	opening: number;
	active: number;
	pending: number;
	deferred: number;
	locked: boolean;
	recovery: boolean;
	internal: boolean;
	readonly waiters: (() => void)[];
	checkpoint?: { messageEntryId: string; toolResultEntryIds: string[] };
}

/** Process-local exclusive file ownership. Callers must use canonical real paths. */
export class LeadAdmission {
	private readonly files = new Map<string, FileAdmission>();
	private readonly ownership = new AsyncLocalStorage<ReadonlySet<FileAdmission>>();
	private readonly openingScope = new AsyncLocalStorage<ReadonlySet<FileAdmission>>();
	openingOwned(file: FileAdmission): boolean {
		return this.openingScope.getStore()?.has(file) === true;
	}
	runOpening<T>(file: FileAdmission, operation: () => T): T {
		return this.openingScope.run(new Set([...(this.openingScope.getStore() ?? []), file]), operation);
	}
	owns(file: FileAdmission): boolean {
		return file.internal || this.ownership.getStore()?.has(file) === true;
	}
	owned<T>(file: FileAdmission, operation: () => T): T {
		return this.ownership.run(new Set([...(this.ownership.getStore() ?? []), file]), operation);
	}
	assertReadable(source: string): void {
		const file = this.file(source);
		if ((file.locked || file.recovery) && !this.owns(file)) throw new Error("file-owned-for-compaction");
	}
	file(source: string): FileAdmission {
		if (!isAbsolute(source) || normalize(source) !== source) throw new Error("noncanonical-source");
		try {
			if (realpathSync(source) !== source) throw new Error("noncanonical-source");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (realpathSync(dirname(source)) !== dirname(source)) throw new Error("noncanonical-source");
		}
		let file = this.files.get(source);
		if (!file) {
			file = {
				source,
				generation: 0,
				revision: 0,
				bindingEpoch: 0,
				opening: 0,
				active: 0,
				pending: 0,
				deferred: 0,
				locked: false,
				recovery: false,
				internal: false,
				waiters: [],
			};
			this.files.set(source, file);
		}
		return file;
	}
	async available(file: FileAdmission): Promise<void> {
		while (file.locked || file.recovery) await new Promise<void>((resolve) => file.waiters.push(resolve));
	}
	release(file: FileAdmission): void {
		file.locked = false;
		if (!file.recovery) for (const wake of file.waiters.splice(0)) wake();
	}
	/** Reserve BEFORE the SDK reads a journal or constructs a manager. */
	async open<T>(source: string, create: () => Promise<T>): Promise<T> {
		const file = this.file(source);
		if (file.opening) throw new Error("opening-owner-collision");
		file.opening++;
		file.generation++;
		try {
			await this.available(file);
			if (file.session) throw new Error("cached-owner-collision");
			return await create();
		} finally {
			file.opening--;
		}
	}
	attach(session: AgentSession): FileAdmission {
		const source = session.sessionManager.getSessionFile();
		if (!source) throw new Error("unpersisted-session");
		const file = this.file(source);
		if ((file.locked || file.recovery) && !this.owns(file)) throw new Error("file-owned-for-compaction");
		if (file.session && file.session !== session && !this.owns(file)) throw new Error("cached-owner-collision");
		if (file.session !== session) file.generation++;
		file.session = session;
		return file;
	}
	/** An input waits outside SDK state, and resolves against the current owner after recovery. */
	input<T>(file: FileAdmission, deliver: (session: AgentSession) => Promise<T>): Promise<T> {
		file.revision++;
		file.pending++;
		const run = (): Promise<T> => {
			if (!file.session) {
				file.pending--;
				return Promise.reject(new Error("native-owner-unavailable"));
			}
			file.active++;
			try {
				return Promise.resolve(deliver(file.session)).finally(() => {
					file.active--;
					file.pending--;
				});
			} catch (error) {
				file.active--;
				file.pending--;
				return Promise.reject(error);
			}
		};
		// Preserve synchronous SDK admission when no commit/recovery owns the file.
		return file.locked || file.recovery ? this.available(file).then(run) : run();
	}
	mutation<T>(file: FileAdmission, change: () => T, lifecycle = false): T {
		if ((file.locked || file.recovery) && !this.owns(file)) throw new Error("file-owned-for-compaction");
		file.revision++;
		if (lifecycle) file.generation++;
		return change();
	}
	/** The caller must finish with release; no archive or network is permitted inside. */
	acquire(file: FileAdmission): boolean {
		if (file.locked || file.recovery || file.opening || file.active || file.pending || file.deferred) return false;
		file.locked = true;
		return true;
	}
	/** Recovery keeps input owned. The caller has reconstructed and rebound the same home. */
	recovered(file: FileAdmission, session: AgentSession): void {
		if (!file.recovery || !file.locked) throw new Error("recovery-not-owned");
		if (session.sessionManager.getSessionFile() !== file.source) throw new Error("recovery-source-drift");
		file.session = session;
		file.generation++;
		file.revision++;
		file.recovery = false;
	}
}
