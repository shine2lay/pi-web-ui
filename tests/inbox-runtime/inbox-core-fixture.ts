import { readFileSync, writeFileSync } from "node:fs";
import { InboxRuntime } from "../../server/inbox-runtime.js";
import type { RoleMessageRecord } from "../../server/role-messages.js";
import { clock, world } from "../unit/role-message-guard-host-harness.js";
import { caseOf, type InboxCase } from "./inbox-corpora.js";
import { setup } from "./inbox-world.js";

export function core(id: string): InboxCase & { input: Record<string, unknown> } {
	const c = caseOf("core", id);
	const raw = c.input ?? {};
	const input = "$from" in raw ? { ...core(String(raw.$from)).input, ...(raw.$set as Record<string, unknown>) } : raw;
	return { ...c, input };
}
export type CoreWorld = Awaited<ReturnType<typeof setup>>;
/** Edit the canonical source file before reopening RoleMessages, never its private in-memory data. */
export async function seed(h: CoreWorld, change: (records: RoleMessageRecord[]) => void) {
	h.w.rm.stop();
	h.w.host.stop();
	const store = JSON.parse(readFileSync(h.roleMessagesFile, "utf8")) as { messages: RoleMessageRecord[] };
	change(store.messages);
	writeFileSync(h.roleMessagesFile, JSON.stringify(store));
	h.w = await world(h.w);
	h.runtime = new InboxRuntime({
		ledgerFile: h.ledgerFile,
		roleMessagesFile: h.roleMessagesFile,
		messages: h.w.rm,
		guard: h.w.host,
		now: clock,
	});
	return h;
}
export function view(h: CoreWorld) {
	const read = h.runtime.read("beta");
	if (read.status !== "ok") throw new Error(`Whole reader failed: ${read.source}: ${read.reason}`);
	const item = read.items.find((i) => i.key === h.key);
	if (!item) throw new Error(`Missing item ${h.key}`);
	return item;
}
