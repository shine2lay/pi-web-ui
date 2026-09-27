/**
 * tool_status smoke test — verifies the new tool_status (tool_execution_end)
 * message arrives the moment a bash command finishes, before the model's next
 * response lands. Runs against its own throwaway server (tests/lib/own-server.mjs) with the
 * stand-in model (tests/lib/mock-model.mjs): it asks for `pwd` through the bash tool, then
 * answers the tool result after a pause. No real model is called.
 *
 * Usage: npm run build && node tests/tool-status-test.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ownServer } from "./lib/own-server.mjs";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let srv = null;
async function startServer() {
	srv = await ownServer({
		name: "tool-status-test",
		mock: async ({ toolResult, sideRequest }) => {
			if (sideRequest) return "tool status";
			if (!toolResult) return { tool: "bash", args: { command: "pwd" } };
			// The next response lands a while after the tool finished: tool_status must come first.
			await sleep(1500);
			return `pwd printed: ${toolResult.content.trim()}`;
		},
	});
}
async function stopServer() {
	if (srv) {
		await srv.stop();
		srv = null;
	}
}

async function main() {
	await startServer();
	console.log("server up");

	const ws = new WebSocket(srv.ws);
	const msgs = [];
	const waiters = [];
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		msgs.push(msg);
		for (const w of [...waiters]) w(msg);
	};
	const waitFor = (pred, timeoutMs = 120_000) =>
		new Promise((resolve, reject) => {
			const found = msgs.find(pred);
			if (found) return resolve(found);
			const timer = setTimeout(() => reject(new Error(`timeout waiting for message`)), timeoutMs);
			const listener = (m) => {
				if (pred(m)) {
					clearTimeout(timer);
					const i = waiters.indexOf(listener);
					if (i >= 0) waiters.splice(i, 1);
					resolve(m);
				}
			};
			waiters.push(listener);
		});
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error("ws error"));
	});
	ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
	await waitFor((m) => m.type === "ready");
	console.log("ready");

	// Fire a prompt; the stand-in model answers with a bash call (pwd).
	ws.send(
		JSON.stringify({
			type: "prompt",
			text: "运行命令 pwd，把输出原样告诉我，不要做任何其他事。",
		}),
	);
	// Snapshot protocol v2: regular updates are snapshot_delta; ask for full snapshots (get_state).
	const poll = setInterval(() => ws.send(JSON.stringify({ type: "get_state" })), 300);

	// 1) tool_execution_end → tool_status must arrive.
	const status = await waitFor((m) => m.type === "tool_status", 120_000);
	check(
		"tool_status arrived",
		!!status.toolCallId && status.toolName.length > 0,
		`tool=${status.toolName} err=${status.isError} exit=${status.exitCode} dur=${status.durationMs}ms`,
	);
	check("tool_status carries durationMs", status.durationMs !== undefined);

	// 2) tool_status must arrive BEFORE the snapshot containing the toolResult
	//    (i.e. while the model is still chewing on the result).
	await waitFor((m) => m.type === "snapshot" && m.state.messages.some((mm) => mm.role === "toolResult"), 120_000);
	const statusIdx = msgs.indexOf(status);
	// 只在 tool_status 之后找快照 —— 历史快照若含旧 toolResult 不应参与比较
	const snapIdx = msgs.findIndex(
		(m, i) => i > statusIdx && m.type === "snapshot" && m.state.messages.some((mm) => mm.role === "toolResult"),
	);
	const earlierSnapIdx = msgs.findIndex(
		(m, i) => i < statusIdx && m.type === "snapshot" && m.state.messages.some((mm) => mm.role === "toolResult"),
	);
	check(
		"tool_status preceded the toolResult snapshot",
		statusIdx >= 0 && snapIdx > statusIdx && earlierSnapIdx === -1,
		`status@${statusIdx} snapshot@${snapIdx}`,
	);

	// 3) The run must complete (agent settles → snapshot no longer streaming).
	//    Match the FIRST settled snapshot AFTER our turn (the initial empty
	//    snapshot is also !isStreaming).
	const settled = await waitFor(
		(m) =>
			m.type === "snapshot" &&
			!m.state.isStreaming &&
			m.state.messages.some((mm) => mm.role === "toolResult") &&
			m.state.messages.at(-1)?.role === "assistant",
		120_000,
	);
	clearInterval(poll);
	check("run settled", !!settled);
	const toolResults = settled.state.messages.filter((mm) => mm.role === "toolResult");
	check("toolResult landed in final snapshot", toolResults.length > 0);
	if (status.exitCode !== undefined) {
		const same = toolResults.some(
			(mm) => mm.toolCallId === status.toolCallId && (mm.isError ?? false) === status.isError,
		);
		check("toolResult matches tool_status toolCallId", same);
	}

	ws.close();
	await stopServer();
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error("ERROR:", err.message);
	await stopServer();
	process.exit(1);
});
