/** Shared streamed transcript readers for role messages and department peer notes. */
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export async function eachLineWith(
	file: string,
	from: number,
	needle: string,
	fn: (entry: unknown) => boolean,
): Promise<void> {
	await eachLine(file, from, (line) => {
		if (!line.includes(needle)) return false;
		try {
			return fn(JSON.parse(line));
		} catch {
			return false;
		}
	});
}
export async function eachLine(file: string, from: number, take: (line: string) => boolean): Promise<void> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const decoder = new StringDecoder("utf8");
		const chunk = Buffer.alloc(256 * 1024);
		let carry = "";
		for (let pos = Math.max(0, from); ;) {
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
			if (!bytesRead) {
				take(carry + decoder.end());
				return;
			}
			pos += bytesRead;
			const lines = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) if (take(line)) return;
		}
	} catch {
		// unreadable: nothing found
	} finally {
		await fh?.close().catch(() => {});
	}
}
export function firstTextOf(c: unknown): string | undefined {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return undefined;
	const first = c.find((b) => (b as { type?: unknown })?.type === "text") as { text?: unknown } | undefined;
	return typeof first?.text === "string" ? first.text : undefined;
}
export function userTextOf(entry: unknown): string | undefined {
	const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (e?.type !== "message" || e.message?.role !== "user") return undefined;
	return firstTextOf(e.message.content);
}
export function noteTextOf(entry: unknown, customType = "role-message"): string | undefined {
	const e = entry as { type?: unknown; customType?: unknown; content?: unknown };
	if (e?.type !== "custom_message" || e.customType !== customType) return undefined;
	return firstTextOf(e.content);
}
/** Only a peer custom message proves a pn delivery; quoted/user text never does. */
export async function transcriptHasRoleMessage(file: string, from: number, id: string): Promise<boolean> {
	const peer = /^pn-[0-9a-f]{16}$/.test(id);
	const needle = peer ? `[Peer note ${id}]` : `[Role message ${id} `;
	let found = false;
	await eachLineWith(file, from, needle, (entry) => {
		const text = peer ? noteTextOf(entry, "peer-note") : (userTextOf(entry) ?? noteTextOf(entry));
		found = peer
			? !!text?.startsWith("Peer note from task #") && text.split("\n")[2] === needle
			: text?.startsWith(needle) === true;
		return found;
	});
	return found;
}
export function assistantTextOf(entry: unknown): string | undefined {
	const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (e?.type !== "message" || e.message?.role !== "assistant") return undefined;
	const c = e.message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return undefined;
	return c
		.filter((b) => (b as { type?: unknown })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}
/** Receipt proof is deliberately separate from delivery proof. */
export async function transcriptHasPeerReceipt(file: string, id: string): Promise<boolean> {
	const needle = `Peer note ${id} to task #`;
	let found = false;
	await eachLineWith(file, 0, needle, (entry) => {
		found = noteTextOf(entry, "peer-note")?.startsWith(needle) === true;
		return found;
	});
	return found;
}
