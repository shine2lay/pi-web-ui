#!/usr/bin/env node
/**
 * run-sealed.mjs: run the E2E scripts (tests/*-test.mjs), each one in its own sealed temporary
 * home (scripts/sealed.sh), in parallel, and list what failed or touched real data.
 *
 *   node tests/run-sealed.mjs                      # every E2E script, fence enforcing
 *   node tests/run-sealed.mjs busy-endpoint-test …  # just these
 *   node tests/run-sealed.mjs --report             # fence only records (inventory)
 *   node tests/run-sealed.mjs --jobs=4 --timeout=600 --out=/tmp/runs
 *   node tests/run-sealed.mjs --no-build …          # the build is already fresh
 *
 * Each script's output goes to <out>/<name>.log and its sealed summary (fence hits, processes left
 * running, new folders in the real sessions list) to <out>/<name>.json; <out>/summary.json has
 * them all. The exit code is 1 when any script failed or hit the fence.
 *
 * It builds first (npm run build): most scripts start dist/server/index.js. Scripts that share a
 * fixed port never run at the same time (see portsOf below). A full run skips the few upstream
 * tests that don't apply to this fork and prints why (NOT_FOR_THIS_FORK below).
 *
 * queue-side-by-side:
 *  - Started from a chat (inside pi-web-ui's service, whose restart stops everything in it), it starts
 *    itself again outside it (systemd-run --user, a unit pi-sealed-<time>) and shows that run's output
 *    until it ends, with its exit code. A restart cuts this command off, but not the run:
 *      node tests/run-sealed.mjs --result             # how this folder's newest run went (waits for its end)
 *      node tests/run-sealed.mjs --result --out=<dir> # that run
 *    --here runs it in place anyway.
 *  - At most 2 suites run at once (PI_SEALED_MAX_SUITES): the next one waits for a free slot and says so.
 *  - <out> also holds run.json, pid, run.log (the output) and exit (the exit code, once it has ended).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { findRun, follow, inService, runOf, runsBase, takeSlot } from "./lib/sealed-runs.mjs";

// queue-side-by-side: the run this script started outside pi-web-ui's service (below) takes the
// environment of the command that started it, exactly: systemd gives a service the user manager's own.
// What systemd sets for one service (pi-web-ui's, in that environment) stays this unit's own.
const envFile = process.env.PI_SEALED_ENV_FILE;
if (envFile) {
	try {
		const env = JSON.parse(readFileSync(envFile, "utf8"));
		const ownKeys = ["INVOCATION_ID", "JOURNAL_STREAM", "NOTIFY_SOCKET", "MANAGER_PID", "SYSTEMD_EXEC_PID"];
		const own = Object.fromEntries(ownKeys.filter((k) => k in process.env).map((k) => [k, process.env[k]]));
		for (const k of Object.keys(process.env)) delete process.env[k];
		for (const k of ownKeys) delete env[k];
		Object.assign(process.env, env, own);
	} catch (e) {
		console.error(`couldn't read the environment of the command that started this run (${e.message})`);
	}
	rmSync(envFile, { force: true });
	delete process.env.PI_SEALED_ENV_FILE;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const sealedSh = join(repo, "scripts", "sealed.sh");
/** This folder, the way runs record it (a worktree's own path). */
const repoKey = (() => {
	try {
		return realpathSync(repo);
	} catch {
		return resolve(repo);
	}
})();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const a = args.find((x) => x.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : fallback;
};

// --result: how this folder's newest run went (or the one in --out), waiting for it to end if it hasn't.
if (args.includes("--result")) {
	const dir = opt("out", undefined);
	const found = dir
		? runOf(resolve(dir))
			? { dir: resolve(dir), run: runOf(resolve(dir)) }
			: undefined
		: findRun(runsBase(), repoKey);
	if (!found) {
		console.log(dir ? `no sealed run in ${dir}` : `no sealed run of ${repoKey} in ${runsBase()}`);
		process.exit(2);
	}
	const what = (found.run.args ?? []).filter((a) => !a.startsWith("--")).join(" ") || "every script";
	console.log(`the sealed run of ${what}, started ${found.run.at} (logs: ${found.dir}):`);
	process.exit(await follow(found.dir));
}

const report = args.includes("--report");
const jobs = Math.max(1, Number(opt("jobs", "6")) || 6);
const timeoutSec = Math.max(10, Number(opt("timeout", "600")) || 600);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(opt("out", join(runsBase(), stamp)));
mkdirSync(out, { recursive: true });

const all = readdirSync(here)
	.filter((f) => f.endsWith(".mjs") && !f.startsWith("run-"))
	.map((f) => basename(f, ".mjs"))
	.sort();
const named = args.filter((a) => !a.startsWith("--")).map((a) => basename(a, ".mjs"));
for (const n of named) {
	if (!all.includes(n)) {
		console.error(`no such test: ${n}`);
		process.exit(2);
	}
}

// queue-side-by-side: a chat's bash runs inside pi-web-ui's service, and a pi-web-ui restart (an
// install) stops everything in it, a long suite too. So, started there, this starts itself again
// outside it, as a systemd user service of its own, and just shows that run's output (run.log) until
// it ends. Cut off by a restart, `node tests/run-sealed.mjs --result` picks it up again.
if (!envFile && !args.includes("--here") && inService()) {
	const unit = `pi-sealed-${stamp}`;
	const logFile = join(out, "run.log");
	const passOn = join(out, "env.json");
	writeFileSync(join(out, "run.json"), JSON.stringify({ repo: repoKey, args, unit, at: new Date().toISOString() }));
	writeFileSync(passOn, JSON.stringify(process.env), { mode: 0o600 });
	const r = spawnSync(
		"systemd-run",
		[
			"--user",
			"--quiet",
			"--collect",
			`--unit=${unit}`,
			`--description=sealed tests of ${repoKey}`,
			`--working-directory=${repoKey}`,
			`--property=StandardOutput=append:${logFile}`,
			`--property=StandardError=append:${logFile}`,
			`--setenv=PI_SEALED_ENV_FILE=${passOn}`,
			process.execPath,
			fileURLToPath(import.meta.url),
			...args.filter((a) => !a.startsWith("--out=")),
			`--out=${out}`,
		],
		{ encoding: "utf8" },
	);
	if (r.status === 0) {
		console.log(`running outside pi-web-ui's service, as ${unit}: a pi-web-ui restart doesn't stop it.`);
		console.log(
			"  Cut off (by a restart, say)? `node tests/run-sealed.mjs --result` shows it again and waits for its end.",
		);
		console.log(`  Stop it: systemctl --user stop ${unit}`);
		process.exit(await follow(out));
	}
	rmSync(passOn, { force: true });
	rmSync(join(out, "run.json"), { force: true });
	const why = (r.stderr || r.error?.message || `exit ${r.status}`).trim();
	console.log(
		`couldn't start it outside pi-web-ui's service (${why}); running it here, where a pi-web-ui restart stops it`,
	);
}

// The run's record, for --result: run.json (the command that started this run outside the service
// wrote it), the runner's pid, and its exit code once it ends. Stopped (systemctl stop, Ctrl+C), it
// still writes one. In place, its output goes to run.log too (outside the service, systemd puts it there).
if (!runOf(out))
	writeFileSync(
		join(out, "run.json"),
		JSON.stringify({ repo: repoKey, args, unit: null, at: new Date().toISOString() }),
	);
writeFileSync(join(out, "pid"), String(process.pid));
process.on("exit", (code) => {
	try {
		writeFileSync(join(out, "exit"), String(code));
	} catch {
		/* the folder is gone */
	}
});
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
if (!envFile) {
	const logFile = join(out, "run.log");
	for (const k of ["log", "error"]) {
		const write = console[k].bind(console);
		console[k] = (...a) => {
			write(...a);
			try {
				appendFileSync(logFile, `${format(...a)}\n`);
			} catch {
				/* the folder is gone */
			}
		};
	}
}

// At most 2 suites at once (PI_SEALED_MAX_SUITES): the queue runs tasks side by side, and more suites
// at once slow each other down until their tests time out. The next one waits for a free slot.
process.on("exit", await takeSlot({ owner: { pid: process.pid, repo: repoKey, out, at: new Date().toISOString() } }));

// Upstream tests of behaviour our fork changed on purpose, plus one upstream test left behind by
// an upstream redesign. They fail here by design, so a full run lists them as "skip" with the
// reason instead of running them; name one to run it anyway. The files stay exactly as upstream
// has them (no conflicts at the next sync), and PATCHES.md ("sealed-tests") has the same list.
// The fork's replacements have their own tests, which do run.
const NOT_FOR_THIS_FORK = {
	"takeover-test":
		"server-owned-chats: chats belong to the server, not to one window, so there is no other window's run to take over",
	"idle-takeover-test":
		"server-owned-chats: a second window opens the same shared chat; there is no idle takeover or elsewhere row",
	"remote-answer-test":
		"server-owned-chats: a question is answered in the shared chat itself; there is no elsewhere row with a question mark",
	"elsewhere-lifecycle-test": "server-owned-chats: no 'running elsewhere' rows (listExternalRunning() is always empty)",
	"elsewhere-click-takeover-ui-test": "server-owned-chats: no 'running elsewhere' rows to click",
	"orphan-adopt-test":
		"reload-adopt: a reloaded page goes back to its own chat (pickAdoptTarget) instead of adopting an orphan (findAdoptableOrphan)",
	"model-config-ui-test":
		"upstream redesign: the model studio replaced the model modal this test drives (it fails on pure v0.96.1 too)",
};
const skipped = named.length > 0 ? [] : all.filter((n) => n in NOT_FOR_THIS_FORK);
const list = named.length > 0 ? named : all.filter((n) => !(n in NOT_FOR_THIS_FORK));

// Build once, before any script starts. Several scripts run `npm run build` themselves, and a
// rebuild empties web/dist while other scripts' servers are serving it, so their pages break at
// random. PI_TEST_PREBUILT tells those scripts the build is already there. --no-build skips it.
if (!args.includes("--no-build")) {
	console.log("building (npm run build)");
	execFileSync("npm", ["run", "build"], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
}

// The page-picker tests import the built browser extension ("npm run build:extension" in their
// headers). Build it once when it is missing.
if (
	list.some((n) => n.startsWith("page-picker")) &&
	!existsSync(join(repo, "plugins", "page-picker", "extension", "dist", "background.js"))
) {
	console.log("building the page-picker extension (npm run build:extension)");
	execFileSync(process.execPath, [join(repo, "plugins", "page-picker", "extension", "build.mjs")], {
		cwd: repo,
		stdio: "inherit",
	});
}

// What run-smoke sets for the whole batch: no remote plugin catalog, private hosts allowed for
// the tests' own local mock sites.
const passEnv = ["PI_WEB_PLUGIN_CATALOG_URL=", "LEGADO_ALLOW_PRIVATE_HOSTS=127.0.0.1,localhost", "PI_TEST_PREBUILT=1"];

function runOne(name) {
	return new Promise((resolve) => {
		const started = Date.now();
		const logFile = join(out, `${name}.log`);
		const reportFile = join(out, `${name}.json`);
		const env = { ...process.env, PI_SEALED_REPORT_FILE: reportFile };
		delete env.PI_SEALED; // a run of its own even when this runner is inside a sealed run
		const cmd = [
			sealedSh,
			...(report ? ["--report"] : []),
			"env",
			...passEnv,
			process.execPath,
			join(here, `${name}.mjs`),
		];
		const child = spawn("bash", cmd, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => chunks.push(d));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
		}, timeoutSec * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString();
			writeFileSync(logFile, text);
			let summary = {};
			try {
				summary = JSON.parse(readFileSync(reportFile, "utf8"));
			} catch {
				/* killed before the summary */
			}
			const r = {
				name,
				code: timedOut ? "timeout" : code,
				secs: Math.round((Date.now() - started) / 1000),
				hits: summary.hits?.length ?? 0,
				hitPaths: [...new Set((summary.hits ?? []).map((h) => `${h.kind} ${h.path}`))].slice(0, 8),
				leaked: summary.leaked?.length ?? 0,
				newSessionDirs: summary.newSessionDirs ?? [],
				tail: text.trim().split("\n").slice(-6).join("\n"),
			};
			resolve(r);
		});
	});
}

// Many scripts use a fixed port (`const PORT = 8899;`) and free it first with `lsof … | kill -9`
// (tests/lib/port-utils.mjs). Two such scripts running side by side would kill each other's
// server, so scripts that name the same fixed port never run at the same time. Ports derived from
// another one count too (`const MOCK_PORT = PORT + 1;`), and so do the other fixed servers a
// script starts (`const SITE = 8972;`): missing those let rewind-to-here's mock model (8971 + 1)
// collide with provider-keys (8972), and plugin-grants free its port 8976 by killing
// no-active-chat-crash's mock model (8975 + 1), i.e. the whole test.
const fixedPortRe =
	/\b(?:const|let)\s+([A-Z_]*(?:PORT|SITE)[A-Z_]*)\s*=\s*(?:Number\(\s*process\.argv\[\d\]\s*\|\|\s*)?(\d{4,5})\b(?!\s*\+)/g;
const derivedPortRe = /\b(?:const|let)\s+([A-Z_]*(?:PORT|SITE)[A-Z_]*)\s*=\s*([A-Z_]+)\s*\+\s*(\d{1,3})\b/g;
function fixedPorts(src) {
	const byName = new Map();
	for (const m of src.matchAll(fixedPortRe)) byName.set(m[1], Number(m[2]));
	for (const m of src.matchAll(derivedPortRe)) {
		if (byName.has(m[2])) byName.set(m[1], byName.get(m[2]) + Number(m[3]));
	}
	return [...new Set(byName.values())];
}
const portsOf = new Map(list.map((n) => [n, fixedPorts(readFileSync(join(here, `${n}.mjs`), "utf8"))]));
const portsInUse = new Set();
const pending = [...list];
const wakeups = [];
const wakeAll = () => {
	for (const w of wakeups.splice(0)) w();
};
function takeNext() {
	const i = pending.findIndex((n) => portsOf.get(n).every((p) => !portsInUse.has(p)));
	if (i < 0) return undefined;
	const [name] = pending.splice(i, 1);
	for (const p of portsOf.get(name)) portsInUse.add(p);
	return name;
}

const results = [];
let done = 0;
async function worker() {
	while (pending.length > 0) {
		const name = takeNext();
		if (name === undefined) {
			// Everything left waits for a port a running script holds.
			await new Promise((r) => wakeups.push(r));
			continue;
		}
		const r = await runOne(name);
		for (const p of portsOf.get(name)) portsInUse.delete(p);
		wakeAll();
		results.push(r);
		done++;
		const ok = r.code === 0 && r.hits === 0;
		const extra = [r.hits ? `${r.hits} fence hit(s)` : "", r.leaked ? `${r.leaked} left running` : ""]
			.filter(Boolean)
			.join(", ");
		console.log(
			`[${done}/${list.length}] ${ok ? "PASS" : "FAIL"} ${name} (${r.secs}s, exit ${r.code})${extra ? ` ${extra}` : ""}`,
		);
	}
}
await Promise.all(Array.from({ length: Math.min(jobs, list.length) }, worker));

results.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.code !== 0);
const hit = results.filter((r) => r.hits > 0);
const newDirs = [...new Set(results.flatMap((r) => r.newSessionDirs))];
console.log(
	`\n${results.length - failed.length}/${results.length} passed; ${hit.length} with fence hits (${report ? "report" : "enforce"} mode)`,
);
for (const n of skipped) console.log(`  skip  ${n}: ${NOT_FOR_THIS_FORK[n]}`);
for (const r of hit) console.log(`  hits  ${r.name}: ${r.hitPaths.join(" | ")}`);
for (const r of failed) console.log(`  fail  ${r.name} (exit ${r.code})`);
if (newDirs.length > 0) console.log(`  the real sessions list gained: ${newDirs.join(", ")}`);
console.log(`logs: ${out}`);
process.exit(failed.length > 0 || hit.length > 0 ? 1 : 0);
