/**
 * Review loop: bounded smoke. Sets a LOCKED unlimited goal (maxRounds=0), sends a prompt, and
 * verifies the loop really loops: a review fires, a failed round goes back to the agent as a
 * revision message, the lock keeps reviewing (it is not single-shot), and a pass ends and clears
 * the goal.
 *
 * With no reviewer model the goal runs in autonomous mode (server/goal-service.ts runGoalReview):
 * a round passes only when the agent's answer carries the completion marker (GOAL_COMPLETION_RE),
 * otherwise it fails and the loop continues. The model is a local stand-in
 * (tests/lib/mock-model.mjs): its first answer has no marker, and its answer to the revision
 * message has one. No real model is called.
 *
 * Run: npm run build && node tests/goal-review-loop-test.mjs
 */
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

/* eslint-env node */

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "\u2713" : "\u2717"} ${name}${extra ? " \u2014 " + extra : ""}`);
	if (!ok) failures++;
}

// The revision message the loop sends after a failed round (both languages, see goal.review.revise).
const REVISION_RE = /\u76ee\u6807\u5ba1\u67e5|Goal review: round/;
// The notice for a passed review (both languages).
const PASS_NOTICE_RE = /\u5df2\u901a\u8fc7\u5ba1\u67e5|passed review/;

const answers = []; // what the stand-in model was asked (main conversation only)
const srv = await ownServer({
	name: "goal-review-loop",
	mock: ({ lastUser, sideRequest }) => {
		if (sideRequest) return "Squares";
		const asked = lastUser ?? "";
		answers.push(asked);
		if (REVISION_RE.test(asked)) {
			// The revised answer: complete, with the completion marker.
			return "| n | n^2 |\n|---|---|\n| 1 | 1 |\n| 2 | 4 |\n| 3 | 9 |\n\nGOAL: COMPLETED";
		}
		if (answers.length === 1) return "| 1 | 1 |\n| 2 | 4 |\n| 3 | 9 |";
		return "OK";
	},
});

const ws = new WebSocket(srv.ws);
const seen = [];
ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
const until = async (pred, what, ms = 60000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const hit = seen.find(pred);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`timeout: ${what}`);
};

try {
	await new Promise((res) => ws.on("open", res));
	ws.send(JSON.stringify({ type: "hello", clientId: "lock-test" }));
	await until((m) => m.type === "snapshot", "initial snapshot", 20000);

	// Locked, unlimited (maxRounds=0).
	ws.send(
		JSON.stringify({
			type: "set_goal",
			goal: "List the squares of 1, 2 and 3 as a one-line markdown table",
			maxRounds: 0,
			locked: true,
		}),
	);
	await until((m) => m.type === "goal_status" && m.status.goal, "goal set", 10000);
	ws.send(JSON.stringify({ type: "prompt", text: "Please do it: a markdown table of the squares of 1, 2, 3." }));

	const passed = await until(
		(m) => m.type === "notice" && PASS_NOTICE_RE.test(`${m.text ?? ""} ${m.textEn ?? ""}`),
		"the goal passes review",
		90000,
	).catch(() => null);
	// Give the last goal_status a moment to arrive after the notice.
	await new Promise((r) => setTimeout(r, 1000));

	const statuses = seen.filter((m) => m.type === "goal_status").map((m) => m.status);
	check(
		"review fired (reviewing observed)",
		statuses.some((s) => s.reviewing),
	);
	check(
		"a failed round went back to the agent as a revision message",
		answers.some((a) => REVISION_RE.test(a)),
		`${answers.length} requests`,
	);
	const rounds = Math.max(0, ...statuses.map((s) => s.round ?? 0));
	check("the unlimited lock kept reviewing (a second round, not single-shot)", rounds >= 2, `round ${rounds}`);
	check(
		"got a verdict: pass after the revision",
		!!passed && statuses.some((s) => s.verdict === "pass"),
		passed ? "" : "no pass notice",
	);
	const last = statuses[statuses.length - 1];
	check("a passed goal is cleared", !!last && last.goal === null, JSON.stringify(last?.goal));
} catch (e) {
	check("goal review loop ran", false, String(e?.message ?? e));
} finally {
	ws.close();
	await srv.stop();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
