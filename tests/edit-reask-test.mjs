/* Smoke test for edit-and-re-ask (edit_message → runtime.fork → re-prompt).
 * Starts its own server (tests/lib/own-server.mjs) with temp folders and a model that can't be
 * reached (the user message is appended before the API call, so the fork mechanics are testable
 * even though the call fails).
 * Run: npm run build && node tests/edit-reask-test.mjs
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "edit-reask-test" });
const WS = srv.ws;
const CLIENT_ID = "edit-test-client";

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else {
				inbox.push(msg);
			}
		});
		ws.on("open", () =>
			resolve({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 60000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeout);
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(t);
								res(m);
							},
						});
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

const msgText = (snap, text) =>
	snap.state.messages.some(
		(m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes(text)),
	);
const userMessages = (snap) => snap.state.messages.filter((m) => m.role === "user");

/** Changes arrive as snapshot deltas; ask for the full state (get_state) until it matches. */
async function stateUntil(c, pred, timeout = 20_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		c.send({ type: "get_state" });
		const snap = await c.wait((m) => m.type === "snapshot", 5000);
		if (pred(snap)) return snap;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("timeout waiting for the state");
}

async function main() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");
	const snap0 = await c.wait((m) => m.type === "snapshot");
	console.log("[1] initial session:", snap0.state.sessionId.slice(0, 8));

	// Pick any model that appears available with the dummy auth, then ask twice.
	c.send({ type: "list_models" });
	const models = await c.wait((m) => m.type === "models");
	console.log("[2] available models:", models.models.length);
	if (models.models.length === 0) {
		throw new Error("no models with dummy auth — cannot run the edit flow");
	}
	c.send({ type: "set_model", modelId: models.models[0].id });

	c.send({ type: "prompt", text: "第一个问题：如何学习 TypeScript？" });
	await stateUntil(c, (m) => msgText(m, "第一个问题") && !m.state.isStreaming);
	console.log("[3] first question persisted");

	c.send({ type: "prompt", text: "第二个问题：如何学习 Rust？" });
	const preSnap = await stateUntil(c, (m) => msgText(m, "第二个问题") && !m.state.isStreaming);
	const pre = userMessages(preSnap);
	const target = pre.find((m) => m.content.some((b) => b.text?.includes("第一个问题")));
	if (!target) throw new Error("FAIL: could not find first user message");
	console.log("[4] editing message id:", target.id);

	c.send({
		type: "edit_message",
		messageId: target.id,
		text: "修改后的问题：怎么学 Go？",
	});
	const snap2 = await stateUntil(c, (m) => msgText(m, "修改后的问题"));
	console.log("[5] new session:", snap2.state.sessionId.slice(0, 8));
	if (snap2.state.sessionId === snap0.state.sessionId) {
		throw new Error("FAIL: session did not change after edit");
	}
	const texts = snap2.state.messages
		.filter((m) => m.role === "user")
		.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
	console.log("[6] user messages in new session:", JSON.stringify(texts));
	if (texts.some((t) => t.includes("第一个问题") || t.includes("第二个问题"))) {
		throw new Error("FAIL: old questions leaked into the forked session");
	}
	if (!texts.some((t) => t.includes("修改后的问题"))) {
		throw new Error("FAIL: edited question missing from new session");
	}

	// The original thread is kept on disk next to the new fork. The history list shows only the
	// newest session of a fork chain (upstream hides forked parents, see pushSessions()).
	const files = readdirSync(join(srv.agentDir, "sessions"), { recursive: true }).filter((f) =>
		String(f).endsWith(".jsonl"),
	);
	console.log("[7] session files:", files.length, "(expect >= 2: original thread kept + new fork)");
	if (files.length < 2) {
		throw new Error("FAIL: the original session should still be on disk");
	}
	c.send({ type: "list_sessions" });
	const sessions = await c.wait((m) => m.type === "sessions" && m.sessions.length >= 1);
	const listed = sessions.sessions.map((s) => s.path);
	console.log("[8] history list:", listed.length, "session(s)");
	if (!listed.some((p) => p.includes(snap2.state.sessionId))) {
		throw new Error("FAIL: the new fork should be in the history list");
	}
	c.close();
	await srv.stop();
	console.log("\n\u2705 EDIT-AND-RE-ASK CHECKS PASSED");
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
