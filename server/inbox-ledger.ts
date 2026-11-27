import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { decodeInboxLine, type InboxLine } from "./shared/inbox-wire.js";

/** The one append-only metadata journal. Unknown/torn history is never repaired implicitly. */
export class InboxLedger {
	constructor(readonly file: string) {}
	read(): InboxLine[] {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		if (text && !text.endsWith("\n")) throw new Error("E_RPI_UNKNOWN: torn ledger");
		const lines: InboxLine[] = [];
		for (const raw of text.split("\n").filter(Boolean)) {
			const d = decodeInboxLine(JSON.parse(raw));
			if (!d.ok || d.value.seq !== lines.length + 1) throw new Error("E_RPI_UNKNOWN: ledger schema/sequence");
			lines.push(d.value);
		}
		return lines;
	}
	append(line: InboxLine): void {
		if (!decodeInboxLine(line).ok || line.seq !== this.read().length + 1)
			throw new Error("E_RPI_UNKNOWN: invalid append");
		const fd = openSync(
			this.file,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("E_RPI_UNKNOWN: unsafe ledger");
			const bytes = Buffer.from(JSON.stringify(line) + "\n");
			let offset = 0;
			while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}
export type InboxIntent = Extract<InboxLine, { op: "effect_intent" }>;
/** One interpretation of pending physical operations, shared by recovery and rotation. */
export function inboxPendingIntents(lines: readonly InboxLine[]): InboxIntent[] {
	const pending = new Map<string, InboxIntent>();
	for (const line of lines) {
		if (line.op === "effect_intent") pending.set(line.key, line);
		const intent = pending.get(line.key);
		if (
			intent &&
			((line.op === "effect_done" && line.opKey === intent.opKey) ||
				(((line.op === "attempt" && line.cause === "no_effect") ||
					(line.op === "refusal" && line.code === "E_RPI_NOT_ACCEPTED")) &&
					line.leaseId === intent.leaseId &&
					line.epoch === intent.epoch))
		)
			pending.delete(line.key);
	}
	return [...pending.values()];
}
/** Shared across runtime replacements, so recovery cannot overlap an accepted local effect. */
const coordinators = new Map<string, Map<string, Promise<unknown>>>();
export function inboxCoordinator(file: string): Map<string, Promise<unknown>> {
	let map = coordinators.get(file);
	if (!map) {
		map = new Map();
		coordinators.set(file, map);
	}
	return map;
}
