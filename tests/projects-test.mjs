/* Smoke test for project memory + recent-project list + create and open project.
 * Usage:
 *   npm run build && node tests/projects-test.mjs
 * The test starts its own server (tests/lib/own-server.mjs, temp folders) and runs, in order:
 *   phase1  connect, switch cwd, check the project list
 *   restart the server (same folders)
 *   phase2  after the restart: the project list still has the project; the cwd is the server's
 *           start folder (the no-cwd-restore patch: a new connection never jumps back to the
 *           last folder, see PATCHES.md)
 *   mkdir   make_dir(setAsCwd: true) creates and opens a project
 */
import { WebSocket } from "ws";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "projects-test" });
const WS = srv.ws;
const CLIENT_ID = "test-client-0001";
const PROJ_B = join(srv.root, "proj-b");
mkdirSync(PROJ_B, { recursive: true });

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
						const t = setTimeout(
							() => rej(new Error(`timeout waiting for message: ${String(pred).slice(0, 120)}`)),
							timeout,
						);
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

async function phase1() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");
	// First snapshot carries the initial cwd (sent right after ready).
	const first = await c.wait((m) => m.type === "snapshot");
	console.log("[1] initial cwd =", first.state.cwd);

	c.send({ type: "set_cwd", path: PROJ_B });
	const afterSwitch = await c.wait((m) => m.type === "snapshot" && m.state.cwd === PROJ_B);
	console.log("[2] after set_cwd →", afterSwitch.state.cwd);

	const projs = await c.wait((m) => m.type === "projects");
	console.log(
		"[3] projects =",
		projs.projects.map((p) => p.path),
	);
	if (!projs.projects.some((p) => p.path === PROJ_B)) {
		throw new Error("FAIL: new cwd missing from project list");
	}
	// Explicit list_projects must also work.
	c.send({ type: "list_projects" });
	const projs2 = await c.wait((m) => m.type === "projects");
	console.log(
		"[4] list_projects →",
		projs2.projects.map((p) => p.path),
	);
	if (projs2.projects[0].path !== PROJ_B) {
		throw new Error("FAIL: most recent project not first");
	}
	c.close();
	console.log("\n✅ PHASE 1 PASSED");
}

async function testMakeDirScenario() {
	let c;
	const tempBase = mkdtempSync(join(srv.root, "pi-proj-mkdir-"));
	const target = join(tempBase, "new-project-folder");
	try {
		c = await connect();
		c.send({ type: "hello", clientId: CLIENT_ID });
		await c.wait((m) => m.type === "ready");
		// A client the server already knows (same clientId as the phases before) may get only a
		// snapshot_delta on reconnect (snapshot protocol v2).
		await c.wait((m) => m.type === "snapshot" || m.type === "snapshot_delta");

		c.send({ type: "make_dir", path: target, setAsCwd: true });
		const normTarget = resolve(target);
		const snap = await c.wait((m) => m.type === "snapshot" && resolve(m.state.cwd) === normTarget, 10000);
		console.log("[mkdir] after make_dir(setAsCwd: true) → cwd =", snap.state.cwd);

		if (!existsSync(target)) {
			throw new Error("FAIL: target directory was not created on disk");
		}

		c.send({ type: "list_projects" });
		const projs = await c.wait((m) => m.type === "projects");
		console.log(
			"[mkdir] projects =",
			projs.projects.map((p) => p.path),
		);
		if (!projs.projects.some((p) => resolve(p.path) === normTarget)) {
			throw new Error("FAIL: created directory missing from projects list");
		}
		console.log("\n✅ MAKE_DIR (setAsCwd: true) SCENARIO PASSED");
	} finally {
		if (c) c.close();
		try {
			rmSync(tempBase, { recursive: true, force: true });
		} catch {}
	}
}

async function phase2() {
	const c = await connect();
	c.send({ type: "hello", clientId: CLIENT_ID });
	await c.wait((m) => m.type === "ready");
	const restored = await c.wait((m) => m.type === "snapshot");
	console.log("[5] after restart, cwd =", restored.state.cwd);
	if (restored.state.cwd !== srv.workdir) {
		throw new Error(`FAIL: cwd should be the server's start folder (no-cwd-restore), got ${restored.state.cwd}`);
	}
	// The real browser client asks for the project list right after ready.
	c.send({ type: "list_projects" });
	const projs = await c.wait((m) => m.type === "projects");
	console.log(
		"[6] projects after restart =",
		projs.projects.map((p) => p.path),
	);
	if (!projs.projects.some((p) => p.path === PROJ_B)) {
		throw new Error("FAIL: restored project missing from list");
	}
	c.close();
	console.log("\n✅ PHASE 2 PASSED");
}

async function main() {
	await phase1();
	await srv.restart();
	await phase2();
	await testMakeDirScenario();
	await srv.stop();
	console.log("\n✅ PROJECTS CHECKS PASSED");
}

main().catch(async (e) => {
	console.error("❌", e.message);
	await srv.stop();
	process.exit(1);
});
