/**
 * Reading the small state files the Roles feed shows (the work registry's log, the 6 am report's runs, the
 * scheduler's jobs) so an odd file in their place can't stall the server or read on without end: open
 * non-blocking (a FIFO can't make the open or the read wait), never as the controlling terminal (a tty in
 * the place), `fstat` the handle and accept only a regular file, and stop reading past a size cap even when
 * the file grows meanwhile. Same-UID only either way; this keeps the Roles look bounded.
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const STATE_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0);

/** The whole of an open file from its start, read `chunk` bytes at a time: null once it passes `max` bytes. */
export async function readUpTo(fh: FileHandle, max: number, chunk: number): Promise<Buffer | null> {
	const parts: Buffer[] = [];
	let total = 0;
	for (;;) {
		const buf = Buffer.alloc(chunk);
		const { bytesRead } = await fh.read(buf, 0, chunk, total);
		if (bytesRead === 0) break;
		total += bytesRead;
		if (total > max) return null;
		parts.push(buf.subarray(0, bytesRead));
	}
	return Buffer.concat(parts, total);
}
