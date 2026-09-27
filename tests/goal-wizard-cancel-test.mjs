/**
 * Goal wizard — cancellation test.
 *
 * Starts a wizard, answers the first question, then sends clear_goal (the ✗
 * button). Verifies the browser dialog is closed (dialog_closed), the wizard
 * status clears, and NO goal is auto-set.
 *
 * Runs on its own server (tests/lib/own-server.mjs) with the stand-in model (tests/lib/mock-model.mjs):
 * the wizard session asks through goal_ask like a real model would. No real model is called.
 * Usage: npm run build && node tests/goal-wizard-cancel-test.mjs
 */
import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { wizardReply } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

/* eslint-env node */

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let srv = null;
async function startServer() {
	srv = await ownServer({
		name: "goal-wizard-cancel-test",
		mock: ({ payload, sideRequest }) =>
			wizardReply(payload, {
				questions: [
					{ question: "同步方向是？", options: ["单向同步", "双向同步"] },
					{ question: "需要忽略哪些文件？" },
				],
				goal: "写一个单向文件同步工具，并附带测试。",
			}) ?? (sideRequest ? "文件同步" : "好的。"),
	});
}

async function main() {
	await startServer();
	const ws = new WebSocket(srv.ws);
	const inbox = [];
	const waiters = [];
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		let consumed = false;
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i](m)) {
				waiters.splice(i, 1);
				consumed = true;
				i--;
			}
		}
		if (!consumed) inbox.push(m);
	});
	const next = (pred, what, ms = 30000) => {
		const i = inbox.findIndex(pred);
		if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
			waiters.push((m) => {
				if (pred(m)) {
					clearTimeout(t);
					res(m);
					return true;
				}
				return false;
			});
		});
	};

	await new Promise((res) => ws.on("open", res));
	ws.send(JSON.stringify({ type: "hello", clientId: "wiz-cancel" }));
	await next((m) => m.type === "snapshot", "initial snapshot");

	ws.send(JSON.stringify({ type: "start_goal_wizard", text: "写一个文件同步工具", maxRounds: 4 }));

	// Wait for the FIRST question dialog, then cancel via clear_goal.
	const d1 = await next((m) => m.type === "dialog", "first question", 40000);
	console.error(`[d] got Q (id=${d1.id}): ${(d1.args?.[0] || "").toString().slice(0, 50)}`);
	check("wizard asked a question", true);

	// User clicks ✗ → clear_goal.
	ws.send(JSON.stringify({ type: "clear_goal" }));

	// Expect a dialog_closed for that dialog (the browser modal must close).
	try {
		const closed = await next(
			(m) => m.type === "dialog_closed" && m.id === d1.id,
			"dialog_closed for the wizard question",
			15000,
		);
		check("dialog closed on cancel", closed.id === d1.id);
	} catch {
		check("dialog closed on cancel", false, "no dialog_closed");
	}

	// Wizard status should return to inactive (no active=goal).
	await sleep(1200);
	const gs = inbox.filter((m) => m.type === "goal_status");
	const last = gs[gs.length - 1];
	const wizardInactive = last && last.status.wizard && last.status.wizard.active === false;
	const noGoal = last ? last.status.goal === null : true;
	check("wizard went inactive after cancel", Boolean(wizardInactive), JSON.stringify(last?.status?.wizard));
	check("no goal auto-set on cancel", noGoal);

	// Wait a moment to ensure no delayed goal_set arrives.
	await sleep(2000);
	const lateGoal = inbox.some((m) => m.type === "goal_status" && m.status.goal && m.status.goal !== null);
	check("no goal set even after waiting", !lateGoal);
	// The wizard really stopped: the model was asked for the first question only.
	const wizardRequests = srv.mock.requests.filter((r) => wizardReply(r, { questions: [], goal: "" }) !== null);
	check(
		"the wizard made no model request after the cancel",
		wizardRequests.length === 1,
		`requests=${wizardRequests.length}`,
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	ws.close();
	await srv.stop();
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
	console.error("ERR", e);
	await srv?.stop();
	process.exit(1);
});
