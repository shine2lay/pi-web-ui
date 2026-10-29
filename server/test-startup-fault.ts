/**
 * test-startup-fault.ts (first-send, Ops #631): a sealed e2e test's fault hook for chat start-up.
 *
 * Only active when the server runs with PI_WEB_TEST_STARTUP_FAULT_FILE set, which only
 * tests/first-send-test.mjs does (never a real install). Each session create (a new window's first
 * chat, New chat) reads that file; missing or unreadable = no fault. Its JSON:
 *   { "delayMs"?: number }  hold the create that long first (a slow start-up, to act while it starts);
 *   { "fail"?: true }       then throw, the real "Failed to initialize session" / "Failed to create chat".
 */
import { readFileSync } from "node:fs";

export async function testStartupFault(): Promise<void> {
	const path = process.env.PI_WEB_TEST_STARTUP_FAULT_FILE;
	if (!path) return;
	let spec: { delayMs?: unknown; fail?: unknown };
	try {
		spec = JSON.parse(readFileSync(path, "utf8")) as typeof spec;
	} catch {
		return;
	}
	if (typeof spec.delayMs === "number" && spec.delayMs > 0) {
		const ms = spec.delayMs;
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
	if (spec.fail === true) throw new Error("test fault: session create failed");
}
