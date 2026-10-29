#!/usr/bin/env node
// cpu-split-stall (Ops #628): measure how much a busy chat command starves the server's main thread,
// with today's layout (A: the commands share the server's cgroup) and with the split
// (B: server/ at cpu.weight 10000, tools/ at 100, server/cgroup-split.ts moving them).
//
// Never touches the live service: every run is a throwaway `systemd-run --user` transient service
// with the live unit's CPUWeight=1000, pinned to a few CPUs with taskset so the rest of the machine
// keeps its cores. Inside it a small node "server" (75% busy by default: 3 ms of work every 4 ms,
// like the live main thread's ~81% on 2026-10-28 21:40, in callback-sized pieces) records
// event-loop delay (monitorEventLoopDelay) and stalls (a 50 ms setInterval's gaps), while it runs
// cpus x 2 busy-loop node children as the stand-in for chat commands.
//
//   node scripts/cpu-split-stall.mjs [--runs 3] [--seconds 60] [--cpus 16-19] [--busy 3] [--tick 4] [--json out.json]
//
// Prints one line per run and a summary table (Markdown) at the end.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};

function cpuCount(list) {
	let n = 0;
	for (const part of list.split(",")) {
		const [a, b] = part.split("-").map(Number);
		n += Number.isFinite(b) ? b - a + 1 : 1;
	}
	return n;
}

async function server() {
	const layout = opt("layout");
	const seconds = Number(opt("seconds", "60"));
	const burners = Number(opt("burners", "8"));
	const busy = Number(opt("busy", "3"));
	const tick = Number(opt("tick", "4"));
	const resultFile = opt("result");
	let split = null;
	if (layout.startsWith("B")) {
		const mod = await import(pathToFileURL(path.join(REPO, "server/cgroup-split.ts")).href);
		split = mod.startCgroupSplit({ log: (l) => console.error(l) });
		if (!split.stats().active) throw new Error(`split didn't start: ${split.stats().reason}`);
	}
	// Fixed CPU work, calibrated before the children start: `busy` ms of computation when the thread
	// has a core to itself. (A wall-clock busy-wait would "finish" while preempted.)
	let sink = 1;
	const spin = (n) => {
		let x = sink;
		for (let i = 0; i < n; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
		sink = x;
	};
	// Calibrate with the jobs' own call shape (many short calls); one long call runs ~4x faster.
	for (let i = 0; i < 300; i++) spin(1e4);
	const t0 = performance.now();
	for (let i = 0; i < 2000; i++) spin(1e4);
	const perMs = 2e7 / (performance.now() - t0);
	const workIters = Math.round(perMs * busy);
	const kids = [];
	for (let i = 0; i < burners; i++) kids.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
	// The stand-in server's own work: `busy` ms of CPU every `tick` ms.
	// --model tick (H-CPU-SPLIT-1): a setInterval does one piece per tick; late ticks are dropped,
	//   so demand the thread can't meet just disappears.
	// --model queue (H-CPU-SPLIT-2, default): like requests, one job arrives every `tick` ms of wall
	//   time whether or not the thread kept up, and waits in a queue; job latency = arrival → done.
	const model = opt("model", "queue");
	let workTicks = 0;
	let measuring = false;
	const jobLat = [];
	let spinMs = 0;
	const queue = [];
	let stopped = false;
	let work;
	if (model === "tick") {
		work = setInterval(() => {
			workTicks++;
			spin(workIters);
		}, tick);
	} else {
		let nextDue = performance.now();
		let draining = false;
		const drain = () => {
			const due = stopped ? undefined : queue.shift();
			if (due === undefined) {
				draining = false;
				return;
			}
			const a = performance.now();
			spin(workIters);
			if (measuring) spinMs += performance.now() - a;
			workTicks++;
			if (measuring) jobLat.push(performance.now() - due);
			setImmediate(drain);
		};
		work = setInterval(() => {
			const now = performance.now();
			while (nextDue <= now) {
				queue.push(nextDue);
				nextDue += tick;
			}
			if (!draining) {
				draining = true;
				setImmediate(drain);
			}
		}, tick);
	}
	await new Promise((r) => setTimeout(r, 3000)); // warm-up: children started (and moved, in B)
	// B0 (diagnosis): the split with the mover stopped once the children are in tools/.
	if (layout === "B0") split.stop();
	const ticksAtStart = workTicks;
	measuring = true;
	// The main thread's own CPU time (utime + stime, clock ticks of 10 ms) from /proc.
	const threadCpu = () => {
		const f = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8");
		const rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
		return (Number(rest[11]) + Number(rest[12])) * 10;
	};
	const cpuAtStart = threadCpu();
	const h = monitorEventLoopDelay({ resolution: 1 });
	h.enable();
	let last = performance.now();
	let maxGap = 0;
	let stalls = 0;
	let stalls50 = 0;
	const bigGaps = [];
	const t0Measure = performance.now();
	const gaps = setInterval(() => {
		const now = performance.now();
		const late = now - last - 50;
		last = now;
		if (late > maxGap) maxGap = late;
		if (late >= 50) {
			stalls50++;
			if (bigGaps.length < 20) bigGaps.push([Math.round(now - t0Measure), Math.round(late)]);
		}
		if (late >= 500) stalls++;
	}, 50);
	await new Promise((r) => setTimeout(r, seconds * 1000));
	h.disable();
	clearInterval(gaps);
	clearInterval(work);
	stopped = true;
	const mainThreadCpu = (threadCpu() - cpuAtStart) / (seconds * 1000);
	// Jobs still waiting at the end count with the wait they had so far.
	const end = performance.now();
	for (const due of queue) jobLat.push(end - due);
	jobLat.sort((a, b) => a - b);
	const q = (p) => (jobLat.length ? jobLat[Math.min(jobLat.length - 1, Math.floor((p / 100) * jobLat.length))] : 0);
	const where = (pid) => {
		try {
			return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("/").pop();
		} catch {
			return "?";
		}
	};
	const result = {
		layout,
		seconds,
		burners,
		busy,
		tick,
		// Share of the server's work that got done (1 = every tick ran).
		workDone: (workTicks - ticksAtStart) / ((seconds * 1000) / tick),
		p50: h.percentile(50) / 1e6,
		p99: h.percentile(99) / 1e6,
		max: h.max / 1e6,
		maxGap,
		stalls500: stalls,
		stalls50,
		model,
		jobP50: q(50),
		jobP99: q(99),
		jobMax: jobLat.length ? jobLat[jobLat.length - 1] : 0,
		backlog: queue.length,
		calibratedMs: busy,
		// Share of one core the main thread got while measuring (1 = a whole core).
		mainThreadCpu,
		jobMs: spinMs / Math.max(1, workTicks - ticksAtStart),
		bigGaps,
		serverCgroup: where(process.pid),
		childCgroups: [...new Set(kids.map((k) => where(k.pid)))],
		moved: split?.stats().moved ?? 0,
		sink,
	};
	for (const k of kids) k.kill("SIGKILL");
	split?.stop();
	fs.writeFileSync(resultFile, JSON.stringify(result));
}

function orchestrate() {
	const runs = Number(opt("runs", "3"));
	const seconds = Number(opt("seconds", "60"));
	const cpus = opt("cpus", "16-19");
	const burners = Number(opt("burners", String(cpuCount(cpus) * 2)));
	const busy = opt("busy", "3");
	const tick = opt("tick", "4");
	const layouts = opt("layouts", "A,B").split(",");
	const model = opt("model", "queue");
	// The transient unit's CPUWeight; the live unit's is 1000.
	const unitWeight = opt("unit-weight", "1000");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-split-"));
	const results = [];
	for (let i = 1; i <= runs; i++) {
		for (const layout of layouts) {
			const unit = `ops628-cpu-split-${layout}${i}-${process.pid}`;
			const resultFile = path.join(dir, `${layout}${i}.json`);
			const load1 = Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
			const props = [
				"-p",
				`CPUWeight=${unitWeight}`,
				...(layout !== "A" ? ["-p", "Delegate=yes", "-p", "DelegateSubgroup=server"] : []),
			];
			const r = spawnSync(
				"systemd-run",
				[
					"--user",
					`--unit=${unit}`,
					"--collect",
					"--wait",
					"--quiet",
					...props,
					`--working-directory=${REPO}`,
					"taskset",
					"-c",
					cpus,
					process.execPath,
					path.join(HERE, "cpu-split-stall.mjs"),
					"--server",
					"--layout",
					layout,
					"--seconds",
					String(seconds),
					"--burners",
					String(burners),
					"--busy",
					busy,
					"--tick",
					tick,
					"--model",
					model,
					"--result",
					resultFile,
				],
				{ encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
			);
			if (r.status !== 0 || !fs.existsSync(resultFile)) {
				console.error(`run ${layout}${i} failed (exit ${r.status}); journalctl --user -u ${unit}`);
				process.exit(1);
			}
			const res = { run: i, load1, ...JSON.parse(fs.readFileSync(resultFile, "utf8")) };
			results.push(res);
			console.log(
				`${layout}${i} load1=${load1} p50=${res.p50.toFixed(1)}ms p99=${res.p99.toFixed(1)}ms max=${res.max.toFixed(1)}ms maxGap=${res.maxGap.toFixed(1)}ms stalls>=500ms=${res.stalls500} >=50ms=${res.stalls50} workDone=${(res.workDone * 100).toFixed(0)}%${model === "queue" ? ` job p50=${res.jobP50.toFixed(0)}ms p99=${res.jobP99.toFixed(0)}ms max=${res.jobMax.toFixed(0)}ms backlog=${res.backlog}` : ""} mainCpu=${(res.mainThreadCpu * 100).toFixed(0)}% server=${res.serverCgroup} children=${res.childCgroups.join(",")} moved=${res.moved}`,
			);
			if (res.bigGaps.length) console.log(`   gaps>=50ms [at ms, late ms]: ${JSON.stringify(res.bigGaps)}`);
		}
	}
	const json = opt("json");
	if (json) fs.writeFileSync(json, JSON.stringify({ cpus, burners, busy, tick, model, seconds, results }, null, 2));
	const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	const pick = (l, k) => results.filter((r) => r.layout === l).map((r) => r[k]);
	console.log(`\n| metric (median of ${runs}) | ${layouts.join(" | ")} |\n|---|${layouts.map(() => "---|").join("")}`);
	const keys = [
		"p50",
		"p99",
		"max",
		"maxGap",
		"stalls500",
		"stalls50",
		"workDone",
		"mainThreadCpu",
		...(model === "queue" ? ["jobP50", "jobP99", "jobMax", "backlog"] : []),
	];
	for (const k of keys) {
		console.log(`| ${k} | ${layouts.map((l) => med(pick(l, k)).toFixed(2)).join(" | ")} |`);
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

if (args.includes("--server")) await server();
else orchestrate();
