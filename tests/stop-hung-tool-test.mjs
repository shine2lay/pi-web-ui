/* stop-hung-tool E2E (no tokens): Stop and the hang guard free a chat whose tool never returns.
 *
 * What went wrong live (2026-11-12, pi 1.5.2, ops #861): five lead chats hung in a tool call that
 * never returned (queue_reply, google_search). Stop did nothing and the 20-minute hang guard never
 * freed them; only a restart did. Cause: pi 1.5.2's AgentSessionRuntime.dispose() first awaits
 * session.abort(), which waits for the run to go idle, and a run stuck in a tool never does, so the
 * force-reset behind Stop and the hang guard never finished.
 *
 * Two sealed servers with a scripted model and a test add-on tool that never ends and ignores the
 * abort. Each: the chat's turn hangs in the tool, then
 *   1. Stop: the chat is free again (not working) within the abort window + settle + margin;
 *   2. hang guard (4 s watchdog, no Stop): the chat is free again within deadline + abort window + margin;
 * and after that the chat takes the next message and answers it.
 * Never prints what goes to the model (rule 8).
 * Usage: npm run build && node tests/stop-hung-tool-test.mjs   (STOPHANG_DEBUG=1: server output)
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const HARD_ABORT_MS = 15_000; // ClientSession.HARD_ABORT_TIMEOUT_MS
const WATCHDOG_MS = 4_000;
const MARGIN_MS = 10_000;

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}

const HANG_TOOL = `/** stop-hung-tool test: a tool that never ends and ignores the abort. */
export default function (pi: any) {
	pi.registerTool({
		name: "hang_forever",
		label: "Hang",
		description: "Test tool: never returns.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: () => new Promise(() => {}),
	});
}
`;
const reply = ({ lastUser, toolResult, sideRequest }) => {
	if (sideRequest) return "Chat";
	if (toolResult) return "after the tool";
	if (/^hang now/.test(lastUser)) return { tool: "hang_forever", args: {} };
	if (/^are you back/.test(lastUser)) return "pong-back";
	return "ok";
};

function sessionFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...sessionFiles(p));
		else if (p.endsWith(".jsonl")) out.push(p);
	}
	return out;
}
function answered(agentDir, text) {
	return sessionFiles(join(agentDir, "sessions")).some((f) =>
		readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.some((l) => {
				try {
					const e = JSON.parse(l);
					return (
						e.type === "message" &&
						e.message?.role === "assistant" &&
						(e.message.content ?? []).some((c) => c.type === "text" && c.text === text)
					);
				} catch {
					return false;
				}
			}),
	);
}

async function scenario(label, { watchdogMs, stop }) {
	const srv = await ownServer({
		name: `stop-hung-tool-${label}`,
		verbose: !!process.env.STOPHANG_DEBUG,
		mock: reply,
		prepare: ({ agentDir }) => {
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(join(agentDir, "extensions", "hang-tool.ts"), HANG_TOOL);
		},
		env: { PI_WEB_TOOL_TIMEOUT_MS: String(watchdogMs) },
	});
	const ws = new WebSocket(srv.ws);
	let streaming = false;
	let seenHang = false;
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if ((m.type === "snapshot" || m.type === "snapshot_delta") && m.state) {
			streaming = !!m.state.isStreaming;
			if (JSON.stringify(m.state.messages ?? m.appended ?? []).includes("hang_forever")) seenHang = true;
		}
	});
	try {
		await new Promise((res, rej) => {
			ws.once("open", res);
			ws.once("error", rej);
		});
		ws.send(JSON.stringify({ type: "hello", clientId: `stop-hung-${label}` }));
		await sleep(1500);
		ws.send(JSON.stringify({ type: "prompt", text: "hang now" }));
		check(`${label}: the turn hangs in the tool`, !!(await waitFor(() => seenHang && streaming, 30000)));
		await sleep(1000);
		check(`${label}: the chat is still working while the tool hangs`, streaming);
		const t0 = Date.now();
		if (stop) ws.send(JSON.stringify({ type: "abort" }));
		const limit = (stop ? 0 : watchdogMs) + HARD_ABORT_MS + MARGIN_MS;
		const freed = await waitFor(() => !streaming, limit);
		const took = ((Date.now() - t0) / 1000).toFixed(1);
		console.log(`  ${label}: freed after ${took}s (limit ${limit / 1000}s)`);
		check(`${label}: the chat is free again`, !!freed, `still working after ${took}s`);
		ws.send(JSON.stringify({ type: "prompt", text: "are you back?" }));
		check(
			`${label}: the chat takes the next message and answers it`,
			!!(await waitFor(() => !streaming && answered(srv.agentDir, "pong-back"), 30000)),
		);
	} catch (err) {
		check(`${label}: scenario ran`, false, err?.stack ?? String(err));
	} finally {
		ws.close();
		await srv.stop();
	}
}

await scenario("stop", { watchdogMs: 600_000, stop: true });
await scenario("hang-guard", { watchdogMs: WATCHDOG_MS, stop: false });

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
