import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";

/** Ops #248 (Security N1): a request is a few hundred bytes; a bigger file is refused unread. */
export const GUARD_FRESH_START_MAX_BYTES = 4096;

export function writeDurable(path: string, text: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text);
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
/** Ops #241: the operator's request (scripts/role-guard-fresh-start.mjs writes it). */
export interface GuardFreshStartRequest {
	v: 1;
	gen: number;
	journalSha256: string;
	acceptedSha256: string;
	at: number;
	expiresAt: number;
	reason: string;
}
export function parseFreshStartRequest(text: string): GuardFreshStartRequest | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const r = value as Record<string, unknown>;
	const hex = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
	const whole = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;
	const ok =
		r.v === 1 &&
		whole(r.gen) &&
		hex(r.journalSha256) &&
		hex(r.acceptedSha256) &&
		whole(r.at) &&
		whole(r.expiresAt) &&
		typeof r.reason === "string";
	return ok ? (r as unknown as GuardFreshStartRequest) : null;
}
/** Ops #248 (Security N1): the request's text, from one open that doesn't follow a link or wait on a pipe, checked
 *  on that open file (a plain file of this user, mode 0600, at most 4 KiB) and read from it, capped. null when there
 *  is none; otherwise why it isn't read. */
export function readFreshStartFile(path: string): { text: string } | string | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		return code === "ELOOP" ? "the request is not a plain file" : "the request can't be read";
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return "the request is not a plain file";
		if (typeof process.getuid === "function" && st.uid !== process.getuid())
			return "the request belongs to another user";
		if (st.mode & 0o022) return "other users can write the request";
		if ((st.mode & 0o777) !== 0o600) return `the request's mode is 0${(st.mode & 0o777).toString(8)}, not 0600`;
		if (st.size > GUARD_FRESH_START_MAX_BYTES) return "the request is over 4 KiB";
		const buf = Buffer.alloc(GUARD_FRESH_START_MAX_BYTES + 1);
		let n = 0;
		while (n < buf.length) {
			const got = readSync(fd, buf, n, buf.length - n, null);
			if (got === 0) break;
			n += got;
		}
		if (n > GUARD_FRESH_START_MAX_BYTES) return "the request is over 4 KiB";
		return { text: buf.subarray(0, n).toString("utf8") };
	} catch {
		return "the request can't be read";
	} finally {
		closeSync(fd);
	}
}
export function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
/** A byte-exact copy, flushed before it is renamed into place; 0600 like the store's own files. */
export function writeDurableBytes(path: string, bytes: Buffer): void {
	const tmp = `${path}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, bytes, { mode: 0o600 });
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
export function fsyncDir(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
