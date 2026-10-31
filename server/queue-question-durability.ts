/** Native JSONL acknowledgement only. Never await a void/async adapter append. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { QuestionCommit, QuestionCommitResult } from "./queue-question-port.js";

/** Capability detection only. It cannot attest a successful write; acknowledgement below must do that. */
export function supportsNativeQuestionWrite(value: unknown): value is SessionManager {
	return (
		value instanceof SessionManager &&
		Object.getPrototypeOf(value) === SessionManager.prototype &&
		value.isPersisted() &&
		Reflect.get(value, "flushed") === true &&
		["appendCustomEntry", "appendCustomMessageEntry", "_appendEntry", "_persist"].every(
			(name) => Reflect.get(value, name) === Reflect.get(SessionManager.prototype, name),
		)
	);
}

function nativeManager(value: unknown): SessionManager {
	if (!supportsNativeQuestionWrite(value))
		throw new Error("question commits require the synchronous native JSONL writer; this runtime is unsupported");
	return value;
}

/** Owns only an existing file descriptor, never creates/rewrites a session or a side journal. */
export class NativeQuestionWrite {
	private readonly manager: SessionManager;
	private readonly file: string;
	private readonly fd: number;
	private readonly before: Stats;
	private readonly count: number;
	private closed = false;

	constructor(manager: unknown) {
		this.manager = nativeManager(manager);
		const file = this.manager.getSessionFile();
		if (!file?.startsWith("/")) throw new Error("question session has no native transcript");
		this.file = file;
		this.fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		try {
			this.before = fstatSync(this.fd);
			if (!this.before.isFile()) throw new Error("question transcript is not a regular file");
			this.count = this.manager.getEntries().length;
		} catch (error) {
			closeSync(this.fd);
			throw error;
		}
	}

	/** Check the exact appended bytes, then fsync. The endpoint must finish before its aftermath. */
	acknowledge(request: QuestionCommit, result: QuestionCommitResult): void {
		const entries = this.manager.getEntries();
		const appended = entries.slice(this.count);
		if ("reason" in result) {
			if (result.status === "refused" && appended.length)
				throw new Error("refused question commit changed the transcript");
			return;
		}
		if (appended.length !== (result.status === "committed" ? 1 : 0))
			throw new Error("question commit did not isolate its single canonical append");
		const { binding: b, change } = request;
		if (result.status === "committed" && result.rid !== change.rid)
			throw new Error("question commit returned another receipt");
		const candidates = result.status === "committed" ? appended : this.manager.getBranch();
		const entry = candidates.find((e) => {
			if (e.type !== "custom" || e.customType !== "queue" || !e.data || typeof e.data !== "object") return false;
			const data = e.data as Record<string, unknown>;
			const receipt = data[change.kind === "owner" ? "admission" : "retraction"] as Record<string, unknown> | undefined;
			return (
				data.v === 1 &&
				data.op === (change.kind === "owner" ? "owner_admission" : "recall") &&
				data.id === b.id &&
				data.n === b.n &&
				data.at === b.at &&
				!!receipt &&
				receipt.rid === result.rid &&
				(change.kind === "owner" ? data.escalation : receipt.escalation) === b.escalation &&
				data.revision === b.revision &&
				result.revision === b.revision + (change.kind === "recall" ? 1 : 0)
			);
		});
		if (!entry) throw new Error("question commit has no matching canonical queue receipt");
		this.sync(appended.map((e) => JSON.stringify(e) + "\n").join(""));
		// Already may refer to an earlier record. Verify it exists on disk, not just in the SDK's memory.
		if (result.status === "already" && !this.contains(JSON.stringify(entry) + "\n"))
			throw new Error("question receipt is not in the saved transcript");
	}

	/** Metadata-only host acceptance uses the same native append/fsync proof, not a second journal. */
	acknowledgeMetadata(customType: string, data: unknown): void {
		const appended = this.manager.getEntries().slice(this.count);
		if (
			appended.length !== 1 ||
			appended[0].type !== "custom" ||
			appended[0].customType !== customType ||
			JSON.stringify(appended[0].data) !== JSON.stringify(data)
		)
			throw new Error("owner acceptance did not isolate its native metadata append");
		this.sync(JSON.stringify(appended[0]) + "\n");
	}

	/** For a native custom-message card: the appended entry itself is the durable correlation. */
	acknowledgeCard(tag: string): void {
		const appended = this.manager.getEntries().slice(this.count);
		if (
			appended.length !== 1 ||
			appended[0].type !== "custom_message" ||
			appended[0].customType !== "queue-question-card" ||
			(appended[0].details as { tag?: unknown } | undefined)?.tag !== tag
		)
			throw new Error("question card was buffered instead of synchronously persisted");
		this.sync(JSON.stringify(appended[0]) + "\n");
	}

	acknowledgeExisting(entry: unknown): void {
		this.sync("");
		if (!this.contains(JSON.stringify(entry) + "\n")) throw new Error("question card is not in the saved transcript");
	}

	private sync(appended: string): void {
		if (this.closed || nativeManager(this.manager).getSessionFile() !== this.file)
			throw new Error("question writer was replaced");
		const current = statSync(this.file);
		const opened = fstatSync(this.fd);
		if (
			current.dev !== this.before.dev ||
			current.ino !== this.before.ino ||
			opened.size !== this.before.size + Buffer.byteLength(appended)
		)
			throw new Error("question transcript changed outside its native append");
		const bytes = Buffer.alloc(Buffer.byteLength(appended));
		if (
			readSync(this.fd, bytes, 0, bytes.length, this.before.size) !== bytes.length ||
			bytes.toString("utf8") !== appended
		)
			throw new Error("question append did not reach its native transcript");
		fsyncSync(this.fd);
	}

	private contains(line: string): boolean {
		const needle = Buffer.from(line);
		let prefix = Buffer.alloc(0);
		const size = fstatSync(this.fd).size;
		for (let offset = 0; offset < size;) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
			const n = readSync(this.fd, chunk, 0, chunk.length, offset);
			if (!n) throw new Error("question transcript ended during acknowledgement");
			const bytes = Buffer.concat([prefix, chunk.subarray(0, n)]);
			const found = bytes.indexOf(needle);
			if (found >= 0 && ((offset === 0 && found === 0) || (found > 0 && bytes[found - 1] === 10))) return true;
			prefix = bytes.subarray(Math.max(0, bytes.length - needle.length));
			offset += n;
		}
		return false;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeSync(this.fd);
	}
}
