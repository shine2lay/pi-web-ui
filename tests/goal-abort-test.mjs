/**
 * Manual-abort stops the goal review loop.
 * Sets a goal, sends a prompt, then hits Stop (abort) mid-run. Verifies the
 * review loop does NOT re-fire and the goal is cleared (no endless review of a
 * half-finished run).
 *
 * Runs on its own server (tests/lib/own-server.mjs, temp folders) with the stand-in model
 * (tests/lib/mock-model.mjs). The stand-in holds every answer for a minute, so the Stop always
 * lands mid-run. No real model is called.
 * Robust harness: bounded awaits, never hangs.
 */
import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { ownServer } from "./lib/own-server.mjs";

/* eslint-env node */

function openSocket(url, ms) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => {
			ws.terminate();
			reject(new Error("ws timeout"));
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
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].test(m)) {
				const r = waiters[i];
				waiters.splice(i, 1);
				clearTimeout(r.t);
				r.res(m);
				return;
			}
		}
		inbox.push(m);
	};
	const next = (pred, what, ms) =>
		new Promise((res, rej) => {
			const test = (m) => {
				try {
					return pred(m);
				} catch {
					return false;
				}
			};
			const i = inbox.findIndex(test);
			if (i >= 0) return res(inbox.splice(i, 1)[0]);
			const t = setTimeout(() => rej(new Error("timeout: " + what)), ms);
			waiters.push({ test, res, rej, t });
		});
	return { onMsg, next };
}

(async () => {
	// The stand-in model answers only after a minute: the run is still going when Stop is hit.
	const srv = await ownServer({
		name: "goal-abort-test",
		mock: async () => {
			await sleep(60_000);
			return "(late answer)";
		},
	});

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
	ws.send(JSON.stringify({ type: "hello", clientId: "abort-test" }));
	try {
		await next((m) => m.type === "snapshot", "snap", 20000);
	} catch {}

	ws.send(
		JSON.stringify({ type: "set_goal", goal: "写一段超过500字的说明，字越多越好。", maxRounds: 0, locked: true }),
	);
	try {
		await next((m) => m.type === "goal_status" && m.status.goal, "goal set", 10000);
	} catch {}

	// Start generation then abort shortly after.
	ws.send(JSON.stringify({ type: "prompt", text: "请开始。" }));
	await sleep(4000);
	const askedBeforeAbort = srv.mock.requests.length;
	console.log(`[d] model requests before Stop: ${askedBeforeAbort}`);
	ws.send(JSON.stringify({ type: "abort" }));

	// After abort, the goal should be cleared (abort → stop review), not re-reviewed.
	await sleep(6000);
	let goalCleared = false;
	// Wait for the abort-clear goal_status (goal === null with the manual-stop status text,
	// server/goal-service.ts: "已手动停止…" in Chinese, "…stopped manually…" in English).
	try {
		await next(
			(m) =>
				m.type === "goal_status" &&
				m.status.goal === null &&
				(m.status.status.includes("手动停止") || /stopped manually|manual stop/i.test(m.status.status)),
			"abort-cleared goal_status",
			15000,
		);
		goalCleared = true;
		console.log("[d] goal cleared after manual abort (review loop stopped) ✓");
	} catch {
		goalCleared = false;
		console.log("[d] goal NOT detected as cleared after abort");
	}
	// No review round after the Stop: the model got no new request.
	const askedAfterAbort = srv.mock.requests.length - askedBeforeAbort;
	console.log(`[d] model requests after Stop: ${askedAfterAbort}`);
	const noReview = askedAfterAbort === 0;

	console.log(goalCleared ? "✓ manual abort clears goal (stops review loop)" : "✗ goal not cleared on abort");
	console.log(noReview ? "✓ no review round after the Stop" : "✗ the model was asked again after the Stop");
	try {
		ws.close();
		await srv.stop();
	} catch {}
	process.exit(goalCleared && noReview ? 0 : 1);
})().catch((e) => {
	console.error("ERR", e);
	process.exit(1);
});
