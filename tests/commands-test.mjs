/* Smoke test: commands.json is per-project (follows the current cwd).
 * Starts its own server (tests/lib/own-server.mjs) with temp folders: project A is the server's
 * work folder, project B a second folder; each has its own .pi/commands.json.
 * Run: npm run build && node tests/commands-test.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "commands-test" });
const PROJ_B = join(srv.root, "proj-b");
for (const [dir, name] of [
	[srv.workdir, "cmd-A"],
	[PROJ_B, "cmd-B"],
]) {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "commands.json"), JSON.stringify([{ name, command: `echo ${name}` }]));
}
const WS = srv.ws;
const CLIENT_ID = "cmd-test-client";

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
				wait: (pred, timeout = 8000) =>
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

async function main() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");

	// Project A commands first (server default cwd = work dir A).
	c.send({ type: "list_commands" });
	const ca = await c.wait((m) => m.type === "commands");
	console.log("[1] cwd A commands:", JSON.stringify(ca.commands.map((x) => x.name)), "→", ca.path);
	if (!ca.commands.some((x) => x.name === "cmd-A")) {
		throw new Error("FAIL: expected project A command");
	}

	// Switch to project B — commands must auto-switch to B's file.
	c.send({ type: "set_cwd", path: PROJ_B });
	await c.wait((m) => m.type === "snapshot" && m.state.cwd === PROJ_B);
	const cb = await c.wait((m) => m.type === "commands");
	console.log("[2] cwd B commands:", JSON.stringify(cb.commands.map((x) => x.name)), "→", cb.path);
	if (!cb.commands.some((x) => x.name === "cmd-B")) {
		throw new Error("FAIL: expected project B command after cwd switch");
	}
	if (cb.commands.some((x) => x.name === "cmd-A")) {
		throw new Error("FAIL: project A commands leaked into project B");
	}
	c.close();
	await srv.stop();
	console.log("\n✅ PER-PROJECT COMMANDS CHECKS PASSED");
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
