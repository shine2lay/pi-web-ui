/**
 * Goal wizard — smoke test.
 *
 * Drives the collaborative target wizard over raw WebSocket: sends a raw
 * requirement, answers each dialog question (goal_ask) it pushes via
 * `dialog_response`, and verifies the refined goal gets auto-set.
 *
 * Runs on its own server (tests/lib/own-server.mjs) with the stand-in model (tests/lib/mock-model.mjs):
 * the wizard session asks two goal_ask questions (one multiple choice, one open) and then answers
 * "GOAL: …", like a real model would. No real model is called.
 * Usage: npm run build && node tests/goal-wizard-test.mjs
 */
import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { textOf, wizardReply } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

/* eslint-env node */

// The kick-off message: "[Goal set]" in the server's prompt language (goal-service.ts), "【目标已设定】" in Chinese.
const isKickoff = (text) => text.startsWith("[Goal set]") || text.startsWith("【目标已设定】");
const GOAL = "写一个 Python 命令行文件去重小工具：按内容哈希找出重复文件并列出，附带测试。";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const srv = await ownServer({
	name: "goal-wizard-test",
	mock: ({ payload, sideRequest }) =>
		wizardReply(payload, {
			questions: [{ question: "用什么语言写？", options: ["Python", "Node.js"] }, { question: "还有别的要求吗？" }],
			goal: GOAL,
		}) ?? (sideRequest ? "文件去重" : "好的，开始。"),
});

(async () => {
	const ws = new WebSocket(srv.ws);
	const inbox = [];
	const waiters = [];
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		// Resolve pending waiters WITHOUT leaving the message in inbox (so it is
		// not consumed twice). If no waiter matched, keep it in inbox for next().
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
	const next = (pred, what, ms = 60000) => {
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
	ws.send(JSON.stringify({ type: "hello", clientId: "wiz-live" }));
	await next((m) => m.type === "snapshot", "initial snapshot");

	console.log("Starting goal wizard…");
	ws.send(JSON.stringify({ type: "start_goal_wizard", text: "写一个打开即用的文件去重小工具", maxRounds: 3 }));

	let sawWizardActive = false;
	let answered = 0;
	const deadline = Date.now() + 120000;
	let setGoalSeen = null;
	let kickOffSeen = false;
	while (Date.now() < deadline) {
		let msg;
		try {
			msg = await next((m) => m.type === "dialog" || m.type === "goal_status" || m.type === "notice", "any", 15000);
		} catch {
			// inner timeout — check whether a goal was already set
			msg = null;
		}
		if (!msg) {
			const g = inbox.find((m) => m.type === "goal_status");
			if (g && g.status.goal) {
				setGoalSeen = g.status.goal;
				break;
			}
			continue;
		}
		if (msg.type === "dialog") {
			sawWizardActive = true;
			answered += 1;
			console.error(`[d] Q${answered} (id=${msg.id}) → ${(msg.args?.[0] || "?").toString().slice(0, 50)}`);
			// Answer multiple-choice by picking the first option; else free text.
			const opts = msg.args?.[0];
			const val = Array.isArray(opts) && opts.length > 0 ? opts[0] : "都可以，你决定";
			ws.send(JSON.stringify({ type: "dialog_response", id: msg.id, value: val }));
		}
		if (msg.type === "goal_status" && msg.status.goal && !setGoalSeen) {
			setGoalSeen = msg.status.goal;
			console.error(`[d] goal set: ${msg.status.goal.slice(0, 60)}`);
			// After goal set, the wizard should AUTO-KICK generation (no "开始吧").
			// Wait for the kick-off user message (the marker text injected by
			// startGoalWizard) to appear in the conversation. Snapshot protocol v2 sends
			// changes as snapshot_delta, so ask for full snapshots (get_state) meanwhile.
			const poll = setInterval(() => ws.send(JSON.stringify({ type: "get_state" })), 700);
			try {
				await next(
					(m) => m.type === "snapshot" && m.state.messages.some((mm) => mm.role === "user" && isKickoff(textOf(mm))),
					"auto-generate kick-off user message",
					30000,
				);
				kickOffSeen = true;
				console.error("[d] auto-generate kicked off ✓");
			} catch {
				kickOffSeen = false;
			} finally {
				clearInterval(poll);
			}
		}
		if (kickOffSeen) break;
	}
	await sleep(300);

	check("wizard went active (asked questions)", sawWizardActive, `answered=${answered}`);
	check("wizard asked both questions", answered === 2, `answered=${answered}`);
	check("refined goal auto-set", Boolean(setGoalSeen), setGoalSeen || "none");
	check("the goal is the wizard's refined one", setGoalSeen === GOAL, setGoalSeen || "none");
	check("auto-generated after survey (no manual 开始吧)", kickOffSeen);
	if (!setGoalSeen) {
		const g = inbox.find((m) => m.type === "goal_status");
		console.error("[d] last goal_status:", JSON.stringify(g));
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	ws.close();
	await srv.stop();
	process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
	console.error("ERR", e);
	await srv.stop();
	process.exit(1);
});
