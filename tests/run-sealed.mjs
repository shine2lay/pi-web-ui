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
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const sealedSh = join(repo, "scripts", "sealed.sh");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const a = args.find((x) => x.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : fallback;
};
const report = args.includes("--report");
const jobs = Math.max(1, Number(opt("jobs", "6")) || 6);
const timeoutSec = Math.max(10, Number(opt("timeout", "600")) || 600);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = opt("out", join(tmpdir(), "pi-sealed-runs", stamp));
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
