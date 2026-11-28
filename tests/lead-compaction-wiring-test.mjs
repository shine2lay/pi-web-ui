/**
 * lead-compaction-wiring: the BUILT server starts lead recovery from the staged OpenViking add-on,
 * finds a canonical lead home, checks it off the web thread, and still lets that home open.
 *
 * Why it exists: unit tests join the host, executor and scheduler in one process. They cannot show
 * that the installed server can load the add-on's files, start its worker and pass the recovery
 * preflight every lead home goes through on open. If that wiring breaks, lead homes refuse to open.
 *
 * Own server, own temp home (HOME, agent, data, identities, journals); a small made-up lead home
 * below the trigger, so no archive is requested and no model is called. Two layouts:
 *   1. the add-on staged the way pi-web-deploy stages it (a copy with node_modules linked back);
 *   2. planted fault: an empty staged folder. Recovery must say so (never claim it is enabled) and the
 *      home must NOT open: this proves check 1 can fail, and pins the fail-closed behaviour.
 *
 * Usage: node tests/run-sealed.mjs lead-compaction-wiring-test   (builds first)
 */
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ownServer } from "./lib/own-server.mjs";

const OPENVIKING = process.env.PI_OPENVIKING_ROOT ?? "/home/shinelay/projects/pi-openviking";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One made-up canonical lead home (role ops) in the server's own folders. */
function seedLeadHome({ root, agentDir, workdir }) {
	const sessions = join(agentDir, "sessions", "--lead-wiring--");
	mkdirSync(sessions, { recursive: true });
	const manager = SessionManager.create(workdir, sessions);
	manager.appendCustomEntry("identity", { id: "ops", via: "home" });
	manager.appendMessage({ role: "user", content: "made-up lead question", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "made-up lead answer" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	const home = manager.getSessionFile();
	const identities = join(root, ".pi", "agent", "memory", "identities");
	mkdirSync(join(identities, "ops"), { recursive: true });
	writeFileSync(join(identities, "ops", "identity.json"), JSON.stringify({ id: "ops", homeChat: home }), {
		mode: 0o600,
	});
	mkdirSync(join(root, ".pi", "openviking"), { recursive: true, mode: 0o700 });
	writeFileSync(join(root, ".pi", "openviking", "rollout-state.json"), JSON.stringify({ phase: "v2" }), {
		mode: 0o600,
	});
	return { home, identities };
}

async function run(name, stageAddon) {
	let seeded;
	const env = {};
	const srv = await ownServer({
		name,
		prepare: (dirs) => {
			seeded = seedLeadHome(dirs);
			const stage = join(dirs.root, "addons");
			mkdirSync(stage, { recursive: true });
			stageAddon(join(stage, "pi-openviking"));
			// Everything the server and the add-on read by default now lives under the temp root.
			Object.assign(env, {
				HOME: dirs.root,
				PI_IDENTITY_DIR: seeded.identities,
				PI_WEB_ADDONS_DIR: stage,
				PI_OPENVIKING_ROLLOUT_STATE_PATH: join(dirs.root, ".pi", "openviking", "rollout-state.json"),
				OV_LEAD_HANDOFFS_PATH: join(dirs.root, ".pi", "openviking", "lead-handoffs.jsonl"),
				OV_METRICS_PATH: join(dirs.root, ".pi", "openviking", "metrics.jsonl"),
			});
		},
		env,
	});
	const diagnostics = async () => (await (await fetch(`${srv.http}/api/busy`)).json()).leadCompaction;
	const until = async (pred, timeoutMs) => {
		const t0 = Date.now();
		let last;
		while (Date.now() - t0 < timeoutMs) {
			last = await diagnostics();
			if (pred(last)) return last;
			await sleep(250);
		}
		return last;
	};
	const open = async () => {
		const ws = new WebSocket(srv.ws);
		const frames = [];
		ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
		await new Promise((res, rej) => {
			ws.once("open", res);
			ws.once("error", rej);
		});
		const frame = async (pred, timeoutMs = 60_000) => {
			const t0 = Date.now();
			while (Date.now() - t0 < timeoutMs) {
				const hit = frames.find(pred);
				if (hit) return hit;
				await sleep(20);
			}
			return undefined;
		};
		ws.send(JSON.stringify({ type: "hello", clientId: `${name}-socket`, locale: "en" }));
		await frame((m) => m.type === "ready");
		frames.length = 0;
		ws.send(JSON.stringify({ type: "switch_session", path: seeded.home }));
		const done = await frame((m) => m.type === "switch_done" || m.type === "switch_failed", 20_000);
		ws.close();
		// Frame type names only, never their content.
		return done?.type ?? `no answer (saw: ${[...new Set(frames.map((m) => m.type))].join(", ") || "nothing"})`;
	};
	return { srv, until, open };
}

// 1. Staged like an install: a copy of the add-on's files, node_modules linked back to its checkout.
{
	console.log("staged add-on, as pi-web-deploy lays it out:");
	const { srv, until, open } = await run("lead-wiring", (target) => {
		mkdirSync(target, { recursive: true });
		cpSync(join(OPENVIKING, "src"), join(target, "src"), { recursive: true });
		cpSync(join(OPENVIKING, "package.json"), join(target, "package.json"));
		symlinkSync(join(OPENVIKING, "node_modules"), join(target, "node_modules"));
	});
	try {
		const started = await until((d) => d?.enabled === true || !!d?.errorCode, 30_000);
		check(
			"lead recovery is enabled, with no startup error",
			started?.enabled === true && !started?.errorCode,
			JSON.stringify(started),
		);
		const checked = await until((d) => d?.homes?.some((h) => h.role === "ops" && h.state === "ready"), 90_000);
		const home = checked?.homes?.find((h) => h.role === "ops");
		check(
			"the made-up lead home was checked off-thread: ready, below the trigger",
			home?.state === "ready" && home?.nextRetryReason === "below_threshold",
			JSON.stringify(home ?? checked),
		);
		check("the lead home opens after the recovery preflight", (await open()) === "switch_done");
		const after = await until((d) => d?.homes?.some((h) => h.role === "ops"), 10_000);
		check(
			"still enabled after the open, no error",
			after?.enabled === true && !after?.errorCode,
			JSON.stringify(after),
		);
		check("the server log has no lead-recovery startup error", !srv.stderr().includes("E_LEAD_STARTUP"));
	} finally {
		await srv.stop();
	}
}

// 2. Planted fault: nothing staged. The check above must be able to fail, and it fails closed.
{
	console.log("planted fault, an empty staged add-on:");
	const { srv, until, open } = await run("lead-wiring-fault", (target) => mkdirSync(target, { recursive: true }));
	try {
		const started = await until((d) => !!d?.errorCode, 30_000);
		check(
			"recovery reports its startup error and does not claim to be enabled",
			started?.enabled === false && started?.errorCode === "E_LEAD_STARTUP",
			JSON.stringify(started),
		);
		const refused = await open();
		check("the lead home refuses to open while recovery is unavailable", refused === "switch_failed", refused);
	} finally {
		await srv.stop();
	}
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
