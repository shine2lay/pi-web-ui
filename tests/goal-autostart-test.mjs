/**
 * Direct goal set — auto-start test.
 * Sends set_goal (NO AI-提炼 / no wizard) and confirms the main agent is
 * auto-triggered to generate (a "【目标已设定】" user message appears in a
 * snapshot). No reliance on the model completing.
 *
 * Robust harness: server-startup check + WebSocket open/error/close handled,
 * so it can never hang forever — every await has a bounded timeout.
 */
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

/* eslint-env node */

// The kick-off message: "[Goal set]" in the server's prompt language (goal-service.ts), "【目标已设定】" in Chinese.
const isKickoff = (text) => text.startsWith("[Goal set]") || text.startsWith("【目标已设定】");

function openSocket(url, ms) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => {
			ws.terminate();
			reject(new Error("ws connect timeout"));
		}, ms);
		ws.on("open", () => {
			clearTimeout(t);
			resolve(ws);
		});
		ws.on("error", (e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

function mkWaiters() {
	const inbox = [];
	const waiters = [];
	const onMsg = (m) => {
		let handled = false;
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].test(m)) {
				const r = waiters[i];
				waiters.splice(i, 1);
				clearTimeout(r.t);
				r.res(m);
				handled = true;
				break;
			}
		}
		if (!handled) inbox.push(m);
	};
	const next = (pred, what, ms) =>
		new Promise((res, rej) => {
			const withTimeout = (m) => {
				const mm = m;
				try {
					return pred(mm);
				} catch {
					return false;
				}
			};
			const i = inbox.findIndex(withTimeout);
			if (i >= 0) return res(inbox.splice(i, 1)[0]);
			const t = setTimeout(() => rej(new Error("timeout: " + what)), ms);
			waiters.push({ test: withTimeout, res, rej, t });
		});
	return { inbox, onMsg, next };
}

(async () => {
	// Its own server (temp folders) with the stand-in model: it answers every request with a short
	// text, so the auto-started run finishes without any real model.
	const srv = await ownServer({ name: "goal-autostart-test", mock: () => "我是测试助手。" });
	const ws = await openSocket(srv.ws, 10000);
	const { onMsg, next } = mkWaiters();
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		onMsg(m);
	});

	ws.send(JSON.stringify({ type: "hello", clientId: "autostart" }));
	try {
		await next((m) => m.type === "snapshot", "snapshot", 20000);
	} catch {}

	// Direct goal set (maxRounds 0 = unlimited, locked).
	ws.send(JSON.stringify({ type: "set_goal", goal: "帮我写一句自我介绍。", maxRounds: 0, locked: true }));
	// Snapshot protocol v2: regular updates are snapshot_delta; ask for full snapshots.
	const poll = setInterval(() => ws.send(JSON.stringify({ type: "get_state" })), 700);

	// Expect the auto-start kick-off user message in a snapshot.
	let kickoff = false;
	try {
		await next(
			(m) => m.type === "snapshot" && m.state.messages.some((mm) => isKickoff(mm.content?.[0]?.text ?? "")),
			"auto-start kick-off",
			20000,
		);
		kickoff = true;
		console.log("[d] auto-start fired after direct set_goal ✓");
	} catch {
		kickoff = false;
		console.log("[d] NO auto-start after direct set_goal");
	}

	console.log(kickoff ? "✓ direct set_goal auto-starts generation" : "✗ direct set_goal did NOT auto-start");
	clearInterval(poll);
	try {
		ws.close();
		await srv.stop();
	} catch {}
	process.exit(kickoff ? 0 : 1);
})().catch((e) => {
	console.error("ERR", e);
	process.exit(1);
});
